import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { ensureSelfHouseholdMember } from '@/lib/services/household/ensureSelfMember';
import { loadOwnerContext } from '@/lib/ownership/validateOwnerSelection';
import { buildOwnerOptions } from '@/lib/ownership/ownerOptions';
import { isOwnerFlow } from '@/lib/ownership/ownerSelection';

// GET /api/ownership/options?flow=bank|ii_cas
//
// Owner-before-upload (Phase 1): the owners THIS user may choose from for one
// upload flow. User-scoped end to end -- every read filters on the caller's own
// id, nothing is cached across users, and the home country that decides
// whether HUF / SMSF appear is the user's authoritative profile country, never
// a query parameter.
//
// The caller's own "Self" household member is created here if it does not
// exist yet (lib/services/household/ensureSelfMember.ts), so the first upload
// never needs an extra onboarding step before "Mine" can be chosen.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const flow = new URL(req.url).searchParams.get('flow');
  if (!isOwnerFlow(flow)) return bad('Unknown upload type.', 422, 'owner_flow_invalid');

  await ensureSelfHouseholdMember(user.id);
  const ctx = await loadOwnerContext(user.id);
  return ok(buildOwnerOptions(ctx, flow));
}
