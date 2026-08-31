import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { declineInvitation } from '@/lib/services/professional-access/access';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const result = await declineInvitation(id, user.id);
  if (!result.ok) return bad(result.error ?? 'Failed to decline invitation.');
  return ok({ declined: true });
}
