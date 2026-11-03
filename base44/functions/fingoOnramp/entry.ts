import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { fingoCharge, normalizeKePhone, quoteOnramp, getRampAddress, FINGO_LIMITS, FingoError } from '../../shared/fingo.ts';
import { publicRamp } from '../../shared/fingoRamp.ts';

// ONRAMP (buy crypto with M-Pesa). Creates a FiatRamp and sends an M-Pesa STK
// Push via Fingo Pay. Once Fingo reports the charge completed (webhook or the
// status poll), the ramp liquidity wallet sends USDC/USDT to the user's wallet.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const kes = Math.floor(Number(body.kesAmount));
    const chain = body.chain || 'bnb';
    const token = body.token || 'USDT';
    const phone = normalizeKePhone(body.phoneNumber);
    if (!['bnb', 'ethereum', 'polygon'].includes(chain)) return Response.json({ error: 'Unsupported chain' }, { status: 400 });
    if (!['USDC', 'USDT'].includes(token)) return Response.json({ error: 'Unsupported token' }, { status: 400 });
    if (!phone) return Response.json({ error: 'Enter a valid Kenyan M-Pesa number (07XXXXXXXX or +2547XXXXXXXX)' }, { status: 400 });
    if (!Number.isFinite(kes) || kes < FINGO_LIMITS.chargeMinKes || kes > FINGO_LIMITS.chargeMaxKes) {
      return Response.json({ error: `Amount must be between KES ${FINGO_LIMITS.chargeMinKes} and KES ${FINGO_LIMITS.chargeMaxKes.toLocaleString()}` }, { status: 400 });
    }

    const wallets = await base44.entities.Wallet.filter({ userId: user.id });
    const wallet = wallets[0];
    if (!wallet?.walletAddress) return Response.json({ error: 'No wallet', needsWallet: true }, { status: 400 });
    if (user.isBlacklisted || wallet.isBlacklisted) {
      return Response.json({ error: 'Your wallet or account is blacklisted — ramps are disabled.' }, { status: 403 });
    }
    if (!getRampAddress()) return Response.json({ error: 'Onramp is not available right now (ramp wallet not configured)' }, { status: 503 });

    const q = quoteOnramp(kes);
    if (q.crypto <= 0) return Response.json({ error: 'Amount too small' }, { status: 400 });

    const merchantTransactionId = `ramp_on_${crypto.randomUUID().replace(/-/g, '')}`;
    const ts = new Date().toISOString();
    const ramp = await svc.entities.FiatRamp.create({
      userId: user.id,
      fullName: user.full_name || user.email,
      direction: 'ONRAMP',
      status: 'AWAITING_PAYMENT',
      phoneNumber: phone,
      kesAmount: kes,
      cryptoAmount: q.crypto,
      chain,
      token,
      rate: q.kesPerUsd,
      feePct: q.feePct,
      walletAddress: wallet.walletAddress,
      merchantTransactionId,
      message: 'Check your phone and enter your M-Pesa PIN',
      createdAt: ts,
      updatedAt: ts,
    });

    try {
      const r = await fingoCharge({
        merchantTransactionId,
        kes,
        phoneNumber: phone,
        narration: `Buy ${q.crypto} ${token}`,
        metadata: { rampId: ramp.id, userId: user.id, direction: 'ONRAMP' },
      });
      await svc.entities.FiatRamp.update(ramp.id, { fingoTransactionId: r.transactionId || '' });
      ramp.fingoTransactionId = r.transactionId || '';
    } catch (e) {
      const msg = e instanceof FingoError ? e.message : 'Could not start M-Pesa payment';
      await svc.entities.FiatRamp.update(ramp.id, { status: 'FAILED', message: msg, updatedAt: new Date().toISOString() });
      return Response.json({ error: msg }, { status: e instanceof FingoError && e.status < 500 ? 400 : 502 });
    }

    return Response.json({ ramp: publicRamp(ramp) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
