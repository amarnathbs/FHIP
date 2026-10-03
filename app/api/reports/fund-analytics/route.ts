import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { canViewPremiumReport } from '@/lib/services/entitlements';
import { REPORT_PERIOD_CHOICES } from '@/lib/engines/nav2/analysisSpec';
import { FUND_ANALYTICS_PREMIUM_MESSAGE, generateFundAnalyticsReport, listFundAnalyticsReports } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';

// The Fund analytics report (NAV2) -- list the caller's pinned versions, or generate the next one.
//
// PREMIUM ONLY, explicit refusal: a free user gets a 403 with a plain sentence, never an empty list that could be read as "no
// reports yet" (Admin / Premium-route standard). The feature switch (job-control row nav2_fund_analytics, shipped OFF) answers
// 404 "not available yet" and does nothing else. A held price-history gate answers 202 with the shared waiting body.
// The caller is always the authenticated, country-confirmed session user; nothing user-identifying is read from the body.
export const dynamic = 'force-dynamic';

const generateBody = z.object({ period: z.enum(REPORT_PERIOD_CHOICES as unknown as [string, ...string[]]).optional() }).strict();

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  if (!(await canViewPremiumReport(user.id, supabase))) return bad(FUND_ANALYTICS_PREMIUM_MESSAGE, 403);
  try {
    return ok(await listFundAnalyticsReports(supabase, user.id));
  } catch {
    return bad('Could not load your reports.', 500);
  }
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  let json: unknown = {};
  try {
    const text = await req.text();
    json = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return bad('The request body is not valid JSON.', 400);
  }
  const parsed = generateBody.safeParse(json);
  if (!parsed.success) return badValidation(parsed.error);

  try {
    const supabase = await createClient();
    const result = await generateFundAnalyticsReport({ userId: user.id, sessionClient: supabase, adminClient: createAdminClient(), periodChoice: parsed.data.period });
    switch (result.status) {
      case 'disabled':
        return bad(result.message, 404);
      case 'forbidden':
        return bad(result.message, 403);
      case 'preparing':
        return Response.json({ data: { status: 'preparing', message: result.message, ...result.waiting } }, { status: 202 });
      case 'no_funds':
        return ok({ status: 'no_funds', message: result.message });
      case 'ready':
        return Response.json({ data: { status: 'ready', report: result.report } }, { status: 201 });
    }
  } catch (e) {
    console.error('[fund-analytics] generate failed', e instanceof Error ? e.message : e);
    return bad('The report could not be generated. Please try again.', 500);
  }
}
