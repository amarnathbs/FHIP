import { createClient } from '@/lib/supabase/server';
import { loadDashboard, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { loadHealthScore, type HealthScorePayload } from '@/lib/services/healthScoreData';
import { loadResilience, type ResiliencePayload } from '@/lib/services/resilienceData';
import { loadFinancialDna, type FinancialDnaPayload } from '@/lib/services/financialDnaData';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import type { DashboardSummary } from '@/lib/engines/dashboard';
import type { GoalsPagePayload } from '@/lib/services/goalsData';
import { computeSectionEligibility, isEligibleForOfficialMonthlyReport, type EligibilityInput } from '@/lib/engines/reportEligibility';
import { listTwinRuns, getTwinRunDetail, type StoredTwinDetail } from '@/lib/services/financialTwinService';
import { getPlanTier, type PlanTier } from '@/lib/services/entitlements';
import type { CommitmentRow } from '@/lib/engines/resilience';
import { buildForecastReportData, type ForecastReportData } from '@/lib/services/forecastReportData';
import { loadReportContent, type ReportContent } from '@/lib/services/reportContentData';
import { buildReportActionMatches, type ReportActionItem } from '@/lib/services/recommendationsData';

export interface ReportProfile {
  fullName: string | null;
  householdName: string | null;
  householdType: string | null;
  countryOfResidence: string | null;
  preferredCurrency: 'AUD' | 'INR';
  dependantsCount: number;
}

export interface PremiumInvestmentRow {
  id: string;
  investment_name: string;
  current_value: number;
  cost_base: number | null;
  investment_type: string;
  country_code: string;
  annual_contribution: number | null;
  institution: string | null;
}

export interface PremiumInsuranceRow {
  policy_name: string;
  cover_amount: number;
  premium: number;
  premium_frequency: string;
  cover_type: string;
  renewal_date: string | null;
  waiting_period_days: number | null;
}

export interface PremiumAssetRow {
  asset_name: string;
  current_value: number;
  asset_class: string;
  country_code: string;
}

export interface PremiumLiabilityRow {
  liability_name: string;
  balance: number;
  interest_rate: number | null;
  monthly_repayment: number | null;
  debt_type: string;
  country_code: string;
}

export interface PremiumIncomeRow {
  source_name: string | null;
  employer_name: string | null;
  amount: number;
  frequency: string;
}

export interface PremiumExpenseRow {
  expense_name: string;
  amount: number;
  frequency: string;
  is_essential: boolean;
  expense_category: string;
}

export interface GoalsOnTrackHistoryPoint {
  month: string;
  onTrackCount: number;
  activeCount: number;
}

export interface PremiumSourceData {
  investments: PremiumInvestmentRow[];
  insurancePolicies: PremiumInsuranceRow[];
  assets: PremiumAssetRow[];
  liabilities: PremiumLiabilityRow[];
  incomeSources: PremiumIncomeRow[];
  expenseItems: PremiumExpenseRow[];
  forecastReportData: ForecastReportData | null;
  goalsOnTrackHistory: GoalsOnTrackHistoryPoint[];
}

export interface ReportSourceData {
  userId: string;
  reportMonth: string; // YYYY-MM-01
  asOfDate: string;
  currency: 'AUD' | 'INR';
  profile: ReportProfile;
  dashboard: DashboardSummary;
  healthScore: HealthScorePayload | null;
  resilience: ResiliencePayload | null;
  dna: FinancialDnaPayload | null;
  goals: GoalsPagePayload;
  previousGoalsOnTrackCount: number | null;
  previousActiveGoalsCount: number | null;
  dataFreshness: Record<string, string | null>; // category -> most recent updated_at (ISO), for the Data Quality section
  financialTwin: StoredTwinDetail | null;
  planTier: PlanTier;
  premium: PremiumSourceData | null; // null for free-tier users — Premium-only queries are skipped entirely, not just hidden
  commitments: CommitmentRow[]; // light query, loaded for every tier — powers the 90-day commitment timeline in both Free and Premium reports
  content: ReportContent; // report_content_library, replacing reportCopy.ts's hardcoded constants (Report v3 Phase 3a)
  // Real recommendation-engine matches (action_recommendation_master, filtered
  // to include_in_monthly_report=true) — pillar-triggered signals for every
  // tier, plus forecast-category signals too when planTier === 'premium'
  // (Report v3 Phase 3a). Replaces reportSections.ts's/reportSectionsPremium.ts's
  // old ad hoc sourcing from healthScore.recommendations directly.
  actionRecommendations: ReportActionItem[];
}

const FRESHNESS_TABLES: { category: string; table: string }[] = [
  { category: 'income', table: 'income_sources' },
  { category: 'expenses', table: 'expense_items' },
  { category: 'assets', table: 'assets' },
  { category: 'liabilities', table: 'liabilities' },
  { category: 'investments', table: 'investments' },
  { category: 'retirement', table: 'retirement_accounts' },
  { category: 'insurance', table: 'insurance_policies' },
];

// Extracted so callers that only need per-category freshness (e.g. a
// dashboard "data quality" tile) aren't forced to pay for the rest of
// resolveReportSourceData's much heavier report-assembly queries.
export async function loadDataFreshness(userId: string, client?: SupabaseServerClient): Promise<Record<string, string | null>> {
  const supabase = client ?? (await createClient());
  const freshnessResults = await Promise.all(
    FRESHNESS_TABLES.map(({ table }) =>
      supabase.from(table).select('updated_at').eq('user_id', userId).eq('is_active', true).order('updated_at', { ascending: false }).limit(1).maybeSingle()
    )
  );
  const dataFreshness: Record<string, string | null> = {};
  FRESHNESS_TABLES.forEach(({ category }, i) => {
    dataFreshness[category] = (freshnessResults[i].data?.updated_at as string) ?? null;
  });
  return dataFreshness;
}

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function previousMonthStart(month: string): string {
  const d = new Date(month);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

// Reuses each module's existing load*/compute* function rather than
// re-querying the underlying score/DNA/resilience/goal tables directly
// (Rule 15 — the report module never recalculates core intelligence).
export async function resolveReportSourceData(
  userId: string,
  reportMonth?: string,
  client?: SupabaseServerClient
): Promise<ReportSourceData> {
  const supabase = client ?? (await createClient());
  const month = reportMonth ?? monthStart();

  const [profileRes, householdRes] = await Promise.all([
    supabase.from('user_profiles').select('full_name, country_of_residence, preferred_currency').eq('user_id', userId).single(),
    supabase.from('households').select('household_name, household_type, dependants_count').eq('user_id', userId).maybeSingle(),
  ]);

  const [dashboard, healthScore, resilience, dna, goals, financialTwin, commitmentsRes, content] = await Promise.all([
    loadDashboard(userId, supabase),
    loadHealthScore(userId, supabase).catch(() => null),
    loadResilience(userId, supabase).catch(() => null),
    loadFinancialDna(userId, supabase).catch(() => null),
    computeGoalsPagePayload(userId, supabase).then((r) => r.payload),
    listTwinRuns(userId, supabase).then((runs) => (runs.length > 0 ? getTwinRunDetail(userId, runs[0].id, supabase) : null)),
    // Light 3-column query, cheap enough to load for every tier — powers the
    // 90-day commitment timeline in both Free and Premium reports (was
    // previously gated behind planTier === 'premium', which meant Free
    // reports could never show this even though the Free spec calls for it).
    supabase.from('future_financial_commitments').select('amount, due_date, is_mandatory').eq('user_id', userId).eq('is_active', true),
    // Small table (~40-60 active rows), one query per report generation.
    loadReportContent('en', supabase),
  ]);
  const commitments = (commitmentsRes.data as CommitmentRow[]) ?? [];

  const currency = (profileRes.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const { data: prevGoalSnapshots } = await supabase
    .from('goal_snapshots')
    .select('track_status')
    .eq('user_id', userId)
    .eq('snapshot_month', previousMonthStart(month));
  const previousGoalsOnTrackCount = prevGoalSnapshots
    ? prevGoalSnapshots.filter((g) => ['on_track', 'ahead_of_track'].includes(g.track_status)).length
    : null;
  const previousActiveGoalsCount = prevGoalSnapshots ? prevGoalSnapshots.length : null;

  const dataFreshness = await loadDataFreshness(userId, supabase);

  const planTier = await getPlanTier(userId);

  // Kicked off alongside the premium block below rather than awaited inline —
  // pillar signals for every tier, plus forecast-category signals too when
  // Premium (which already resolves a forecast profile/scenario via
  // buildForecastReportData below, so this adds no new side effect; Free-tier
  // report generation never touches forecast data today, and this
  // deliberately doesn't change that).
  const actionRecommendationsPromise = buildReportActionMatches(userId, { includeForecastSignals: planTier === 'premium' }, supabase).catch(() => []);

  // Premium-only queries are skipped entirely for free-tier users rather than
  // just hidden in the UI, to avoid paying for data a free report never renders.
  let premium: PremiumSourceData | null = null;
  if (planTier === 'premium') {
    const [
      investmentsRes,
      insuranceRes,
      assetsRes,
      liabilitiesRes,
      incomeRes,
      expensesRes,
      forecastReportData,
      goalSnapshotsRes,
    ] = await Promise.all([
      supabase
        .from('investments')
        .select('id, investment_name, current_value, cost_base, investment_type, country_code, annual_contribution, institution')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase
        .from('insurance_policies')
        .select('policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase.from('assets').select('asset_name, current_value, asset_class, country_code').eq('user_id', userId).eq('is_active', true),
      supabase
        .from('liabilities')
        .select('liability_name, balance, interest_rate, monthly_repayment, debt_type, country_code')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase.from('income_sources').select('source_name, employer_name, amount, frequency').eq('user_id', userId).eq('is_active', true),
      supabase
        .from('expense_items')
        .select('expense_name, amount, frequency, is_essential, expense_category')
        .eq('user_id', userId)
        .eq('is_active', true),
      buildForecastReportData(userId, undefined, supabase).catch(() => null),
      // goal_snapshots is only written when the Goals page itself is visited
      // (a pre-existing gap, not introduced here) — history may be sparse for
      // accounts that haven't opened Goals; render whatever exists.
      supabase
        .from('goal_snapshots')
        .select('snapshot_month, track_status')
        .eq('user_id', userId)
        .order('snapshot_month', { ascending: true })
        .limit(400),
    ]);

    const historyByMonth = new Map<string, { onTrackCount: number; activeCount: number }>();
    (goalSnapshotsRes.data ?? []).forEach((row) => {
      const month = row.snapshot_month as string;
      const entry = historyByMonth.get(month) ?? { onTrackCount: 0, activeCount: 0 };
      entry.activeCount += 1;
      if (['on_track', 'ahead_of_track'].includes(row.track_status as string)) entry.onTrackCount += 1;
      historyByMonth.set(month, entry);
    });
    const goalsOnTrackHistory = Array.from(historyByMonth.entries())
      .map(([month, v]) => ({ month, ...v }))
      .slice(-12);

    premium = {
      investments: (investmentsRes.data as PremiumInvestmentRow[]) ?? [],
      insurancePolicies: (insuranceRes.data as PremiumInsuranceRow[]) ?? [],
      assets: (assetsRes.data as PremiumAssetRow[]) ?? [],
      liabilities: (liabilitiesRes.data as PremiumLiabilityRow[]) ?? [],
      incomeSources: (incomeRes.data as PremiumIncomeRow[]) ?? [],
      expenseItems: (expensesRes.data as PremiumExpenseRow[]) ?? [],
      forecastReportData,
      goalsOnTrackHistory,
    };
  }

  const actionRecommendations = await actionRecommendationsPromise;

  return {
    userId,
    reportMonth: month,
    asOfDate: new Date().toISOString().slice(0, 10),
    currency,
    profile: {
      fullName: profileRes.data?.full_name ?? null,
      householdName: householdRes.data?.household_name ?? null,
      householdType: householdRes.data?.household_type ?? null,
      countryOfResidence: profileRes.data?.country_of_residence ?? null,
      preferredCurrency: currency,
      dependantsCount: householdRes.data?.dependants_count ?? 0,
    },
    dashboard,
    healthScore,
    resilience,
    dna,
    goals,
    previousGoalsOnTrackCount,
    previousActiveGoalsCount,
    dataFreshness,
    financialTwin,
    planTier,
    premium,
    commitments,
    content,
    actionRecommendations,
  };
}

export function buildEligibilityInput(source: ReportSourceData): EligibilityInput {
  const d = source.dashboard;
  return {
    hasIncome: d.hasIncome,
    hasExpenses: d.hasExpenses,
    hasAssets: d.hasAssets,
    hasLiabilities: d.hasLiabilities,
    hasHealthScore: source.healthScore !== null,
    hasDnaProfile: source.dna !== null && source.dna.status !== 'insufficient_data',
    hasResilienceResult: source.resilience !== null && source.resilience.components.some((c) => c.treatment === 'scored'),
    hasActiveGoals: source.goals.summary.activeGoalsCount > 0,
    hasFinancialTwin: source.financialTwin !== null,
    countriesInUseCount: d.countriesInUse.length,
    hasActions:
      source.actionRecommendations.length > 0 ||
      (source.resilience?.actions.length ?? 0) > 0 ||
      source.goals.goals.some((g) => g.forecasts.base.requiredMonthlyContribution !== null),
  };
}

export { computeSectionEligibility, isEligibleForOfficialMonthlyReport };
