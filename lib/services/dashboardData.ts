import { createClient } from '@/lib/supabase/server';
import { computeDashboard, type DashboardSummary } from '@/lib/engines/dashboard';

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

// Accepts an optional pre-built client so the scheduled report-generation job
// (which has no per-request cookie session) can pass a service-role client
// instead — every other call site is unaffected and keeps using its own
// cookie-based session client.
export async function loadDashboard(userId: string, client?: SupabaseServerClient): Promise<DashboardSummary> {
  const supabase = client ?? (await createClient());

  const [profile, income, expenses, assets, liabilities, investments, retirement, insurance, goals, snapshots] =
    await Promise.all([
      supabase.from('user_profiles').select('preferred_currency').eq('user_id', userId).single(),
      supabase.from('income_sources').select('source_name, amount, net_amount, frequency, master_item_key, employer_name').eq('user_id', userId).eq('is_active', true),
      supabase
        .from('expense_items')
        .select('expense_name, amount, frequency, is_essential, master_item_key, expense_category')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase.from('assets').select('current_value, asset_class, country_code').eq('user_id', userId).eq('is_active', true),
      supabase
        .from('liabilities')
        .select('balance, interest_rate, monthly_repayment, debt_type, interest_rate_type, fixed_rate_expiry, credit_limit, country_code')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase
        .from('investments')
        .select('current_value, cost_base, investment_type, country_code, annual_contribution, institution')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase
        .from('retirement_accounts')
        .select('current_balance, employer_contribution, personal_contribution, contribution_frequency, country_code')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase
        .from('insurance_policies')
        .select('policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase
        .from('user_goals')
        .select('goal_name, target_amount, current_amount, currency_code, target_date, priority, status')
        .eq('user_id', userId)
        .eq('status', 'active'),
      supabase
        .from('financial_snapshots')
        .select('snapshot_month, net_worth, monthly_income, monthly_expenses, monthly_surplus, savings_rate, total_assets, total_liabilities')
        .eq('user_id', userId)
        .order('snapshot_month', { ascending: true })
        .limit(12),
    ]);

  const currency = (profile.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const summary = computeDashboard(
    {
      income: income.data ?? [],
      expenses: expenses.data ?? [],
      assets: assets.data ?? [],
      liabilities: liabilities.data ?? [],
      investments: investments.data ?? [],
      retirement: retirement.data ?? [],
      insurance: insurance.data ?? [],
      goals: goals.data ?? [],
      snapshots: snapshots.data ?? [],
    },
    currency
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
