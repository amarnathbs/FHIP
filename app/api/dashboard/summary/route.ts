import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadDashboard } from '@/lib/services/dashboardData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const summary = await loadDashboard(user.id);
    return ok(summary);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load dashboard');
  }
}
