import { requireUser, bad, ok } from '@/lib/api';
import { getOverview } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { parseActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';

// GET /api/financial-data-hub/activity/overview?period=this_month|last_month|3_months|6_months|12_months|year_to_date|custom&from=&to=&account_id=
// FDH-8 spec 14. `approved` and `pending` are always two separate fields —
// see lib/financial-data-hub/analytics/financialActivityAnalytics.ts header.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const { period, accountId, error } = parseActivityParams(url);
  if (error) return bad(error, 400);

  try {
    const overview = await getOverview(user.id, { period, accountId });
    return ok(overview);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not load overview', 500);
  }
}
