import { requireUser, bad, ok } from '@/lib/api';
import { getRecurring } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';

// GET /api/financial-data-hub/activity/recurring — FDH-8 spec 37-40.
// Read-only over FDH-6/R8's fdh_recurring_transactions; no detection here.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const recurring = await getRecurring(user.id);
    return ok({ recurring });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not load recurring activity', 500);
  }
}
