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

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const VARIANCE_CATEGORIES: VarianceForecastCategory[] = ['net_worth', 'retirement', 'goal', 'debt', 'cross_border'];

export interface ForecastReportData {
  generatedAt: string;
  comparisonDate: string;
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

export async function buildForecastReportData(userId: string, requestedScenarioId: string | undefined, client?: SupabaseServerClient): Promise<ForecastReportData> {
  const supabase = client ?? (await createClient());
  const [dashboard, { profile, activeScenario }] = await Promise.all([
    loadDashboard(userId, supabase),
    resolveForecastPageContext(userId, requestedScenarioId, supabase),
  ]);
  const scenarioId = activeScenario.id;

  const [variances, netWorthRun, retirementRun, goalRun, debtRun, investmentRun, crossBorderRun, resilienceRun, scenarioComparison, assumptions] = await Promise.all([
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
  ]);

  return {
    generatedAt: new Date().toISOString(),
    comparisonDate: new Date().toISOString().slice(0, 10),
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
  };
}

