// Canonical, approved wording for the Free Report v2, per the user's
// "Revised Free and Premium Report Content Specification" docx. Per that
// spec's own Section 1: "The report-generation layer must use the approved
// wording in this specification. It must not independently create new
// definitions, financial interpretations, formulas, score meanings or
// status rules." Fixed strings below are copied verbatim from the spec;
// household-specific sentences are generated from these templates using
// real reconciled values, never invented figures.

export const REPORT_WHAT_IT_IS =
  "This report provides a consolidated view of your household's current financial position. It brings together your income, expenses, assets, debts, emergency savings, goals, retirement assets and other available financial information to help you understand your overall financial health. It is designed to show not only your financial numbers, but also what those numbers may mean for your day-to-day position, financial resilience and longer-term plans.";

export const REPORT_WHY_IT_EXISTS =
  'Financial information is often spread across bank accounts, loans, investments, properties, retirement accounts and different countries. This can make it difficult to understand the household’s complete position. The Financial Health Intelligence Platform™ created this report to provide one consistent and understandable view of your finances, identify areas of strength, highlight matters that may require review and help you prioritise practical next steps.';

export const REPORT_HOW_TO_READ =
  'The report uses colours to help you identify areas that are on track and areas that may require further review. Green means the result is within the preferred or acceptable range. Amber means the position should be reviewed or monitored. Red means the issue may require priority attention. Grey means there is not enough reliable information to assess the position. A colour is a guide to the calculated result. It is not a guarantee, financial recommendation or prediction of future outcomes.';

export const PAGE1_DISCLAIMER =
  'This report is provided for general financial-information and educational purposes. It is based on the information supplied to the platform and the calculation assumptions shown in the report. It does not constitute personal financial advice, tax advice, legal advice, credit advice or a recommendation to acquire, hold or dispose of any financial product. Consider obtaining advice from an appropriately licensed professional before making financial decisions.';

export const FULL_DISCLAIMER =
  'This report has been prepared by the Financial Health Intelligence Platform™ using information supplied by the user, connected data sources, applicable calculation rules and the assumptions disclosed in the report. The report is provided for general financial-information and educational purposes only. It does not take into account all circumstances that may be relevant to a financial decision and does not constitute personal financial advice, investment advice, tax advice, legal advice, credit advice, insurance advice or a recommendation to acquire, hold, vary or dispose of any financial product. Financial values, projections, scores, benchmarks, scenarios and risk classifications are estimates based on the information and assumptions available at the report date. Actual results may differ due to changes in income, expenses, interest rates, market values, exchange rates, taxation, legislation, household circumstances and other factors. The user should review the underlying data and obtain advice from an appropriately qualified and licensed professional before making financial, investment, credit, insurance, tax or legal decisions.';

export const SCORE_GAUGE_EXPLANATION =
  'Your Financial Health Score combines several areas of your financial position, such as cash flow, emergency savings, debt, assets, protection, retirement preparation and goal progress. It is intended to help you identify relative strengths and areas requiring review. It is not a credit score and does not predict investment returns.';

export const CURRENCY_NAMES: Record<'AUD' | 'INR', string> = {
  AUD: 'Australian dollars',
  INR: 'Indian rupees',
};

// Page 2 "10. Core figures" — exact definitions, used verbatim as the
// "what it is" line for each key metric rather than a bare label.
export const CORE_FIGURE_DEFINITIONS = {
  netIncome: 'Income available to the household after recorded tax and other payroll deductions.',
  expenses: 'Total recorded household outflows for the reporting period, including living expenses, debt repayments, insurance premiums and applicable one-off costs.',
  surplus: 'The amount remaining after total monthly expenses are deducted from net monthly income. A negative result represents a monthly deficit.',
  savingsRate: 'The percentage of net monthly income remaining after recorded expenses.',
  assets: 'The total estimated value of the property, cash, investments, retirement assets and other financial or personal assets included in the report.',
  liabilities: 'The total outstanding value of home loans, investment loans, personal loans, credit cards and other recorded debts.',
  netWorth: 'The amount remaining after total liabilities are deducted from total assets.',
  emergencyFundMonths: 'The number of months of essential household expenses that could be met from eligible, readily available emergency funds.',
  debtServiceRatio: 'The percentage of net monthly income required to meet scheduled debt repayments.',
  goalsOnTrack: 'The number of active financial goals currently meeting their required contribution, funding or timing pathway.',
} as const;

// Page 3 definitions — exact wording.
export const CASHFLOW_DEFINITIONS = {
  grossVsNet:
    'Gross income is income before tax and other deductions. Net income is the amount available after those deductions. The report primarily uses net income when assessing monthly affordability, savings and debt pressure because it represents the amount normally available to the household.',
  essentialVsDiscretionary:
    'Essential expenses are costs that are generally necessary to maintain the household, such as housing, basic food, utilities, transport, healthcare and required education or childcare costs. Discretionary expenses are expenses where the household normally has greater control over the amount or timing, such as entertainment, non-essential shopping, dining out and optional travel.',
  fixedCommitments:
    "Fixed commitments are recurring payments that are difficult to reduce immediately, such as rent, scheduled loan repayments, school fees, subscriptions under contract and other regular obligations. A high level of fixed commitments may reduce the household's ability to adjust spending when income falls or unexpected costs arise.",
  debtRepayments:
    'Debt repayments are the scheduled principal, interest and required minimum payments recorded for loans and credit facilities. They are shown separately because they affect monthly cash flow and financial flexibility.',
  insurancePremiums:
    'Insurance premiums are the regular costs of maintaining the insurance policies recorded in the platform. Premiums affect monthly cash flow, while the corresponding insurance cover is assessed separately in the protection section.',
  oneOffExpenses:
    'One-off expenses are irregular or non-recurring payments that may materially affect the reporting period but are not expected to continue every month. Examples may include major repairs, medical costs, annual fees, travel, tax payments or large purchases.',
  monthlySurplus:
    'Monthly surplus is the amount remaining after recorded monthly expenses and commitments are deducted from net income. A continuing surplus may provide capacity for emergency savings, debt reduction, investment, retirement contributions or financial goals.',
  monthlyDeficit:
    'A monthly deficit means recorded expenses and commitments are greater than current net income. The household may be relying on savings, asset sales, credit or irregular income to meet the difference.',
} as const;

// Page 4 definitions — exact wording.
export const NET_WORTH_DEFINITIONS = {
  netWorth:
    "Net worth is the estimated value of everything included in your household's assets after deducting all recorded liabilities. It provides a broad measure of your accumulated financial position at the snapshot date. Net worth does not represent the amount of cash immediately available to the household.",
  liquidVsIlliquid:
    'Liquid assets can generally be accessed or converted into cash relatively quickly, subject to any account or market restrictions. Examples may include cash, transaction accounts, deposits and some listed investments. Illiquid assets may take longer to sell, involve significant transaction costs or be unavailable for immediate household use. Examples may include property, private businesses, unlisted investments and certain retirement assets.',
  propertyConcentration:
    "Property concentration measures how much of the household's total assets or net wealth is held in property. A high concentration is not automatically negative, but it may make the household more dependent on property values, rental conditions, interest rates and the time required to sell a property.",
  retirementAssets:
    'Retirement assets are balances intended primarily to support income after retirement. These may include superannuation, SMSF assets, EPF, PPF, NPS, pensions and other approved retirement accounts. Retirement assets form part of overall wealth but may not be available for current household expenses because access can be restricted by law, age, account rules or tax conditions.',
  securedDebt:
    'Secured debt is supported by an asset that the lender may have rights over if required repayments are not made. Home loans, investment-property loans and some vehicle or business loans are common examples.',
  unsecuredDebt:
    'Unsecured debt is not directly supported by a specific asset. Credit cards, some personal loans and certain lines of credit are common examples. These debts may carry higher interest rates and may create greater monthly cash-flow pressure.',
} as const;

// Page 7 definitions — exact wording.
export const DATA_QUALITY_DEFINITIONS = {
  completion: 'Completion percentage shows how much of the information required for the applicable report calculations has been supplied and accepted.',
  stale: 'Stale data is information that may no longer represent the household’s current position because it has not been updated within the applicable review period.',
  rejected: 'Rejected records are not included in report calculations. Review or correct these records before relying on the affected results.',
  duplicates: 'Suspected duplicate records may cause income, assets, liabilities or expenses to be counted more than once. Records classified as confirmed duplicates must be excluded from calculations.',
  versions: 'Calculation versions identify the rules and models used to produce this report. They allow the report to be reproduced and reconciled to the same source snapshot.',
} as const;

export function confidenceExplanation(level: 'high' | 'medium' | 'low', limitingArea: string | null): string {
  if (level === 'high') return 'High data confidence: most required records are complete, current and successfully reconciled.';
  if (level === 'medium')
    return `Medium data confidence: most major balances were available, but ${limitingArea ?? 'some sections'} contain incomplete or older information.`;
  return `Low data confidence: important records affecting ${limitingArea ?? 'this report'} are missing, stale or inconsistent, so this report may present an incomplete picture.`;
}

// "Core financial data completion" (the data-quality table's percentage) and
// "Premium analysis readiness" are different measures — completion counts
// whether required records were supplied, readiness reflects whether
// deeper calculations (trend history, behaviour check-ins, Financial Twin)
// have enough history/inputs to run at all. Showing only one number as if
// it covered both understates what's actually still unavailable.
export function premiumAnalysisReadinessNote(unavailableAreas: string[]): string | null {
  if (unavailableAreas.length === 0) return null;
  return `Premium analysis readiness: Partial — ${unavailableAreas.join(', ')} ${unavailableAreas.length === 1 ? 'is' : 'are'} not yet available for this household.`;
}

// Raw database category codes must never reach user-facing report or chart
// text verbatim (spec requirement) — every place a code from these enums
// reaches report output should route through categoryLabel() below.
const CATEGORY_LABELS: Record<string, string> = {
  // asset_class (supabase/migrations/0003_module2.sql)
  cash: 'Cash and Deposits',
  property: 'Property',
  vehicle: 'Vehicle',
  business: 'Business',
  // debt_type
  mortgage: 'Mortgage',
  personal_loan: 'Personal Loan',
  credit_card: 'Credit Card',
  auto_loan: 'Auto Loan',
  student_loan: 'Student Loan / HECS-HELP',
  // investment_type
  shares: 'Shares',
  managed_fund: 'Managed Fund',
  etf: 'ETF',
  crypto: 'Cryptocurrency',
  business_equity: 'Business Equity',
  // insurance cover_type
  life: 'Life Insurance',
  income_protection: 'Income Protection',
  health: 'Health Cover',
  home: 'Home and Contents Insurance',
  // dashboard.ts AllocationBucket (superset of asset_class/investment_type)
  super: 'Superannuation',
  fixed_income: 'Fixed Income',
  gold: 'Gold',
  // Generic fallback shared by asset_class/debt_type/investment_type's own
  // "other" value — kept context-neutral since this map has no way to know
  // which enum a given code came from.
  other: 'Other',
};

export function categoryLabel(code: string): string {
  return CATEGORY_LABELS[code] ?? code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
