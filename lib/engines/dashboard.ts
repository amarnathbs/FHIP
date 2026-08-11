import { toMonthly, type Frequency } from './money';
import { convertToReportingCurrency, type SupportedCurrency } from './fx';

// ---------------------------------------------------------------------------
// Input row shapes (the subset of each register's columns the dashboard uses)
// ---------------------------------------------------------------------------

export interface IncomeRow {
  source_name?: string | null;
  amount: number;
  net_amount: number | null;
  frequency: Frequency;
  master_item_key: string | null;
  employer_name?: string | null;
}
export interface ExpenseRow {
  expense_name: string;
  amount: number;
  frequency: Frequency;
  is_essential: boolean;
  master_item_key?: string | null;
  expense_category?: string | null;
}
export interface AssetRow {
  current_value: number;
  asset_class: string;
  master_item_key?: string | null;
  country_code?: string | null;
  currency_code?: string | null;
}
export interface LiabilityRow {
  balance: number;
  interest_rate: number | null;
  monthly_repayment: number;
  debt_type: string;
  master_item_key?: string | null;
  interest_rate_type?: 'fixed' | 'variable' | null;
  fixed_rate_expiry?: string | null;
  credit_limit?: number | null;
  country_code?: string | null;
  currency_code?: string | null;
}
export interface InvestmentRow {
  current_value: number;
  cost_base: number | null;
  investment_type: string;
  master_item_key?: string | null;
  country_code: string | null;
  annual_contribution: number | null;
  institution?: string | null;
  currency_code?: string | null;
}
export interface RetirementRow {
  current_balance: number;
  employer_contribution: number | null;
  personal_contribution: number | null;
  contribution_frequency: Frequency | null;
  country_code?: string | null;
  currency_code?: string | null;
}
export interface InsuranceRow {
  policy_name: string;
  cover_amount: number;
  premium: number;
  premium_frequency: Frequency;
  cover_type: string;
  renewal_date: string | null;
  waiting_period_days?: number | null;
}
export interface GoalRow {
  goal_name: string;
  target_amount: number;
  current_amount: number;
  currency_code: string;
  target_date: string | null;
  priority: string;
  status: string;
}
export interface SnapshotRow {
  snapshot_month: string;
  net_worth: number;
  monthly_income: number;
  monthly_expenses: number;
  monthly_surplus: number;
  savings_rate: number | null;
  total_assets: number;
  total_liabilities: number;
}

export interface DashboardInput {
  income: IncomeRow[];
  expenses: ExpenseRow[];
  assets: AssetRow[];
  liabilities: LiabilityRow[];
  investments: InvestmentRow[];
  retirement: RetirementRow[];
  insurance: InsuranceRow[];
  goals: GoalRow[];
  snapshots: SnapshotRow[]; // most recent last
}

// Income sources not derived from active work — used for passive-income and
// financial-independence ratios.
const PASSIVE_INCOME_KEYS = new Set([
  'rental_income',
  'airbnb_income',
  'interest_income',
  'dividend_income',
  'managed_fund_distribution',
  'capital_gains',
  'trust_distribution',
  'partnership_distribution',
  'royalty_income',
  'super_pension',
  'annuity_income',
  'government_pension',
  'age_pension',
  'disability_pension',
  'family_tax_benefit',
  'child_support_received',
  'overseas_income',
]);

// Approximates the Level 1 "Core Survival" expense tier (housing, utilities,
// groceries, essential health, minimum transport) from existing master-item
// tags, since expenses aren't separately tiered in the data model. Only
// counted when the row is also marked essential by the user.
const CORE_SURVIVAL_EXPENSE_KEYS = new Set([
  'mortgage',
  'rent',
  'council_rates',
  'water_rates',
  'electricity',
  'gas',
  'water',
  'groceries',
  'health_insurance',
  'medical',
  'pharmacy',
  'fuel',
  'public_transport',
]);

export type AllocationBucket =
  | 'cash'
  | 'property'
  | 'shares'
  | 'super'
  | 'business'
  | 'fixed_income'
  | 'crypto'
  | 'gold'
  | 'other';

// asset_class (lib/validation/asset.ts) is a 5-value enum ('cash'|'property'|
// 'vehicle'|'business'|'other') that the real grid UI (lib/grid/configs.ts)
// never actually collects — every row created through the live app leaves it
// at its Zod default ('other'), same root cause already fixed for the
// Forecasting Engine's investment-return mapping (see
// lib/engines/forecast/investmentCalculator.ts's MASTER_ITEM_TO_ASSET_CLASS
// comment: "master_item_key is the reliable asset-class signal — the grid
// always sets it; investment_type/asset_class/debt_type it does not
// collect at all"). Without this, liquidAssets was silently 0 for every
// real user (never just this test's synthetic data), which cascades into
// emergencyFundMonths, liquidAssetRatio and propertyConcentration always
// reading 0 too. Keyed from the same master_financial_items catalogue
// (supabase/seed_master_items.sql, 'asset' category, 39 items).
const MASTER_ASSET_ITEM_TO_BUCKET: Record<string, AllocationBucket> = {
  wallet_cash: 'cash',
  savings_account: 'cash',
  cheque_account: 'cash',
  offset_account: 'cash',
  term_deposits: 'cash',
  foreign_currency: 'cash',
  principal_residence: 'property',
  investment_property: 'property',
  holiday_home: 'property',
  vacant_land: 'property',
  commercial_property: 'property',
  farm: 'property',
  business_ownership: 'business',
  partnership_interest: 'business',
  gold: 'gold',
  silver: 'gold',
  cryptocurrency: 'crypto',
  shares: 'shares',
  etfs: 'shares',
  managed_funds: 'shares',
  bonds: 'fixed_income',
};

export function bucketAssetClass(assetClass: string, masterItemKey?: string | null): AllocationBucket {
  const fromCatalog = masterItemKey ? MASTER_ASSET_ITEM_TO_BUCKET[masterItemKey] : undefined;
  if (fromCatalog) return fromCatalog;
  if (assetClass === 'cash') return 'cash';
  if (assetClass === 'property') return 'property';
  if (assetClass === 'business') return 'business';
  return 'other';
}

// Same root cause and fix pattern as MASTER_ASSET_ITEM_TO_BUCKET above.
// investment_type (lib/validation/investment.ts) is likewise never
// collected by the grid. Keyed from master_financial_items' 'investment'
// category (32 items) — the type-string checks below (kept as a secondary
// fallback for rows set directly via the API rather than the grid) already
// assumed catalog-style plural keys like 'etfs'/'managed_funds', not the
// singular Zod enum values ('etf'/'managed_fund'), which was itself a sign
// this mapping was written for master_item_key and just never wired to it.
const MASTER_INVESTMENT_ITEM_TO_BUCKET: Record<string, AllocationBucket> = {
  cash_investments: 'cash',
  high_interest_savings: 'cash',
  term_deposits: 'cash',
  property: 'property',
  commercial_property: 'property',
  reits: 'property',
  bonds: 'fixed_income',
  government_bonds: 'fixed_income',
  corporate_bonds: 'fixed_income',
  gold: 'gold',
  silver: 'gold',
  cryptocurrency: 'crypto',
  business_investment: 'business',
  partnership_investment: 'business',
  shares: 'shares',
  etfs: 'shares',
  managed_funds: 'shares',
  index_funds: 'shares',
  australian_shares: 'shares',
  international_shares: 'shares',
};

export function bucketInvestmentType(type: string, masterItemKey?: string | null): AllocationBucket {
  const fromCatalog = masterItemKey ? MASTER_INVESTMENT_ITEM_TO_BUCKET[masterItemKey] : undefined;
  if (fromCatalog) return fromCatalog;
  if (['cash_investments', 'high_interest_savings', 'term_deposits'].includes(type)) return 'cash';
  if (['property', 'commercial_property', 'reits'].includes(type)) return 'property';
  if (['bonds', 'government_bonds', 'corporate_bonds'].includes(type)) return 'fixed_income';
  if (type === 'gold' || type === 'silver') return 'gold';
  if (type === 'cryptocurrency') return 'crypto';
  if (['business_investment', 'partnership_investment'].includes(type)) return 'business';
  if (
    ['shares', 'etfs', 'managed_funds', 'index_funds', 'australian_shares', 'international_shares'].includes(type)
  )
    return 'shares';
  return 'other';
}

// debt_type (lib/validation/liability.ts) has the same never-collected-by-
// the-grid problem — GOOD_DEBT_TYPES below already contained catalog-style
// keys ('investment_loan', 'hecs_help') that don't even exist in debt_type's
// own 6-value Zod enum, a strong sign this was always meant to check
// master_item_key. 'mortgage' (the Zod enum spelling) is kept alongside
// 'home_loan' (the catalog spelling) so a row set either way still counts.
const GOOD_DEBT_MASTER_ITEMS = new Set(['home_loan', 'investment_loan', 'construction_loan', 'education_loan', 'hecs_help', 'business_loan']);
export function isGoodDebt(debtType: string, masterItemKey?: string | null): boolean {
  if (masterItemKey) return GOOD_DEBT_MASTER_ITEMS.has(masterItemKey) || debtType === 'mortgage';
  return debtType === 'mortgage' || GOOD_DEBT_MASTER_ITEMS.has(debtType);
}
export function isCreditCardDebt(debtType: string, masterItemKey?: string | null): boolean {
  return masterItemKey === 'credit_card' || masterItemKey === 'store_card' || debtType === 'credit_card';
}

function sumMonthly<T>(rows: T[], amountField: keyof T, freqField: keyof T): number {
  return rows.reduce((sum, r) => sum + toMonthly(Number(r[amountField]), r[freqField] as Frequency), 0);
}

// Standard loan amortisation: months to pay off a balance at a monthly rate
// with a fixed monthly payment. Returns null if the payment never covers the
// accruing interest (balance would grow forever).
export function estimateMonthsToPayoff(
  balance: number,
  annualRatePct: number | null,
  monthlyRepayment: number
): number | null {
  if (monthlyRepayment <= 0 || balance <= 0) return null;
  const r = (annualRatePct ?? 0) / 100 / 12;
  if (r <= 0) return Math.ceil(balance / monthlyRepayment);
  if (monthlyRepayment <= r * balance) return null;
  const months = -Math.log(1 - (r * balance) / monthlyRepayment) / Math.log(1 + r);
  return Math.ceil(months);
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export type RatioStatus = 'good' | 'caution' | 'risk' | 'neutral';

export interface RatioResult {
  key: string;
  label: string;
  value: number | null; // as a plain number (e.g. 0.23 for 23%, or a multiple like 2.5)
  format: 'percent' | 'multiple' | 'months';
  benchmarkLabel: string;
  status: RatioStatus;
}

export interface AllocationSlice {
  bucket: AllocationBucket;
  value: number;
}

export interface DashboardSummary {
  currency: 'AUD' | 'INR';

  // Cash flow
  grossMonthlyIncome: number;
  netMonthlyIncome: number;
  passiveMonthlyIncome: number;
  activeMonthlyIncome: number;
  essentialMonthlyExpenses: number;
  coreSurvivalMonthlyExpenses: number; // Level 1 subset of essential expenses (see CORE_SURVIVAL_EXPENSE_KEYS)
  lifestyleMonthlyExpenses: number;
  debtMonthlyRepayments: number;
  totalMonthlyExpenses: number; // essential + lifestyle (excludes debt repayments, tracked separately)
  monthlySurplus: number;
  savingsRate: number | null;
  operatingCashFlow: number; // net income after essential expenses only
  disposableIncome: number; // operating cash flow after debt repayments
  cashFlowRatio: number | null; // surplus / total expenses
  topExpenses: { name: string; monthlyAmount: number }[];
  topIncome: { name: string; monthlyAmount: number }[];
  incomeSourceCount: number;
  largestIncomeSharePct: number | null; // 0-1, largest single income row's share of gross income
  discretionaryRatio: number | null; // lifestyle expenses / income
  employerConcentration: number | null; // 0-1 HHI across distinct employers; null if no employer data recorded
  hasInvestments: boolean;
  hasRetirement: boolean;
  hasInsurance: boolean;

  // Net worth
  totalAssets: number; // property/cash/other assets only — excludes investments and retirement, which are tracked separately below
  totalAssetsCombined: number; // totalAssets + totalInvestments + totalRetirement — the figure to show as "total assets" anywhere net worth is also shown, so the two reconcile
  totalInvestments: number;
  totalRetirement: number;
  totalLiabilities: number;
  netWorth: number;
  netWorthAllocation: AllocationSlice[];
  liabilityByType: { debtType: string; balance: number }[];
  liquidAssetRatio: number | null; // liquid assets / total assets
  propertyConcentration: number | null; // property bucket / total assets
  assetsByCountry: { countryCode: string; value: number }[];
  liabilitiesByCountry: { countryCode: string; value: number }[];
  retirementByCountry: { countryCode: string; value: number }[];
  countriesInUse: string[]; // distinct country_code values recorded anywhere, for cross-border section eligibility

  // Savings / emergency fund
  liquidAssets: number;
  emergencyFundMonths: number | null;

  // Debt
  averageInterestRate: number | null;
  debtToIncome: number | null;
  debtServiceRatio: number | null;
  liabilitiesWithPayoff: { debtType: string; balance: number; monthsToPayoff: number | null }[];
  goodDebt: number;
  badDebt: number;
  variableRateDebtBalance: number;
  variableRateDebtRatio: number | null; // balance-weighted; null if no liability has interest_rate_type recorded
  upcomingRateResetBalance12m: number; // fixed-rate balance expiring within 12 months
  creditUtilization: number | null; // credit-card balance / credit limit; null if no credit_limit recorded

  // Investments
  investmentCostBase: number;
  investmentUnrealisedGain: number;
  investmentDiversificationScore: number | null; // 0-100, higher = more diversified
  investmentByCountry: { countryCode: string; value: number }[];
  institutionConcentration: number | null; // 0-1 HHI across investment institutions; null if no institution data
  dividendMonthlyIncome: number;
  dividendYield: number | null; // annualised
  rentalMonthlyIncome: number; // rental_income + airbnb_income master items

  // Retirement
  retirementEmployerMonthlyContribution: number;
  retirementPersonalMonthlyContribution: number;
  investmentAnnualContribution: number;
  investmentContributionRate: number | null; // investment contributions / income
  retirementContributionRate: number | null; // employer + personal retirement contributions / income
  retirementEmployerContributionRate: number | null; // employer retirement contributions only / income — the genuinely additive portion, since it's never part of take-home pay (unlike personal retirement/investment contributions, which come out of the same income already reflected in savingsRate)

  // Insurance
  insuranceByType: { coverType: string; coverAmount: number; annualPremium: number }[];
  totalAnnualPremium: number;
  upcomingRenewals: { policyName: string; renewalDate: string }[];
  incomeProtectionWaitingPeriodDays: number | null; // longest waiting period across income-protection policies

  // Ratios (section 11)
  ratios: RatioResult[];

  // History
  snapshots: SnapshotRow[];

  // Goals (pass-through; computed progress happens in the UI layer)
  goals: GoalRow[];

  // Data completeness
  hasIncome: boolean;
  hasExpenses: boolean;
  hasAssets: boolean;
  hasLiabilities: boolean;
}

function ratio(
  key: string,
  label: string,
  value: number | null,
  format: RatioResult['format'],
  benchmarkLabel: string,
  status: RatioStatus
): RatioResult {
  return { key, label, value, format, benchmarkLabel, status };
}

// Matches crossBorderCalculator.ts's DEFAULT_FX_RATE_AUD_INR and the
// forecast_global_assumptions seed row — used only when no live rate is
// supplied, so single-currency households (the vast majority of callers)
// are entirely unaffected.
const DEFAULT_FX_RATE_AUD_INR = 56;

function toSupportedCurrency(code: string | null | undefined): SupportedCurrency | null {
  return code === 'AUD' || code === 'INR' ? code : null;
}

export function computeDashboard(input: DashboardInput, currency: 'AUD' | 'INR', fxRateAudInr: number = DEFAULT_FX_RATE_AUD_INR): DashboardSummary {
  // Converts a row's own-currency amount to the household's reporting
  // currency before it enters totalAssets/totalInvestments/totalRetirement/
  // totalLiabilities (and the allocation chart, which must stay consistent
  // with those totals). Rows with no currency_code, or one this app doesn't
  // recognise, are assumed to already be in the reporting currency — this
  // keeps every existing single-currency household byte-for-byte unchanged.
  // Per-country breakdowns (assetsByCountry etc., below) deliberately do NOT
  // go through this — the cross-border report section shows those "as
  // recorded, in each country's own currency" by design.
  function reportingValue(rowCurrencyCode: string | null | undefined, amount: number): number {
    const rowCurrency = toSupportedCurrency(rowCurrencyCode);
    if (!rowCurrency) return amount;
    return convertToReportingCurrency(amount, rowCurrency, currency, fxRateAudInr);
  }
  const grossMonthlyIncome = sumMonthly(input.income, 'amount', 'frequency');
  const netMonthlyIncome = input.income.reduce((sum, r) => {
    const monthly = toMonthly(r.net_amount ?? r.amount, r.frequency);
    return sum + monthly;
  }, 0);
  const passiveMonthlyIncome = input.income
    .filter((r) => r.master_item_key && PASSIVE_INCOME_KEYS.has(r.master_item_key))
    .reduce((sum, r) => sum + toMonthly(r.amount, r.frequency), 0);
  const activeMonthlyIncome = grossMonthlyIncome - passiveMonthlyIncome;

  // 'debt_repayment'-category expense rows and the liabilities table's
  // monthly_repayment represent the same cash outflow when a user tracks a
  // loan repayment as an expense line — excluded here so debtMonthlyRepayments
  // (below) is the only source of debt cash-flow, matching this field's own
  // long-standing "excludes debt repayments, tracked separately" comment.
  const nonDebtExpenses = input.expenses.filter((r) => r.expense_category !== 'debt_repayment');
  const essentialMonthlyExpenses = sumMonthly(
    nonDebtExpenses.filter((r) => r.is_essential),
    'amount',
    'frequency'
  );
  const coreSurvivalMonthlyExpenses = sumMonthly(
    nonDebtExpenses.filter((r) => r.is_essential && r.master_item_key && CORE_SURVIVAL_EXPENSE_KEYS.has(r.master_item_key)),
    'amount',
    'frequency'
  );
  const lifestyleMonthlyExpenses = sumMonthly(
    nonDebtExpenses.filter((r) => !r.is_essential),
    'amount',
    'frequency'
  );
  const totalMonthlyExpenses = essentialMonthlyExpenses + lifestyleMonthlyExpenses;
  // Same reporting-currency conversion as the balance totals above — a
  // foreign-currency liability's repayment must not be added raw into a
  // reporting-currency cash-flow figure (monthlySurplus, disposableIncome).
  const debtMonthlyRepayments = input.liabilities.reduce((sum, r) => sum + reportingValue(r.currency_code, r.monthly_repayment ?? 0), 0);

  const incomeForSurplus = netMonthlyIncome || grossMonthlyIncome;
  const monthlySurplus = incomeForSurplus - totalMonthlyExpenses - debtMonthlyRepayments;
  const savingsRate = incomeForSurplus > 0 ? monthlySurplus / incomeForSurplus : null;
  const operatingCashFlow = incomeForSurplus - essentialMonthlyExpenses;
  const disposableIncome = operatingCashFlow - debtMonthlyRepayments;
  const totalOutflow = totalMonthlyExpenses + debtMonthlyRepayments;
  const cashFlowRatio = totalOutflow > 0 ? monthlySurplus / totalOutflow : null;
  const topExpenses = input.expenses
    .map((e) => ({ name: e.expense_name, monthlyAmount: toMonthly(e.amount, e.frequency) }))
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
    .slice(0, 5);
  const topIncome = input.income
    .map((r) => ({ name: r.source_name ?? r.employer_name ?? 'Income source', monthlyAmount: toMonthly(r.amount, r.frequency) }))
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
    .slice(0, 5);
  const incomeSourceCount = input.income.length;
  const incomeMonthlyAmounts = input.income.map((r) => toMonthly(r.amount, r.frequency));
  const largestIncomeSharePct =
    grossMonthlyIncome > 0 && incomeMonthlyAmounts.length > 0
      ? Math.max(...incomeMonthlyAmounts) / grossMonthlyIncome
      : null;
  const discretionaryRatio = incomeForSurplus > 0 ? lifestyleMonthlyExpenses / incomeForSurplus : null;

  const activeIncomeRows = input.income.filter((r) => !r.master_item_key || !PASSIVE_INCOME_KEYS.has(r.master_item_key));
  const employerMap = new Map<string, number>();
  for (const r of activeIncomeRows) {
    if (!r.employer_name) continue;
    const monthly = toMonthly(r.amount, r.frequency);
    employerMap.set(r.employer_name, (employerMap.get(r.employer_name) ?? 0) + monthly);
  }
  const activeIncomeTotal = Array.from(employerMap.values()).reduce((sum, v) => sum + v, 0);
  const employerConcentration =
    employerMap.size > 0 && activeIncomeTotal > 0
      ? Array.from(employerMap.values()).reduce((sum, v) => sum + (v / activeIncomeTotal) ** 2, 0)
      : null;

  const totalAssets = input.assets.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_value), 0);
  const totalInvestments = input.investments.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_value), 0);
  const totalRetirement = input.retirement.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_balance), 0);
  const totalLiabilities = input.liabilities.reduce((sum, r) => sum + reportingValue(r.currency_code, r.balance), 0);
  const netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities;

  const allocationMap = new Map<AllocationBucket, number>();
  const addAlloc = (bucket: AllocationBucket, value: number) =>
    allocationMap.set(bucket, (allocationMap.get(bucket) ?? 0) + value);
  for (const a of input.assets) addAlloc(bucketAssetClass(a.asset_class, a.master_item_key), reportingValue(a.currency_code, a.current_value));
  for (const i of input.investments) addAlloc(bucketInvestmentType(i.investment_type, i.master_item_key), reportingValue(i.currency_code, i.current_value));
  if (totalRetirement > 0) addAlloc('super', totalRetirement);
  const netWorthAllocation: AllocationSlice[] = Array.from(allocationMap.entries()).map(([bucket, value]) => ({
    bucket,
    value,
  }));

  const liabilityTypeMap = new Map<string, number>();
  for (const l of input.liabilities) {
    const key = l.master_item_key ?? l.debt_type;
    liabilityTypeMap.set(key, (liabilityTypeMap.get(key) ?? 0) + l.balance);
  }
  const liabilityByType = Array.from(liabilityTypeMap.entries()).map(([debtType, balance]) => ({ debtType, balance }));

  // Cross-border rollups — reuses the country_code already recorded on each
  // register row rather than introducing a new classification.
  function byCountry<T>(rows: T[], valueField: keyof T, countryField: keyof T): { countryCode: string; value: number }[] {
    const map = new Map<string, number>();
    for (const r of rows) {
      const code = r[countryField] as unknown as string | null | undefined;
      if (!code) continue;
      map.set(code, (map.get(code) ?? 0) + Number(r[valueField]));
    }
    return Array.from(map.entries()).map(([countryCode, value]) => ({ countryCode, value }));
  }
  const assetsByCountry = byCountry(input.assets, 'current_value', 'country_code');
  const liabilitiesByCountry = byCountry(input.liabilities, 'balance', 'country_code');
  const retirementByCountry = byCountry(input.retirement, 'current_balance', 'country_code');

  const liquidAssets = allocationMap.get('cash') ?? 0;
  const emergencyFundMonths = essentialMonthlyExpenses > 0 ? liquidAssets / essentialMonthlyExpenses : null;
  const totalAssetBaseForRatios = totalAssets + totalInvestments + totalRetirement;
  const liquidAssetRatio = totalAssetBaseForRatios > 0 ? liquidAssets / totalAssetBaseForRatios : null;
  const propertyConcentration =
    totalAssetBaseForRatios > 0 ? (allocationMap.get('property') ?? 0) / totalAssetBaseForRatios : null;

  const liabilitiesWithRate = input.liabilities.filter((r) => r.interest_rate !== null);
  const balanceWithRate = liabilitiesWithRate.reduce((sum, r) => sum + r.balance, 0);
  const totalInterestWeighted = liabilitiesWithRate.reduce((sum, r) => sum + r.interest_rate! * r.balance, 0);
  const averageInterestRate = balanceWithRate > 0 ? totalInterestWeighted / balanceWithRate : null;
  const annualGrossIncome = grossMonthlyIncome * 12;
  const debtToIncome = annualGrossIncome > 0 ? totalLiabilities / annualGrossIncome : null;
  // Net income, not gross — matches the report spec's own definition
  // ("percentage of net monthly income required to meet scheduled debt
  // repayments") and every other ratio in this file that already divides by
  // incomeForSurplus. Previously divided by gross income, which silently
  // disagreed with the report copy's stated definition.
  const debtServiceRatio = incomeForSurplus > 0 ? debtMonthlyRepayments / incomeForSurplus : null;
  const liabilitiesWithPayoff = input.liabilities.map((l) => ({
    debtType: l.master_item_key ?? l.debt_type,
    balance: l.balance,
    monthsToPayoff: estimateMonthsToPayoff(l.balance, l.interest_rate, l.monthly_repayment),
  }));
  let goodDebt = 0;
  let badDebt = 0;
  for (const l of input.liabilities) {
    if (isGoodDebt(l.debt_type, l.master_item_key)) goodDebt += l.balance;
    else badDebt += l.balance;
  }

  const liabilitiesWithRateType = input.liabilities.filter((l) => (l.interest_rate_type ?? null) !== null);
  const rateTypeBalance = liabilitiesWithRateType.reduce((sum, l) => sum + l.balance, 0);
  const variableRateDebtBalance = liabilitiesWithRateType
    .filter((l) => l.interest_rate_type === 'variable')
    .reduce((sum, l) => sum + l.balance, 0);
  const variableRateDebtRatio = rateTypeBalance > 0 ? variableRateDebtBalance / rateTypeBalance : null;
  const in12Months = new Date();
  in12Months.setMonth(in12Months.getMonth() + 12);
  const in12MonthsStr = in12Months.toISOString().slice(0, 10);
  const upcomingRateResetBalance12m = input.liabilities
    .filter((l) => l.fixed_rate_expiry && l.fixed_rate_expiry <= in12MonthsStr)
    .reduce((sum, l) => sum + l.balance, 0);
  const creditCardLiabilities = input.liabilities.filter(
    (l) => isCreditCardDebt(l.debt_type, l.master_item_key) && (l.credit_limit ?? null) !== null
  );
  const totalCreditLimit = creditCardLiabilities.reduce((sum, l) => sum + (l.credit_limit ?? 0), 0);
  const creditUtilization =
    totalCreditLimit > 0
      ? creditCardLiabilities.reduce((sum, l) => sum + l.balance, 0) / totalCreditLimit
      : null;

  const investmentCostBase = input.investments.reduce((sum, r) => sum + (r.cost_base ?? r.current_value), 0);
  const investmentUnrealisedGain = totalInvestments - investmentCostBase;

  let investmentDiversificationScore: number | null = null;
  if (input.investments.length > 0 && totalInvestments > 0) {
    const byType = new Map<string, number>();
    for (const i of input.investments) {
      const key = i.master_item_key ?? i.investment_type;
      byType.set(key, (byType.get(key) ?? 0) + i.current_value);
    }
    const hhi = Array.from(byType.values()).reduce((sum, v) => sum + (v / totalInvestments) ** 2, 0);
    investmentDiversificationScore = Math.round((1 - hhi) * 100);
  }

  const countryMap = new Map<string, number>();
  for (const i of input.investments) {
    if (!i.country_code) continue;
    countryMap.set(i.country_code, (countryMap.get(i.country_code) ?? 0) + i.current_value);
  }
  const investmentByCountry = Array.from(countryMap.entries()).map(([countryCode, value]) => ({ countryCode, value }));
  const countriesInUse = Array.from(
    new Set([
      ...assetsByCountry.map((a) => a.countryCode),
      ...liabilitiesByCountry.map((l) => l.countryCode),
      ...retirementByCountry.map((r) => r.countryCode),
      ...investmentByCountry.map((i) => i.countryCode),
    ])
  );

  const institutionMap = new Map<string, number>();
  for (const i of input.investments) {
    if (!i.institution) continue;
    institutionMap.set(i.institution, (institutionMap.get(i.institution) ?? 0) + i.current_value);
  }
  const institutionConcentration =
    institutionMap.size > 0 && totalInvestments > 0
      ? Array.from(institutionMap.values()).reduce((sum, v) => sum + (v / totalInvestments) ** 2, 0)
      : null;

  const dividendMonthlyIncome = input.income
    .filter((r) => r.master_item_key === 'dividend_income')
    .reduce((sum, r) => sum + toMonthly(r.amount, r.frequency), 0);
  const dividendYield = totalInvestments > 0 ? (dividendMonthlyIncome * 12) / totalInvestments : null;

  const rentalMonthlyIncome = input.income
    .filter((r) => r.master_item_key === 'rental_income' || r.master_item_key === 'airbnb_income')
    .reduce((sum, r) => sum + toMonthly(r.amount, r.frequency), 0);

  const retirementEmployerMonthlyContribution = input.retirement.reduce(
    (sum, r) => sum + toMonthly(r.employer_contribution ?? 0, r.contribution_frequency ?? 'monthly'),
    0
  );
  const retirementPersonalMonthlyContribution = input.retirement.reduce(
    (sum, r) => sum + toMonthly(r.personal_contribution ?? 0, r.contribution_frequency ?? 'monthly'),
    0
  );
  const investmentAnnualContribution = input.investments.reduce((sum, r) => sum + (r.annual_contribution ?? 0), 0);
  const investmentContributionRate = incomeForSurplus > 0 ? investmentAnnualContribution / 12 / incomeForSurplus : null;
  const retirementContributionRate =
    incomeForSurplus > 0
      ? (retirementEmployerMonthlyContribution + retirementPersonalMonthlyContribution) / incomeForSurplus
      : null;
  const retirementEmployerContributionRate = incomeForSurplus > 0 ? retirementEmployerMonthlyContribution / incomeForSurplus : null;

  const insuranceTypeMap = new Map<string, { coverAmount: number; annualPremium: number }>();
  for (const i of input.insurance) {
    const entry = insuranceTypeMap.get(i.cover_type) ?? { coverAmount: 0, annualPremium: 0 };
    entry.coverAmount += i.cover_amount;
    entry.annualPremium += toMonthly(i.premium, i.premium_frequency) * 12;
    insuranceTypeMap.set(i.cover_type, entry);
  }
  const insuranceByType = Array.from(insuranceTypeMap.entries()).map(([coverType, v]) => ({
    coverType,
    coverAmount: v.coverAmount,
    annualPremium: v.annualPremium,
  }));
  const totalAnnualPremium = insuranceByType.reduce((sum, i) => sum + i.annualPremium, 0);
  const today = new Date().toISOString().slice(0, 10);
  const upcomingRenewals = input.insurance
    .filter((i): i is InsuranceRow & { renewal_date: string } => Boolean(i.renewal_date) && i.renewal_date! >= today)
    .sort((a, b) => a.renewal_date!.localeCompare(b.renewal_date!))
    .slice(0, 5)
    .map((i) => ({ policyName: i.policy_name, renewalDate: i.renewal_date! }));
  const incomeProtectionWaitingPeriods = input.insurance
    .filter((i) => i.cover_type === 'income_protection' && (i.waiting_period_days ?? null) !== null)
    .map((i) => i.waiting_period_days as number);
  const incomeProtectionWaitingPeriodDays =
    incomeProtectionWaitingPeriods.length > 0 ? Math.max(...incomeProtectionWaitingPeriods) : null;

  const netWorthRatio = totalAssetBaseForRatios > 0 ? netWorth / totalAssetBaseForRatios : null;
  const liquidityRatio = totalMonthlyExpenses > 0 ? liquidAssets / totalMonthlyExpenses : null;
  const investmentRatio =
    totalAssetBaseForRatios > 0 ? (totalInvestments + totalRetirement) / totalAssetBaseForRatios : null;
  const passiveIncomeRatio = grossMonthlyIncome > 0 ? passiveMonthlyIncome / grossMonthlyIncome : null;
  const financialIndependenceRatio = totalMonthlyExpenses > 0 ? passiveMonthlyIncome / totalMonthlyExpenses : null;

  const ratios: RatioResult[] = [
    ratio(
      'savings_rate',
      'Savings Rate',
      savingsRate,
      'percent',
      '>20%',
      savingsRate === null ? 'neutral' : savingsRate >= 0.2 ? 'good' : savingsRate >= 0.1 ? 'caution' : 'risk'
    ),
    ratio(
      'expense_ratio',
      'Expense Ratio',
      incomeForSurplus > 0 ? totalMonthlyExpenses / incomeForSurplus : null,
      'percent',
      '<80%',
      incomeForSurplus === 0
        ? 'neutral'
        : totalMonthlyExpenses / incomeForSurplus < 0.8
          ? 'good'
          : totalMonthlyExpenses / incomeForSurplus < 1
            ? 'caution'
            : 'risk'
    ),
    ratio(
      'debt_to_income',
      'Debt-to-Income',
      debtToIncome,
      'multiple',
      '<3x',
      debtToIncome === null ? 'neutral' : debtToIncome < 3 ? 'good' : debtToIncome < 5 ? 'caution' : 'risk'
    ),
    ratio(
      'debt_service_ratio',
      'Debt Service Ratio',
      debtServiceRatio,
      'percent',
      '<35%',
      debtServiceRatio === null ? 'neutral' : debtServiceRatio < 0.35 ? 'good' : debtServiceRatio < 0.5 ? 'caution' : 'risk'
    ),
    ratio(
      'net_worth_ratio',
      'Net Worth Ratio',
      netWorthRatio,
      'percent',
      '>60%',
      netWorthRatio === null ? 'neutral' : netWorthRatio >= 0.6 ? 'good' : netWorthRatio >= 0.3 ? 'caution' : 'risk'
    ),
    ratio(
      'liquidity_ratio',
      'Liquidity Ratio',
      liquidityRatio,
      'months',
      '>6 months',
      liquidityRatio === null ? 'neutral' : liquidityRatio >= 6 ? 'good' : liquidityRatio >= 3 ? 'caution' : 'risk'
    ),
    ratio('investment_ratio', 'Investment Ratio', investmentRatio, 'percent', 'Varies by age', 'neutral'),
    ratio(
      'emergency_fund_ratio',
      'Emergency Fund Ratio',
      emergencyFundMonths,
      'months',
      '6-12 months',
      emergencyFundMonths === null
        ? 'neutral'
        : emergencyFundMonths >= 6
          ? 'good'
          : emergencyFundMonths >= 3
            ? 'caution'
            : 'risk'
    ),
    ratio(
      'passive_income_ratio',
      'Passive Income Ratio',
      passiveIncomeRatio,
      'percent',
      '>20%',
      passiveIncomeRatio === null ? 'neutral' : passiveIncomeRatio >= 0.2 ? 'good' : passiveIncomeRatio >= 0.1 ? 'caution' : 'risk'
    ),
    ratio(
      'financial_independence_ratio',
      'Financial Independence Ratio',
      financialIndependenceRatio,
      'percent',
      '100%',
      financialIndependenceRatio === null
        ? 'neutral'
        : financialIndependenceRatio >= 1
          ? 'good'
          : financialIndependenceRatio >= 0.5
            ? 'caution'
            : 'risk'
    ),
  ];

  return {
    currency,
    grossMonthlyIncome,
    netMonthlyIncome,
    passiveMonthlyIncome,
    activeMonthlyIncome,
    essentialMonthlyExpenses,
    coreSurvivalMonthlyExpenses,
    lifestyleMonthlyExpenses,
    debtMonthlyRepayments,
    totalMonthlyExpenses,
    monthlySurplus,
    savingsRate,
    operatingCashFlow,
    disposableIncome,
    cashFlowRatio,
    topExpenses,
    topIncome,
    incomeSourceCount,
    largestIncomeSharePct,
    discretionaryRatio,
    employerConcentration,
    hasInvestments: input.investments.length > 0,
    hasRetirement: input.retirement.length > 0,
    hasInsurance: input.insurance.length > 0,
    totalAssets,
    totalAssetsCombined: totalAssetBaseForRatios,
    totalInvestments,
    totalRetirement,
    totalLiabilities,
    netWorth,
    netWorthAllocation,
    liabilityByType,
    liquidAssetRatio,
    propertyConcentration,
    assetsByCountry,
    liabilitiesByCountry,
    retirementByCountry,
    countriesInUse,
    liquidAssets,
    emergencyFundMonths,
    averageInterestRate,
    debtToIncome,
    debtServiceRatio,
    liabilitiesWithPayoff,
    goodDebt,
    badDebt,
    variableRateDebtBalance,
    variableRateDebtRatio,
    upcomingRateResetBalance12m,
    creditUtilization,
    investmentCostBase,
    investmentUnrealisedGain,
    investmentDiversificationScore,
    investmentByCountry,
    institutionConcentration,
    dividendMonthlyIncome,
    dividendYield,
    rentalMonthlyIncome,
    retirementEmployerMonthlyContribution,
    retirementPersonalMonthlyContribution,
    investmentAnnualContribution,
    investmentContributionRate,
    retirementContributionRate,
    retirementEmployerContributionRate,
    insuranceByType,
    totalAnnualPremium,
    upcomingRenewals,
    incomeProtectionWaitingPeriodDays,
    ratios,
    snapshots: input.snapshots,
    goals: input.goals,
    hasIncome: input.income.length > 0,
    hasExpenses: input.expenses.length > 0,
    hasAssets: input.assets.length > 0 || input.investments.length > 0 || input.retirement.length > 0,
    hasLiabilities: input.liabilities.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Shared insurance-adequacy facts, reused by both the Health Score's
// Insurance & Protection component (Module 4) and the Resilience engine's
// Insurance & Protection component (Module 6) so the underlying life-cover
// gap calculation isn't duplicated across modules.
// ---------------------------------------------------------------------------
export interface InsuranceAdequacyFacts {
  hasLife: boolean;
  hasIncomeProtection: boolean;
  lifeCover: number;
  targetLifeCover: number;
  adequacyRatio: number | null;
  incomeProtectionWaitingPeriodDays: number | null;
}

export function computeInsuranceAdequacy(d: DashboardSummary, dependantsCount: number): InsuranceAdequacyFacts {
  const hasLife = d.insuranceByType.some((i) => i.coverType === 'life');
  const hasIncomeProtection = d.insuranceByType.some((i) => i.coverType === 'income_protection');
  const lifeCover = d.insuranceByType.find((i) => i.coverType === 'life')?.coverAmount ?? 0;
  const annualIncome = d.grossMonthlyIncome * 12;
  const targetLifeCover = annualIncome * (dependantsCount > 0 ? 10 : 5);
  const adequacyRatio = targetLifeCover > 0 ? lifeCover / targetLifeCover : null;
  return {
    hasLife,
    hasIncomeProtection,
    lifeCover,
    targetLifeCover,
    adequacyRatio,
    incomeProtectionWaitingPeriodDays: d.incomeProtectionWaitingPeriodDays,
  };
}
