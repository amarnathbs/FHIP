import { createClient } from '@/lib/supabase/server';
import { computeDashboard, type DashboardSummary, type LiabilityRow as DashboardLiabilityRow } from '@/lib/engines/dashboard';
import { loadBusinessEntitiesForValuation } from '@/lib/services/businessEntityData';
import { applySmsfPropertyLoanLinkOverride } from '@/lib/engines/householdContext';
import { allUnavailableCashFlow, toCanonicalCashFlow } from '@/lib/services/dashboardCanonicalAdapter';
import { buildCanonicalFinancialSnapshot, type CanonicalFinancialSnapshotResult } from '@/lib/read-models/snapshot';
import { computeMonthCashFlow } from '@/lib/read-models/monthlyCashFlow';
import { ECONOMIC_TRANSACTION_TYPES, ECONOMIC_TYPE_BUCKET, type EconomicTransactionType } from '@/lib/read-models/core/spendingRules';
import { DEFAULT_FX_RATE_AUD_INR } from '@/lib/read-models/core/currency';
import { monthStart as monthStartOf } from '@/lib/read-models/core/window';

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// WP-03 (Approved Upload -> Canonical programme). This loader no longer reads
// the approved bank ledger itself. The three raw ledger queries it used to run
// (current UTC calendar month only; no duplicate, split or refund-link rules;
// added blindly on top of the plan -- DC-01/02/03/19, EXP-G3/G4/G5) are gone:
// every imported fact now reaches the Dashboard through ONE
// CanonicalFinancialSnapshot built by lib/read-models per request.
//
// The three exported type lists below are kept for the category review's
// "counts toward" wording, but are now DERIVED from the canonical economic
// type -> bucket map instead of being a second hand-kept list (they were a
// mirror of the Dashboard query's filter). WP-08 moves that consumer onto the
// read-model rules directly.
// ---------------------------------------------------------------------------
const typesInBucket = (bucket: string): EconomicTransactionType[] => ECONOMIC_TRANSACTION_TYPES.filter((t) => ECONOMIC_TYPE_BUCKET[t] === bucket);
/** Economic types that are household spending on an ordinary bank account (canonical: spendingRules). */
export const BANK_EXPENSE_TRANSACTION_TYPES: readonly EconomicTransactionType[] = typesInBucket('spending');
export const BANK_REFUND_TRANSACTION_TYPE: EconomicTransactionType = 'refund';
export const BANK_INCOME_TRANSACTION_TYPES: readonly EconomicTransactionType[] = typesInBucket('income');

// Deliberately a small dedicated lookup, not the full forecasting
// resolveAssumptions() tier stack. Still used by goals / forecasts for their
// own cross-currency conversions. WP-03 (DC-14): a failed read is an ERROR,
// not the default rate -- only a genuinely missing row falls back to the
// documented default (the same rule as the read models' loadFxContext).
export async function getFxRateAudInr(supabase: SupabaseServerClient): Promise<number> {
  const { data, error } = await supabase
    .from('forecast_global_assumptions')
    .select('assumption_value')
    .eq('assumption_key', 'fx_rate_aud_inr')
    .eq('is_active', true)
    .is('country_code', null)
    .maybeSingle();
  if (error) throw new Error('FX rate unavailable: forecast_global_assumptions could not be read');
  return data?.assumption_value ?? DEFAULT_FX_RATE_AUD_INR;
}

// FDH-16 fix (FDH16-DEF-001): PostgREST enforces a server-side default
// max-rows cap (1000 on this project, confirmed live) on any query with no
// explicit .range(). This pages through in batches of 1000 using .range()
// until a short page confirms the end, so totals are always computed from the
// complete row set. `factory` must return a FRESH query builder each call.
export async function fetchAllRows<T>(factory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await factory(from, from + PAGE - 1);
    if (error) throw error;
    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export interface LatestSnapshot {
  snapshot_month: string;
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
}

// The only "latest snapshot on or before a given date" lookup in the
// codebase. Used by getForecastVariance to resolve a real comparison date
// instead of defaulting to report-generation time.
export async function getLatestSnapshotAsOf(userId: string, targetDate: string, supabase: SupabaseServerClient): Promise<LatestSnapshot | null> {
  const { data } = await supabase
    .from('financial_snapshots')
    .select('snapshot_month, net_worth, total_assets, total_liabilities')
    .eq('user_id', userId)
    .lte('snapshot_month', targetDate)
    .order('snapshot_month', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * ONE per request (DC-15): the canonical snapshot and the Dashboard summary
 * computed from it. Score, DNA, Resilience, Goals, Recommendations and the AI
 * context take this object instead of each re-running loadDashboard().
 */
export interface DashboardContext {
  userId: string;
  snapshot: CanonicalFinancialSnapshotResult;
  summary: DashboardSummary;
}

type SnapshotWriteResult = NonNullable<NonNullable<DashboardSummary['dataStatus']>['snapshotWrite']>;

function isReadOnlyBlock(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'M11_READONLY';
}

/**
 * financial_snapshots (DC-01 / DC-14):
 *  - this month's row: the balance sheet now, and the COMBINED cash flow over
 *    complete months (the same figures the Dashboard shows);
 *  - each month of the read window that an approved statement fully covers:
 *    its cash-flow columns are back-filled from THAT month's own approved
 *    lines (computeMonthCashFlow). Only rows that already exist are updated:
 *    a month with no row gets none, because its balance sheet is unknown and
 *    is never fabricated.
 * Any error is logged and reported in dataStatus.snapshotWrite -- never
 * silently ignored. The read-only AI context client blocks writes by design;
 * that is reported as 'skipped_read_only', not as a failure.
 */
async function writeFinancialSnapshots(
  userId: string,
  supabase: SupabaseServerClient,
  summary: DashboardSummary,
  snapshot: CanonicalFinancialSnapshotResult,
  fxRateAudInr: number,
): Promise<SnapshotWriteResult> {
  const today = new Date().toISOString().slice(0, 10);
  const current = monthStart();
  const { error } = await supabase.from('financial_snapshots').upsert(
    {
      user_id: userId,
      snapshot_month: current,
      total_assets: summary.totalAssets + summary.totalInvestments + summary.totalRetirement,
      total_liabilities: summary.totalLiabilities,
      net_worth: summary.netWorth,
      monthly_income: summary.grossMonthlyIncome,
      monthly_expenses: summary.totalMonthlyExpenses + summary.debtMonthlyRepayments,
      monthly_surplus: summary.monthlySurplus,
      savings_rate: summary.savingsRate,
      currency_code: summary.currency,
      // G6 Contract 3 -- FX-rate lineage, populated at write time.
      fx_rate_aud_inr: fxRateAudInr,
      fx_rate_date: today,
    },
    { onConflict: 'user_id,snapshot_month' }
  );
  if (error) {
    if (isReadOnlyBlock(error)) return 'skipped_read_only';
    console.error('[dashboard] financial_snapshots write failed', { code: (error as { code?: string }).code ?? null });
    return 'failed';
  }
  if (snapshot.status !== 'ok' || snapshot.ledger.status !== 'ok') return 'written';
  for (const month of snapshot.ledger.value.coverage.coveredMonths) {
    const monthRow = monthStartOf(month);
    if (monthRow === current) continue;
    const m = computeMonthCashFlow(snapshot, month);
    if (!m) continue;
    const { error: backfillError } = await supabase
      .from('financial_snapshots')
      .update({
        monthly_income: m.grossIncome,
        monthly_expenses: m.expenses + m.debtService,
        monthly_surplus: m.surplus,
        savings_rate: m.savingsRate,
        currency_code: summary.currency,
        fx_rate_aud_inr: fxRateAudInr,
        fx_rate_date: today,
      })
      .eq('user_id', userId)
      .eq('snapshot_month', monthRow);
    if (backfillError) {
      if (isReadOnlyBlock(backfillError)) return 'skipped_read_only';
      console.error('[dashboard] financial_snapshots back-fill failed', { month, code: (backfillError as { code?: string }).code ?? null });
      return 'failed';
    }
  }
  return 'written';
}

// Accepts an optional pre-built client so the scheduled report-generation job
// (which has no per-request cookie session) can pass a service-role client.
export async function loadDashboardContext(userId: string, client?: SupabaseServerClient): Promise<DashboardContext> {
  const supabase = client ?? (await createClient());

  // THE one snapshot for this request: income, expenses, debt service,
  // investments, retirement and assets, each 'ok' or explicitly 'unavailable'.
  const snapshot = await buildCanonicalFinancialSnapshot(userId, { client: supabase });

  if (snapshot.status !== 'ok') {
    // The FX / profile read failed: nothing can be converted, so nothing is
    // reported as if it were known (DC-14). Every section is 'unavailable';
    // every has* flag is false, every ratio null, and the Score/DNA/Resilience
    // engines report their components missing rather than scoring zeros.
    const summary = computeDashboard(
      { income: [], expenses: [], assets: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [], canonical: allUnavailableCashFlow(snapshot) },
      'AUD',
      DEFAULT_FX_RATE_AUD_INR
    );
    return { userId, snapshot, summary };
  }

  const currency = snapshot.fx.reportingCurrency;
  const fxRateAudInr = snapshot.fx.fxRateAudInr;

  // Balance-sheet COMPOSITION reads (breakdowns by type / country / rate /
  // institution, which the read models do not carry). Cash flow never comes
  // from these rows any more.
  const [assets, liabilities, investments, retirement, insurance, goals, snapshotsRes, businessEntitiesResult] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase.from('assets').select('current_value, asset_class, master_item_key, country_code, currency_code').eq('user_id', userId).eq('is_active', true).range(from, to)
    ),
    fetchAllRows<DashboardLiabilityRow & { id: string }>((from, to) =>
      supabase
        .from('liabilities')
        .select('id, balance, interest_rate, monthly_repayment, debt_type, master_item_key, interest_rate_type, fixed_rate_expiry, credit_limit, country_code, currency_code, owner')
        .eq('user_id', userId)
        .eq('is_active', true)
        .range(from, to)
    ),
    fetchAllRows((from, to) =>
      supabase
        .from('investments')
        .select('current_value, cost_base, investment_type, master_item_key, country_code, annual_contribution, institution, currency_code')
        .eq('user_id', userId)
        .eq('is_active', true)
        .range(from, to)
    ),
    fetchAllRows((from, to) =>
      supabase
        .from('retirement_accounts')
        .select('current_balance, employer_contribution, personal_contribution, contribution_frequency, country_code, currency_code')
        .eq('user_id', userId)
        .eq('is_active', true)
        .range(from, to)
    ),
    fetchAllRows((from, to) =>
      supabase
        .from('insurance_policies')
        .select('policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days, owner, currency_code')
        .eq('user_id', userId)
        .eq('is_active', true)
        .range(from, to)
    ),
    fetchAllRows((from, to) =>
      supabase
        .from('user_goals')
        .select('goal_name, target_amount, current_amount, currency_code, target_date, priority, status')
        .eq('user_id', userId)
        .eq('status', 'active')
        .range(from, to)
    ),
    // Deliberately bounded to the most recent 12 months, not a scale-risk query.
    supabase
      .from('financial_snapshots')
      .select('snapshot_month, net_worth, monthly_income, monthly_expenses, monthly_surplus, savings_rate, total_assets, total_liabilities, fx_rate_aud_inr, fx_rate_date')
      .eq('user_id', userId)
      .order('snapshot_month', { ascending: true })
      .limit(12),
    // LR-11: active business entities + Detailed-mode line items.
    loadBusinessEntitiesForValuation(userId, supabase),
  ]);

  // LR-12R reconciliation fix: a liability linked to an SMSF fund as its
  // property loan (property_liability_links.link_type='smsf_property_loan') is
  // the fund's own debt for DTI/DSR, whatever its owner tag. The Liabilities
  // read model already loaded those links (paged); when it could not, they are
  // read here, and a failure is an error, not "no links".
  let smsfLinkedLiabilityIds: Set<string>;
  if (snapshot.liabilities.status === 'ok') {
    smsfLinkedLiabilityIds = new Set(snapshot.liabilities.lines.filter((l) => l.smsfPropertyLoanLinked).map((l) => l.id));
  } else {
    const links = await fetchAllRows<{ liability_id: string }>((from, to) =>
      supabase
        .from('property_liability_links')
        .select('liability_id')
        .eq('user_id', userId)
        .eq('link_type', 'smsf_property_loan')
        .eq('is_active', true)
        .range(from, to)
    );
    smsfLinkedLiabilityIds = new Set(links.map((l) => l.liability_id));
  }
  const liabilitiesForHouseholdContext = applySmsfPropertyLoanLinkOverride(liabilities, smsfLinkedLiabilityIds);

  const canonical = toCanonicalCashFlow(snapshot);
  // DC-14: a failed history or business-entity read is reported, not zeroed silently.
  if (snapshotsRes.error) canonical.otherUnavailable.push({ section: 'history', reason: 'query_failed', source: 'financial_snapshots' });
  if (businessEntitiesResult.error || !businessEntitiesResult.data) {
    canonical.otherUnavailable.push({ section: 'business_entities', reason: 'query_failed', source: 'business_entities' });
  }

  const summary = computeDashboard(
    {
      // Cash flow comes from `canonical`; the raw income / expense rows are not read.
      income: [],
      expenses: [],
      assets,
      liabilities: liabilitiesForHouseholdContext,
      investments,
      retirement,
      insurance,
      goals,
      snapshots: snapshotsRes.error ? [] : snapshotsRes.data ?? [],
      businessEntities: businessEntitiesResult.data ?? [],
      canonical,
    },
    currency,
    fxRateAudInr
  );

  const snapshotWrite = await writeFinancialSnapshots(userId, supabase, summary, snapshot, fxRateAudInr);
  if (summary.dataStatus) summary.dataStatus.snapshotWrite = snapshotWrite;

  return { userId, snapshot, summary };
}

export async function loadDashboard(userId: string, client?: SupabaseServerClient, context?: DashboardContext): Promise<DashboardSummary> {
  if (context && context.userId === userId) return context.summary;
  return (await loadDashboardContext(userId, client)).summary;
}
