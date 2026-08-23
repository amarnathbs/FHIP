import { requireUser, ok, bad } from '@/lib/api';
import { refreshPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';

// R3 spec sections 33-35. [id] is the NEW ii_holding_snapshots.id (the
// freshly-certified position) for an economic position that already has an
// active publication. Decides ACTIVATE_NEW / REJECT_OLDER /
// ACTIVATE_NEW_SAME_DATE_CORRECTION and never creates a second active
// publication for the same (account, instrument).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { error, publicationId, decision } = await refreshPosition(user.id, id);
  if (error && decision === 'REJECT_OLDER') return bad(error, 409);
  if (error) return bad(error, 422);
  return ok({ publicationId, decision });
}
