import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { checkEligibility } from '@/lib/services/investment-intelligence/investmentPublicationService';

// R3 spec section 61 — eligibility check. Read-only, no side effects other
// than the position lookup itself (RLS-scoped to the caller's own data).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { eligibility, error } = await checkEligibility(user.id, id);
  if (error) return bad(error, 404);
  return ok(eligibility);
}
