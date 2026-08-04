// I/O layer for the Recommendations Engine (Module 10, Phase 8). Builds a
// deterministic per-category "signal" (forecast_category, recommendation_signal,
// forecast_status, variance_result) from data already computed elsewhere
// (dashboard.ts, forecastData.ts's variance tracking) and matches it against
// the recommendation library. Coverage today: the category-wide variance
// signal for 6 forecast-run categories (net_worth, retirement, goal, debt,
// cross_border, investment_growth — each category's own recommendation_signal
// name, e.g. "retirement_gap" not "overall_variance"; see CATEGORY_TO_SIGNAL,
// verified against the actual imported condition rows rather than assumed)
// plus a resilience heuristic ("emergency_fund_low") derived from
// dashboard.emergencyFundMonths — the ~500 finer-grained sub_category
// signals in the supplied library (arrears, rate_shock, allocation_drift,
// etc.) remain imported and admin-editable but dormant until each gets its
// own detector, since fabricating a match without real underlying logic
// would violate this app's deterministic-accuracy principle.
import { createClient } from '@/lib/supabase/server';
import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveForecastPageContext, getForecastVariance, type VarianceForecastCategory, type VarianceStatus } from '@/lib/services/forecastData';
import { matchRecommendations } from '@/lib/engines/recommendations/matcher';
import type {
  EvaluationContext,
  RecommendationMatch,
  RecommendationWithConditions,
  RecommendationCondition,
  RecommendationMasterRow,
  ForecastCategory,
  ForecastStatus,
} from '@/lib/engines/recommendations/types';

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;
type DashboardSummary = Awaited<ReturnType<typeof loadDashboard>>;

const VARIANCE_CATEGORIES: VarianceForecastCategory[] = ['net_worth', 'retirement', 'goal', 'debt', 'cross_border', 'investment'];

const CATEGORY_TO_LIBRARY: Record<VarianceForecastCategory, ForecastCategory> = {
  net_worth: 'net_worth',
  retirement: 'retirement',
  goal: 'goal',
  debt: 'debt',
  cross_border: 'cross_border',
  investment: 'investment_growth',
};

// The library's recommendation_signal values for each category's overall
// variance are NOT uniformly named "overall_variance" — only net_worth uses
// that bare name; the others are category-prefixed (or, for retirement, a
// different concept name entirely: "retirement_gap", not
// "retirement_overall_variance"). Verified directly against the imported
// condition rows rather than assumed.
const CATEGORY_TO_SIGNAL: Record<VarianceForecastCategory, string> = {
  net_worth: 'overall_variance',
  retirement: 'retirement_gap',
  goal: 'goal_overall_variance',
  debt: 'debt_overall_variance',
  cross_border: 'cross_border_overall_variance',
  investment: 'investment_overall_variance',
};

// The library's forecast_status vocabulary has no "significantly_ahead" tier
// distinct from "ahead_of_plan" (a genuinely different recommendation isn't
// needed for "ahead" vs "significantly ahead" — the action is the same:
// maintain course) — fold it in rather than leaving those users unmatched.
function toLibraryStatus(status: VarianceStatus): ForecastStatus | null {
  if (status === 'insufficient_data') return null;
  if (status === 'significantly_ahead') return 'ahead_of_plan';
  return status;
}

// Resilience has no single "original forecast run" to compare against the
// way the other 6 categories do — its signal is instead derived directly
// from dashboard.emergencyFundMonths, the same real, already-computed field
// (and the same 6-month/3-month bands) used by the health-score/resilience
// engines elsewhere in this app.
function resilienceSignal(dashboard: DashboardSummary): { status: ForecastStatus; result: 'favourable' | 'unfavourable' | 'neutral' } | null {
  const months = dashboard.emergencyFundMonths;
  if (months === null) return null;
  // Status/result pairing verified against the actual RES_EMERGENCY_FUND_LOW_*
  // condition rows — slightly_behind pairs with unfavourable there, not neutral.
  if (months >= 6) return { status: 'ahead_of_plan', result: 'favourable' };
  if (months >= 3) return { status: 'slightly_behind', result: 'unfavourable' };
  return { status: 'at_risk', result: 'unfavourable' };
}

export async function buildCategorySignals(
  userId: string,
  requestedScenarioId: string | undefined,
  client?: SupabaseServerClient
): Promise<{ signals: EvaluationContext[]; profileId: string; scenarioId: string }> {
  const supabase = client ?? (await createClient());
  const [dashboard, { profile, activeScenario }] = await Promise.all([
    loadDashboard(userId, supabase),
    resolveForecastPageContext(userId, requestedScenarioId, supabase),
  ]);
  const scenarioId = activeScenario.id;
  const countryCode = profile.country_code ?? null;

  const variances = await Promise.all(VARIANCE_CATEGORIES.map((c) => getForecastVariance(userId, profile.id, scenarioId, c, undefined, supabase)));

  const signals: EvaluationContext[] = [];
  variances.forEach((v, i) => {
    const libraryStatus = toLibraryStatus(v.status);
    if (libraryStatus === null) return; // no baseline forecast yet for this category — nothing to recommend against
    signals.push({
      forecast_category: CATEGORY_TO_LIBRARY[VARIANCE_CATEGORIES[i]],
      recommendation_signal: CATEGORY_TO_SIGNAL[VARIANCE_CATEGORIES[i]],
      forecast_status: libraryStatus,
      variance_result: v.result,
      country_code: countryCode,
      variance_amount: v.varianceAmount,
      variance_percentage: v.variancePercentage,
      actual_till_date: v.actualTillDate,
      forecast_till_date: v.forecastTillDate,
      revised_forecast_value: v.revisedForecast,
      estimated_future_impact: v.varianceAmount,
      monthly_surplus: dashboard.monthlySurplus,
    });
  });

  const resilience = resilienceSignal(dashboard);
  if (resilience) {
    signals.push({
      forecast_category: 'resilience',
      // Resilience has no generic "overall_variance" concept in the
      // library at all — "emergency_fund_low" is the closest real signal,
      // covering all 5 status/result combinations including the favourable
      // ones (verified against the imported condition rows).
      recommendation_signal: 'emergency_fund_low',
      forecast_status: resilience.status,
      variance_result: resilience.result,
      country_code: countryCode,
      emergency_fund_months: dashboard.emergencyFundMonths,
      monthly_surplus: dashboard.monthlySurplus,
    });
  }

  return { signals, profileId: profile.id, scenarioId };
}

function mapMasterRow(row: Record<string, unknown>): RecommendationMasterRow {
  return {
    id: row.id as string,
    recommendationCode: row.recommendation_code as string,
    forecastCategory: row.forecast_category as ForecastCategory,
    subCategory: row.sub_category as string,
    scenarioName: row.scenario_name as string,
    scenarioDescription: (row.scenario_description as string) ?? null,
    varianceResult: (row.variance_result as RecommendationMasterRow['varianceResult']) ?? null,
    forecastStatus: row.forecast_status as ForecastStatus,
    severity: row.severity as RecommendationMasterRow['severity'],
    actionType: row.action_type as string,
    actionTitleTemplate: row.action_title_template as string,
    actionContentTemplate: row.action_content_template as string,
    financialImpactTemplate: (row.financial_impact_template as string) ?? null,
    calculationMethodCode: (row.calculation_method_code as string) ?? null,
    priorityScore: row.priority_score as number,
    countryCode: (row.country_code as string) ?? null,
    currencyCode: (row.currency_code as string) ?? null,
    isPremium: Boolean(row.is_premium),
    isActive: Boolean(row.is_active),
    includeInForecasting: Boolean(row.include_in_forecasting),
    includeInMonthlyReport: Boolean(row.include_in_monthly_report),
  };
}

// Supabase/PostgREST caps a plain .select() at 1000 rows — with 2143
// condition rows, an unpaginated fetch would silently return only the
// first 1000, leaving roughly half the library with zero conditions
// loaded. Since an empty conditions array is treated as "always matches"
// (a recommendation with no gating conditions), that silent truncation
// would make hundreds of unrelated codes match everyone. Page through both
// tables explicitly (master is under 1000 rows today, but paginate it too
// so this doesn't quietly break again once the library grows).
const PAGE_SIZE = 1000;

async function fetchAllMasterRows(client: SupabaseServerClient): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('action_recommendation_master')
      .select('*')
      .eq('is_active', true)
      .eq('include_in_forecasting', true)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}

interface RawConditionRow {
  id: string;
  recommendation_code: string;
  condition_group: number;
  field_name: string;
  operator: string;
  comparison_value: string | null;
  logical_operator: string;
  evaluation_order: number;
}

async function fetchAllConditionRows(client: SupabaseServerClient): Promise<RawConditionRow[]> {
  const all: RawConditionRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client.from('action_recommendation_conditions').select('*').eq('is_active', true).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as RawConditionRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}

async function loadActiveLibrary(client: SupabaseServerClient): Promise<RecommendationWithConditions[]> {
  const [masterRows, conditionRows] = await Promise.all([fetchAllMasterRows(client), fetchAllConditionRows(client)]);

  const conditionsByCode = new Map<string, RecommendationCondition[]>();
  for (const row of conditionRows) {
    const list = conditionsByCode.get(row.recommendation_code) ?? [];
    list.push({
      id: row.id,
      conditionGroup: row.condition_group,
      fieldName: row.field_name,
      operator: row.operator as RecommendationCondition['operator'],
      comparisonValue: row.comparison_value,
      logicalOperator: row.logical_operator,
      evaluationOrder: row.evaluation_order,
    });
    conditionsByCode.set(row.recommendation_code, list);
  }

  return masterRows.map((row) => ({
    ...mapMasterRow(row),
    conditions: conditionsByCode.get(row.recommendation_code as string) ?? [],
  }));
}

export interface RecommendationRunResult {
  runId: string;
  matches: RecommendationMatch[];
}

export async function runRecommendationEvaluation(
  userId: string,
  requestedScenarioId: string | undefined,
  client?: SupabaseServerClient
): Promise<RecommendationRunResult> {
  const supabase = client ?? (await createClient());
  const [{ signals, profileId, scenarioId }, library] = await Promise.all([
    buildCategorySignals(userId, requestedScenarioId, supabase),
    loadActiveLibrary(supabase),
  ]);

  const seen = new Set<string>();
  const matches: RecommendationMatch[] = [];
  for (const signal of signals) {
    for (const m of matchRecommendations(signal, library)) {
      if (seen.has(m.recommendation.id)) continue;
      seen.add(m.recommendation.id);
      matches.push(m);
    }
  }
  matches.sort((a, b) => b.recommendation.priorityScore - a.recommendation.priorityScore);

  const { data: run, error: runError } = await supabase
    .from('user_recommendation_runs')
    .insert({
      user_id: userId,
      forecast_profile_id: profileId,
      scenario_id: scenarioId,
      matched_count: matches.length,
      context_snapshot: { signals },
    })
    .select('*')
    .single();
  if (runError) throw new Error(runError.message);

  if (matches.length > 0) {
    const { error: matchError } = await supabase.from('user_recommendation_matches').insert(
      matches.map((m) => ({
        user_id: userId,
        run_id: run.id,
        recommendation_id: m.recommendation.id,
        evaluated_impact_text: m.evaluatedImpactText,
        evaluated_impact_value: m.evaluatedImpactValue,
      }))
    );
    if (matchError) throw new Error(matchError.message);
  }

  return { runId: run.id, matches };
}

export interface StoredRecommendationMatch {
  id: string;
  recommendation: RecommendationMasterRow;
  evaluatedImpactText: string | null;
  evaluatedImpactValue: number | null;
  dismissed: boolean;
}

export async function getLatestRecommendations(userId: string, client?: SupabaseServerClient): Promise<StoredRecommendationMatch[]> {
  const supabase = client ?? (await createClient());
  const { data: latestRun } = await supabase
    .from('user_recommendation_runs')
    .select('id')
    .eq('user_id', userId)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRun) return [];

  const { data, error } = await supabase
    .from('user_recommendation_matches')
    .select('*, action_recommendation_master(*)')
    .eq('run_id', latestRun.id)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((row) => row.action_recommendation_master)
    .map((row) => ({
      id: row.id,
      recommendation: mapMasterRow(row.action_recommendation_master),
      evaluatedImpactText: row.evaluated_impact_text,
      evaluatedImpactValue: row.evaluated_impact_value,
      dismissed: row.dismissed,
    }))
    .sort((a, b) => b.recommendation.priorityScore - a.recommendation.priorityScore);
}

export async function dismissRecommendationMatch(userId: string, matchId: string, client?: SupabaseServerClient): Promise<void> {
  const supabase = client ?? (await createClient());
  const { error } = await supabase
    .from('user_recommendation_matches')
    .update({ dismissed: true, dismissed_at: new Date().toISOString() })
    .eq('id', matchId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}
