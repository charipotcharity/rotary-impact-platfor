import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { quoteOnramp, quoteOfframp, rampPricing, fingoApiKey, getRampAddress, fingoIsSandbox, FINGO_LIMITS } from '../../shared/fingo.ts';
import { advanceRamp, publicRamp } from '../../shared/fingoRamp.ts';

// Ramp helper endpoint.
//   { action: 'config' }                         -> rate, fee, limits, availability
//   { action: 'quote', direction, amount }       -> live quote
//   { action: 'status', rampId }                 -> advances & returns one ramp
//   { action: 'list' } (default)                 -> advances open ramps, returns recent
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'list';

    if (action === 'config') {
      const { kesPerUsd, feePct } = rampPricing();
      return Response.json({
        kesPerUsd, feePct, limits: FINGO_LIMITS,
        available: !!(fingoApiKey() && getRampAddress()),
        sandbox: fingoIsSandbox(),
      });
    }
    if (action === 'quote') {
      const amt = Number(body.amount) || 0;
      return Response.json(body.direction === 'OFFRAMP' ? quoteOfframp(amt) : quoteOnramp(Math.floor(amt)));
    }
    if (action === 'status') {
      const ramp = await svc.entities.FiatRamp.get(body.rampId).catch(() => null);
      if (!ramp || ramp.userId !== user.id) return Response.json({ error: 'Not found' }, { status: 404 });
      await advanceRamp(svc, ramp);
      return Response.json({ ramp: publicRamp(ramp) });
    }

    const list = await svc.entities.FiatRamp.filter({ userId: user.id }, '-createdAt', 10);
    for (const r of list) {
      if (!['COMPLETED', 'FAILED', 'NEEDS_REVIEW'].includes(r.status)) {
        try { await advanceRamp(svc, r); } catch (_) { /* keep listing */ }
      }
    }
    return Response.json({ ramps: list.map(publicRamp) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
