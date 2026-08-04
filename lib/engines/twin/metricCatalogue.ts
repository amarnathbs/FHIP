import type { ComparisonDirection, MetricCategory } from './taxonomy';

export type MetricUnit = 'currency' | 'percentage' | 'months' | 'ratio' | 'count' | 'days';

export interface MetricDefinition {
  code: string;
  category: MetricCategory;
  label: string;
  unit: MetricUnit;
  direction: ComparisonDirection;
  explanation: string;
  displayOrder: number;
}

// The full ~67-metric catalogue (spec section 7). direction reflects the
// metric's fundamental peer-comparison direction; FHIP planning target-range
// evaluation (section 8) is a separate, additional calculation layered on
// top via benchmark_target_ranges — a metric can be both "higher is
// generally better" for peer comparison AND have an upper healthy bound.
export const METRIC_CATALOGUE: MetricDefinition[] = [
  // 7.1 Income and Cash Flow
  { code: 'gross_household_income', category: 'income_cashflow', label: 'Gross household income', unit: 'currency', direction: 'context_only', explanation: 'Annualised gross recurring household income.', displayOrder: 1 },
  { code: 'net_household_income', category: 'income_cashflow', label: 'Net household income', unit: 'currency', direction: 'context_only', explanation: 'Annualised after-tax recurring household income.', displayOrder: 2 },
  { code: 'income_growth_12m', category: 'income_cashflow', label: 'Income growth', unit: 'percentage', direction: 'higher_better', explanation: 'Change in gross income over the last 12 months.', displayOrder: 3 },
  { code: 'income_concentration', category: 'income_cashflow', label: 'Income concentration', unit: 'percentage', direction: 'lower_better', explanation: 'Largest income source as a share of total income.', displayOrder: 4 },
  { code: 'passive_income_ratio', category: 'income_cashflow', label: 'Passive income ratio', unit: 'percentage', direction: 'context_only', explanation: 'Stable passive income as a share of total income.', displayOrder: 5 },
  { code: 'monthly_surplus', category: 'income_cashflow', label: 'Monthly surplus', unit: 'currency', direction: 'higher_better', explanation: 'Net income minus cash outflows for the month.', displayOrder: 6 },
  { code: 'surplus_margin', category: 'income_cashflow', label: 'Surplus margin', unit: 'percentage', direction: 'higher_better', explanation: 'Monthly surplus as a share of net income.', displayOrder: 7 },
  { code: 'positive_cashflow_consistency', category: 'income_cashflow', label: 'Positive cash-flow consistency', unit: 'percentage', direction: 'higher_better', explanation: 'Share of the last 12 months with a positive surplus.', displayOrder: 8 },

  // 7.2 Expenses and Savings
  { code: 'total_expense_ratio', category: 'expenses_savings', label: 'Total expense ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Household expenses as a share of net income.', displayOrder: 9 },
  { code: 'essential_expense_ratio', category: 'expenses_savings', label: 'Essential expense ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Essential expenses as a share of net income.', displayOrder: 10 },
  { code: 'discretionary_expense_ratio', category: 'expenses_savings', label: 'Discretionary expense ratio', unit: 'percentage', direction: 'context_only', explanation: 'Discretionary (lifestyle) expenses as a share of net income.', displayOrder: 11 },
  { code: 'housing_cost_ratio', category: 'expenses_savings', label: 'Housing-cost ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Housing costs as a share of gross income.', displayOrder: 12 },
  { code: 'fixed_commitment_ratio', category: 'expenses_savings', label: 'Fixed-commitment ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Mandatory commitments (essentials plus debt repayments) as a share of net income.', displayOrder: 13 },
  { code: 'savings_rate', category: 'expenses_savings', label: 'Savings rate', unit: 'percentage', direction: 'higher_better', explanation: 'Savings and investment contributions as a share of net income.', displayOrder: 14 },
  { code: 'expense_growth_12m', category: 'expenses_savings', label: 'Expense growth', unit: 'percentage', direction: 'context_only', explanation: 'Change in total expenses over the last 12 months, best read against income growth.', displayOrder: 15 },

  // 7.3 Liquidity and Resilience
  { code: 'emergency_fund_months', category: 'liquidity_resilience', label: 'Emergency fund', unit: 'months', direction: 'higher_better', explanation: 'Accessible reserves divided by essential monthly expenses.', displayOrder: 16 },
  { code: 'immediate_liquidity_ratio', category: 'liquidity_resilience', label: 'Immediate liquidity ratio', unit: 'ratio', direction: 'higher_better', explanation: 'Immediately accessible assets divided by 30-day obligations.', displayOrder: 17 },
  { code: 'liquid_net_worth', category: 'liquidity_resilience', label: 'Liquid net worth', unit: 'currency', direction: 'higher_better', explanation: 'Liquid assets minus short-term liabilities.', displayOrder: 18 },
  { code: 'near_liquid_coverage', category: 'liquidity_resilience', label: 'Near-liquid coverage', unit: 'months', direction: 'higher_better', explanation: 'Immediate and near-liquid resources divided by essential expenses.', displayOrder: 19 },
  { code: 'income_interruption_coverage', category: 'liquidity_resilience', label: 'Income interruption coverage', unit: 'months', direction: 'higher_better', explanation: 'Resources available to cover essential expenses during an income loss.', displayOrder: 20 },

  // 7.4 Debt and Commitments
  { code: 'debt_to_income', category: 'debt_commitments', label: 'Debt-to-income', unit: 'ratio', direction: 'lower_better', explanation: 'Total debt divided by gross annual income.', displayOrder: 21 },
  { code: 'debt_service_ratio', category: 'debt_commitments', label: 'Debt-service ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Required debt repayments as a share of monthly net income.', displayOrder: 22 },
  { code: 'debt_to_asset_ratio', category: 'debt_commitments', label: 'Debt-to-asset ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Total debt divided by total assets.', displayOrder: 23 },
  { code: 'unsecured_debt_ratio', category: 'debt_commitments', label: 'Unsecured debt ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Unsecured debt as a share of annual net income.', displayOrder: 24 },
  { code: 'high_interest_debt_share', category: 'debt_commitments', label: 'High-interest debt share', unit: 'percentage', direction: 'lower_better', explanation: 'Debt with an interest rate at or above 10% as a share of total debt.', displayOrder: 25 },
  { code: 'credit_utilization', category: 'debt_commitments', label: 'Credit utilisation', unit: 'percentage', direction: 'lower_better', explanation: 'Revolving credit balance divided by credit limit.', displayOrder: 26 },
  { code: 'home_loan_lvr', category: 'debt_commitments', label: 'Home loan LVR', unit: 'percentage', direction: 'lower_better', explanation: 'Mortgage balance divided by property value (aggregate approximation where multiple properties or loans exist).', displayOrder: 27 },
  { code: 'variable_rate_exposure', category: 'debt_commitments', label: 'Variable-rate exposure', unit: 'percentage', direction: 'context_only', explanation: 'Variable-rate debt as a share of total rate-classified debt.', displayOrder: 28 },
  { code: 'refinance_exposure_24m', category: 'debt_commitments', label: 'Refinance exposure', unit: 'percentage', direction: 'lower_better', explanation: 'Debt due or resetting within the next 24 months as a share of total debt.', displayOrder: 29 },

  // 7.5 Assets and Net Worth
  { code: 'total_assets', category: 'assets_networth', label: 'Total assets', unit: 'currency', direction: 'context_only', explanation: 'Sum of all active recorded assets.', displayOrder: 30 },
  { code: 'net_worth', category: 'assets_networth', label: 'Net worth', unit: 'currency', direction: 'higher_better', explanation: 'Assets minus liabilities.', displayOrder: 31 },
  { code: 'net_worth_to_income', category: 'assets_networth', label: 'Net-worth-to-income', unit: 'ratio', direction: 'higher_better', explanation: 'Net worth divided by annual gross income.', displayOrder: 32 },
  { code: 'liquid_asset_share', category: 'assets_networth', label: 'Liquid-asset share', unit: 'percentage', direction: 'context_only', explanation: 'Liquid assets as a share of total assets.', displayOrder: 33 },
  { code: 'property_concentration', category: 'assets_networth', label: 'Property concentration', unit: 'percentage', direction: 'context_only', explanation: 'Property assets as a share of total assets.', displayOrder: 34 },
  { code: 'productive_asset_ratio', category: 'assets_networth', label: 'Productive-asset ratio', unit: 'percentage', direction: 'higher_better', explanation: 'Investment, retirement and business assets as a share of total assets.', displayOrder: 35 },
  { code: 'depreciating_asset_ratio', category: 'assets_networth', label: 'Depreciating-asset ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Vehicles and similar depreciating assets as a share of total assets.', displayOrder: 36 },
  { code: 'net_worth_growth_12m', category: 'assets_networth', label: 'Net-worth growth', unit: 'percentage', direction: 'higher_better', explanation: 'Change in net worth over the last 12 months.', displayOrder: 37 },

  // 7.6 Investments
  { code: 'investment_contribution_rate', category: 'investments', label: 'Investment contribution rate', unit: 'percentage', direction: 'higher_better', explanation: 'Annual investment contributions as a share of net income.', displayOrder: 38 },
  { code: 'investable_assets_ratio', category: 'investments', label: 'Investable-assets ratio', unit: 'percentage', direction: 'context_only', explanation: 'Investments as a share of total assets.', displayOrder: 39 },
  { code: 'largest_holding_concentration', category: 'investments', label: 'Largest holding concentration', unit: 'percentage', direction: 'lower_better', explanation: 'Largest single investment holding as a share of the investable portfolio.', displayOrder: 40 },
  { code: 'asset_class_diversification', category: 'investments', label: 'Asset-class diversification', unit: 'count', direction: 'higher_better', explanation: 'Number of distinct, materially-weighted investment asset classes held.', displayOrder: 41 },
  { code: 'geographic_diversification', category: 'investments', label: 'Geographic diversification', unit: 'percentage', direction: 'context_only', explanation: 'Investments recorded outside the home country as a share of the portfolio.', displayOrder: 42 },
  { code: 'speculative_asset_ratio', category: 'investments', label: 'Speculative-asset ratio', unit: 'percentage', direction: 'context_only', explanation: 'High-volatility holdings (for example cryptocurrency) as a share of the investable portfolio.', displayOrder: 43 },
  { code: 'portfolio_cost_ratio', category: 'investments', label: 'Portfolio cost ratio', unit: 'percentage', direction: 'lower_better', explanation: 'Annual portfolio fees as a share of portfolio value.', displayOrder: 44 },

  // 7.7 Retirement
  { code: 'retirement_balance', category: 'retirement', label: 'Retirement balance', unit: 'currency', direction: 'higher_better', explanation: 'Sum of recorded retirement accounts.', displayOrder: 45 },
  { code: 'retirement_balance_to_income', category: 'retirement', label: 'Retirement balance-to-income', unit: 'ratio', direction: 'higher_better', explanation: 'Retirement assets divided by annual gross income.', displayOrder: 46 },
  { code: 'retirement_contribution_rate', category: 'retirement', label: 'Retirement contribution rate', unit: 'percentage', direction: 'higher_better', explanation: 'Employer and personal retirement contributions as a share of net income.', displayOrder: 47 },
  { code: 'projected_retirement_readiness', category: 'retirement', label: 'Projected retirement readiness', unit: 'percentage', direction: 'higher_better', explanation: 'Projected balance at target retirement age as a share of an indicative target balance.', displayOrder: 48 },
  { code: 'retirement_funding_gap', category: 'retirement', label: 'Retirement funding gap', unit: 'currency', direction: 'lower_better', explanation: 'Indicative target balance minus the projected balance at target retirement age.', displayOrder: 49 },
  { code: 'debt_at_retirement', category: 'retirement', label: 'Debt at retirement', unit: 'currency', direction: 'lower_better', explanation: 'Projected outstanding debt at target retirement age, assuming current repayment schedules.', displayOrder: 50 },

  // 7.8 Protection
  { code: 'life_cover_adequacy', category: 'insurance', label: 'Life-cover adequacy', unit: 'percentage', direction: 'target_range', explanation: 'Current life cover divided by a modelled need based on debt, dependants and income.', displayOrder: 51 },
  { code: 'income_protection_alignment', category: 'insurance', label: 'Income-protection alignment', unit: 'ratio', direction: 'target_range', explanation: 'Accessible reserve months divided by the income-protection waiting period in months.', displayOrder: 52 },
  { code: 'tpd_cover_adequacy', category: 'insurance', label: 'TPD-cover adequacy', unit: 'percentage', direction: 'target_range', explanation: 'Current total-and-permanent-disability cover divided by a modelled need.', displayOrder: 53 },
  { code: 'major_asset_coverage', category: 'insurance', label: 'Major-asset coverage', unit: 'percentage', direction: 'target_range', explanation: 'Insured replacement value divided by the estimated replacement value of major assets.', displayOrder: 54 },
  { code: 'policy_completeness', category: 'insurance', label: 'Policy completeness', unit: 'percentage', direction: 'higher_better', explanation: 'Relevant active protection categories as a share of relevant categories for this household.', displayOrder: 55 },
  { code: 'premium_burden', category: 'insurance', label: 'Premium burden', unit: 'percentage', direction: 'target_range', explanation: 'Annual insurance premiums as a share of net income.', displayOrder: 56 },

  // 7.9 Goals
  { code: 'goal_progress', category: 'goals', label: 'Goal progress', unit: 'percentage', direction: 'higher_better', explanation: 'Current amount saved as a share of the goal target across active goals.', displayOrder: 57 },
  { code: 'goal_contribution_adequacy', category: 'goals', label: 'Goal contribution adequacy', unit: 'percentage', direction: 'higher_better', explanation: 'Planned contributions as a share of the required contribution to stay on track.', displayOrder: 58 },
  { code: 'on_track_goal_percentage', category: 'goals', label: 'On-track goal percentage', unit: 'percentage', direction: 'higher_better', explanation: 'Share of active goals currently on track.', displayOrder: 59 },
  { code: 'goal_allocation_burden', category: 'goals', label: 'Goal allocation burden', unit: 'percentage', direction: 'target_range', explanation: 'Planned goal contributions as a share of monthly surplus.', displayOrder: 60 },
  { code: 'priority_alignment', category: 'goals', label: 'Priority alignment', unit: 'percentage', direction: 'higher_better', explanation: 'Share of available goal funding directed to high-priority goals.', displayOrder: 61 },

  // 7.10 Cross-Border
  { code: 'country_concentration', category: 'cross_border', label: 'Country concentration', unit: 'percentage', direction: 'context_only', explanation: 'Largest single country as a share of total assets.', displayOrder: 62 },
  { code: 'currency_concentration', category: 'cross_border', label: 'Currency concentration', unit: 'percentage', direction: 'context_only', explanation: 'Largest single currency as a share of total assets.', displayOrder: 63 },
  { code: 'currency_mismatch', category: 'cross_border', label: 'Currency mismatch', unit: 'percentage', direction: 'lower_better', explanation: 'Unmatched foreign-currency obligations as a share of net worth.', displayOrder: 64 },
  { code: 'remittance_burden', category: 'cross_border', label: 'Remittance burden', unit: 'percentage', direction: 'lower_better', explanation: 'Family support and remittances sent overseas as a share of net income.', displayOrder: 65 },
  { code: 'offshore_liquidity_access', category: 'cross_border', label: 'Offshore liquidity access', unit: 'days', direction: 'lower_better', explanation: 'Estimated time required to access offshore emergency funds.', displayOrder: 66 },
  { code: 'cross_border_retirement_coverage', category: 'cross_border', label: 'Cross-border retirement coverage', unit: 'percentage', direction: 'higher_better', explanation: 'Country-specific retirement assets compared with that country’s retirement obligations.', displayOrder: 67 },
];

export function getMetricDefinition(code: string): MetricDefinition | undefined {
  return METRIC_CATALOGUE.find((m) => m.code === code);
}

export function metricsByCategory(category: MetricCategory): MetricDefinition[] {
  return METRIC_CATALOGUE.filter((m) => m.category === category).sort((a, b) => a.displayOrder - b.displayOrder);
}
