import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';
import { sendToken, readOnChainBalances, checkGasForTransfers } from '../../shared/walletCrypto.ts';
import { cryptoEscrowOf } from '../../shared/escrow.ts';
import { normalizeKePhone, quoteOfframp, getRampAddress, fingoApiKey, FINGO_LIMITS } from '../../shared/fingo.ts';
import { publicRamp } from '../../shared/fingoRamp.ts';

// OFFRAMP (sell crypto for M-Pesa). Moves USDC/USDT from the user's platform
// wallet to the ramp liquidity wallet; once that transfer is mined, Fingo Pay
// sends KES to the user's M-Pesa via B2C (driven by fingoRampStatus / webhook).
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const amount = Math.floor(Number(body.cryptoAmount) * 100) / 100;
    const chain = body.chain || 'bnb';
    const token = body.token || 'USDT';
    const phone = normalizeKePhone(body.phoneNumber);
    if (!['bnb', 'ethereum', 'polygon'].includes(chain)) return Response.json({ error: 'Unsupported chain' }, { status: 400 });
    if (!['USDC', 'USDT'].includes(token)) return Response.json({ error: 'Unsupported token' }, { status: 400 });
    if (!phone) return Response.json({ error: 'Enter a valid Kenyan M-Pesa number (07XXXXXXXX or +2547XXXXXXXX)' }, { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0) return Response.json({ error: 'Enter a valid amount' }, { status: 400 });

    const q = quoteOfframp(amount);
    if (q.kes < FINGO_LIMITS.payoutMinKes || q.kes > FINGO_LIMITS.payoutMaxKes) {
      return Response.json({ error: `Payout must be between KES ${FINGO_LIMITS.payoutMinKes} and KES ${FINGO_LIMITS.payoutMaxKes.toLocaleString()} (you'd receive KES ${q.kes.toLocaleString()})` }, { status: 400 });
    }

    const pass = secrets.get('WALLET_ENCRYPTION_KEY');
    if (!pass) return Response.json({ error: 'WALLET_ENCRYPTION_KEY not configured' }, { status: 500 });
    const rampAddr = getRampAddress();
    if (!rampAddr || !fingoApiKey()) return Response.json({ error: 'Offramp is not available right now' }, { status: 503 });

    const wallets = await base44.entities.Wallet.filter({ userId: user.id });
    const wallet = wallets[0];
    if (!wallet?.walletAddress || !wallet.encryptedPrivateKey) return Response.json({ error: 'No wallet', needsWallet: true }, { status: 400 });
    if (user.isBlacklisted || wallet.isBlacklisted) {
      return Response.json({ error: 'Your wallet or account is blacklisted — ramps are disabled.' }, { status: 403 });
    }

    // Available balance = on-chain minus marketplace escrow (same rule as withdrawCrypto).
    const chains = await readOnChainBalances(wallet.walletAddress);
    const onChain = Number(chains.find((c) => c.chain === chain)?.balances?.[token] ?? 0);
    const available = onChain - cryptoEscrowOf(wallet, chain, token);
    if (available < amount - 1e-6) {
      return Response.json({ error: `Insufficient ${token} on ${chain}. Available: ${available.toFixed(2)}` }, { status: 400 });
    }
    const gas = await checkGasForTransfers(chain, wallet.walletAddress, 1);
    if (!gas.ok) {
      return Response.json({ error: `Not enough gas on ${chain} to send ${token}. Top up a little native coin first.` }, { status: 400 });
    }

    const merchantTransactionId = `ramp_off_${crypto.randomUUID().replace(/-/g, '')}`;
    const ts = new Date().toISOString();
    const ramp = await svc.entities.FiatRamp.create({
      userId: user.id,
      fullName: user.full_name || user.email,
      direction: 'OFFRAMP',
      status: 'AWAITING_CRYPTO',
      phoneNumber: phone,
      kesAmount: q.kes,
      cryptoAmount: amount,
      chain,
      token,
      rate: q.kesPerUsd,
      feePct: q.feePct,
      walletAddress: wallet.walletAddress,
      merchantTransactionId,
      message: 'Sending your stablecoin…',
      createdAt: ts,
      updatedAt: ts,
    });

    let tx;
    try {
      tx = await sendToken(chain, token, wallet.encryptedPrivateKey, rampAddr, String(amount), pass);
    } catch (e) {
      await svc.entities.FiatRamp.update(ramp.id, { status: 'FAILED', message: `Transfer failed: ${e.message}`, updatedAt: new Date().toISOString() });
      return Response.json({ error: `Transfer failed: ${e.message}` }, { status: 400 });
    }

    await svc.entities.FiatRamp.update(ramp.id, { cryptoTxHash: tx.txHash, message: 'Waiting for blockchain confirmation', updatedAt: new Date().toISOString() });
    ramp.cryptoTxHash = tx.txHash;
    await svc.entities.CryptoTransaction.create({
      userId: user.id,
      fullName: user.full_name || user.email,
      type: 'RAMP_SELL',
      chain,
      token,
      amount,
      txHash: tx.txHash,
      fromAddress: wallet.walletAddress,
      toAddress: rampAddr,
      status: 'PENDING',
      reference: ramp.id,
      createdAt: new Date().toISOString(),
    });
    await svc.entities.AuditLog.create({
      actor: user.full_name || user.email,
      actorRole: user.role,
      action: 'FIAT_OFFRAMP_STARTED',
      entityType: 'FiatRamp',
      entityId: ramp.id,
      details: `Sell ${amount} ${token} on ${chain} for KES ${q.kes} to ${phone}`,
      timestamp: new Date().toISOString(),
      severity: 'info',
    });

    return Response.json({ ramp: publicRamp(ramp) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
