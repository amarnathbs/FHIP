// Assembles the Consolidated Forecasting Report's data. Deliberately does
// NO new calculation here — every figure comes from an existing, already
// live-tested Forecasting Engine service (variance tracking, the per-type
// calculators via runForecast, scenario comparison, resolved assumptions).
// This keeps the report a pure aggregation layer, matching the spec's
// "use deterministic calculations from the Forecasting Engine" requirement
// and this project's engines/services split.
import { createClient } from '@/lib/supabase/server';
import { loadDashboard } from '@/lib/services/dashboardData';
import {
  resolveForecastPageContext,
  getForecastVariance,
  runForecast,
  getForecastRunDetail,
  compareNetWorthAcrossScenarios,
  getResolvedAssumptions,
  type VarianceForecastCategory,
  type CategoryVariance,
  type ScenarioNetWorthComparison,
} from '@/lib/services/forecastData';
import type { DashboardSummary } from '@/lib/engines/dashboard';
import type { ResolvedAssumptionSet } from '@/lib/engines/forecast/types';
import { buildForecastReportActionMatches, type ReportActionItem } from '@/lib/services/recommendationsData';

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const VARIANCE_CATEGORIES: VarianceForecastCategory[] = ['net_worth', 'retirement', 'goal', 'debt', 'cross_border'];

export interface ForecastReportData {
  generatedAt: string;
  comparisonDate: string;
  // The date financial_snapshots data was actually current as of, when a
  // snapshot backed the comparison (see getForecastVariance) — distinct
  // from generatedAt (when this PDF/page was built) and distinct from
  // comparisonDate (the date being compared to, which normally becomes the
  // snapshot date, but can fall back to "today" when no snapshot exists).
  dataLastUpdated: string | null;
  currency: 'AUD' | 'INR';
  scenarioName: string;
  scenarioId: string;
  dashboard: DashboardSummary;
  variances: CategoryVariance[];
  netWorthRun: Awaited<ReturnType<typeof getForecastRunDetail>> | null;
  retirementRun: Awaited<ReturnType<typeof getForecastRunDetail>> | null;
  goalRun: Awaited<ReturnType<typeof getForecastRunDetail>> | null;
  debtRun: Awaited<ReturnType<typeof getForecastRunDetail>> | null;
  investmentRun: Awaited<ReturnType<typeof getForecastRunDetail>> | null;
  crossBorderRun: Awaited<ReturnType<typeof getForecastRunDetail>> | null;
  resilienceRun: Awaited<ReturnType<typeof getForecastRunDetail>> | null;
  scenarioComparison: ScenarioNetWorthComparison[];
  assumptions: ResolvedAssumptionSet;
  // FHIP-FC-REC-001/002 — up to 5 ranked, non-conflicting recommendations
  // sourced from the real recommendation engine (previously missing entirely).
  actionPlan: ReportActionItem[];
}

async function safeRunDetail(
  userId: string,
  params: Parameters<typeof runForecast>[1],
  supabase: SupabaseServerClient
): Promise<Awaited<ReturnType<typeof getForecastRunDetail>> | null> {
  try {
    const { run } = await runForecast(userId, params, supabase);
    if (run.status !== 'completed') return null;
    return await getForecastRunDetail(userId, run.id, supabase);
  } catch {
    // A category with no relevant data (e.g. no active liabilities) may
    // still compute successfully with empty results — genuine failures
    // (validation errors etc.) are treated as "not available" for report
    // purposes rather than aborting the whole report.
    return null;
  }
}

// For the headless PDF renderer's print route
// (app/(app)/forecast/report/print), which has no user session to
// authenticate with — authorizes via a short-lived single-use render_token
// instead (see lib/services/forecastReportPdfRenderer.ts), the same pattern
// as reportsData.ts's getReportByRenderToken for the Free/Premium report.
export async function resolveForecastReportRenderToken(token: string): Promise<{ userId: string; scenarioId: string | null } | null> {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();
  const { data } = await admin.from('forecast_report_render_tokens').select('user_id, scenario_id, expires_at').eq('token', token).maybeSingle();
  if (!data) return null;
  if (!data.expires_at || new Date(data.expires_at as string) < new Date()) return null;
  return { userId: data.user_id as string, scenarioId: (data.scenario_id as string | null) ?? null };
}

export async function buildForecastReportData(userId: string, requestedScenarioId: string | undefined, client?: SupabaseServerClient): Promise<ForecastReportData> {
  const supabase = client ?? (await createClient());
  const [dashboard, { profile, activeScenario }] = await Promise.all([
    loadDashboard(userId, supabase),
    resolveForecastPageContext(userId, requestedScenarioId, supabase),
  ]);
  const scenarioId = activeScenario.id;

  const [variances, netWorthRun, retirementRun, goalRun, debtRun, investmentRun, crossBorderRun, resilienceRun, scenarioComparison, assumptions, actionPlan] =
    await Promise.all([
      Promise.all(VARIANCE_CATEGORIES.map((c) => getForecastVariance(userId, profile.id, scenarioId, c, undefined, supabase))),
      safeRunDetail(userId, { scenarioId, forecastType: 'net_worth' }, supabase),
      safeRunDetail(
        userId,
        { scenarioId, forecastType: 'retirement', retirementTargetMethod: 'desired_income', retirementDesiredAnnualIncome: Math.max(1, dashboard.essentialMonthlyExpenses * 12) },
        supabase
      ),
      safeRunDetail(userId, { scenarioId, forecastType: 'goal' }, supabase),
      safeRunDetail(userId, { scenarioId, forecastType: 'debt' }, supabase),
      safeRunDetail(userId, { scenarioId, forecastType: 'investment' }, supabase),
      safeRunDetail(userId, { scenarioId, forecastType: 'cross_border' }, supabase),
      safeRunDetail(userId, { scenarioId, forecastType: 'resilience' }, supabase),
      compareNetWorthAcrossScenarios(userId, profile.id, supabase),
      getResolvedAssumptions(userId, profile.id, scenarioId, supabase),
      buildForecastReportActionMatches(userId, requestedScenarioId, supabase).catch(() => []),
    ]);

  // All 5 categories are resolved against the same requested date
  // (undefined -> today) inside getForecastVariance, so they agree on the
  // same grounded comparison date — net_worth is first in
  // VARIANCE_CATEGORIES and, being the category most likely to have a
  // financial_snapshots row backing it, is the most reliable one to read
  // this from, but any category's variances[i].comparisonDate would match.
  const resolvedComparisonDate = variances[0]?.comparisonDate ?? new Date().toISOString().slice(0, 10);
  const dataLastUpdated = variances.find((v) => v.dataLastUpdated !== null)?.dataLastUpdated ?? null;

  return {
    generatedAt: new Date().toISOString(),
    comparisonDate: resolvedComparisonDate,
    dataLastUpdated,
    currency: dashboard.currency,
    scenarioName: activeScenario.scenario_name,
    scenarioId,
    dashboard,
    variances,
    netWorthRun,
    retirementRun,
    goalRun,
    debtRun,
    investmentRun,
    crossBorderRun,
    resilienceRun,
    scenarioComparison,
    assumptions,
    actionPlan,
  };
}

