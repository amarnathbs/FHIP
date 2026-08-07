import { createClient } from '@/lib/supabase/server';
import type { SupabaseServerClient } from './dashboardData';
import { getFxRateAudInr } from './dashboardData';
import { computeDashboard, type DashboardSummary, computeInsuranceAdequacy } from '@/lib/engines/dashboard';
import { toMonthly } from '@/lib/engines/money';
import { loadHealthScore, type HealthScorePayload } from './healthScoreData';
import { loadResilience, type ResiliencePayload } from './resilienceData';
import { loadFinancialDna } from './financialDnaData';
import { computeGoalsPagePayload, type GoalsPagePayload } from './goalsData';
import type { DnaResult } from '@/lib/engines/financialDna';
import { ageFromDateOfBirth, ageToAgeBand, normalizeEmploymentType, normalizeHouseholdType, deriveLifeStage, annualGrossIncomeToIncomeBand } from '@/lib/engines/twin/taxonomy';
import type { AgeBand, EmploymentType, HouseholdTypeCode, IncomeBand, LifeStage } from '@/lib/engines/twin/taxonomy';

export interface TwinRetirementRow {
  current_balance: number;
  employer_contribution: number | null;
  personal_contribution: number | null;
  contribution_frequency: string | null;
  country_code: string | null;
  target_retirement_age: number | null;
  account_type: string;
}
export interface TwinInsuranceRow {
  cover_amount: number;
  premium: number;
  premium_frequency: string;
  cover_type: string;
  waiting_period_days: number | null;
}
export interface TwinInvestmentRow {
  current_value: number;
  investment_type: string;
  country_code: string | null;
  currency_code: string | null;
}
export interface TwinLiabilityRow {
  balance: number;
  debt_type: string;
  interest_rate: number | null;
  country_code: string | null;
  currency_code: string | null;
}
export interface TwinAssetRow {
  current_value: number;
  asset_class: string;
  country_code: string | null;
  currency_code: string | null;
}

export interface TwinHouseholdContext {
  countryOfResidence: 'AU' | 'IN';
  secondaryCountry: 'AU' | 'IN' | null;
  preferredCurrency: 'AUD' | 'INR';
  age: number | null;
  ageBand: AgeBand | null;
  dependantsCount: number;
  employmentType: EmploymentType;
  householdTypeCode: HouseholdTypeCode;
  housingTenure: string | null;
  residenceType: string | null;
  lifeStage: LifeStage;
  incomeBand: IncomeBand;
  isCrossBorder: boolean;
  dnaProfileCode: string | null;
}

export interface TwinSourceData {
  userId: string;
  household: TwinHouseholdContext;
  dashboard: DashboardSummary;
  insuranceAdequacy: ReturnType<typeof computeInsuranceAdequacy>;
  healthScore: HealthScorePayload;
  resilience: ResiliencePayload;
  dna: DnaResult | null;
  goals: GoalsPagePayload;
  rawRetirement: TwinRetirementRow[];
  rawInsurance: TwinInsuranceRow[];
  rawInvestments: TwinInvestmentRow[];
  rawLiabilities: TwinLiabilityRow[];
  rawAssets: TwinAssetRow[];
  expenseHousingMonthly: number;
  remittanceMonthly: number;
  snapshots12m: { month: string; netWorth: number; monthlyIncome: number; monthlyExpenses: number; monthlySurplus: number }[];
  hasMinimumData: boolean;
}

export async function loadTwinSourceData(userId: string, client?: SupabaseServerClient): Promise<TwinSourceData> {
  const supabase = client ?? (await createClient());

  const [profileRes, householdRes, expensesRes, retirementRes, insuranceRes, investmentsRes, liabilitiesRes, assetsRes, snapshotsRes] =
    await Promise.all([
      supabase.from('user_profiles').select('date_of_birth, employment_status, country_of_residence, secondary_country, preferred_currency').eq('user_id', userId).single(),
      supabase.from('households').select('household_type, marital_status, dependants_count, housing_tenure, residence_type, primary_country').eq('user_id', userId).maybeSingle(),
      supabase.from('expense_items').select('amount, frequency, master_item_key, is_essential').eq('user_id', userId).eq('is_active', true),
      supabase.from('retirement_accounts').select('current_balance, employer_contribution, personal_contribution, contribution_frequency, country_code, target_retirement_age, account_type').eq('user_id', userId).eq('is_active', true),
      supabase.from('insurance_policies').select('cover_amount, premium, premium_frequency, cover_type, waiting_period_days').eq('user_id', userId).eq('is_active', true),
      supabase.from('investments').select('current_value, investment_type, country_code, currency_code').eq('user_id', userId).eq('is_active', true),
      supabase.from('liabilities').select('balance, debt_type, interest_rate, country_code, currency_code').eq('user_id', userId).eq('is_active', true),
      supabase.from('assets').select('current_value, asset_class, country_code, currency_code').eq('user_id', userId).eq('is_active', true),
      supabase.from('financial_snapshots').select('snapshot_month, net_worth, monthly_income, monthly_expenses, monthly_surplus').eq('user_id', userId).order('snapshot_month', { ascending: true }).limit(12),
    ]);

  const [dashboard, healthScore, resilience, dna, goalsResult] = await Promise.all([
    loadDashboardForTwin(userId, supabase),
    loadHealthScore(userId, supabase),
    loadResilience(userId, supabase),
    loadFinancialDna(userId, supabase),
    computeGoalsPagePayload(userId, supabase),
  ]);
  const goals = goalsResult.payload;

  const profile = profileRes.data;
  const household = householdRes.data;
  const countryOfResidence = (profile?.country_of_residence as 'AU' | 'IN') ?? 'AU';
  const secondaryCountry = (profile?.secondary_country as 'AU' | 'IN' | null) ?? null;
  const age = profile?.date_of_birth ? ageFromDateOfBirth(profile.date_of_birth) : null;
  const ageBand = age !== null ? ageToAgeBand(age) : null;
  const dependantsCount = household?.dependants_count ?? 0;
  const employmentType = normalizeEmploymentType(profile?.employment_status ?? null);
  const householdTypeCode = normalizeHouseholdType(household?.household_type ?? null, dependantsCount);
  const lifeStage = deriveLifeStage({ ageBand, dependantsCount, employmentType });
  const annualGrossIncome = dashboard.grossMonthlyIncome * 12;
  const incomeBand = annualGrossIncomeToIncomeBand(countryOfResidence, annualGrossIncome);
  const isCrossBorder = Boolean(secondaryCountry) || dashboard.countriesInUse.length > 1;

  const expenseHousingMonthly = (expensesRes.data ?? [])
    .filter((e) => e.master_item_key === 'mortgage' || e.master_item_key === 'rent' || e.master_item_key === 'council_rates' || e.master_item_key === 'strata_fees')
    .reduce((sum, e) => sum + toMonthly(Number(e.amount), e.frequency as Parameters<typeof toMonthly>[1]), 0);
  const remittanceMonthly = (expensesRes.data ?? [])
    .filter((e) => e.master_item_key === 'family_support_remittance')
    .reduce((sum, e) => sum + toMonthly(Number(e.amount), e.frequency as Parameters<typeof toMonthly>[1]), 0);

  const insuranceAdequacy = computeInsuranceAdequacy(dashboard, dependantsCount);

  const snapshots12m = (snapshotsRes.data ?? []).map((s) => ({
    month: s.snapshot_month as string,
    netWorth: Number(s.net_worth ?? 0),
    monthlyIncome: Number(s.monthly_income ?? 0),
    monthlyExpenses: Number(s.monthly_expenses ?? 0),
    monthlySurplus: Number(s.monthly_surplus ?? 0),
  }));

  const hasMinimumData =
    Boolean(profile?.country_of_residence) &&
    age !== null &&
    dashboard.hasIncome &&
    dashboard.hasExpenses &&
    (dashboard.hasAssets || dashboard.hasLiabilities);

  return {
    userId,
    household: {
      countryOfResidence,
      secondaryCountry,
      preferredCurrency: (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD',
      age,
      ageBand,
      dependantsCount,
      employmentType,
      householdTypeCode,
      housingTenure: household?.housing_tenure ?? null,
      residenceType: household?.residence_type ?? null,
      lifeStage,
      incomeBand,
      isCrossBorder,
      dnaProfileCode: dna?.primaryProfileCode ?? null,
    },
    dashboard,
    insuranceAdequacy,
    healthScore,
    resilience,
    dna,
    goals,
    rawRetirement: (retirementRes.data ?? []) as TwinRetirementRow[],
    rawInsurance: (insuranceRes.data ?? []) as TwinInsuranceRow[],
    rawInvestments: (investmentsRes.data ?? []) as TwinInvestmentRow[],
    rawLiabilities: (liabilitiesRes.data ?? []) as TwinLiabilityRow[],
    rawAssets: (assetsRes.data ?? []) as TwinAssetRow[],
    expenseHousingMonthly,
    remittanceMonthly,
    snapshots12m,
    hasMinimumData,
  };
}

// Loads the shared dashboard summary without re-deriving any ratio the Twin
// itself needs — reuses computeDashboard directly (the same engine
// loadDashboard uses) so this module never recalculates a financial ratio.
async function loadDashboardForTwin(userId: string, supabase: SupabaseServerClient): Promise<DashboardSummary> {
  const [profile, income, expenses, assets, liabilities, investments, retirement, insurance, goals, snapshots, fxRateAudInr] = await Promise.all([
    supabase.from('user_profiles').select('preferred_currency').eq('user_id', userId).single(),
    supabase.from('income_sources').select('amount, net_amount, frequency, master_item_key, employer_name').eq('user_id', userId).eq('is_active', true),
    supabase.from('expense_items').select('expense_name, amount, frequency, is_essential, master_item_key, expense_category').eq('user_id', userId).eq('is_active', true),
    supabase.from('assets').select('current_value, asset_class, country_code, currency_code').eq('user_id', userId).eq('is_active', true),
    supabase.from('liabilities').select('balance, interest_rate, monthly_repayment, debt_type, interest_rate_type, fixed_rate_expiry, credit_limit, country_code, currency_code').eq('user_id', userId).eq('is_active', true),
    supabase.from('investments').select('current_value, cost_base, investment_type, country_code, annual_contribution, institution, currency_code').eq('user_id', userId).eq('is_active', true),
    supabase.from('retirement_accounts').select('current_balance, employer_contribution, personal_contribution, contribution_frequency, country_code, currency_code').eq('user_id', userId).eq('is_active', true),
    supabase.from('insurance_policies').select('policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days').eq('user_id', userId).eq('is_active', true),
    supabase.from('user_goals').select('goal_name, target_amount, current_amount, currency_code, target_date, priority, status').eq('user_id', userId).eq('status', 'active'),
    supabase.from('financial_snapshots').select('snapshot_month, net_worth, monthly_income, monthly_expenses, monthly_surplus, savings_rate, total_assets, total_liabilities').eq('user_id', userId).order('snapshot_month', { ascending: true }).limit(12),
    getFxRateAudInr(supabase),
  ]);
  const currency = (profile.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';
  return computeDashboard(
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
    currency,
    fxRateAudInr
  );
}

