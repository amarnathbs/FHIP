import { createClient } from '@/lib/supabase/server';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { loadDashboard, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { buildResilienceInput } from '@/lib/services/resilienceData';
import { computeResilience } from '@/lib/engines/resilience';
import { computeGoalAffordability, type AffordabilityResult } from '@/lib/engines/goalAffordability';
import {
  computeAllScenarios,
  MODEL_VERSION,
  type GoalRecord,
  type GoalExtras,
  type GoalPlanningConfig,
  type CategoryForecastResult,
  type ScenarioCode,
} from '@/lib/engines/goalForecast';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

const ASSUMPTION_SET_ID = 'goals-1.0.0-default';

export interface GoalTypeRef {
  type_key: string;
  category: string;
  type_label: string;
  forecast_logic_key: string;
  default_priority: number;
  default_importance_type: string;
  default_inflation_category: string;
}

export interface GoalMilestoneRow {
  id: string;
  milestone_name: string;
  target_amount: number;
  target_date: string | null;
  display_order: number;
  status: string;
  achieved_at: string | null;
}

export interface GoalFundingSourceRow {
  id: string;
  source_type: string;
  linked_asset_id: string | null;
  linked_investment_id: string | null;
  allocated_amount: number;
  allocation_percentage: number | null;
  currency_code: string | null;
}

export interface GoalPayload {
  id: string;
  goalName: string;
  goalType: string;
  goalCategory: string | null;
  forecastLogicKey: string;
  description: string | null;
  status: string;
  ownerMemberId: string | null;
  beneficiaryMemberId: string | null;
  countryCode: string | null;
  currencyCode: 'AUD' | 'INR';
  userPriority: number;
  importanceType: string;
  targetAmount: number;
  targetDate: string | null;
  targetDateFlexibility: string;
  currentAmount: number;
  plannedContributionAmount: number;
  contributionFrequency: string;
  annualContributionGrowthPct: number;
  inflationAdjusted: boolean;
  nextReviewDate: string | null;
  forecasts: Record<ScenarioCode, CategoryForecastResult>;
  milestones: GoalMilestoneRow[];
  fundingSources: GoalFundingSourceRow[];
}

export interface GoalSummary {
  activeGoalsCount: number;
  totalTargetAmount: number;
  totalCurrentAmount: number;
  overallProgressPct: number;
  totalMonthlyContribution: number;
  onTrackCount: number;
  atRiskCount: number;
  offTrackCount: number;
  achievedCount: number;
  nextGoalDue: { goalId: string; goalName: string; targetDate: string } | null;
}

export interface GoalsPagePayload {
  goals: GoalPayload[];
  summary: GoalSummary;
  affordability: AffordabilityResult;
  modelVersion: string;
  goalTypes: GoalTypeRef[];
}

export async function loadGoalPlanningConfig(client?: SupabaseServerClient): Promise<GoalPlanningConfig> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase.from('goal_planning_config').select('config').eq('is_active', true).single();
  return data?.config as GoalPlanningConfig;
}

async function loadGoalTypes(client?: SupabaseServerClient): Promise<GoalTypeRef[]> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('goal_types')
    .select('type_key, category, type_label, forecast_logic_key, default_priority, default_importance_type, default_inflation_category')
    .eq('is_active', true)
    .order('sort_order');
  return (data ?? []) as GoalTypeRef[];
}

// Sums a goal's overallocation-checked funding sources into a display list —
// the funded amount itself lives on user_goals.current_amount (kept in sync
// transactionally by the contributions API), so sources are informational
// plus the basis for the double-counting check, not summed on top of it.
async function loadFundingSourcesByGoal(
  userId: string,
  goalIds: string[],
  client?: SupabaseServerClient
): Promise<Map<string, GoalFundingSourceRow[]>> {
  const map = new Map<string, GoalFundingSourceRow[]>();
  if (goalIds.length === 0) return map;
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('goal_funding_sources')
    .select('id, goal_id, source_type, linked_asset_id, linked_investment_id, allocated_amount, allocation_percentage, currency_code')
    .eq('user_id', userId)
    .eq('is_active', true)
    .in('goal_id', goalIds);
  for (const row of data ?? []) {
    const list = map.get(row.goal_id) ?? [];
    list.push(row as GoalFundingSourceRow);
    map.set(row.goal_id, list);
  }
  return map;
}

async function loadMilestonesByGoal(
  userId: string,
  goalIds: string[],
  client?: SupabaseServerClient
): Promise<Map<string, GoalMilestoneRow[]>> {
  const map = new Map<string, GoalMilestoneRow[]>();
  if (goalIds.length === 0) return map;
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('goal_milestones')
    .select('id, goal_id, milestone_name, target_amount, target_date, display_order, status, achieved_at')
    .eq('user_id', userId)
    .in('goal_id', goalIds)
    .order('display_order');
  for (const row of data ?? []) {
    const list = map.get(row.goal_id) ?? [];
    list.push(row as GoalMilestoneRow);
    map.set(row.goal_id, list);
  }
  return map;
}

async function buildExtrasForGoal(
  userId: string,
  goalRow: Record<string, unknown>,
  dashboardEssentialExpenses: number,
  reportingCurrencyCode: 'AUD' | 'INR',
  client?: SupabaseServerClient
): Promise<GoalExtras> {
  const extras: GoalExtras = { reportingCurrencyCode };
  const logicKey = goalRow.forecast_logic_key as string;
  if (logicKey === 'debt_payoff' && goalRow.linked_liability_id) {
    const supabase = client ?? (await createClient());
    const { data } = await supabase
      .from('liabilities')
      .select('balance, interest_rate, monthly_repayment')
      .eq('id', goalRow.linked_liability_id as string)
      .eq('user_id', userId)
      .maybeSingle();
    if (data) {
      extras.linkedLiability = {
        balance: data.balance as number,
        interestRate: data.interest_rate as number | null,
        monthlyRepayment: data.monthly_repayment as number,
      };
    }
  }
  if (logicKey === 'emergency_fund') {
    extras.essentialMonthlyExpenses = dashboardEssentialExpenses || null;
    extras.targetCoverageMonths = 6;
  }
  return extras;
}

function toGoalRecord(row: Record<string, unknown>): GoalRecord {
  return {
    targetAmount: Number(row.target_amount),
    targetAmountBasis: row.target_amount_basis as 'today_value' | 'future_value',
    currentAmount: Number(row.current_amount ?? 0),
    targetDate: (row.target_date as string) ?? null,
    plannedContributionAmount: toMonthly(Number(row.planned_contribution_amount ?? 0), row.contribution_frequency as Frequency),
    annualContributionGrowthPct: Number(row.annual_contribution_growth_pct ?? 0) / 100,
    inflationAdjusted: Boolean(row.inflation_adjusted),
    inflationCategory: (row.inflation_category as string) ?? 'general',
    currencyCode: row.currency_code as 'AUD' | 'INR',
    countryCode: (row.country_code as string) ?? null,
    forecastLogicKey: row.forecast_logic_key as string,
  };
}

export interface SingleGoalForecastInputs {
  goalRecord: GoalRecord;
  extras: GoalExtras;
  config: GoalPlanningConfig;
}

// Builds the inputs for one goal's forecast without persisting — used by the
// what-if scenario endpoint (never persisted, mirrors lib/engines/whatIf.ts).
export async function buildGoalForecastInputs(userId: string, goalId: string): Promise<SingleGoalForecastInputs | null> {
  const supabase = await createClient();
  const [goalRes, config, goalTypes, dashboard, profileRes] = await Promise.all([
    supabase.from('user_goals').select('*').eq('id', goalId).eq('user_id', userId).single(),
    loadGoalPlanningConfig(),
    loadGoalTypes(),
    loadDashboard(userId),
    supabase.from('user_profiles').select('preferred_currency').eq('user_id', userId).single(),
  ]);
  if (goalRes.error || !goalRes.data) return null;

  const goalTypeByKey = new Map(goalTypes.map((t) => [t.type_key, t]));
  const typeRef = goalTypeByKey.get(goalRes.data.goal_type as string);
  const row = { ...goalRes.data, forecast_logic_key: typeRef?.forecast_logic_key ?? 'generic' };
  const reportingCurrency = (profileRes.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const extras = await buildExtrasForGoal(userId, row, dashboard.essentialMonthlyExpenses, reportingCurrency);
  return { goalRecord: toGoalRecord(row), extras, config };
}

// Pure computation, no persistence — safe to call from anywhere that just
// needs to display goal data (e.g. the dashboard summary card) without
// writing a new goal_forecasts row on every view. loadGoalsPage below wraps
// this with the actual immutable-history persistence for the main Goals page.
export async function computeGoalsPagePayload(userId: string, client?: SupabaseServerClient): Promise<{
  payload: GoalsPagePayload;
  rawGoalsById: Map<string, Record<string, unknown>>;
  config: GoalPlanningConfig;
  reportingCurrency: 'AUD' | 'INR';
}> {
  const supabase = client ?? (await createClient());

  const [goalsRes, config, goalTypes, dashboard, resilienceInput, profileRes] = await Promise.all([
    supabase
      .from('user_goals')
      .select('*')
      .eq('user_id', userId)
      .not('status', 'in', '(archived,cancelled)'),
    loadGoalPlanningConfig(supabase),
    loadGoalTypes(supabase),
    loadDashboard(userId, supabase),
    buildResilienceInput(userId, supabase),
    supabase.from('user_profiles').select('preferred_currency').eq('user_id', userId).single(),
  ]);

  const reportingCurrency = (profileRes.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';
  const resilienceResult = resilienceInput.config ? computeResilience(resilienceInput) : null;
  const emergencyFundAtRisk = resilienceResult
    ? resilienceResult.components.find((c) => c.code === 'emergency_fund')?.rawScore !== null &&
      (resilienceResult.components.find((c) => c.code === 'emergency_fund')?.rawScore ?? 100) < 60
    : false;

  const goalTypeByKey = new Map(goalTypes.map((t) => [t.type_key, t]));
  const rawGoals = (goalsRes.data ?? []).map((row) => {
    const typeRef = goalTypeByKey.get(row.goal_type as string);
    return { ...row, forecast_logic_key: typeRef?.forecast_logic_key ?? 'generic' };
  });

  const goalIds = rawGoals.map((g) => g.id as string);
  const [fundingSourcesByGoal, milestonesByGoal] = await Promise.all([
    loadFundingSourcesByGoal(userId, goalIds, supabase),
    loadMilestonesByGoal(userId, goalIds, supabase),
  ]);

  const today = new Date();
  const goals: GoalPayload[] = [];
  for (const row of rawGoals) {
    const goalRecord = toGoalRecord(row);
    const extras = await buildExtrasForGoal(userId, row, dashboard.essentialMonthlyExpenses, reportingCurrency, supabase);
    const forecasts = computeAllScenarios(goalRecord, extras, config, today);

    goals.push({
      id: row.id as string,
      goalName: row.goal_name as string,
      goalType: row.goal_type as string,
      goalCategory: (row.goal_category as string) ?? null,
      forecastLogicKey: row.forecast_logic_key as string,
      description: (row.description as string) ?? null,
      status: row.status as string,
      ownerMemberId: (row.owner_member_id as string) ?? null,
      beneficiaryMemberId: (row.beneficiary_member_id as string) ?? null,
      countryCode: (row.country_code as string) ?? null,
      currencyCode: row.currency_code as 'AUD' | 'INR',
      userPriority: row.user_priority as number,
      importanceType: row.importance_type as string,
      targetAmount: Number(row.target_amount),
      targetDate: (row.target_date as string) ?? null,
      targetDateFlexibility: row.target_date_flexibility as string,
      currentAmount: Number(row.current_amount ?? 0),
      plannedContributionAmount: Number(row.planned_contribution_amount ?? 0),
      contributionFrequency: row.contribution_frequency as string,
      annualContributionGrowthPct: Number(row.annual_contribution_growth_pct ?? 0),
      inflationAdjusted: Boolean(row.inflation_adjusted),
      nextReviewDate: (row.next_review_date as string) ?? null,
      forecasts,
      milestones: milestonesByGoal.get(row.id as string) ?? [],
      fundingSources: fundingSourcesByGoal.get(row.id as string) ?? [],
    });
  }

  const activeGoals = goals.filter((g) => g.status === 'active');
  const totalTargetAmount = activeGoals.reduce((sum, g) => sum + g.forecasts.base.targetAmountFuture, 0);
  const totalCurrentAmount = activeGoals.reduce((sum, g) => sum + g.currentAmount, 0);
  const totalMonthlyContribution = activeGoals.reduce(
    (sum, g) => sum + toMonthly(g.plannedContributionAmount, g.contributionFrequency as Frequency),
    0
  );
  const onTrackCount = activeGoals.filter((g) => ['on_track', 'ahead_of_track'].includes(g.forecasts.base.trackStatus)).length;
  const atRiskCount = activeGoals.filter((g) => g.forecasts.base.trackStatus === 'at_risk').length;
  const offTrackCount = activeGoals.filter((g) => g.forecasts.base.trackStatus === 'off_track').length;
  const achievedCount = goals.filter((g) => g.status === 'achieved' || g.forecasts.base.trackStatus === 'fully_funded').length;

  const nextDue = activeGoals
    .filter((g) => g.targetDate)
    .sort((a, b) => (a.targetDate! < b.targetDate! ? -1 : 1))[0];

  const summary: GoalSummary = {
    activeGoalsCount: activeGoals.length,
    totalTargetAmount,
    totalCurrentAmount,
    overallProgressPct: totalTargetAmount > 0 ? (totalCurrentAmount / totalTargetAmount) * 100 : 0,
    totalMonthlyContribution,
    onTrackCount,
    atRiskCount,
    offTrackCount,
    achievedCount,
    nextGoalDue: nextDue ? { goalId: nextDue.id, goalName: nextDue.goalName, targetDate: nextDue.targetDate! } : null,
  };

  const affordability = computeGoalAffordability({
    monthlySurplus: dashboard.hasIncome && dashboard.hasExpenses ? dashboard.monthlySurplus : null,
    totalPlannedGoalContributions: totalMonthlyContribution,
    thresholds: config.affordabilityThresholds,
    emergencyFundAtRisk,
  });

  const payload: GoalsPagePayload = { goals, summary, affordability, modelVersion: MODEL_VERSION, goalTypes };
  const rawGoalsById = new Map(rawGoals.map((r) => [r.id as string, r]));
  return { payload, rawGoalsById, config, reportingCurrency };
}

// Computes fresh (via computeGoalsPagePayload) and persists an immutable
// base-scenario forecast row per goal for this run (Rule 10/11: never
// overwritten) plus this month's snapshot upsert. Call this only from the
// main Goals page — anything else that just needs to display goal data
// (e.g. the dashboard summary card) should call computeGoalsPagePayload
// directly to avoid writing a new history row on every view.
export async function loadGoalsPage(userId: string): Promise<GoalsPagePayload> {
  const supabase = await createClient();
  const { payload, rawGoalsById, config, reportingCurrency } = await computeGoalsPagePayload(userId);

  for (const goal of payload.goals) {
    if (goal.status !== 'active') continue;
    const base = goal.forecasts.base;
    await supabase.from('goal_forecasts').insert({
      goal_id: goal.id,
      user_id: userId,
      scenario_code: 'base',
      target_amount_original: base.targetAmountOriginal,
      target_amount_future: base.targetAmountFuture,
      current_amount: base.currentAmount,
      projected_target_date_value: base.projectedTargetDateValue,
      projected_completion_date: base.projectedCompletionDate,
      required_monthly_contribution: base.requiredMonthlyContribution,
      current_monthly_contribution: base.currentMonthlyContribution,
      funding_gap_at_target_date: base.fundingGapAtTargetDate,
      progress_pct: base.progressPct,
      forecast_funding_pct: base.forecastFundingPct,
      track_status: base.trackStatus,
      confidence_score: computeConfidence(goal, config),
      currency_code: goal.currencyCode,
      reporting_currency_code: reportingCurrency,
      assumption_set_id: ASSUMPTION_SET_ID,
      model_version: MODEL_VERSION,
      input_snapshot: { goal: toGoalRecord(rawGoalsById.get(goal.id)!) },
    });

    await supabase.from('goal_snapshots').upsert(
      {
        goal_id: goal.id,
        user_id: userId,
        snapshot_month: monthStart(),
        current_amount: goal.currentAmount,
        target_amount: base.targetAmountFuture,
        target_date: goal.targetDate,
        planned_contribution_amount: goal.plannedContributionAmount,
        progress_pct: base.progressPct,
        required_monthly_contribution: base.requiredMonthlyContribution,
        forecast_completion_date: base.projectedCompletionDate,
        track_status: base.trackStatus,
        confidence_score: computeConfidence(goal, config),
        model_version: MODEL_VERSION,
        assumption_set_id: ASSUMPTION_SET_ID,
        reporting_currency_equivalent: base.targetAmountFuture,
      },
      { onConflict: 'goal_id,snapshot_month' }
    );
  }

  return payload;
}

// Confidence per spec section 28 — how much of the calculation rests on
// verified vs. assumed inputs, kept separate from track status.
function computeConfidence(goal: GoalPayload, config: GoalPlanningConfig): number {
  const w = config.confidenceWeights;
  const targetAmountCompleteness = goal.targetAmount > 0 ? 100 : 0;
  const targetDateCertainty = goal.targetDate ? (goal.targetDateFlexibility === 'fixed' ? 100 : 60) : 20;
  const currentBalanceVerification = goal.fundingSources.length > 0 ? 100 : goal.currentAmount > 0 ? 60 : 40;
  const contributionHistory = goal.plannedContributionAmount > 0 ? 80 : 30;
  const linkedCashFlowData = 70; // uses the shared dashboard surplus, always available once income+expenses exist
  const assumptionReliability = 70; // fixed: config-driven, versioned assumptions
  const monthsOut = goal.targetDate ? Math.max(0, (new Date(goal.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30)) : 36;
  const timeHorizon = monthsOut <= 24 ? 90 : monthsOut <= 60 ? 70 : 50;
  const dataRecency = 90;
  const score =
    targetAmountCompleteness * w.targetAmountCompleteness +
    targetDateCertainty * w.targetDateCertainty +
    currentBalanceVerification * w.currentBalanceVerification +
    contributionHistory * w.contributionHistory +
    linkedCashFlowData * w.linkedCashFlowData +
    assumptionReliability * w.assumptionReliability +
    timeHorizon * w.timeHorizon +
    dataRecency * w.dataRecency;
  return Math.max(0, Math.min(100, score));
}

export interface GoalContributionRow {
  id: string;
  contribution_date: string;
  amount: number;
  currency_code: string;
  contribution_type: string;
  contribution_status: string;
  notes: string | null;
}

export interface GoalDetailPayload {
  goal: GoalPayload;
  contributions: GoalContributionRow[];
}

export async function loadGoalDetail(userId: string, goalId: string): Promise<GoalDetailPayload | null> {
  const supabase = await createClient();
  const inputs = await buildGoalForecastInputs(userId, goalId);
  if (!inputs) return null;

  const [goalRes, fundingSourcesRes, milestonesRes, contributionsRes] = await Promise.all([
    supabase.from('user_goals').select('*').eq('id', goalId).eq('user_id', userId).single(),
    supabase
      .from('goal_funding_sources')
      .select('id, source_type, linked_asset_id, linked_investment_id, allocated_amount, allocation_percentage, currency_code')
      .eq('goal_id', goalId)
      .eq('user_id', userId)
      .eq('is_active', true),
    supabase
      .from('goal_milestones')
      .select('id, milestone_name, target_amount, target_date, display_order, status, achieved_at')
      .eq('goal_id', goalId)
      .eq('user_id', userId)
      .order('display_order'),
    supabase
      .from('goal_contributions')
      .select('id, contribution_date, amount, currency_code, contribution_type, contribution_status, notes')
      .eq('goal_id', goalId)
      .eq('user_id', userId)
      .order('contribution_date', { ascending: false }),
  ]);
  if (goalRes.error || !goalRes.data) return null;
  const row = goalRes.data;

  const forecasts = computeAllScenarios(inputs.goalRecord, inputs.extras, inputs.config);

  const goal: GoalPayload = {
    id: row.id,
    goalName: row.goal_name,
    goalType: row.goal_type,
    goalCategory: row.goal_category ?? null,
    forecastLogicKey: inputs.goalRecord.forecastLogicKey,
    description: row.description ?? null,
    status: row.status,
    ownerMemberId: row.owner_member_id ?? null,
    beneficiaryMemberId: row.beneficiary_member_id ?? null,
    countryCode: row.country_code ?? null,
    currencyCode: row.currency_code,
    userPriority: row.user_priority,
    importanceType: row.importance_type,
    targetAmount: Number(row.target_amount),
    targetDate: row.target_date ?? null,
    targetDateFlexibility: row.target_date_flexibility,
    currentAmount: Number(row.current_amount ?? 0),
    plannedContributionAmount: Number(row.planned_contribution_amount ?? 0),
    contributionFrequency: row.contribution_frequency,
    annualContributionGrowthPct: Number(row.annual_contribution_growth_pct ?? 0),
    inflationAdjusted: Boolean(row.inflation_adjusted),
    nextReviewDate: row.next_review_date ?? null,
    forecasts,
    milestones: (milestonesRes.data ?? []) as GoalMilestoneRow[],
    fundingSources: (fundingSourcesRes.data ?? []) as GoalFundingSourceRow[],
  };

  return { goal, contributions: (contributionsRes.data ?? []) as GoalContributionRow[] };
}
