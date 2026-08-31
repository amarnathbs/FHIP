import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { listTwinRuns, getTwinRunDetail } from '@/lib/services/financialTwinService';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const runs = await listTwinRuns(user.id);
  if (runs.length === 0) return ok(null);
  const detail = await getTwinRunDetail(user.id, runs[0].id);
  return ok(detail);
}
