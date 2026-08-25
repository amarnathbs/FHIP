import { requireUser, bad, ok } from '@/lib/api';
import { getMerchants } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { parseActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';

// GET /api/financial-data-hub/activity/merchants?limit= — FDH-8 spec 29-31.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const { period, accountId, error } = parseActivityParams(url);
  if (error) return bad(error, 400);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(1, Number(limitParam)), 200) : 20;

  try {
    const merchants = await getMerchants(user.id, { period, accountId }, { limit });
    return ok({ period, merchants });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not load merchants', 500);
  }
}
