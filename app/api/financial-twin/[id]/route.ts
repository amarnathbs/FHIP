import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { getTwinRunDetail } from '@/lib/services/financialTwinService';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const detail = await getTwinRunDetail(user.id, id);
  if (!detail) return bad('Financial Twin run not found', 404);
  return ok(detail);
}
