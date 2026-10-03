import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { canViewPremiumReport } from '@/lib/services/entitlements';
import { FUND_ANALYTICS_PREMIUM_MESSAGE, getFundAnalyticsReport } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';

// One pinned Fund analytics report. Premium only (explicit 403). RLS AND an explicit user filter scope it to the caller:
// another user's id is a 404, indistinguishable from an id that does not exist.
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad('The report was not found.', 404);
  const supabase = await createClient();
  if (!(await canViewPremiumReport(user.id, supabase))) return bad(FUND_ANALYTICS_PREMIUM_MESSAGE, 403);
  const found = await getFundAnalyticsReport(supabase, user.id, id);
  if (!found) return bad('The report was not found.', 404);
  return Response.json({ data: { summary: found.summary, report: found.report, manifestChecksum: found.manifestChecksum } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
