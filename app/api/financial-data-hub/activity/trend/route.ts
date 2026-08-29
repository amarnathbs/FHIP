import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getTrend } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { parseActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';

// GET /api/financial-data-hub/activity/trend — FDH-8 spec 50-53. Monthly
// historical actuals only, per currency. No forecasting.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const { period, accountId, error } = parseActivityParams(url);
  if (error) return bad(error, 400);

  try {
    const trend = await getTrend(user.id, { period, accountId });
    return ok({ period, trend });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not load trend', 500);
  }
}
