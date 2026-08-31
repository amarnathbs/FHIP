import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { getReport } from '@/lib/services/reportsData';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const result = await getReport(user.id, id);
  if (!result) return bad('Report not found', 404);
  return ok(result.sections);
}
