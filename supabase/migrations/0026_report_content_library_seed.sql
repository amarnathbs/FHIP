-- Seeds report_content_library with the exact wording lib/engines/reportCopy.ts
-- has always used (word-for-word, per the "Revised Free and Premium Report
-- Content Specification" the app must not deviate from) — this migration
-- moves WHERE the content lives, it does not change what it says. Uses
-- dollar-quoting throughout to avoid manually escaping the many apostrophes
-- in this copy.
insert into report_content_library (content_key, locale, content_type, status_band, code_value, title, body_template) values

('report_what_it_is', 'en', 'fixed', null, null, null, $$This report provides a consolidated view of your household's current financial position. It brings together your income, expenses, assets, debts, emergency savings, goals, retirement assets and other available financial information to help you understand your overall financial health. It is designed to show not only your financial numbers, but also what those numbers may mean for your day-to-day position, financial resilience and longer-term plans.$$),

('report_why_it_exists', 'en', 'fixed', null, null, null, $$Financial information is often spread across bank accounts, loans, investments, properties, retirement accounts and different countries. This can make it difficult to understand the household’s complete position. The Financial Health Intelligence Platform™ created this report to provide one consistent and understandable view of your finances, identify areas of strength, highlight matters that may require review and help you prioritise practical next steps.$$),

('report_how_to_read', 'en', 'fixed', null, null, null, $$The report uses colours to help you identify areas that are on track and areas that may require further review. Green means the result is within the preferred or acceptable range. Amber means the position should be reviewed or monitored. Red means the issue may require priority attention. Grey means there is not enough reliable information to assess the position. A colour is a guide to the calculated result. It is not a guarantee, financial recommendation or prediction of future outcomes.$$),

('page1_disclaimer', 'en', 'fixed', null, null, null, $$This report is provided for general financial-information and educational purposes. It is based on the information supplied to the platform and the calculation assumptions shown in the report. It does not constitute personal financial advice, tax advice, legal advice, credit advice or a recommendation to acquire, hold or dispose of any financial product. Consider obtaining advice from an appropriately licensed professional before making financial decisions.$$),

('full_disclaimer', 'en', 'fixed', null, null, null, $$This report has been prepared by the Financial Health Intelligence Platform™ using information supplied by the user, connected data sources, applicable calculation rules and the assumptions disclosed in the report. The report is provided for general financial-information and educational purposes only. It does not take into account all circumstances that may be relevant to a financial decision and does not constitute personal financial advice, investment advice, tax advice, legal advice, credit advice, insurance advice or a recommendation to acquire, hold, vary or dispose of any financial product. Financial values, projections, scores, benchmarks, scenarios and risk classifications are estimates based on the information and assumptions available at the report date. Actual results may differ due to changes in income, expenses, interest rates, market values, exchange rates, taxation, legislation, household circumstances and other factors. The user should review the underlying data and obtain advice from an appropriately qualified and licensed professional before making financial, investment, credit, insurance, tax or legal decisions.$$),

('score_gauge_explanation', 'en', 'fixed', null, null, null, $$Your Financial Health Score combines several areas of your financial position, such as cash flow, emergency savings, debt, assets, protection, retirement preparation and goal progress. It is intended to help you identify relative strengths and areas requiring review. It is not a credit score and does not predict investment returns.$$),

-- Zero unavailable areas -> null (no row shown); the accessor returns null
-- when unavailableAreas is empty, matching premiumAnalysisReadinessNote()'s
-- existing early-return.
('premium_analysis_readiness_note', 'en', 'fixed', null, null, null, $$Premium analysis readiness: Partial — {unavailableAreas} {verb}.$$),

-- Confidence explanation — banded by level, medium/low carry a {limitingArea} placeholder.
('confidence_explanation', 'en', 'banded', 'high', null, null, $$High data confidence: most required records are complete, current and successfully reconciled.$$),
('confidence_explanation', 'en', 'banded', 'medium', null, null, $$Medium data confidence: most major balances were available, but {limitingArea} contain incomplete or older information.$$),
('confidence_explanation', 'en', 'banded', 'low', null, null, $$Low data confidence: important records affecting {limitingArea} are missing, stale or inconsistent, so this report may present an incomplete picture.$$),

-- Currency names
('currency_name', 'en', 'code_label', null, 'AUD', null, $$Australian dollars$$),
('currency_name', 'en', 'code_label', null, 'INR', null, $$Indian rupees$$),

-- Core figure definitions (page 2 "10. Core figures")
('core_figure_definition', 'en', 'code_label', null, 'netIncome', null, $$Income available to the household after recorded tax and other payroll deductions.$$),
('core_figure_definition', 'en', 'code_label', null, 'expenses', null, $$Total recorded household outflows for the reporting period, including living expenses, debt repayments, insurance premiums and applicable one-off costs.$$),
('core_figure_definition', 'en', 'code_label', null, 'surplus', null, $$The amount remaining after total monthly expenses are deducted from net monthly income. A negative result represents a monthly deficit.$$),
('core_figure_definition', 'en', 'code_label', null, 'savingsRate', null, $$The percentage of net monthly income remaining after recorded expenses.$$),
('core_figure_definition', 'en', 'code_label', null, 'assets', null, $$The total estimated value of the property, cash, investments, retirement assets and other financial or personal assets included in the report.$$),
('core_figure_definition', 'en', 'code_label', null, 'liabilities', null, $$The total outstanding value of home loans, investment loans, personal loans, credit cards and other recorded debts.$$),
('core_figure_definition', 'en', 'code_label', null, 'netWorth', null, $$The amount remaining after total liabilities are deducted from total assets.$$),
('core_figure_definition', 'en', 'code_label', null, 'emergencyFundMonths', null, $$The number of months of essential household expenses that could be met from eligible, readily available emergency funds.$$),
('core_figure_definition', 'en', 'code_label', null, 'debtServiceRatio', null, $$The percentage of net monthly income required to meet scheduled debt repayments.$$),
('core_figure_definition', 'en', 'code_label', null, 'goalsOnTrack', null, $$The number of active financial goals currently meeting their required contribution, funding or timing pathway.$$),

-- Cash flow definitions (page 3)
('cashflow_definition', 'en', 'code_label', null, 'grossVsNet', null, $$Gross income is income before tax and other deductions. Net income is the amount available after those deductions. The report primarily uses net income when assessing monthly affordability, savings and debt pressure because it represents the amount normally available to the household.$$),
('cashflow_definition', 'en', 'code_label', null, 'essentialVsDiscretionary', null, $$Essential expenses are costs that are generally necessary to maintain the household, such as housing, basic food, utilities, transport, healthcare and required education or childcare costs. Discretionary expenses are expenses where the household normally has greater control over the amount or timing, such as entertainment, non-essential shopping, dining out and optional travel.$$),
('cashflow_definition', 'en', 'code_label', null, 'fixedCommitments', null, $$Fixed commitments are recurring payments that are difficult to reduce immediately, such as rent, scheduled loan repayments, school fees, subscriptions under contract and other regular obligations. A high level of fixed commitments may reduce the household's ability to adjust spending when income falls or unexpected costs arise.$$),
('cashflow_definition', 'en', 'code_label', null, 'debtRepayments', null, $$Debt repayments are the scheduled principal, interest and required minimum payments recorded for loans and credit facilities. They are shown separately because they affect monthly cash flow and financial flexibility.$$),
('cashflow_definition', 'en', 'code_label', null, 'insurancePremiums', null, $$Insurance premiums are the regular costs of maintaining the insurance policies recorded in the platform. Premiums affect monthly cash flow, while the corresponding insurance cover is assessed separately in the protection section.$$),
('cashflow_definition', 'en', 'code_label', null, 'oneOffExpenses', null, $$One-off expenses are irregular or non-recurring payments that may materially affect the reporting period but are not expected to continue every month. Examples may include major repairs, medical costs, annual fees, travel, tax payments or large purchases.$$),
('cashflow_definition', 'en', 'code_label', null, 'monthlySurplus', null, $$Monthly surplus is the amount remaining after recorded monthly expenses and commitments are deducted from net income. A continuing surplus may provide capacity for emergency savings, debt reduction, investment, retirement contributions or financial goals.$$),
('cashflow_definition', 'en', 'code_label', null, 'monthlyDeficit', null, $$A monthly deficit means recorded expenses and commitments are greater than current net income. The household may be relying on savings, asset sales, credit or irregular income to meet the difference.$$),

-- Net worth definitions (page 4)
('net_worth_definition', 'en', 'code_label', null, 'netWorth', null, $$Net worth is the estimated value of everything included in your household's assets after deducting all recorded liabilities. It provides a broad measure of your accumulated financial position at the snapshot date. Net worth does not represent the amount of cash immediately available to the household.$$),
('net_worth_definition', 'en', 'code_label', null, 'liquidVsIlliquid', null, $$Liquid assets can generally be accessed or converted into cash relatively quickly, subject to any account or market restrictions. Examples may include cash, transaction accounts, deposits and some listed investments. Illiquid assets may take longer to sell, involve significant transaction costs or be unavailable for immediate household use. Examples may include property, private businesses, unlisted investments and certain retirement assets.$$),
('net_worth_definition', 'en', 'code_label', null, 'propertyConcentration', null, $$Property concentration measures how much of the household's total assets or net wealth is held in property. A high concentration is not automatically negative, but it may make the household more dependent on property values, rental conditions, interest rates and the time required to sell a property.$$),
('net_worth_definition', 'en', 'code_label', null, 'retirementAssets', null, $$Retirement assets are balances intended primarily to support income after retirement. These may include superannuation, SMSF assets, EPF, PPF, NPS, pensions and other approved retirement accounts. Retirement assets form part of overall wealth but may not be available for current household expenses because access can be restricted by law, age, account rules or tax conditions.$$),
('net_worth_definition', 'en', 'code_label', null, 'securedDebt', null, $$Secured debt is supported by an asset that the lender may have rights over if required repayments are not made. Home loans, investment-property loans and some vehicle or business loans are common examples.$$),
('net_worth_definition', 'en', 'code_label', null, 'unsecuredDebt', null, $$Unsecured debt is not directly supported by a specific asset. Credit cards, some personal loans and certain lines of credit are common examples. These debts may carry higher interest rates and may create greater monthly cash-flow pressure.$$),

-- Data quality definitions (page 7)
('data_quality_definition', 'en', 'code_label', null, 'completion', null, $$Completion percentage shows how much of the information required for the applicable report calculations has been supplied and accepted.$$),
('data_quality_definition', 'en', 'code_label', null, 'stale', null, $$Stale data is information that may no longer represent the household’s current position because it has not been updated within the applicable review period.$$),
('data_quality_definition', 'en', 'code_label', null, 'rejected', null, $$Rejected records are not included in report calculations. Review or correct these records before relying on the affected results.$$),
('data_quality_definition', 'en', 'code_label', null, 'duplicates', null, $$Suspected duplicate records may cause income, assets, liabilities or expenses to be counted more than once. Records classified as confirmed duplicates must be excluded from calculations.$$),
('data_quality_definition', 'en', 'code_label', null, 'versions', null, $$Calculation versions identify the rules and models used to produce this report. They allow the report to be reproduced and reconciled to the same source snapshot.$$),

-- Category labels — raw DB enum codes must never reach report/chart text
-- verbatim. Generic fallback (title-cased raw code) stays in code for any
-- code not seeded here, matching categoryLabel()'s existing behaviour.
('category_label', 'en', 'code_label', null, 'cash', null, $$Cash and Deposits$$),
('category_label', 'en', 'code_label', null, 'property', null, $$Property$$),
('category_label', 'en', 'code_label', null, 'vehicle', null, $$Vehicle$$),
('category_label', 'en', 'code_label', null, 'business', null, $$Business$$),
('category_label', 'en', 'code_label', null, 'mortgage', null, $$Mortgage$$),
('category_label', 'en', 'code_label', null, 'personal_loan', null, $$Personal Loan$$),
('category_label', 'en', 'code_label', null, 'credit_card', null, $$Credit Card$$),
('category_label', 'en', 'code_label', null, 'auto_loan', null, $$Auto Loan$$),
('category_label', 'en', 'code_label', null, 'student_loan', null, $$Student Loan / HECS-HELP$$),
('category_label', 'en', 'code_label', null, 'shares', null, $$Shares$$),
('category_label', 'en', 'code_label', null, 'managed_fund', null, $$Managed Fund$$),
('category_label', 'en', 'code_label', null, 'etf', null, $$ETF$$),
('category_label', 'en', 'code_label', null, 'crypto', null, $$Cryptocurrency$$),
('category_label', 'en', 'code_label', null, 'business_equity', null, $$Business Equity$$),
('category_label', 'en', 'code_label', null, 'life', null, $$Life Insurance$$),
('category_label', 'en', 'code_label', null, 'income_protection', null, $$Income Protection$$),
('category_label', 'en', 'code_label', null, 'health', null, $$Health Cover$$),
('category_label', 'en', 'code_label', null, 'home', null, $$Home and Contents Insurance$$),
('category_label', 'en', 'code_label', null, 'super', null, $$Superannuation$$),
('category_label', 'en', 'code_label', null, 'fixed_income', null, $$Fixed Income$$),
('category_label', 'en', 'code_label', null, 'gold', null, $$Gold$$),
('category_label', 'en', 'code_label', null, 'other', null, $$Other$$)

on conflict (content_key, locale, status_band, code_value) do nothing;
