import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { republishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';

// R3 spec section 37. [id] is an ii_fhip_publications.id (currently
// 'unpublished') owned by the caller. Deterministic — refuses to proceed if
// another publication for the same economic position is already active,
// preventing a duplicate active row.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { error, publicationId } = await republishPosition(user.id, id);
  if (error) return bad(error, 409);
  return ok({ publicationId });
}
