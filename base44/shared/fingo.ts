import { Wallet as EthersWallet } from 'npm:ethers@6.13.4';
import { secrets } from 'base44:runtime';

// Fingo Pay (https://docs.fingopay.io) — Kenyan M-Pesa collections & payouts.
// One base URL for sandbox and production; the environment is selected by the
// API key prefix (sk_test_* vs sk_live_*). Amounts are integers in cents and
// M-Pesa C2B charges must be whole shillings.
const FINGO_BASE = 'https://api.fingopay.io';

// Fingo's per-endpoint KES limits (whole shillings).
export const FINGO_LIMITS = {
  chargeMinKes: 10,
  chargeMaxKes: 150000, // C2B allows 250k but we cap to the B2C max so a ramp can always be refunded
  payoutMinKes: 10,
  payoutMaxKes: 150000,
};

export function fingoApiKey(): string | null {
  return secrets.get('FINGO_API_KEY') || null;
}

export function fingoIsSandbox(): boolean {
  return (fingoApiKey() || '').startsWith('sk_test_');
}

export class FingoError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function fingoFetch(method: 'GET' | 'POST', path: string, opts: { body?: unknown; query?: Record<string, string>; idempotencyKey?: string } = {}) {
  const key = fingoApiKey();
  if (!key) throw new FingoError('Fingo Pay is not configured (FINGO_API_KEY missing)', 500, 'not_configured');
  const url = new URL(path, FINGO_BASE);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const e = json?.error || {};
    throw new FingoError(e.message || `Fingo Pay request failed (${res.status})`, res.status, e.code, e.requestId);
  }
  return json;
}

export function normalizeKePhone(raw: string): string | null {
  const s = String(raw || '').replace(/[\s-]/g, '');
  const m = s.match(/^(?:\+254|254|0)((?:7|1)\d{8})$/);
  return m ? `+254${m[1]}` : null;
}

function webhookUrl(): string | undefined {
  const u = secrets.get('FINGO_WEBHOOK_URL');
  return u && /^https:\/\//.test(u) ? u : undefined;
}

function sandboxMeta(meta: Record<string, string>) {
  // In sandbox, allow overriding the simulated outcome via FINGO_SANDBOX_FORCE_STATUS.
  if (!fingoIsSandbox()) return meta;
  const force = secrets.get('FINGO_SANDBOX_FORCE_STATUS');
  return force ? { ...meta, forceStatus: force } : meta;
}

// M-Pesa STK Push. Returns { merchantTransactionId, transactionId }.
export async function fingoCharge(p: { merchantTransactionId: string; kes: number; phoneNumber: string; narration: string; metadata?: Record<string, string> }) {
  const r = await fingoFetch('POST', '/v1/mpesa/charge', {
    idempotencyKey: `charge-${p.merchantTransactionId}`,
    body: {
      merchantTransactionId: p.merchantTransactionId,
      amount: Math.round(p.kes) * 100,
      phoneNumber: p.phoneNumber,
      narration: p.narration.slice(0, 140),
      webhookUrl: webhookUrl(),
      metadata: sandboxMeta(p.metadata || {}),
    },
  });
  return r?.data || {};
}

// M-Pesa B2C payout to a customer's phone. Returns { merchantTransactionId, transactionId }.
export async function fingoPayout(p: { merchantTransactionId: string; kes: number; phoneNumber: string; narration: string; metadata?: Record<string, string> }) {
  const r = await fingoFetch('POST', '/v1/mpesa/b2c', {
    idempotencyKey: `b2c-${p.merchantTransactionId}`,
    body: {
      merchantTransactionId: p.merchantTransactionId,
      amount: Math.round(p.kes * 100),
      phoneNumber: p.phoneNumber,
      narration: p.narration.slice(0, 140),
      webhookUrl: webhookUrl(),
      metadata: sandboxMeta(p.metadata || {}),
    },
  });
  return r?.data || {};
}

export async function fingoGetTransaction(merchantTransactionId: string) {
  try {
    const r = await fingoFetch('GET', '/v1/transaction', { query: { merchantTransactionId } });
    return r?.data || null;
  } catch (e) {
    if (e instanceof FingoError && e.status === 404) return null;
    throw e;
  }
}

// Verifies the X-Fingo-Signature header: "t=<unix>, v1=<hex hmac_sha256(secret, t + '.' + rawBody)>".
export async function verifyFingoSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = secrets.get('FINGO_WEBHOOK_SECRET');
  if (!secret || !header) return false;
  const parts: Record<string, string> = {};
  for (const seg of header.split(',')) {
    const [k, v] = seg.trim().split('=');
    if (k && v) parts[k] = v;
  }
  const t = parts.t;
  const v1 = (parts.v1 || '').toLowerCase();
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)));
  const expected = Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ---- Ramp liquidity wallet ----
// A dedicated platform hot wallet that holds the stablecoin float: it pays out
// crypto on onramps and receives crypto on offramps. Keep it separate from the
// collector/custody wallets so ramp liquidity never mixes with charity funds.
export function getRampKey(): string | null {
  return secrets.get('RAMP_WALLET_PRIVATE_KEY') || null;
}

export function getRampAddress(): string | null {
  const k = getRampKey();
  if (!k) return null;
  try { return new EthersWallet(k).address; } catch (_) { return null; }
}

// ---- Pricing ----
export function rampPricing() {
  const rate = Number(secrets.get('FINGO_KES_PER_USD'));
  const fee = Number(secrets.get('FINGO_RAMP_FEE_PCT'));
  return {
    kesPerUsd: Number.isFinite(rate) && rate > 0 ? rate : 129,
    feePct: Number.isFinite(fee) && fee >= 0 && fee < 50 ? fee : 1.5,
  };
}

const floor2 = (n: number) => Math.floor(n * 100) / 100;

// KES paid → stablecoin received.
export function quoteOnramp(kes: number) {
  const { kesPerUsd, feePct } = rampPricing();
  const cryptoOut = floor2((kes / kesPerUsd) * (1 - feePct / 100));
  return { kes, crypto: cryptoOut, kesPerUsd, feePct };
}

// Stablecoin sold → KES received (whole shillings, rounded down).
export function quoteOfframp(cryptoAmt: number) {
  const { kesPerUsd, feePct } = rampPricing();
  const kes = Math.floor(cryptoAmt * kesPerUsd * (1 - feePct / 100));
  return { kes, crypto: cryptoAmt, kesPerUsd, feePct };
}
