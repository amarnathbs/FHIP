import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { loadOwnerContext } from '@/lib/ownership/validateOwnerSelection';
import { buildOwnerOptions } from '@/lib/ownership/ownerOptions';
import { isOwnerFlow } from '@/lib/ownership/ownerSelection';

// GET /api/ownership/options?flow=bank|ii_cas
//
// PURELY READ-ONLY (PO decision, 2026-10-01): this handler never writes. The
// caller's own "Self" household member is created by the separate, explicit,
// idempotent mutation POST /api/ownership/self, which the selector calls BEFORE
// it reads this list (and which onboarding may call too). A GET that wrote on
// first use would be unsafe to prefetch, retry or cache.
//
// User-scoped end to end: every read filters on the caller's own id, and the home
// country that decides whether HUF / SMSF appear is the authoritative profile
// country, never a query parameter. Marked dynamic and `no-store`: the answer is
// per user and must never be shared between users by any cache.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const flow = new URL(req.url).searchParams.get('flow');
  if (!isOwnerFlow(flow)) return bad('Unknown upload type.', 422, 'owner_flow_invalid');

  const ctx = await loadOwnerContext(user.id);
  return Response.json({ data: buildOwnerOptions(ctx, flow) }, { headers: { 'Cache-Control': 'no-store' } });
}
