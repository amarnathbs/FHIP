// Investment Intelligence R11 — client invites a professional. Only the
// client themselves can call this (requireUser() from their own session);
// the professional's user id must already have an existing
// professional_profiles row (no arbitrary-user search — spec section 62).
import { requireUser, ok, bad } from '@/lib/api';
import { createInvitation } from '@/lib/services/professional-access/access';
import { isProfessionalScope, type ProfessionalScope } from '@/lib/services/professional-access/permissions';

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  let body: { professionalUserId?: string; purpose?: string; scopes?: string[] };
  try {
    body = await req.json();
  } catch {
    return bad('Invalid JSON body.');
  }
  if (!body.professionalUserId || typeof body.professionalUserId !== 'string') return bad('professionalUserId is required.');
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  const invalid = scopes.find((s) => !isProfessionalScope(s));
  if (invalid) return bad(`Unknown scope: ${invalid}`);

  const result = await createInvitation(user.id, body.professionalUserId, body.purpose ?? null, scopes as ProfessionalScope[]);
  if (result.error) return bad(result.error);
  return ok({ relationshipId: result.relationshipId });
}
