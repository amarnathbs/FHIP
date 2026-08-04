import { requireUser, ok } from '@/lib/api';
import { listTwinRuns } from '@/lib/services/financialTwinService';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const runs = await listTwinRuns(user.id);
  return ok(runs);
}
