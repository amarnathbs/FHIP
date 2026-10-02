import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { ensureSelfHouseholdMember } from '@/lib/services/household/ensureSelfMember';

// POST /api/ownership/self
//
// Ensures the caller has their own "Self" household member, so "Mine" can be
// chosen as an upload owner. IDEMPOTENT (an existing active self is returned
// unchanged; nothing is duplicated) and takes no input, so a caller can neither
// name another user nor choose a name: the member is created for the
// authenticated user from their own profile. This is the ONLY place the
// ownership selector causes a write; GET /api/ownership/options never does.
export const dynamic = 'force-dynamic';

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { memberId, error } = await ensureSelfHouseholdMember(user.id);
  if (!memberId) return bad(error ?? 'Could not record you as a household member.', 500);
  return ok({ memberId });
}
