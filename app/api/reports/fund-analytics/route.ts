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
// TIME LIMIT. Production runs on AWS Amplify compute, which kills EVERY request at 28 s whatever a route declares ("Request timed out - your
// application took too long to respond", Duration 28003 ms in CloudWatch; lib/services/investment-intelligence/pc6/ingestBudget.ts and
// docs/nav1/po_run_2026-09-29_hydration_incident/README.md). 28 is therefore the longest value the platform honours; a larger one (the other
// routes declare 60 and 300) is not honoured. Generating a report is the fund engine plus the price reads: about 0.6 to 0.9 s of engine time per
// fund on the development machine (10 funds 10.7 s, 20 funds 18 s, 25 funds 14.5 to 17 s, 40 funds 35 s), so the limit is reached at roughly 30
// funds before any database time. See docs/nav2/NAV2_STAGE3_CERTIFICATION_REPORT.md (limits met by the 25-fund test) for the recommendation.
export const maxDuration = 28;

// `funds` = the instrument ids to cover, for a person who holds more funds than one report covers (the service refuses an empty, repeated, over-long or foreign choice with one message)
const generateBody = z.object({ period: z.enum(REPORT_PERIOD_CHOICES as unknown as [string, ...string[]]).optional(), funds: z.array(z.string().uuid()).max(200).optional() }).strict();

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
  // AUTHORISATION BEFORE VALIDATION: a free user gets the plain 403 for any body, never a 422 that confirms what the endpoint accepts.
  const supabase = await createClient();
  if (!(await canViewPremiumReport(user.id, supabase))) return bad(FUND_ANALYTICS_PREMIUM_MESSAGE, 403);
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
    const result = await generateFundAnalyticsReport({ userId: user.id, sessionClient: supabase, adminClient: createAdminClient(), periodChoice: parsed.data.period, fundIds: parsed.data.funds ?? null });
    switch (result.status) {
      case 'disabled':
        return bad(result.message, 404);
      case 'forbidden':
        return bad(result.message, 403);
      case 'preparing':
        return Response.json({ data: { status: 'preparing', message: result.message, ...result.waiting } }, { status: 202 });
      case 'no_funds':
        return ok({ status: 'no_funds', message: result.message });
      case 'select_funds':
        // 409: the report was not made because a choice is needed; `error` carries the plain message, `data` the funds to choose from
        return Response.json({ error: result.message, data: { status: 'select_funds', message: result.message, max: result.max, heldFundCount: result.heldFundCount, candidates: result.candidates, suggestedIds: result.suggestedIds } }, { status: 409 });
      case 'invalid_selection':
        return bad(result.message, 422);
      case 'in_steps':
        return Response.json(
          { data: { status: 'in_steps', message: result.message, headline: result.message, loaded: result.ready, total: result.total, waitingFunds: [], unavailableFunds: [], retryAfterSeconds: result.retryAfterSeconds } },
          { status: 202, headers: { 'Retry-After': String(result.retryAfterSeconds) } }
        );
      case 'ready':
        return Response.json({ data: { status: 'ready', report: result.report } }, { status: 201 });
    }
  } catch (e) {
    console.error('[fund-analytics] generate failed', e instanceof Error ? e.message : e);
    return bad('The report could not be generated. Please try again.', 500);
  }
}
