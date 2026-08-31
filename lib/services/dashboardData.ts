import { createClient } from '@/lib/supabase/server';
import { computeDashboard, type DashboardSummary } from '@/lib/engines/dashboard';

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

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
async function fetchAllRows<T>(factory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
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

  const [profile, income, expenses, assets, liabilities, investments, retirement, insurance, goals, snapshots, fxRateAudInr] =
    await Promise.all([
      supabase.from('user_profiles').select('preferred_currency').eq('user_id', userId).single(),
      fetchAllRows((from, to) =>
        supabase.from('income_sources').select('source_name, amount, net_amount, frequency, master_item_key, employer_name').eq('user_id', userId).eq('is_active', true).range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase
          .from('expense_items')
          .select('expense_name, amount, frequency, is_essential, master_item_key, expense_category')
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
          .select('balance, interest_rate, monthly_repayment, debt_type, master_item_key, interest_rate_type, fixed_rate_expiry, credit_limit, country_code, currency_code')
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
          .select('policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days')
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
        .select('snapshot_month, net_worth, monthly_income, monthly_expenses, monthly_surplus, savings_rate, total_assets, total_liabilities')
        .eq('user_id', userId)
        .order('snapshot_month', { ascending: true })
        .limit(12),
      getFxRateAudInr(supabase),
    ]);

  const currency = (profile.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const summary = computeDashboard(
    {
      income,
      expenses,
      assets,
      liabilities,
      investments,
      retirement,
      insurance,
      goals,
      snapshots: snapshots.data ?? [],
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
    },
    { onConflict: 'user_id,snapshot_month' }
  );

  return summary;
}
