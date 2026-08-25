// Client revokes their own delegated relationship (spec section 66,
// mandatory hard requirement). Only the owning client may call this —
// enforced inside revokeRelationship() by comparing client_user_id.
import { requireUser, ok, bad } from '@/lib/api';
import { revokeRelationship } from '@/lib/services/professional-access/access';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const result = await revokeRelationship(id, user.id);
  if (!result.ok) return bad(result.error ?? 'Failed to revoke relationship.');
  return ok({ revoked: true });
}
