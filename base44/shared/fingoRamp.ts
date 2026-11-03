import { sendTokenFromRawKey, getTxStatus, readOnChainBalances, checkGasForTransfers } from './walletCrypto.ts';
import { fingoGetTransaction, fingoPayout, getRampKey, getRampAddress, FingoError } from './fingo.ts';

// Fiat ramp state machine (Fingo Pay M-Pesa <-> USDC/USDT).
//
// ONRAMP  (buy):  AWAITING_PAYMENT --(M-Pesa charge completed)--> SENDING_CRYPTO
//                 --(ramp wallet broadcasts transfer)--> CRYPTO_SENT --(mined)--> COMPLETED
// OFFRAMP (sell): AWAITING_CRYPTO --(user's transfer to ramp wallet mined)--> SENDING_PAYOUT
//                 --(Fingo B2C accepted)--> PAYOUT_PENDING --(payout completed)--> COMPLETED
//
// Any leg that fails AFTER the customer's money has moved lands in NEEDS_REVIEW
// (never auto-retried) so an admin can refund or settle manually.
// advanceRamp() is idempotent and is called from both the Fingo webhook and the
// user's status poll, so either path can drive a ramp forward.

const now = () => new Date().toISOString();
const FINAL = new Set(['COMPLETED', 'FAILED', 'NEEDS_REVIEW']);
const PAID = new Set(['completed', 'settled']);
const FAILED = new Set(['failed', 'rejected']);
// An unpaid STK Push that is still pending after this long is treated as abandoned.
const CHARGE_TIMEOUT_MS = 15 * 60 * 1000;

async function patch(svc, ramp, data) {
  const next = { ...data, updatedAt: now() };
  await svc.entities.FiatRamp.update(ramp.id, next);
  Object.assign(ramp, next);
  return ramp;
}

// Best-effort processing lock: write a random claim token alongside the
// in-flight status, wait, then re-read. Only the writer whose token survived
// proceeds, so a webhook and a poll racing on the same ramp cannot both send.
async function claim(svc, ramp, fromStatus, toStatus) {
  const fresh = await svc.entities.FiatRamp.get(ramp.id);
  if (!fresh || fresh.status !== fromStatus) return false;
  const token = crypto.randomUUID();
  await svc.entities.FiatRamp.update(ramp.id, { status: toStatus, claimToken: token, updatedAt: now() });
  await new Promise((r) => setTimeout(r, 400));
  const check = await svc.entities.FiatRamp.get(ramp.id);
  if (!check || check.claimToken !== token) return false;
  Object.assign(ramp, check);
  return true;
}

async function audit(svc, ramp, action, details, severity = 'info') {
  try {
    await svc.entities.AuditLog.create({
      actor: ramp.fullName || ramp.userId,
      actorRole: 'user',
      action,
      entityType: 'FiatRamp',
      entityId: ramp.id,
      details,
      timestamp: now(),
      severity,
    });
  } catch (_) { /* audit is best-effort */ }
}

async function markCryptoTx(svc, ramp, status, blockNumber) {
  if (!ramp.cryptoTxHash) return;
  const recs = await svc.entities.CryptoTransaction.filter({ txHash: ramp.cryptoTxHash, chain: ramp.chain, token: ramp.token });
  for (const r of recs) {
    if (r.status !== status) await svc.entities.CryptoTransaction.update(r.id, { status, blockNumber: blockNumber ?? r.blockNumber });
  }
}

// ---- ONRAMP: send stablecoin once the M-Pesa payment is confirmed ----
async function deliverCrypto(svc, ramp) {
  if (!(await claim(svc, ramp, 'AWAITING_PAYMENT', 'SENDING_CRYPTO'))) return ramp;
  const key = getRampKey();
  const rampAddr = getRampAddress();
  try {
    if (!key || !rampAddr) throw new Error('Ramp wallet not configured');
    const chains = await readOnChainBalances(rampAddr);
    const bal = Number(chains.find((c) => c.chain === ramp.chain)?.balances?.[ramp.token] ?? 0);
    if (bal < ramp.cryptoAmount) throw new Error(`Ramp wallet has insufficient ${ramp.token} liquidity on ${ramp.chain}`);
    const gas = await checkGasForTransfers(ramp.chain, rampAddr, 1);
    if (!gas.ok) throw new Error(`Ramp wallet has insufficient gas on ${ramp.chain}`);

    const res = await sendTokenFromRawKey(ramp.chain, ramp.token, key, ramp.walletAddress, String(ramp.cryptoAmount));
    await patch(svc, ramp, { status: 'CRYPTO_SENT', cryptoTxHash: res.txHash, message: 'Stablecoin transfer broadcast' });
    await svc.entities.CryptoTransaction.create({
      userId: ramp.userId,
      fullName: ramp.fullName,
      type: 'RAMP_BUY',
      chain: ramp.chain,
      token: ramp.token,
      amount: ramp.cryptoAmount,
      txHash: res.txHash,
      fromAddress: rampAddr,
      toAddress: ramp.walletAddress,
      status: 'PENDING',
      reference: ramp.id,
      createdAt: now(),
    });
    await audit(svc, ramp, 'FIAT_ONRAMP_CRYPTO_SENT', `Sent ${ramp.cryptoAmount} ${ramp.token} on ${ramp.chain} for KES ${ramp.kesAmount} (M-Pesa ${ramp.processorReference || '—'})`);
  } catch (e) {
    // Customer has already paid: never auto-fail, flag for an admin.
    await patch(svc, ramp, { status: 'NEEDS_REVIEW', message: `Payment received but crypto delivery failed: ${e.message}` });
    await audit(svc, ramp, 'FIAT_ONRAMP_DELIVERY_FAILED', `KES ${ramp.kesAmount} paid, ${ramp.cryptoAmount} ${ramp.token} not delivered: ${e.message}`, 'critical');
  }
  return ramp;
}

// ---- OFFRAMP: pay KES once the user's stablecoin has landed in the ramp wallet ----
async function sendPayout(svc, ramp) {
  if (!(await claim(svc, ramp, 'AWAITING_CRYPTO', 'SENDING_PAYOUT'))) return ramp;
  try {
    const r = await fingoPayout({
      merchantTransactionId: ramp.merchantTransactionId,
      kes: ramp.kesAmount,
      phoneNumber: ramp.phoneNumber,
      narration: `Sold ${ramp.cryptoAmount} ${ramp.token}`,
      metadata: { rampId: ramp.id, userId: ramp.userId, direction: 'OFFRAMP' },
    });
    await patch(svc, ramp, { status: 'PAYOUT_PENDING', fingoTransactionId: r.transactionId || '', message: 'M-Pesa payout initiated' });
    await audit(svc, ramp, 'FIAT_OFFRAMP_PAYOUT_SENT', `B2C KES ${ramp.kesAmount} to ${ramp.phoneNumber} for ${ramp.cryptoAmount} ${ramp.token}`);
  } catch (e) {
    const msg = e instanceof FingoError ? `${e.message}${e.requestId ? ` (req ${e.requestId})` : ''}` : e.message;
    await patch(svc, ramp, { status: 'NEEDS_REVIEW', message: `Crypto received but M-Pesa payout failed: ${msg}` });
    await audit(svc, ramp, 'FIAT_OFFRAMP_PAYOUT_FAILED', `${ramp.cryptoAmount} ${ramp.token} received, KES ${ramp.kesAmount} not paid: ${msg}`, 'critical');
  }
  return ramp;
}

// Moves a ramp forward as far as it can. `fingoTx` is an optional Fingo
// transaction object (e.g. from a verified webhook) to avoid an extra lookup.
export async function advanceRamp(svc, ramp, fingoTx = null) {
  if (!ramp || FINAL.has(ramp.status)) return ramp;

  if (ramp.direction === 'ONRAMP') {
    if (ramp.status === 'AWAITING_PAYMENT') {
      const tx = fingoTx || (await fingoGetTransaction(ramp.merchantTransactionId).catch(() => null));
      const st = String(tx?.status || '').toLowerCase();
      if (tx?.processorReference && !ramp.processorReference) {
        await patch(svc, ramp, { processorReference: tx.processorReference, fingoTransactionId: ramp.fingoTransactionId || tx.publicId || tx.id || '' });
      }
      if (PAID.has(st)) return deliverCrypto(svc, ramp);
      if (FAILED.has(st)) {
        return patch(svc, ramp, { status: 'FAILED', message: tx?.message || 'M-Pesa payment failed or was cancelled' });
      }
      if (Date.now() - new Date(ramp.createdAt).getTime() > CHARGE_TIMEOUT_MS && (!tx || st === 'pending' || st === 'initiated')) {
        return patch(svc, ramp, { status: 'FAILED', message: 'M-Pesa payment was not completed in time' });
      }
      return ramp;
    }
    if (ramp.status === 'CRYPTO_SENT' && ramp.cryptoTxHash) {
      const st = await getTxStatus(ramp.chain, ramp.cryptoTxHash);
      if (st.pending) return ramp;
      if (st.confirmed) {
        await markCryptoTx(svc, ramp, 'CONFIRMED', st.blockNumber);
        return patch(svc, ramp, { status: 'COMPLETED', message: 'Stablecoin delivered to your wallet' });
      }
      await markCryptoTx(svc, ramp, 'FAILED', st.blockNumber);
      await audit(svc, ramp, 'FIAT_ONRAMP_TX_REVERTED', `Onramp transfer ${ramp.cryptoTxHash} reverted`, 'critical');
      return patch(svc, ramp, { status: 'NEEDS_REVIEW', message: 'Crypto transfer reverted on-chain — support will resolve this' });
    }
    return ramp;
  }

  // OFFRAMP
  if (ramp.status === 'AWAITING_CRYPTO' && ramp.cryptoTxHash) {
    const st = await getTxStatus(ramp.chain, ramp.cryptoTxHash);
    if (st.pending) return ramp;
    if (st.failed) {
      await markCryptoTx(svc, ramp, 'FAILED', st.blockNumber);
      return patch(svc, ramp, { status: 'FAILED', message: 'Your stablecoin transfer failed on-chain — no funds were sold' });
    }
    await markCryptoTx(svc, ramp, 'CONFIRMED', st.blockNumber);
    return sendPayout(svc, ramp);
  }
  if (ramp.status === 'PAYOUT_PENDING') {
    const tx = fingoTx || (await fingoGetTransaction(ramp.merchantTransactionId).catch(() => null));
    const st = String(tx?.status || '').toLowerCase();
    if (tx?.processorReference && !ramp.processorReference) {
      await patch(svc, ramp, { processorReference: tx.processorReference });
    }
    if (PAID.has(st)) return patch(svc, ramp, { status: 'COMPLETED', message: 'KES sent to your M-Pesa' });
    if (FAILED.has(st)) {
      await audit(svc, ramp, 'FIAT_OFFRAMP_PAYOUT_FAILED', `B2C failed: ${tx?.message || 'unknown'}`, 'critical');
      return patch(svc, ramp, { status: 'NEEDS_REVIEW', message: `M-Pesa payout failed: ${tx?.message || 'unknown error'} — support will resolve this` });
    }
  }
  return ramp;
}

// Strips internal fields before returning a ramp to the client.
export function publicRamp(r) {
  if (!r) return r;
  const { claimToken: _c, ...rest } = r;
  return rest;
}
