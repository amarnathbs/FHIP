import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getSpendingBreakdown } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { parseActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';

// GET /api/financial-data-hub/activity/spending — FDH-8 spec 25-28. Approved
// expense only, grouped by R8 category master, percentage of categorised
// approved expense.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const { period, accountId, error } = parseActivityParams(url);
  if (error) return bad(error, 400);

  try {
    const breakdown = await getSpendingBreakdown(user.id, { period, accountId });
    return ok({ period, breakdown });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not load spending breakdown', 500);
  }
}
