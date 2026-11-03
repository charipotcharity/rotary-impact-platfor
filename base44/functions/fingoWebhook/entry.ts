import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { verifyFingoSignature } from '../../shared/fingo.ts';
import { advanceRamp } from '../../shared/fingoRamp.ts';

// Public webhook receiver for Fingo Pay transaction.* events. Signature is
// verified (HMAC-SHA256, 5-minute window) before anything is touched. The
// event is only used as a trigger: advanceRamp re-checks status and is
// idempotent, so duplicate/at-least-once deliveries are safe.
export default async function (req) {
  try {
    const raw = await req.text();
    const ok = await verifyFingoSignature(raw, req.headers.get('X-Fingo-Signature'));
    if (!ok) return Response.json({ error: 'invalid_signature' }, { status: 400 });

    let event;
    try { event = JSON.parse(raw); } catch (_) { return Response.json({ error: 'bad_json' }, { status: 400 }); }
    const data = event?.data?.object || event?.data || {};
    const mtx = data.merchantTransactionId;
    if (!mtx || !/^ramp_(on|off)_/.test(mtx)) return Response.json({ received: true, ignored: true });

    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const ramp = (await svc.entities.FiatRamp.filter({ merchantTransactionId: mtx }))[0];
    if (!ramp) return Response.json({ received: true, ignored: true });

    // Map the event type onto a transaction-like status for advanceRamp.
    const type = String(event.type || '');
    const status = type === 'transaction.succeeded' ? 'completed'
      : (type === 'transaction.failed' || type === 'transaction.creation_failed') ? 'failed'
      : String(data.status || 'pending');
    await advanceRamp(svc, ramp, { ...data, status });
    return Response.json({ received: true });
  } catch (error) {
    // Non-2xx makes Fingo retry with backoff.
    return Response.json({ error: error.message }, { status: 500 });
  }
}
