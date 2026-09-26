import { createClient } from '@/lib/supabase/server';
import { loadDashboard, getFxRateAudInr, fetchAllRows, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { loadHealthScore, type HealthScorePayload } from '@/lib/services/healthScoreData';
import { loadResilience, type ResiliencePayload } from '@/lib/services/resilienceData';
import { loadFinancialDna, type FinancialDnaPayload } from '@/lib/services/financialDnaData';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import type { DashboardSummary } from '@/lib/engines/dashboard';
import type { GoalsPagePayload } from '@/lib/services/goalsData';
import { buildCanonicalFinancialSnapshot, type CanonicalFinancialSnapshotResult } from '@/lib/read-models';
import { loadImportedCategoryFreshness, loadImportedInputsLastChangedAt, maxTimestamp } from '@/lib/read-models/freshness';
import { buildCanonicalAppendix, type CanonicalAppendix } from '@/lib/engines/reportCanonicalAppendix';
import { computeSectionEligibility, isEligibleForOfficialMonthlyReport, type EligibilityInput } from '@/lib/engines/reportEligibility';
import { listTwinRuns, getTwinRunDetail, type StoredTwinDetail } from '@/lib/services/financialTwinService';
import { getPlanTier, type PlanTier } from '@/lib/services/entitlements';
import type { CommitmentRow } from '@/lib/engines/resilience';
import { buildForecastReportData, type ForecastReportData } from '@/lib/services/forecastReportData';
import { loadReportContent, type ReportContent } from '@/lib/services/reportContentData';
import { buildReportActionMatches, type ReportActionItem } from '@/lib/services/recommendationsData';
import {
  loadInvestmentPerformanceForReport,
  loadSipForReport,
  loadXrayForReport,
  loadTaxForReport,
  loadReviewItemsForReport,
  type ReportPerformanceData,
  type ReportSipData,
  type ReportXrayData,
  type ReportTaxData,
  type ReportReviewData,
} from '@/lib/services/investmentIntelligenceReportData';

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
  currency_code: string | null;
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

/**
 * WP-06 (DC-08): the Premium investment chapter's totals come from the ONE
 * canonical portfolio figure (selectInvestments().publishedTotal -- the
 * figure Net Worth counts), converted once at the snapshot's FX rate. Holdings
 * imported into Investment Intelligence but not yet added to Net Worth
 * (PO D-05) are disclosed, never silently added or silently dropped.
 */
export interface ReportCanonicalInvestments {
  publishedTotal: number;
  /** investments.id -> reporting-currency value (null = currency not convertible). */
  reportingValueById: Record<string, number | null>;
  unconvertedCount: number;
  unpublished: { label: string; count: number; total: number };
}

/** What the report shows beside Net Worth but deliberately does not count in it (D-04 / D-05). */
export interface NotInNetWorthItem {
  label: string;
  count: number;
  total: number;
}

export interface GoalsOnTrackHistoryPoint {
  month: string;
  onTrackCount: number;
  activeCount: number;
}

export interface PremiumSourceData {
  investments: PremiumInvestmentRow[];
  insurancePolicies: PremiumInsuranceRow[];
  // WP-06 (DC-10 / EXP-G11 / GAP-02): the appendix is built from the canonical
  // read-model line items -- planned AND approved imported lines with their
  // provenance, excluded rows marked, currency shown, retirement included --
  // replacing the raw assets / liabilities / income_sources / expense_items
  // register copies it used to list. null only when the canonical snapshot
  // could not be read at all (the appendix then says so).
  canonicalAppendix: CanonicalAppendix | null;
  canonicalInvestments: ReportCanonicalInvestments | null;
  forecastReportData: ForecastReportData | null;
  goalsOnTrackHistory: GoalsOnTrackHistoryPoint[];
  // FHIP_50_User_Report_Accuracy_Validation_Review P0 finding — Investment
  // Analysis (reportSectionsPremium.ts's buildInvestmentAnalysis) used to sum
  // each investment's current_value regardless of currency_code, badly
  // overstating totals for cross-border households (e.g. an INR 900,000
  // holding counted as AUD 900,000). Same fx_rate_aud_inr assumption
  // dashboard.ts's canonical totalInvestments already uses, threaded through
  // here so the Premium report's own investment totals can never again
  // drift from the correctly-converted canonical figure shown elsewhere in
  // the same report.
  fxRateAudInr: number;
  // II-R10 continuation — Investment Intelligence chapters (spec sections
  // 21-32). Each is null when the module has no data for this user (spec
  // section 39-40: never a page of fabricated zeros) or is not applicable
  // for their country (e.g. Tax & Cost is India-only per spec section
  // 54-55). Populated via lib/services/investmentIntelligenceReportData.ts,
  // which calls the exact same canonical dataset+orchestrator pair each
  // module's own live page/API uses — never a local recalculation.
  investmentPerformance: ReportPerformanceData | null;
  sip: ReportSipData | null;
  xray: ReportXrayData | null;
  taxAndCost: ReportTaxData | null;
  reviewItems: ReportReviewData | null;
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
  // WP-06: items shown beside Net Worth but deliberately NOT in it -- imported
  // holdings not yet added to Net Worth (D-05) and bank closing balances not
  // yet Applied as a cash asset (D-04). Optional so older fixtures/callers
  // stay valid; absent/empty means nothing to disclose.
  notInNetWorth?: NotInNetWorthItem[];
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
  // WP-06: income and expenses are also recorded by APPROVED imported
  // statement lines, which the canonical Income / Expense read models count.
  // A household whose income or spending comes only from approved statements
  // is no longer reported as "Missing" for a category the report includes.
  const imported = await loadImportedCategoryFreshness(userId, supabase);
  dataFreshness.income = maxTimestamp([dataFreshness.income, imported.income]);
  dataFreshness.expenses = maxTimestamp([dataFreshness.expenses, imported.expenses]);
  return dataFreshness;
}

// App Review 2026-09-15, items 4 and 5 — shared root cause.
//
// generateReport() short-circuits on an existing ready/published report for
// the same user+type+month and returns its STORED report_sections verbatim.
// That is correct idempotency, but it also meant a report could never reflect
// anything the household entered after the first generation of that month:
//   - item 4: Assets/Liabilities/Investments/Retirement still reported as
//     "Missing / Not provided" long after 8 assets, 4 liabilities, 2
//     investments and an SMSF had been entered;
//   - item 5: "No active goals were recorded for this period." still shown
//     while the Goals page said "You have 1 active goal".
// Neither section has a period filter — both read live data at BUILD time —
// so in both cases the stored text was simply built before the data existed.
//
// This returns the newest updated_at across every register the report reads,
// so generateReport can tell whether its stored copy is behind the data.
// Cheap: the same 7 one-row queries loadDataFreshness already runs, plus
// goals and the section confirmations.
const REPORT_INPUT_TABLES: string[] = [
  ...FRESHNESS_TABLES.map((t) => t.table),
  'user_goals',
  'user_financial_section_status',
];

export async function loadReportInputsLastChangedAt(userId: string, client?: SupabaseServerClient): Promise<string | null> {
  const supabase = client ?? (await createClient());
  const results = await Promise.all(
    REPORT_INPUT_TABLES.map(async (table) => {
      // A table without an updated_at column, or any transient failure, must
      // never make a report look artificially fresh OR artificially stale —
      // it simply contributes nothing to the comparison.
      try {
        const r = await supabase
          .from(table)
          .select('updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        return (r.data?.updated_at as string | undefined) ?? null;
      } catch {
        return null;
      }
    })
  );
  // WP-06 (DC-09): imported data moves canonical figures too -- approving a
  // statement (its lines' approved_at), a split or link, an AU broker
  // import into Investment Intelligence, a publication to Net Worth, or an
  // Applied payslip / statement proposal must make this month's stored report
  // stale, exactly as a manual register edit does.
  const imported = await loadImportedInputsLastChangedAt(userId, supabase);
  return maxTimestamp([...results, imported]);
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

  const [dashboard, canonicalSnapshot, healthScore, resilience, dna, goals, financialTwin, commitmentsRes, content] = await Promise.all([
    loadDashboard(userId, supabase),
    // WP-06: the per-request canonical snapshot -- one FX rate, one window,
    // one ledger -- that the appendix, the investment reconciliation and the
    // Net Worth disclosures are all built from.
    buildCanonicalFinancialSnapshot(userId, { client: supabase }),
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
  const notInNetWorth = notInNetWorthFrom(canonicalSnapshot);

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

  const planTier = await getPlanTier(userId, supabase);

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
      forecastReportData,
      goalSnapshotsRes,
      fxRateAudInr,
      investmentPerformance,
      sip,
      xray,
      taxAndCost,
      reviewItems,
    ] = await Promise.all([
      // FDH-16 fix (FDH16-DEF-001, same root cause as dashboardData.ts):
      // these queries had no .range()/.limit() and were silently subject
      // to PostgREST's default row cap (1000 on this project, live-confirmed)
      // for any household whose active row count in one register exceeds it.
      // fetchAllRows() pages through until a short page confirms completeness.
      fetchAllRows((from, to) =>
        supabase
          .from('investments')
          .select('id, investment_name, current_value, cost_base, investment_type, country_code, currency_code, annual_contribution, institution')
          .eq('user_id', userId)
          .eq('is_active', true)
          .range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase
          .from('insurance_policies')
          .select('policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days')
          .eq('user_id', userId)
          .eq('is_active', true)
          .range(from, to)
      ),
      // WP-06: the assets / liabilities / income_sources / expense_items
      // register copies the appendix used to list are gone -- the appendix is
      // built from the canonical snapshot above (see buildCanonicalAppendix).
      // LR-FI-1's SMSF rule is kept there by the selectors themselves:
      // SMSF-owned income/expense rows are listed as "not counted", never as
      // counted household items.
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
      getFxRateAudInr(supabase),
      // II-R10 continuation chapters. Each loader already fails safe to
      // null internally (spec section 39) — the .catch() here is defence
      // in depth only, so one chapter's failure can never abort the whole
      // premium report generation.
      loadInvestmentPerformanceForReport(userId, supabase).catch(() => null),
      loadSipForReport(userId, supabase).catch(() => null),
      loadXrayForReport(userId, supabase).catch(() => null),
      loadTaxForReport(userId, supabase).catch(() => null),
      loadReviewItemsForReport(userId).catch(() => null),
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
      investments: investmentsRes as PremiumInvestmentRow[],
      insurancePolicies: insuranceRes as PremiumInsuranceRow[],
      canonicalAppendix: canonicalSnapshot.status === 'ok' ? buildCanonicalAppendix(canonicalSnapshot) : null,
      canonicalInvestments: canonicalInvestmentsFrom(canonicalSnapshot),
      forecastReportData,
      goalsOnTrackHistory,
      // One FX rate per report: the snapshot's when it resolved, so the
      // investment chapter and the appendix can never convert at two rates.
      fxRateAudInr: canonicalSnapshot.status === 'ok' ? canonicalSnapshot.fx.fxRateAudInr : fxRateAudInr,
      investmentPerformance,
      sip,
      xray,
      taxAndCost,
      reviewItems,
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
    notInNetWorth,
    actionRecommendations,
  };
}

/** D-04 / D-05 disclosures shown beside Net Worth (never added to it). */
export function notInNetWorthFrom(snapshot: CanonicalFinancialSnapshotResult): NotInNetWorthItem[] {
  if (snapshot.status !== 'ok') return [];
  const out: NotInNetWorthItem[] = [];
  if (snapshot.investments.status === 'ok' && snapshot.investments.unpublished.count > 0) {
    const u = snapshot.investments.unpublished;
    out.push({ label: u.label, count: u.count, total: u.total });
  }
  if (snapshot.assets.status === 'ok' && snapshot.assets.bankBalanceEvidence.accounts.length > 0) {
    const b = snapshot.assets.bankBalanceEvidence;
    out.push({ label: b.label, count: b.accounts.length, total: b.total });
  }
  return out;
}

export function canonicalInvestmentsFrom(snapshot: CanonicalFinancialSnapshotResult): ReportCanonicalInvestments | null {
  if (snapshot.status !== 'ok' || snapshot.investments.status !== 'ok') return null;
  const inv = snapshot.investments;
  return {
    publishedTotal: inv.publishedTotal,
    reportingValueById: Object.fromEntries(inv.lines.map((l) => [l.id, l.value.amountReporting])),
    unconvertedCount: inv.lines.filter((l) => l.value.amountReporting === null).length,
    unpublished: { label: inv.unpublished.label, count: inv.unpublished.count, total: inv.unpublished.total },
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
