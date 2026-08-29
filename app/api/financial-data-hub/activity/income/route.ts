import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getIncomeBreakdown } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { parseActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';

// GET /api/financial-data-hub/activity/income — FDH-8 spec 32-36. Approved
// economic INCOME only — never every credit (loan proceeds, refunds,
// transfer credits are excluded by construction, see analytics layer).
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const { period, accountId, error } = parseActivityParams(url);
  if (error) return bad(error, 400);

  try {
    const breakdown = await getIncomeBreakdown(user.id, { period, accountId });
    return ok({ period, breakdown });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not load income breakdown', 500);
  }
}
