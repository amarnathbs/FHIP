import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { unpublishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';

// R3 spec section 36. [id] is an ii_fhip_publications.id owned by the caller.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { error } = await unpublishPosition(user.id, id);
  if (error) return bad(error, 404);
  return ok({ unpublished: true });
}
