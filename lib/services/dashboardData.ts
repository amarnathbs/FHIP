import { createClient } from '@/lib/supabase/server';
import { computeDashboard, type DashboardSummary } from '@/lib/engines/dashboard';
import { loadBusinessEntitiesForValuation } from '@/lib/services/businessEntityData';
import { applySmsfPropertyLoanLinkOverride } from '@/lib/engines/householdContext';

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

// LR-3: exclusive upper bound for "this calendar month" — the first day of
// NEXT month, so `transaction_date >= monthStart() and < nextMonthStart()`
// selects the current month regardless of how many days it has.
function nextMonthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

// LR-3: economic_transaction_type values (supabase/migrations/0047_fdh_
// transactions_and_classification.sql) that represent real household
// expense outflow for Monthly Surplus purposes. Deliberately excludes
// 'debt_principal' (tracked separately from ordinary expenses, matching how
// dashboard.ts already excludes Liability repayments from
// totalMonthlyExpenses), 'transfer' (never a real expense — FDH-10's own
// certified economics: a credit-card PAYMENT settling already-recorded
// purchases is a transfer, not a second expense), 'investment'/
// 'asset_purchase'/'asset_sale' (wealth movement, not consumption),
// 'cash_withdrawal' (what the cash was actually spent on is unknown — never
// guessed), and 'refund'/'unknown' (handled separately below / excluded
// until classified).
const BANK_EXPENSE_TRANSACTION_TYPES = ['expense', 'fee', 'debt_interest', 'tax'] as const;
const BANK_REFUND_TRANSACTION_TYPE = 'refund';
const BANK_INCOME_TRANSACTION_TYPES = ['income'] as const;

// Deliberately a small dedicated lookup, not the full forecasting
// resolveAssumptions() tier stack (scenario -> profile -> country -> global)
// — the dashboard's currency-conversion need is "the current global FX rate",
// not a per-scenario forecast override, and this runs on the hot dashboard
// load path. Falls back to the same default as
// forecast/crossBorderCalculator.ts's DEFAULT_FX_RATE_AUD_INR if the seed
// row is ever missing.
export async function getFxRateAudInr(supabase: SupabaseServerClient): Promise<number> {
  const { data } = await supabase
    .from('forecast_global_assumptions')
    .select('assumption_value')
    .eq('assumption_key', 'fx_rate_aud_inr')
    .eq('is_active', true)
    .is('country_code', null)
    .maybeSingle();
  return data?.assumption_value ?? 56;
}

// FDH-16 fix (FDH16-DEF-001): PostgREST enforces a server-side default
// max-rows cap (1000 on this project, confirmed live) on any query with no
// explicit .range(). Every query below previously had none, so a household
// with more than 1000 active rows in ANY single register (income/expenses/
// assets/liabilities/investments/retirement/insurance/goals) would have its
// Dashboard/Net-Worth/Cashflow totals SILENTLY computed from only the first
// 1000 rows — no error, no truncation signal surfaced to computeDashboard(),
// which has no way to know rows were missing. This pages through in batches
// of 1000 using .range() until a short page confirms the end, so totals are
// always computed from the complete row set. `factory` must return a FRESH
// query builder each call (a single builder instance cannot be re-awaited
// with a different .range() and reliably re-execute).
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
// codebase — every prior financial_snapshots read was either "last 12
// months up to now" or "most recent row, no date parameter" (see
// twinData.ts, resilienceData.ts). Used by getForecastVariance to resolve a
// real comparison date instead of defaulting to report-generation time.
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

// Accepts an optional pre-built client so the scheduled report-generation job
// (which has no per-request cookie session) can pass a service-role client
// instead — every other call site is unaffected and keeps using its own
// cookie-based session client.
export async function loadDashboard(userId: string, client?: SupabaseServerClient): Promise<DashboardSummary> {
  const supabase = client ?? (await createClient());

  const [
    profile,
    income,
    expenses,
    assets,
    liabilities,
    investments,
    retirement,
    insurance,
    goals,
    snapshots,
    fxRateAudInr,
    bankExpenseTransactions,
    bankIncomeTransactions,
    businessEntitiesResult,
    smsfPropertyLoanLinks,
  ] = await Promise.all([
      supabase.from('user_profiles').select('preferred_currency').eq('user_id', userId).single(),
      fetchAllRows((from, to) =>
        supabase.from('income_sources').select('source_name, amount, net_amount, frequency, master_item_key, employer_name, owner, superseded_by_bank_import').eq('user_id', userId).eq('is_active', true).range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase
          .from('expense_items')
          .select('expense_name, amount, frequency, is_essential, master_item_key, expense_category, owner, superseded_by_bank_import')
          .eq('user_id', userId)
          .eq('is_active', true)
          .range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase.from('assets').select('current_value, asset_class, master_item_key, country_code, currency_code').eq('user_id', userId).eq('is_active', true).range(from, to)
      ),
      fetchAllRows((from, to) =>
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
          .select('policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days, owner')
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
        // fx_rate_aud_inr/fx_rate_date added for G6 Contract 3 — read-side
        // half of the FX-rate lineage; passed through SnapshotRow untouched.
        .select('snapshot_month, net_worth, monthly_income, monthly_expenses, monthly_surplus, savings_rate, total_assets, total_liabilities, fx_rate_aud_inr, fx_rate_date')
        .eq('user_id', userId)
        .order('snapshot_month', { ascending: true })
        .limit(12),
      getFxRateAudInr(supabase),
      // LR-3: approved bank-statement transactions for the current calendar
      // month only — see BANK_EXPENSE_TRANSACTION_TYPES' own comment for
      // exactly which economic_transaction_type values count as expense
      // outflow. A plain Supabase table query, RLS-scoped like every other
      // fetch above; not a TypeScript import of any Financial Data Hub
      // module code (tests/unit/fdh1Isolation.test.ts's isolation guarantee
      // is about module imports, not about this dashboard reading the same
      // RLS-scoped table that pipeline itself writes to — the same
      // relationship lib/engines/debtServiceContext.ts already has with
      // FDH-10's economics, mirrored rather than imported).
      fetchAllRows((from, to) =>
        supabase
          .from('fdh_transactions')
          .select('amount_original, currency_original')
          .eq('user_id', userId)
          .eq('approval_status', 'approved')
          .in('economic_transaction_type', [...BANK_EXPENSE_TRANSACTION_TYPES])
          .gte('transaction_date', monthStart())
          .lt('transaction_date', nextMonthStart())
          .range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase
          .from('fdh_transactions')
          .select('amount_original, currency_original')
          .eq('user_id', userId)
          .eq('approval_status', 'approved')
          .in('economic_transaction_type', [...BANK_INCOME_TRANSACTION_TYPES])
          .gte('transaction_date', monthStart())
          .lt('transaction_date', nextMonthStart())
          .range(from, to)
      ),
      // LR-11 (Company / Family Trust Entity Architecture) — this user's own
      // active business entities plus their Detailed-mode line items (empty
      // arrays for Summary-mode entities, per loadBusinessEntitiesForValuation's
      // own contract). A household with none gets [], which
      // computeBusinessEntityOwnershipValue() (called inside computeDashboard)
      // reduces to exactly 0 — byte-for-byte identical to every pre-LR-11 result.
      loadBusinessEntitiesForValuation(userId, supabase),
      // LR-12R reconciliation fix (2026-09-11, PO ruling): a liability
      // structurally linked to an SMSF fund as its property loan
      // (property_liability_links.link_type='smsf_property_loan') is the
      // fund's own debt regardless of whether the user separately, manually
      // tags the liability row owner='smsf' — householdContext.ts's own
      // header (LR-FI-1 §... ) had explicitly deferred this exact case as
      // "absent for the plain 'user tagged this row as SMSF' case this
      // defect is about," leaving it counted in personal DTI/DSR until a
      // live oracle test (household income $10k/mo, personal debt service
      // $1k/mo, SMSF-linked-but-not-owner-tagged loan $2k/mo) proved DSR
      // came back 30%, not the required 10% — a real financial-context
      // defect, not merely a discoverability gap. Fetched here, at the data
      // layer, so computeDashboard() itself never needs to know about
      // property_liability_links — see the owner-override mapping below.
      fetchAllRows<{ liability_id: string }>((from, to) =>
        supabase
          .from('property_liability_links')
          .select('liability_id')
          .eq('user_id', userId)
          .eq('link_type', 'smsf_property_loan')
          .eq('is_active', true)
          .range(from, to)
      ),
    ]);

  const currency = (profile.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  // LR-3: a refund is a NEGATIVE contribution to expense outflow (it gives
  // money back for a purchase already counted as an expense elsewhere this
  // same month, or in a prior month if the original purchase predates this
  // window — either way, refunding it should reduce, not add to, this
  // month's net outflow). Fetched and combined here, not inside dashboard.ts,
  // so that engine's own contract stays "just sum what you're given" for
  // every array, matching every other DashboardInput array's contract.
  const refunds = await fetchAllRows<{ amount_original: number; currency_original: string | null }>((from, to) =>
    supabase
      .from('fdh_transactions')
      .select('amount_original, currency_original')
      .eq('user_id', userId)
      .eq('approval_status', 'approved')
      .eq('economic_transaction_type', BANK_REFUND_TRANSACTION_TYPE)
      .gte('transaction_date', monthStart())
      .lt('transaction_date', nextMonthStart())
      .range(from, to)
  );
  const bankExpenseTransactionsNet = [
    ...bankExpenseTransactions,
    ...refunds.map((r) => ({ ...r, amount_original: -r.amount_original })),
  ];

  // LR-12R reconciliation fix — see the property_liability_links fetch above
  // for the full rationale and applySmsfPropertyLoanLinkOverride()'s own
  // header for the exact contract (a shallow copy fed only to
  // computeDashboard(); the real liabilities.owner column is untouched).
  const smsfLinkedLiabilityIds = new Set(smsfPropertyLoanLinks.map((l) => l.liability_id));
  const liabilitiesForHouseholdContext = applySmsfPropertyLoanLinkOverride(liabilities, smsfLinkedLiabilityIds);

  const summary = computeDashboard(
    {
      income,
      expenses,
      assets,
      liabilities: liabilitiesForHouseholdContext,
      investments,
      retirement,
      insurance,
      goals,
      snapshots: snapshots.data ?? [],
      bankExpenseTransactions: bankExpenseTransactionsNet,
      bankIncomeTransactions,
      businessEntities: businessEntitiesResult.data ?? [],
    },
    currency,
    fxRateAudInr
  );

  await supabase.from('financial_snapshots').upsert(
    {
      user_id: userId,
      snapshot_month: monthStart(),
      total_assets: summary.totalAssets + summary.totalInvestments + summary.totalRetirement,
      total_liabilities: summary.totalLiabilities,
      net_worth: summary.netWorth,
      monthly_income: summary.grossMonthlyIncome,
      monthly_expenses: summary.totalMonthlyExpenses + summary.debtMonthlyRepayments,
      monthly_surplus: summary.monthlySurplus,
      savings_rate: summary.savingsRate,
      currency_code: currency,
      // G6 Contract 3 (docs/country-programme/g6-data-contracts.md) — FX-rate
      // lineage, populated at write-time only (never backfilled for
      // historical rows — a pre-G6 snapshot legitimately has NULL here,
      // meaning "rate unknown," never a retroactively-assumed value).
      // fxRateAudInr is the exact same value already resolved by
      // getFxRateAudInr() above and passed into computeDashboard().
      fx_rate_aud_inr: fxRateAudInr,
      fx_rate_date: new Date().toISOString().slice(0, 10),
    },
    { onConflict: 'user_id,snapshot_month' }
  );

  return summary;
}
