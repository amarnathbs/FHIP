import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { listReports } from '@/lib/services/reportsData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const reports = await listReports(user.id);
    return ok(reports);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load reports');
  }
}
