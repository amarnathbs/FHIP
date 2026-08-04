import type { TwinSourceData } from '@/lib/services/twinData';

export interface MetricValueResult {
  value: number | null;
  notComparableReason: string | null;
}

const NOT_COMPARABLE = 'Insufficient data recorded for this metric.';

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function growthPct(values: { month: string; value: number }[]): number | null {
  if (values.length < 2) return null;
  const first = values[0].value;
  const last = values[values.length - 1].value;
  if (first === 0) return null;
  return ((last - first) / Math.abs(first)) * 100;
}

function resilienceComponentValue(source: TwinSourceData, code: string, key: string): number | null {
  const component = source.resilience.components.find((c) => c.code === code);
  const value = component?.currentValue?.[key];
  return typeof value === 'number' ? value : null;
}

// Computes every metric in METRIC_CATALOGUE from data already produced by
// Modules 3-7's shared engines (dashboard.ts, healthScore.ts, resilience.ts,
// financialDna.ts, goalsData.ts) — this function derives comparison-ready
// numbers, it never recalculates a financial ratio those engines already
// own. A metric only gets a null value + notComparableReason when the
// underlying data genuinely isn't captured (spec Rule 7: missing data must
// never silently become a confirmed zero).
export function computeTwinMetricValues(source: TwinSourceData): Record<string, MetricValueResult> {
  const d = source.dashboard;
  const result: Record<string, MetricValueResult> = {};
  const set = (code: string, value: number | null, reason?: string) => {
    result[code] = { value, notComparableReason: value === null ? (reason ?? NOT_COMPARABLE) : null };
  };

  const incomeBase = d.netMonthlyIncome > 0 ? d.netMonthlyIncome : d.grossMonthlyIncome;
  const annualGrossIncome = d.grossMonthlyIncome * 12;
  const annualNetIncomeBase = incomeBase * 12;
  const totalAssetBase = d.totalAssets + d.totalInvestments + d.totalRetirement;

  const incomeSeries = source.snapshots12m.map((s) => ({ month: s.month, value: s.monthlyIncome }));
  const expenseSeries = source.snapshots12m.map((s) => ({ month: s.month, value: s.monthlyExpenses }));
  const netWorthSeries = source.snapshots12m.map((s) => ({ month: s.month, value: s.netWorth }));

  // 7.1 Income and Cash Flow ------------------------------------------------
  set('gross_household_income', d.hasIncome ? annualGrossIncome : null, 'No income recorded.');
  set('net_household_income', d.hasIncome ? d.netMonthlyIncome * 12 : null, 'No income recorded.');
  set('income_growth_12m', growthPct(incomeSeries), 'Fewer than two monthly snapshots recorded.');
  set('income_concentration', d.largestIncomeSharePct !== null ? d.largestIncomeSharePct * 100 : null, 'No income source recorded.');
  set('passive_income_ratio', d.grossMonthlyIncome > 0 ? (d.passiveMonthlyIncome / d.grossMonthlyIncome) * 100 : null);
  set('monthly_surplus', d.hasIncome || d.hasExpenses ? d.monthlySurplus : null);
  set('surplus_margin', d.savingsRate !== null ? d.savingsRate * 100 : null);
  set(
    'positive_cashflow_consistency',
    source.snapshots12m.length > 0 ? (source.snapshots12m.filter((s) => s.monthlySurplus > 0).length / source.snapshots12m.length) * 100 : null,
    'No monthly history recorded yet.'
  );

  // 7.2 Expenses and Savings -------------------------------------------------
  set('total_expense_ratio', ratio(d.totalMonthlyExpenses, incomeBase) !== null ? ratio(d.totalMonthlyExpenses, incomeBase)! * 100 : null);
  set('essential_expense_ratio', ratio(d.essentialMonthlyExpenses, incomeBase) !== null ? ratio(d.essentialMonthlyExpenses, incomeBase)! * 100 : null);
  set('discretionary_expense_ratio', d.discretionaryRatio !== null ? d.discretionaryRatio * 100 : null);
  set('housing_cost_ratio', d.grossMonthlyIncome > 0 ? (source.expenseHousingMonthly / d.grossMonthlyIncome) * 100 : null);
  set(
    'fixed_commitment_ratio',
    incomeBase > 0 ? ((d.essentialMonthlyExpenses + d.debtMonthlyRepayments) / incomeBase) * 100 : null
  );
  // Same underlying cash-flow-surplus figure as surplus_margin (7.1) — this
  // app doesn't separately track "money actually moved into savings/
  // investment accounts" versus "leftover monthly surplus", so both spec
  // metrics resolve to the same computed savings rate rather than a
  // fabricated distinction.
  set('savings_rate', d.savingsRate !== null ? d.savingsRate * 100 : null);
  set('expense_growth_12m', growthPct(expenseSeries), 'Fewer than two monthly snapshots recorded.');

  // 7.3 Liquidity and Resilience ---------------------------------------------
  set('emergency_fund_months', d.emergencyFundMonths, 'No essential expenses marked, or no liquid assets recorded.');
  set(
    'immediate_liquidity_ratio',
    d.totalMonthlyExpenses + d.debtMonthlyRepayments > 0 ? d.liquidAssets / (d.totalMonthlyExpenses + d.debtMonthlyRepayments) : null
  );
  const shortTermLiabilities = source.rawLiabilities
    .filter((l) => l.debt_type === 'credit_card' || l.debt_type === 'personal_loan')
    .reduce((sum, l) => sum + l.balance, 0);
  set('liquid_net_worth', d.liquidAssets - shortTermLiabilities);
  const nearLiquidCoverage = resilienceComponentValue(source, 'liquidity', 'coverageMonths');
  set('near_liquid_coverage', nearLiquidCoverage, 'Mark at least one expense as essential to calculate liquidity coverage.');
  set('income_interruption_coverage', nearLiquidCoverage, 'Mark at least one expense as essential to calculate liquidity coverage.');

  // 7.4 Debt and Commitments --------------------------------------------------
  set('debt_to_income', d.debtToIncome, 'No income recorded to compare against debt.');
  set('debt_service_ratio', d.debtServiceRatio !== null ? d.debtServiceRatio * 100 : null);
  set('debt_to_asset_ratio', totalAssetBase > 0 ? (d.totalLiabilities / totalAssetBase) * 100 : null, 'No assets recorded to compare against debt.');
  const UNSECURED_DEBT_TYPES = new Set(['personal_loan', 'credit_card', 'student_loan', 'other']);
  const unsecuredBalance = source.rawLiabilities.filter((l) => UNSECURED_DEBT_TYPES.has(l.debt_type)).reduce((sum, l) => sum + l.balance, 0);
  set('unsecured_debt_ratio', annualNetIncomeBase > 0 ? (unsecuredBalance / annualNetIncomeBase) * 100 : null);
  const HIGH_INTEREST_THRESHOLD = 10;
  const liabilitiesWithRate = source.rawLiabilities.filter((l) => l.interest_rate !== null);
  const highInterestBalance = liabilitiesWithRate.filter((l) => (l.interest_rate as number) >= HIGH_INTEREST_THRESHOLD).reduce((sum, l) => sum + l.balance, 0);
  set(
    'high_interest_debt_share',
    liabilitiesWithRate.length > 0 && d.totalLiabilities > 0 ? (highInterestBalance / d.totalLiabilities) * 100 : null,
    'No interest rate recorded on any liability.'
  );
  set('credit_utilization', d.creditUtilization !== null ? d.creditUtilization * 100 : null, 'No credit limit recorded on any revolving credit liability.');
  const mortgageBalance = source.rawLiabilities.filter((l) => l.debt_type === 'mortgage').reduce((sum, l) => sum + l.balance, 0);
  const propertyValue = source.rawAssets.filter((a) => a.asset_class === 'property').reduce((sum, a) => sum + a.current_value, 0);
  set(
    'home_loan_lvr',
    propertyValue > 0 ? (mortgageBalance / propertyValue) * 100 : null,
    mortgageBalance > 0 ? 'No property asset recorded to compare against mortgage debt.' : 'No mortgage or property recorded.'
  );
  set('variable_rate_exposure', d.variableRateDebtRatio !== null ? d.variableRateDebtRatio * 100 : null, 'No liability records whether its rate is fixed or variable.');
  // Only 12-month rate-reset data is captured (Module 6); used as a proxy
  // for the spec's 24-month refinance-exposure window, disclosed here.
  set('refinance_exposure_24m', d.totalLiabilities > 0 ? (d.upcomingRateResetBalance12m / d.totalLiabilities) * 100 : null);

  // 7.5 Assets and Net Worth ---------------------------------------------------
  set('total_assets', totalAssetBase);
  set('net_worth', d.netWorth);
  set('net_worth_to_income', annualGrossIncome > 0 ? d.netWorth / annualGrossIncome : null, 'No income recorded.');
  set('liquid_asset_share', d.liquidAssetRatio !== null ? d.liquidAssetRatio * 100 : null);
  set('property_concentration', d.propertyConcentration !== null ? d.propertyConcentration * 100 : null);
  const businessValue = d.netWorthAllocation.find((a) => a.bucket === 'business')?.value ?? 0;
  set('productive_asset_ratio', totalAssetBase > 0 ? ((d.totalInvestments + d.totalRetirement + businessValue) / totalAssetBase) * 100 : null);
  const vehicleValue = source.rawAssets.filter((a) => a.asset_class === 'vehicle').reduce((sum, a) => sum + a.current_value, 0);
  set('depreciating_asset_ratio', totalAssetBase > 0 ? (vehicleValue / totalAssetBase) * 100 : null);
  set('net_worth_growth_12m', growthPct(netWorthSeries), 'Fewer than two monthly snapshots recorded.');

  // 7.6 Investments -------------------------------------------------------------
  set('investment_contribution_rate', d.investmentContributionRate !== null ? d.investmentContributionRate * 100 : null, 'No investments recorded.');
  set('investable_assets_ratio', totalAssetBase > 0 ? (d.totalInvestments / totalAssetBase) * 100 : null);
  const largestHolding = source.rawInvestments.length > 0 ? Math.max(...source.rawInvestments.map((i) => i.current_value)) : 0;
  set('largest_holding_concentration', d.totalInvestments > 0 ? (largestHolding / d.totalInvestments) * 100 : null, 'No investments recorded.');
  const distinctInvestmentTypes = new Set(source.rawInvestments.filter((i) => i.current_value > 0).map((i) => i.investment_type));
  set('asset_class_diversification', source.rawInvestments.length > 0 ? distinctInvestmentTypes.size : null, 'No investments recorded.');
  const investmentsWithCountry = source.rawInvestments.filter((i) => i.country_code);
  const homeCountryInvestmentValue = investmentsWithCountry
    .filter((i) => i.country_code === source.household.countryOfResidence)
    .reduce((sum, i) => sum + i.current_value, 0);
  const investmentsWithCountryTotal = investmentsWithCountry.reduce((sum, i) => sum + i.current_value, 0);
  set(
    'geographic_diversification',
    investmentsWithCountry.length > 0 && investmentsWithCountryTotal > 0
      ? ((investmentsWithCountryTotal - homeCountryInvestmentValue) / investmentsWithCountryTotal) * 100
      : null,
    'No investment records the country it is held in.'
  );
  const cryptoValue = source.rawInvestments.filter((i) => i.investment_type === 'cryptocurrency').reduce((sum, i) => sum + i.current_value, 0);
  set('speculative_asset_ratio', d.totalInvestments > 0 ? (cryptoValue / d.totalInvestments) * 100 : null, 'No investments recorded.');
  set('portfolio_cost_ratio', null, 'Investment fee data is not currently captured.');

  // 7.7 Retirement ----------------------------------------------------------
  set('retirement_balance', d.totalRetirement);
  set('retirement_balance_to_income', annualGrossIncome > 0 ? d.totalRetirement / annualGrossIncome : null, 'No income recorded.');
  set('retirement_contribution_rate', d.retirementContributionRate !== null ? d.retirementContributionRate * 100 : null);
  computeRetirementProjection(source, set, annualGrossIncome);

  // 7.8 Protection ------------------------------------------------------------
  set('life_cover_adequacy', source.insuranceAdequacy.adequacyRatio !== null ? source.insuranceAdequacy.adequacyRatio * 100 : null, 'No income recorded to model a life-cover need.');
  const hasIncomeProtection = source.rawInsurance.some((i) => i.cover_type === 'income_protection');
  const waitingDays = d.incomeProtectionWaitingPeriodDays;
  const reserveMonths = d.emergencyFundMonths;
  set(
    'income_protection_alignment',
    hasIncomeProtection && waitingDays !== null && waitingDays > 0 && reserveMonths !== null ? reserveMonths / (waitingDays / 30) : null,
    hasIncomeProtection ? 'Waiting period or liquid reserves not recorded.' : 'No income-protection policy recorded.'
  );
  set('tpd_cover_adequacy', null, 'Total-and-permanent-disability cover is not currently captured as a separate policy type.');
  const homeCover = source.rawInsurance.filter((i) => i.cover_type === 'home').reduce((sum, i) => sum + i.cover_amount, 0);
  set('major_asset_coverage', propertyValue > 0 ? (homeCover / propertyValue) * 100 : null, 'No property asset recorded to compare cover against.');
  const relevantCategories: string[] = [];
  if (source.household.dependantsCount > 0 || d.totalLiabilities > 0) relevantCategories.push('life');
  if (['employee', 'self_employed', 'business_owner'].includes(source.household.employmentType)) relevantCategories.push('income_protection');
  if (propertyValue > 0) relevantCategories.push('home');
  if (vehicleValue > 0) relevantCategories.push('vehicle');
  const activeCategories = new Set(source.rawInsurance.map((i) => i.cover_type));
  const coveredRelevant = relevantCategories.filter((c) => activeCategories.has(c));
  set('policy_completeness', relevantCategories.length > 0 ? (coveredRelevant.length / relevantCategories.length) * 100 : null, 'No insurance-relevant household facts recorded yet.');
  set('premium_burden', annualNetIncomeBase > 0 ? (d.totalAnnualPremium / annualNetIncomeBase) * 100 : null);

  // 7.9 Goals -----------------------------------------------------------------
  const goalsSummary = source.goals.summary;
  set('goal_progress', goalsSummary.activeGoalsCount > 0 ? goalsSummary.overallProgressPct : null, 'No active goals recorded.');
  const goalsWithRequired = source.goals.goals.filter((g) => (g.forecasts?.base?.requiredMonthlyContribution ?? null) !== null && g.forecasts.base.requiredMonthlyContribution! > 0);
  set(
    'goal_contribution_adequacy',
    goalsWithRequired.length > 0
      ? (goalsWithRequired.reduce((sum, g) => sum + Math.min(g.plannedContributionAmount / g.forecasts.base.requiredMonthlyContribution!, 3), 0) / goalsWithRequired.length) * 100
      : null,
    'No active goal has a computable required contribution yet.'
  );
  const ON_TRACK_STATUSES = new Set(['on_track', 'ahead', 'achieved']);
  set(
    'on_track_goal_percentage',
    goalsSummary.activeGoalsCount > 0
      ? (source.goals.goals.filter((g) => ON_TRACK_STATUSES.has(g.forecasts?.base?.trackStatus ?? '')).length / goalsSummary.activeGoalsCount) * 100
      : null,
    'No active goals recorded.'
  );
  set('goal_allocation_burden', source.goals.affordability.usageRatio !== null ? source.goals.affordability.usageRatio * 100 : null);
  // Assumes lower userPriority number = higher priority (1 = most urgent),
  // consistent with the 1-5 range used across Module 7's goal records.
  const totalPlanned = source.goals.goals.reduce((sum, g) => sum + g.plannedContributionAmount, 0);
  const highPriorityPlanned = source.goals.goals.filter((g) => g.userPriority <= 2).reduce((sum, g) => sum + g.plannedContributionAmount, 0);
  set('priority_alignment', totalPlanned > 0 ? (highPriorityPlanned / totalPlanned) * 100 : null, 'No planned goal contributions recorded.');

  // 7.10 Cross-Border -----------------------------------------------------------
  computeCrossBorderMetrics(source, set, totalAssetBase, annualNetIncomeBase);

  return result;
}

function computeRetirementProjection(
  source: TwinSourceData,
  set: (code: string, value: number | null, reason?: string) => void,
  annualGrossIncome: number
) {
  const { age, countryOfResidence, householdTypeCode } = source.household;
  const targetAge = Math.max(
    countryOfResidence === 'AU' ? 67 : 60,
    ...source.rawRetirement.map((r) => r.target_retirement_age ?? 0)
  );
  if (age === null || targetAge <= age) {
    set('projected_retirement_readiness', null, 'Age or target retirement age not available.');
    set('retirement_funding_gap', null, 'Age or target retirement age not available.');
    set('debt_at_retirement', null, 'Age or target retirement age not available.');
    return;
  }
  const yearsToRetirement = targetAge - age;
  const monthlyContribution = source.dashboard.retirementEmployerMonthlyContribution + source.dashboard.retirementPersonalMonthlyContribution;
  const monthlyReturn = 0.05 / 12; // documented indicative real-return assumption, consistent with Module 7's forecast style
  const months = yearsToRetirement * 12;
  const projectedBalance =
    source.dashboard.totalRetirement * Math.pow(1 + monthlyReturn, months) +
    (monthlyReturn > 0 ? monthlyContribution * ((Math.pow(1 + monthlyReturn, months) - 1) / monthlyReturn) : monthlyContribution * months);

  const isCoupleHousehold = householdTypeCode === 'couple_no_kids' || householdTypeCode === 'couple_with_kids';
  const targetBalance =
    countryOfResidence === 'AU'
      ? isCoupleHousehold
        ? 730_000
        : 630_000
      : annualGrossIncome > 0
        ? annualGrossIncome * 10
        : null;

  set('projected_retirement_readiness', targetBalance !== null && targetBalance > 0 ? (projectedBalance / targetBalance) * 100 : null, 'No indicative retirement target available.');
  set('retirement_funding_gap', targetBalance !== null ? targetBalance - projectedBalance : null, 'No indicative retirement target available.');

  // Linear approximation of remaining debt at target retirement age (not a
  // full amortisation schedule) — disclosed as indicative.
  const debtAtRetirement = source.dashboard.liabilitiesWithPayoff.reduce((sum, l) => {
    if (l.monthsToPayoff === null) return sum + l.balance;
    if (l.monthsToPayoff <= months) return sum;
    return sum + l.balance * (1 - months / l.monthsToPayoff);
  }, 0);
  set('debt_at_retirement', debtAtRetirement);
}

export interface FutureSelfValues {
  netWorthIn5Years: number | null;
  retirementBalanceAtTarget: number | null;
  retirementReadinessAtTarget: number | null;
  goalProgressAtTargetDates: number | null;
}

// Future Self Twin values — deliberately limited to metrics where this app
// already has a genuine deterministic forecast (Module 7 goal forecasts, or
// the retirement projection above / a simple net-worth trend extrapolation
// from 12 months of snapshot history). No other metric gets a fabricated
// multi-year forecast (spec: "uses existing deterministic forecasts").
export function computeFutureSelfValues(source: TwinSourceData): FutureSelfValues {
  const netWorthSeries = source.snapshots12m.map((s) => s.netWorth);
  let netWorthIn5Years: number | null = null;
  if (netWorthSeries.length >= 2) {
    const first = netWorthSeries[0];
    const last = netWorthSeries[netWorthSeries.length - 1];
    if (first !== 0) {
      const monthlyGrowth = Math.pow(last / first, 1 / (netWorthSeries.length - 1)) - 1;
      netWorthIn5Years = last * Math.pow(1 + monthlyGrowth, 60);
    }
  }

  const { age, countryOfResidence, householdTypeCode } = source.household;
  const targetAge = Math.max(countryOfResidence === 'AU' ? 67 : 60, ...source.rawRetirement.map((r) => r.target_retirement_age ?? 0));
  let retirementBalanceAtTarget: number | null = null;
  let retirementReadinessAtTarget: number | null = null;
  if (age !== null && targetAge > age) {
    const months = (targetAge - age) * 12;
    const monthlyReturn = 0.05 / 12;
    const monthlyContribution = source.dashboard.retirementEmployerMonthlyContribution + source.dashboard.retirementPersonalMonthlyContribution;
    retirementBalanceAtTarget =
      source.dashboard.totalRetirement * Math.pow(1 + monthlyReturn, months) +
      monthlyContribution * ((Math.pow(1 + monthlyReturn, months) - 1) / monthlyReturn);
    const isCouple = householdTypeCode === 'couple_no_kids' || householdTypeCode === 'couple_with_kids';
    const targetBalance = countryOfResidence === 'AU' ? (isCouple ? 730_000 : 630_000) : source.dashboard.grossMonthlyIncome * 12 * 10;
    retirementReadinessAtTarget = targetBalance > 0 ? (retirementBalanceAtTarget / targetBalance) * 100 : null;
  }

  const goalsWithProjection = source.goals.goals.filter((g) => g.forecasts?.base?.forecastFundingPct !== null && g.forecasts?.base?.forecastFundingPct !== undefined);
  const goalProgressAtTargetDates =
    goalsWithProjection.length > 0
      ? goalsWithProjection.reduce((sum, g) => sum + (g.forecasts.base.forecastFundingPct as number), 0) / goalsWithProjection.length
      : null;

  return { netWorthIn5Years, retirementBalanceAtTarget, retirementReadinessAtTarget, goalProgressAtTargetDates };
}

function computeCrossBorderMetrics(
  source: TwinSourceData,
  set: (code: string, value: number | null, reason?: string) => void,
  totalAssetBase: number,
  annualNetIncomeBase: number
) {
  const d = source.dashboard;
  if (!source.household.isCrossBorder) {
    const reason = 'Recorded in a single country for this period.';
    ['country_concentration', 'currency_concentration', 'currency_mismatch', 'offshore_liquidity_access', 'cross_border_retirement_coverage'].forEach((code) =>
      set(code, null, reason)
    );
    // Remittance spending is meaningful even for single-country households
    // supporting family overseas, so it's still computed below.
  } else {
    const byCountry = new Map<string, number>();
    for (const a of d.assetsByCountry) byCountry.set(a.countryCode, (byCountry.get(a.countryCode) ?? 0) + a.value);
    for (const i of d.investmentByCountry) byCountry.set(i.countryCode, (byCountry.get(i.countryCode) ?? 0) + i.value);
    for (const r of d.retirementByCountry) byCountry.set(r.countryCode, (byCountry.get(r.countryCode) ?? 0) + r.value);
    const countryTotal = Array.from(byCountry.values()).reduce((sum, v) => sum + v, 0);
    const largestCountryValue = byCountry.size > 0 ? Math.max(...byCountry.values()) : 0;
    set('country_concentration', countryTotal > 0 ? (largestCountryValue / countryTotal) * 100 : null, 'No asset records a country.');

    const byCurrency = new Map<string, number>();
    for (const a of source.rawAssets) if (a.currency_code) byCurrency.set(a.currency_code, (byCurrency.get(a.currency_code) ?? 0) + a.current_value);
    for (const i of source.rawInvestments) if (i.currency_code) byCurrency.set(i.currency_code, (byCurrency.get(i.currency_code) ?? 0) + i.current_value);
    const currencyTotal = Array.from(byCurrency.values()).reduce((sum, v) => sum + v, 0);
    const largestCurrencyValue = byCurrency.size > 0 ? Math.max(...byCurrency.values()) : 0;
    set('currency_concentration', currencyTotal > 0 ? (largestCurrencyValue / currencyTotal) * 100 : null, 'No asset records a currency.');

    set('currency_mismatch', null, 'Currency-matching between obligations and income is not yet modelled.');
    set('offshore_liquidity_access', null, 'Time-to-access for offshore funds is not currently captured.');
    set('cross_border_retirement_coverage', null, 'Country-specific retirement obligation modelling is not yet available.');
  }

  set('remittance_burden', annualNetIncomeBase > 0 ? (source.remittanceMonthly * 12 / annualNetIncomeBase) * 100 : null, 'No income recorded.');
}
