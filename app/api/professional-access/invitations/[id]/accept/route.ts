// Professional accepts a pending invitation. Only the invited professional
// (their own session, never the client) may call this — enforced inside
// acceptInvitation() by comparing professional_user_id, not trusted from
// the URL alone.
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { acceptInvitation } from '@/lib/services/professional-access/access';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const result = await acceptInvitation(id, user.id);
  if (!result.ok) return bad(result.error ?? 'Failed to accept invitation.');
  return ok({ accepted: true });
}
