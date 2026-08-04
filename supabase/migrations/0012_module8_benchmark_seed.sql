-- Module 8 benchmark seed: 67 metric definitions, benchmark sources/datasets
-- for Australia and India official data, a starter cohort set, observed
-- values tied to those cohorts, and the full FHIP Planning Benchmark v1.0
-- target-range library (spec section 8). All FHIP-authored target ranges
-- are seeded as benchmark_class='fhip_planning', evidence_level=
-- 'research_informed', is_indicative=true per the spec's own restriction —
-- these are recommended seed parameters for product development and
-- testing, not claimed population medians, and require review by
-- financial-planning/actuarial/legal/compliance specialists before any
-- public production use.

-- ---------------------------------------------------------------------------
-- 0. First admin user (grants the existing test account admin access to the
-- benchmark-governance screens built in this module).
-- ---------------------------------------------------------------------------
insert into admin_users (user_id, notes)
select id, 'Seeded as first admin for Module 8 benchmark governance testing.'
from auth.users
where email = 'amarnath.bekal@gmail.com'
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Metric definitions (67 metrics, spec section 7)
-- ---------------------------------------------------------------------------
insert into benchmark_metric_definitions (metric_code, metric_name, category_code, unit, comparison_direction, household_or_person, display_precision, explanation, display_order)
values
  ('gross_household_income', 'Gross household income', 'income_cashflow', 'currency', 'context_only', 'household', 0, 'Annualised gross recurring household income.', 1),
  ('net_household_income', 'Net household income', 'income_cashflow', 'currency', 'context_only', 'household', 0, 'Annualised after-tax recurring household income.', 2),
  ('income_growth_12m', 'Income growth', 'income_cashflow', 'percentage', 'higher_better', 'household', 1, 'Change in gross income over the last 12 months.', 3),
  ('income_concentration', 'Income concentration', 'income_cashflow', 'percentage', 'lower_better', 'household', 1, 'Largest income source as a share of total income.', 4),
  ('passive_income_ratio', 'Passive income ratio', 'income_cashflow', 'percentage', 'context_only', 'household', 1, 'Stable passive income as a share of total income.', 5),
  ('monthly_surplus', 'Monthly surplus', 'income_cashflow', 'currency', 'higher_better', 'household', 0, 'Net income minus cash outflows for the month.', 6),
  ('surplus_margin', 'Surplus margin', 'income_cashflow', 'percentage', 'higher_better', 'household', 1, 'Monthly surplus as a share of net income.', 7),
  ('positive_cashflow_consistency', 'Positive cash-flow consistency', 'income_cashflow', 'percentage', 'higher_better', 'household', 1, 'Share of the last 12 months with a positive surplus.', 8),
  ('total_expense_ratio', 'Total expense ratio', 'expenses_savings', 'percentage', 'lower_better', 'household', 1, 'Household expenses as a share of net income.', 9),
  ('essential_expense_ratio', 'Essential expense ratio', 'expenses_savings', 'percentage', 'lower_better', 'household', 1, 'Essential expenses as a share of net income.', 10),
  ('discretionary_expense_ratio', 'Discretionary expense ratio', 'expenses_savings', 'percentage', 'context_only', 'household', 1, 'Discretionary (lifestyle) expenses as a share of net income.', 11),
  ('housing_cost_ratio', 'Housing-cost ratio', 'expenses_savings', 'percentage', 'lower_better', 'household', 1, 'Housing costs as a share of gross income.', 12),
  ('fixed_commitment_ratio', 'Fixed-commitment ratio', 'expenses_savings', 'percentage', 'lower_better', 'household', 1, 'Mandatory commitments as a share of net income.', 13),
  ('savings_rate', 'Savings rate', 'expenses_savings', 'percentage', 'higher_better', 'household', 1, 'Savings and investment contributions as a share of net income.', 14),
  ('expense_growth_12m', 'Expense growth', 'expenses_savings', 'percentage', 'context_only', 'household', 1, 'Change in total expenses over the last 12 months.', 15),
  ('emergency_fund_months', 'Emergency fund', 'liquidity_resilience', 'months', 'higher_better', 'household', 1, 'Accessible reserves divided by essential monthly expenses.', 16),
  ('immediate_liquidity_ratio', 'Immediate liquidity ratio', 'liquidity_resilience', 'ratio', 'higher_better', 'household', 2, 'Immediately accessible assets divided by 30-day obligations.', 17),
  ('liquid_net_worth', 'Liquid net worth', 'liquidity_resilience', 'currency', 'higher_better', 'household', 0, 'Liquid assets minus short-term liabilities.', 18),
  ('near_liquid_coverage', 'Near-liquid coverage', 'liquidity_resilience', 'months', 'higher_better', 'household', 1, 'Immediate and near-liquid resources divided by essential expenses.', 19),
  ('income_interruption_coverage', 'Income interruption coverage', 'liquidity_resilience', 'months', 'higher_better', 'household', 1, 'Resources available to cover essential expenses during an income loss.', 20),
  ('debt_to_income', 'Debt-to-income', 'debt_commitments', 'ratio', 'lower_better', 'household', 2, 'Total debt divided by gross annual income.', 21),
  ('debt_service_ratio', 'Debt-service ratio', 'debt_commitments', 'percentage', 'lower_better', 'household', 1, 'Required debt repayments as a share of monthly net income.', 22),
  ('debt_to_asset_ratio', 'Debt-to-asset ratio', 'debt_commitments', 'percentage', 'lower_better', 'household', 1, 'Total debt divided by total assets.', 23),
  ('unsecured_debt_ratio', 'Unsecured debt ratio', 'debt_commitments', 'percentage', 'lower_better', 'household', 1, 'Unsecured debt as a share of annual net income.', 24),
  ('high_interest_debt_share', 'High-interest debt share', 'debt_commitments', 'percentage', 'lower_better', 'household', 1, 'Debt at or above 10% interest as a share of total debt.', 25),
  ('credit_utilization', 'Credit utilisation', 'debt_commitments', 'percentage', 'lower_better', 'household', 1, 'Revolving credit balance divided by credit limit.', 26),
  ('home_loan_lvr', 'Home loan LVR', 'debt_commitments', 'percentage', 'lower_better', 'household', 1, 'Mortgage balance divided by property value.', 27),
  ('variable_rate_exposure', 'Variable-rate exposure', 'debt_commitments', 'percentage', 'context_only', 'household', 1, 'Variable-rate debt as a share of rate-classified debt.', 28),
  ('refinance_exposure_24m', 'Refinance exposure', 'debt_commitments', 'percentage', 'lower_better', 'household', 1, 'Debt due or resetting soon as a share of total debt.', 29),
  ('total_assets', 'Total assets', 'assets_networth', 'currency', 'context_only', 'household', 0, 'Sum of all active recorded assets.', 30),
  ('net_worth', 'Net worth', 'assets_networth', 'currency', 'higher_better', 'household', 0, 'Assets minus liabilities.', 31),
  ('net_worth_to_income', 'Net-worth-to-income', 'assets_networth', 'ratio', 'higher_better', 'household', 2, 'Net worth divided by annual gross income.', 32),
  ('liquid_asset_share', 'Liquid-asset share', 'assets_networth', 'percentage', 'context_only', 'household', 1, 'Liquid assets as a share of total assets.', 33),
  ('property_concentration', 'Property concentration', 'assets_networth', 'percentage', 'context_only', 'household', 1, 'Property assets as a share of total assets.', 34),
  ('productive_asset_ratio', 'Productive-asset ratio', 'assets_networth', 'percentage', 'higher_better', 'household', 1, 'Investment, retirement and business assets as a share of total assets.', 35),
  ('depreciating_asset_ratio', 'Depreciating-asset ratio', 'assets_networth', 'percentage', 'lower_better', 'household', 1, 'Vehicles and similar assets as a share of total assets.', 36),
  ('net_worth_growth_12m', 'Net-worth growth', 'assets_networth', 'percentage', 'higher_better', 'household', 1, 'Change in net worth over the last 12 months.', 37),
  ('investment_contribution_rate', 'Investment contribution rate', 'investments', 'percentage', 'higher_better', 'household', 1, 'Annual investment contributions as a share of net income.', 38),
  ('investable_assets_ratio', 'Investable-assets ratio', 'investments', 'percentage', 'context_only', 'household', 1, 'Investments as a share of total assets.', 39),
  ('largest_holding_concentration', 'Largest holding concentration', 'investments', 'percentage', 'lower_better', 'household', 1, 'Largest single holding as a share of the investable portfolio.', 40),
  ('asset_class_diversification', 'Asset-class diversification', 'investments', 'count', 'higher_better', 'household', 0, 'Number of distinct investment asset classes held.', 41),
  ('geographic_diversification', 'Geographic diversification', 'investments', 'percentage', 'context_only', 'household', 1, 'Investments outside the home country as a share of the portfolio.', 42),
  ('speculative_asset_ratio', 'Speculative-asset ratio', 'investments', 'percentage', 'context_only', 'household', 1, 'High-volatility holdings as a share of the investable portfolio.', 43),
  ('portfolio_cost_ratio', 'Portfolio cost ratio', 'investments', 'percentage', 'lower_better', 'household', 2, 'Annual portfolio fees as a share of portfolio value.', 44),
  ('retirement_balance', 'Retirement balance', 'retirement', 'currency', 'higher_better', 'household', 0, 'Sum of recorded retirement accounts.', 45),
  ('retirement_balance_to_income', 'Retirement balance-to-income', 'retirement', 'ratio', 'higher_better', 'household', 2, 'Retirement assets divided by annual gross income.', 46),
  ('retirement_contribution_rate', 'Retirement contribution rate', 'retirement', 'percentage', 'higher_better', 'household', 1, 'Employer and personal retirement contributions as a share of net income.', 47),
  ('projected_retirement_readiness', 'Projected retirement readiness', 'retirement', 'percentage', 'higher_better', 'household', 1, 'Projected balance at target retirement age vs an indicative target.', 48),
  ('retirement_funding_gap', 'Retirement funding gap', 'retirement', 'currency', 'lower_better', 'household', 0, 'Indicative target balance minus the projected balance.', 49),
  ('debt_at_retirement', 'Debt at retirement', 'retirement', 'currency', 'lower_better', 'household', 0, 'Projected outstanding debt at target retirement age.', 50),
  ('life_cover_adequacy', 'Life-cover adequacy', 'insurance', 'percentage', 'target_range', 'household', 1, 'Current life cover divided by a modelled need.', 51),
  ('income_protection_alignment', 'Income-protection alignment', 'insurance', 'ratio', 'target_range', 'household', 2, 'Reserve months divided by the income-protection waiting period in months.', 52),
  ('tpd_cover_adequacy', 'TPD-cover adequacy', 'insurance', 'percentage', 'target_range', 'household', 1, 'TPD cover divided by a modelled need.', 53),
  ('major_asset_coverage', 'Major-asset coverage', 'insurance', 'percentage', 'target_range', 'household', 1, 'Insured replacement value divided by estimated replacement value.', 54),
  ('policy_completeness', 'Policy completeness', 'insurance', 'percentage', 'higher_better', 'household', 1, 'Relevant active protection categories as a share of relevant categories.', 55),
  ('premium_burden', 'Premium burden', 'insurance', 'percentage', 'target_range', 'household', 1, 'Annual insurance premiums as a share of net income.', 56),
  ('goal_progress', 'Goal progress', 'goals', 'percentage', 'higher_better', 'household', 1, 'Current amount saved as a share of target across active goals.', 57),
  ('goal_contribution_adequacy', 'Goal contribution adequacy', 'goals', 'percentage', 'higher_better', 'household', 1, 'Planned contributions as a share of the required contribution.', 58),
  ('on_track_goal_percentage', 'On-track goal percentage', 'goals', 'percentage', 'higher_better', 'household', 1, 'Share of active goals currently on track.', 59),
  ('goal_allocation_burden', 'Goal allocation burden', 'goals', 'percentage', 'target_range', 'household', 1, 'Planned goal contributions as a share of monthly surplus.', 60),
  ('priority_alignment', 'Priority alignment', 'goals', 'percentage', 'higher_better', 'household', 1, 'Share of goal funding directed to high-priority goals.', 61),
  ('country_concentration', 'Country concentration', 'cross_border', 'percentage', 'context_only', 'household', 1, 'Largest single country as a share of total assets.', 62),
  ('currency_concentration', 'Currency concentration', 'cross_border', 'percentage', 'context_only', 'household', 1, 'Largest single currency as a share of total assets.', 63),
  ('currency_mismatch', 'Currency mismatch', 'cross_border', 'percentage', 'lower_better', 'household', 1, 'Unmatched foreign-currency obligations as a share of net worth.', 64),
  ('remittance_burden', 'Remittance burden', 'cross_border', 'percentage', 'lower_better', 'household', 1, 'Family support and remittances sent overseas as a share of net income.', 65),
  ('offshore_liquidity_access', 'Offshore liquidity access', 'cross_border', 'days', 'lower_better', 'household', 0, 'Estimated time to access offshore emergency funds.', 66),
  ('cross_border_retirement_coverage', 'Cross-border retirement coverage', 'cross_border', 'percentage', 'higher_better', 'household', 1, 'Country-specific retirement assets vs that country''s obligations.', 67)
on conflict (metric_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Benchmark sources
-- ---------------------------------------------------------------------------
insert into benchmark_sources (source_name, source_type, publisher, source_title, country_code, publication_date, reference_period_start, reference_period_end, citation_text, methodology_notes, quality_rating, status)
values
  ('ABS_SIH_2019_20', 'official', 'Australian Bureau of Statistics', 'Survey of Income and Housing 2019-20', 'AU', '2022-06-28', '2019-07-01', '2020-06-30', 'ABS, Survey of Income and Housing, 2019-20', 'National household survey; wealth figures are mean/median/percentile estimates, not census data.', 'high', 'active'),
  ('ABS_SIH_AGE_2019_20', 'official', 'Australian Bureau of Statistics', 'Survey of Income and Housing 2019-20 - household net worth and income by age of reference person', 'AU', '2022-06-28', '2019-07-01', '2020-06-30', 'ABS, Survey of Income and Housing, 2019-20 (age of household reference person)', 'Figures are MEANS, not medians, and are skewed upward by high-wealth households in each age band.', 'high', 'active'),
  ('APRA_MACROPRUDENTIAL_2026', 'official', 'Australian Prudential Regulation Authority', 'High debt-to-income mortgage lending limit', 'AU', '2026-02-01', '2026-02-01', null, 'APRA macroprudential guidance, effective 2026-02-01', 'A lender-level portfolio limit (20% of new lending at or above 6x DTI), not a personal borrowing recommendation.', 'high', 'active'),
  ('ATO_SUPER_2023_24', 'official', 'Australian Taxation Office', 'Average superannuation account balance 2023-24', 'AU', '2025-04-01', '2023-07-01', '2024-06-30', 'ATO taxation statistics, 2023-24', 'Account-level average, not household- or age-adjusted; used for source transparency only.', 'high', 'active'),
  ('ASFA_STANDARD_2026', 'industry', 'Association of Superannuation Funds of Australia', 'ASFA Retirement Standard 2026', 'AU', '2026-02-01', '2026-02-01', null, 'ASFA Retirement Standard, homeowner retiring at 67, 2026 quarter', 'Assumes specified investment returns and Age Pension settings; a retirement-planning benchmark, not a population median.', 'high', 'active'),
  ('MOSPI_HCES_2023_24', 'official', 'Ministry of Statistics and Programme Implementation (India)', 'Household Consumption Expenditure Survey 2023-24', 'IN', '2024-06-25', '2023-08-01', '2024-07-31', 'MoSPI, Household Consumption Expenditure Survey, 2023-24', 'Reports average monthly PER-CAPITA consumption expenditure; must be scaled by household size before household-level comparison.', 'high', 'active'),
  ('AIDIS_2019', 'official', 'National Statistical Office (India)', 'All-India Debt and Investment Survey 2019 (as at 30 June 2018)', 'IN', '2021-09-01', '2018-06-30', '2018-06-30', 'NSO, All-India Debt and Investment Survey, 2019', 'Household asset/debt averages as at 30 June 2018; rural and urban figures reported separately and must not be merged.', 'high', 'active'),
  ('EPFO_CONTRIBUTION_STRUCTURE', 'official', 'Employees'' Provident Fund Organisation (India)', 'EPF/EPS statutory contribution structure', 'IN', '2026-01-01', '2026-01-01', null, 'EPFO statutory contribution rules', 'Contribution is a percentage of basic wages plus dearness allowance, not of total gross household income.', 'high', 'active'),
  ('FHIP_PLANNING_V1', 'internal', 'FHIP', 'FHIP Planning Benchmarks v1.0', null, current_date, current_date, null, 'FHIP Planning Benchmarks v1.0 (internal, research-informed)', 'Recommended seed parameters for product development and testing. Not claimed to be population medians; requires review by financial-planning, actuarial, legal and compliance specialists before public production use.', 'medium', 'active')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Datasets (one per source-topic, each tagged with its own benchmark_class)
-- ---------------------------------------------------------------------------
insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, evidence_level, is_indicative, requires_periodic_review, source_period, geography_level, statistic_coverage, sample_size, data_status, effective_from, approved_at)
select s.id, d.dataset_name, '1.0', d.benchmark_class, d.evidence_level, d.is_indicative, true, d.source_period, d.geography_level, d.statistic_coverage, d.sample_size, 'active', current_date, now()
from (values
  ('ABS_SIH_2019_20', 'AU household wealth distribution', 'observed_market', 'official_statistical', true, '2019-20', 'country', 'mean, median, approx. P20/P80', null::int, 'AU_wealth_dist'),
  ('ABS_SIH_AGE_2019_20', 'AU net worth and income by age band', 'observed_market', 'official_statistical', true, '2019-20', 'country', 'mean only', null, 'AU_wealth_age'),
  ('ABS_SIH_2019_20', 'AU household asset composition', 'observed_market', 'official_statistical', true, '2019-20', 'country', 'share of total assets', null, 'AU_asset_mix'),
  ('ABS_SIH_2019_20', 'AU household debt context', 'observed_market', 'official_statistical', true, '2019-20', 'country', 'share of indebted households', null, 'AU_debt_context'),
  ('APRA_MACROPRUDENTIAL_2026', 'AU high-DTI mortgage threshold', 'regulatory_statutory', 'regulatory', false, '2026', 'country', 'threshold', null, 'AU_dti_threshold'),
  ('ATO_SUPER_2023_24', 'AU average superannuation balance', 'observed_market', 'official_statistical', true, '2023-24', 'country', 'mean (account level)', null, 'AU_super_avg'),
  ('ASFA_STANDARD_2026', 'AU ASFA retirement standard', 'fhip_planning', 'official_statistical', true, '2026', 'country', 'target balance (single/couple)', null, 'AU_asfa'),
  ('MOSPI_HCES_2023_24', 'India household consumption expenditure (rural/urban)', 'observed_market', 'official_statistical', true, '2023-24', 'urban_rural', 'mean per-capita, fractile averages', 261000, 'IN_hces'),
  ('AIDIS_2019', 'India household assets and debt (rural/urban)', 'observed_market', 'official_statistical', true, '2018-06-30', 'urban_rural', 'mean per household', null, 'IN_aidis'),
  ('EPFO_CONTRIBUTION_STRUCTURE', 'India EPF/EPS contribution structure', 'regulatory_statutory', 'regulatory', false, '2026', 'country', 'rate', null, 'IN_epf'),
  ('FHIP_PLANNING_V1', 'FHIP Planning Benchmarks v1.0', 'fhip_planning', 'research_informed', true, current_date::text, 'country', 'banded target ranges', null, 'FHIP_PLANNING')
) as d(source_key, dataset_name, benchmark_class, evidence_level, is_indicative, source_period, geography_level, statistic_coverage, sample_size, dataset_key)
join benchmark_sources s on s.source_name = d.source_key
on conflict (dataset_name, version) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Cohorts (a starter set — genuinely useful, not exhaustive; most real
-- users will land on Tier 3/4 given the granularity of available official
-- data, which is itself surfaced to the user via the cohort tier badge).
-- ---------------------------------------------------------------------------
insert into benchmark_cohorts (dataset_id, cohort_code, country_code, region_code, urban_rural, age_band, income_band, household_type, life_stage, housing_tenure, employment_type, dependant_band, financial_dna_code, cross_border_flag, cohort_tier, sample_size, cohort_description)
select
  (select id from benchmark_datasets where dataset_name = c.dataset_name and version = '1.0'),
  c.cohort_code, c.country_code, null, c.urban_rural, c.age_band, c.income_band, c.household_type, c.life_stage, c.housing_tenure, c.employment_type, c.dependant_band, null, false, c.cohort_tier, c.sample_size, c.cohort_description
from (values
  ('AU net worth and income by age band', 'AU_AGE_18_24', 'AU', null, 'AGE_18_24', null, null, null, null, null, null, 4, null::int, 'Australian households aged 18-24 (ABS age-based mean reference)'),
  ('AU net worth and income by age band', 'AU_AGE_25_34', 'AU', null, 'AGE_25_34', null, null, null, null, null, null, 4, null, 'Australian households aged 25-34 (ABS age-based mean reference)'),
  ('AU net worth and income by age band', 'AU_AGE_35_44', 'AU', null, 'AGE_35_44', null, null, null, null, null, null, 4, null, 'Australian households aged 35-44 (ABS age-based mean reference)'),
  ('AU net worth and income by age band', 'AU_AGE_45_54', 'AU', null, 'AGE_45_54', null, null, null, null, null, null, 4, null, 'Australian households aged 45-54 (ABS age-based mean reference)'),
  ('AU net worth and income by age band', 'AU_AGE_55_64', 'AU', null, 'AGE_55_64', null, null, null, null, null, null, 4, null, 'Australian households aged 55-64 (ABS age-based mean reference)'),
  ('AU net worth and income by age band', 'AU_AGE_65_74', 'AU', null, 'AGE_65_74', null, null, null, null, null, null, 4, null, 'Australian households aged 65-74 (ABS age-based mean reference)'),
  ('AU net worth and income by age band', 'AU_AGE_75_PLUS', 'AU', null, 'AGE_75_PLUS', null, null, null, null, null, null, 4, null, 'Australian households aged 75+ (ABS age-based mean reference)'),
  ('AU household wealth distribution', 'AU_YOUNG_PROFESSIONAL', 'AU', null, 'AGE_25_34', null, 'single', 'young_professional', null, null, null, 3, null, 'Australian young professional, age 25-34, single, no dependants'),
  ('AU household wealth distribution', 'AU_YOUNG_FAMILY', 'AU', null, 'AGE_25_34', null, 'couple_with_kids', 'young_family', null, null, null, 3, null, 'Australian young family, age 25-34, couple with children'),
  ('AU household wealth distribution', 'AU_ESTABLISHED_FAMILY', 'AU', null, 'AGE_45_54', null, 'couple_with_kids', 'established_family', null, null, null, 3, null, 'Australian established family, age 45-54, couple with children'),
  ('AU household wealth distribution', 'AU_ESTABLISHED_NO_KIDS', 'AU', null, 'AGE_45_54', null, 'couple_no_kids', 'established_no_kids', null, null, null, 3, null, 'Australian established household, age 45-54, couple with no dependants'),
  ('AU household wealth distribution', 'AU_PRE_RETIREE', 'AU', null, 'AGE_55_64', null, 'couple_no_kids', 'pre_retiree', null, null, null, 3, null, 'Australian pre-retiree couple, age 55-64'),
  ('AU household wealth distribution', 'AU_RETIREE', 'AU', null, 'AGE_65_74', null, 'couple_no_kids', 'retiree', null, null, null, 3, null, 'Australian retiree couple, age 65-74'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_YOUNG_PROFESSIONAL', 'IN', 'urban', 'AGE_25_34', null, 'single', 'young_professional', null, null, null, 3, null, 'Urban Indian young professional, age 25-34, single'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_YOUNG_FAMILY', 'IN', 'urban', 'AGE_25_34', null, 'couple_with_kids', 'young_family', null, null, null, 3, null, 'Urban Indian young family, age 25-34, couple with children'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_ESTABLISHED_FAMILY', 'IN', 'urban', 'AGE_45_54', null, 'couple_with_kids', 'established_family', null, null, null, 3, null, 'Urban Indian established family, age 45-54, couple with children'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_ESTABLISHED_NO_KIDS', 'IN', 'urban', 'AGE_45_54', null, 'couple_no_kids', 'established_no_kids', null, null, null, 3, null, 'Urban Indian established household, age 45-54, couple with no dependants'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_PRE_RETIREE', 'IN', 'urban', 'AGE_55_64', null, 'couple_no_kids', 'pre_retiree', null, null, null, 3, null, 'Urban Indian pre-retiree couple, age 55-64'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_RETIREE', 'IN', 'urban', 'AGE_65_74', null, 'couple_no_kids', 'retiree', null, null, null, 3, null, 'Urban Indian retiree couple, age 65-74'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_YOUNG_PROFESSIONAL', 'IN', 'rural', 'AGE_25_34', null, 'single', 'young_professional', null, null, null, 3, null, 'Rural Indian young professional, age 25-34, single'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_YOUNG_FAMILY', 'IN', 'rural', 'AGE_25_34', null, 'couple_with_kids', 'young_family', null, null, null, 3, null, 'Rural Indian young family, age 25-34, couple with children'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_ESTABLISHED_FAMILY', 'IN', 'rural', 'AGE_45_54', null, 'couple_with_kids', 'established_family', null, null, null, 3, null, 'Rural Indian established family, age 45-54, couple with children'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_ESTABLISHED_NO_KIDS', 'IN', 'rural', 'AGE_45_54', null, 'couple_no_kids', 'established_no_kids', null, null, null, 3, null, 'Rural Indian established household, age 45-54, couple with no dependants'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_PRE_RETIREE', 'IN', 'rural', 'AGE_55_64', null, 'couple_no_kids', 'pre_retiree', null, null, null, 3, null, 'Rural Indian pre-retiree couple, age 55-64'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_RETIREE', 'IN', 'rural', 'AGE_65_74', null, 'couple_no_kids', 'retiree', null, null, null, 3, null, 'Rural Indian retiree couple, age 65-74'),
  ('India household assets and debt (rural/urban)', 'IN_URBAN_ALL', 'IN', 'urban', null, null, null, null, null, null, null, 4, null, 'Urban India, all ages and household types (AIDIS 2019 broad reference)'),
  ('India household assets and debt (rural/urban)', 'IN_RURAL_ALL', 'IN', 'rural', null, null, null, null, null, null, null, 4, null, 'Rural India, all ages and household types (AIDIS 2019 broad reference)')
) as c(dataset_name, cohort_code, country_code, urban_rural, age_band, income_band, household_type, life_stage, housing_tenure, employment_type, dependant_band, cohort_tier, sample_size, cohort_description)
on conflict (cohort_code) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Observed benchmark values
-- ---------------------------------------------------------------------------
-- 5a. AU age-based mean net worth and mean gross weekly income*52 (section 9.2)
insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, original_currency, base_date, is_derived, derivation_method, confidence_score, effective_from)
select
  (select id from benchmark_datasets where dataset_name = 'AU net worth and income by age band' and version = '1.0'),
  (select id from benchmark_cohorts where cohort_code = v.cohort_code),
  (select id from benchmark_metric_definitions where metric_code = v.metric_code),
  'mean', v.value_numeric, v.unit, 'AUD', '2020-06-30', v.is_derived, v.derivation_method, 70, '2022-06-28'
from (values
  ('AU_AGE_18_24', 'net_worth', 129000, 'currency', false, null),
  ('AU_AGE_25_34', 'net_worth', 242000, 'currency', false, null),
  ('AU_AGE_35_44', 'net_worth', 555000, 'currency', false, null),
  ('AU_AGE_45_54', 'net_worth', 1055000, 'currency', false, null),
  ('AU_AGE_55_64', 'net_worth', 1453000, 'currency', false, null),
  ('AU_AGE_65_74', 'net_worth', 1835000, 'currency', false, null),
  ('AU_AGE_75_PLUS', 'net_worth', 1167000, 'currency', false, null),
  ('AU_AGE_18_24', 'gross_household_income', 46748, 'currency', true, 'Annualised from ABS mean gross weekly household income (899 * 52).'),
  ('AU_AGE_25_34', 'gross_household_income', 119808, 'currency', true, 'Annualised from ABS mean gross weekly household income (2304 * 52).'),
  ('AU_AGE_35_44', 'gross_household_income', 153972, 'currency', true, 'Annualised from ABS mean gross weekly household income (2961 * 52, using the 40-44 reference row).'),
  ('AU_AGE_45_54', 'gross_household_income', 158964, 'currency', true, 'Annualised from ABS mean gross weekly household income (3058 * 52, using the 45-49 reference row).'),
  ('AU_AGE_55_64', 'gross_household_income', 146744, 'currency', true, 'Annualised from ABS mean gross weekly household income (2822 * 52, using the 55-59 reference row).'),
  ('AU_AGE_65_74', 'gross_household_income', 81328, 'currency', true, 'Annualised from ABS mean gross weekly household income (1564 * 52, using the 65-69 reference row).'),
  ('AU_AGE_75_PLUS', 'gross_household_income', 54340, 'currency', true, 'Annualised from ABS mean gross weekly household income (1045 * 52).')
) as v(cohort_code, metric_code, value_numeric, unit, is_derived, derivation_method);

-- 5b. AU country-wide net worth distribution (2019-20) — cohort_id null = applies broadly, not tied to a specific age/life-stage cohort.
insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, original_currency, base_date, is_derived, confidence_score, effective_from)
select (select id from benchmark_datasets where dataset_name = 'AU household wealth distribution' and version = '1.0'), null,
  (select id from benchmark_metric_definitions where metric_code = 'net_worth'), v.statistic_type, v.value_numeric, 'currency', 'AUD', '2020-06-30', v.is_derived, 75, '2022-06-28'
from (values
  ('median', 579200, false),
  ('mean', 1040000, false),
  ('p20', 113400, true),
  ('p80', 1400000, true)
) as v(statistic_type, value_numeric, is_derived);

-- 5c. AU property concentration (asset composition, section 9.3) — the spec's own worked example.
insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, original_currency, base_date, is_derived, derivation_method, confidence_score, effective_from)
values (
  (select id from benchmark_datasets where dataset_name = 'AU household asset composition' and version = '1.0'), null,
  (select id from benchmark_metric_definitions where metric_code = 'property_concentration'), 'mean', 56.2, 'percentage', 'AUD', '2020-06-30', true,
  'Sum of owner-occupied dwelling (40.7%) and other property (15.5%) shares of total household assets.', 70, '2022-06-28'
);

-- 5d. AU regulatory DTI threshold and ATO super average (context only — not used as the primary retirement comparison, see ASFA target ranges below)
insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, original_currency, base_date, is_derived, confidence_score, effective_from)
values
  ((select id from benchmark_datasets where dataset_name = 'AU high-DTI mortgage threshold' and version = '1.0'), null,
   (select id from benchmark_metric_definitions where metric_code = 'debt_to_income'), 'threshold', 6.0, 'ratio', null, '2026-02-01', false, 95, '2026-02-01'),
  ((select id from benchmark_datasets where dataset_name = 'AU average superannuation balance' and version = '1.0'), null,
   (select id from benchmark_metric_definitions where metric_code = 'retirement_balance'), 'mean', 183000, 'currency', 'AUD', '2024-06-30', false, 55, '2025-04-01');

-- 5e. India HCES per-capita consumption (rural/urban) is deliberately NOT
-- wired to a metric here. The MoSPI figures (rural 4,122 / urban 6,996) are
-- per-PERSON monthly currency amounts; none of the 67 catalogue metrics are
-- denominated that way, and scaling a per-capita figure into a household
-- comparison needs an explicit, tested household-size adjustment (spec
-- 10.1's own warning against comparing household spend directly against
-- per-capita figures). The dataset/source above remains seeded for
-- citation and governance completeness; this is a disclosed limitation
-- until per-capita-to-household scaling is built and tested.

-- 5f. India AIDIS household assets/debt (rural/urban averages, section
-- 10.2/10.3) — attached to the broad IN_URBAN_ALL/IN_RURAL_ALL cohorts
-- (not cohort_id null) so the two figures don't collide as two conflicting
-- country-wide values for the same metric.
insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, original_currency, base_date, is_derived, derivation_method, confidence_score, effective_from)
select (select id from benchmark_datasets where dataset_name = 'India household assets and debt (rural/urban)' and version = '1.0'),
  (select id from benchmark_cohorts where cohort_code = v.cohort_code),
  (select id from benchmark_metric_definitions where metric_code = v.metric_code), 'mean', v.value_numeric, v.unit, 'INR', '2018-06-30', v.is_derived, v.derivation_method, 65, '2021-09-01'
from (values
  ('IN_RURAL_ALL', 'total_assets', 1592379, 'currency', false, 'Rural India average total household assets (AIDIS 2019).'),
  ('IN_URBAN_ALL', 'total_assets', 2717081, 'currency', false, 'Urban India average total household assets (AIDIS 2019).'),
  ('IN_RURAL_ALL', 'liquid_asset_share', 4.6, 'percentage', true, 'FHIP-derived: rural average financial assets (72,608) / average total assets (1,592,379).'),
  ('IN_URBAN_ALL', 'liquid_asset_share', 9.3, 'percentage', true, 'FHIP-derived: urban average financial assets (251,804) / average total assets (2,717,081).')
) as v(cohort_code, metric_code, value_numeric, unit, is_derived, derivation_method);

-- 5g. India EPF/EPS statutory contribution rates (regulatory, not a household-income-relative figure)
insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, original_currency, base_date, is_derived, derivation_method, confidence_score, effective_from)
values (
  (select id from benchmark_datasets where dataset_name = 'India EPF/EPS contribution structure' and version = '1.0'), null,
  (select id from benchmark_metric_definitions where metric_code = 'retirement_contribution_rate'), 'rate', 24.0, 'percentage', null, '2026-01-01', true,
  'Combined statutory employee (12%) plus employer (12%) EPF/EPS contribution as a percentage of basic wages plus dearness allowance — NOT directly equivalent to a percentage of total gross household income.', 60, '2026-01-01'
);

-- ---------------------------------------------------------------------------
-- 6. ASFA retirement-planning targets (household-scoped: single vs couple —
-- section 9.5). Cited to ASFA, not presented as FHIP's own research.
-- ---------------------------------------------------------------------------
insert into benchmark_target_ranges (metric_definition_id, benchmark_source_id, country_code, household_type, band_label, band_tier, lower_bound, upper_bound, explanation, evidence_level, model_version)
select (select id from benchmark_metric_definitions where metric_code = 'retirement_balance'),
  (select id from benchmark_sources where source_name = 'ASFA_STANDARD_2026'), 'AU', v.household_type, v.band_label, v.band_tier, v.lower_bound, v.upper_bound,
  v.explanation, 'official_statistical', 'asfa-2026'
from (values
  ('single', 'modest', 2, 0::numeric, 110000::numeric, 'ASFA "modest" standard for a single homeowner retiring at 67. Renters need a materially higher balance.'),
  ('single', 'comfortable', 4, 630000::numeric, null::numeric, 'ASFA "comfortable" standard for a single homeowner retiring at 67.'),
  ('couple_no_kids', 'modest', 2, 0::numeric, 120000::numeric, 'ASFA "modest" standard for a couple, homeowners, retiring at 67. Renters need a materially higher balance.'),
  ('couple_no_kids', 'comfortable', 4, 730000::numeric, null::numeric, 'ASFA "comfortable" standard for a couple, homeowners, retiring at 67.')
) as v(household_type, band_label, band_tier, lower_bound, upper_bound, explanation);

-- ---------------------------------------------------------------------------
-- 7. FHIP Planning Benchmark v1.0 target ranges (spec sections 8.1-8.9).
-- Country-agnostic bands (percentages/ratios apply the same regardless of
-- country) unless noted otherwise. evidence_level defaults to
-- research_informed, model_version to fhip-planning-1.0.0 (table defaults).
-- ---------------------------------------------------------------------------
insert into benchmark_target_ranges (metric_definition_id, country_code, band_label, band_tier, lower_bound, upper_bound, explanation)
select (select id from benchmark_metric_definitions where metric_code = v.metric_code), null, v.band_label, v.band_tier, v.lower_bound, v.upper_bound, v.explanation
from (values
  -- 8.1 Cash flow, expense and savings
  ('surplus_margin', 'critical', 1, null::numeric, 0::numeric, 'Below 0% surplus margin indicates high cash-flow pressure.'),
  ('surplus_margin', 'needs_attention', 2, 0, 9.9, 'A thin but positive surplus margin.'),
  ('surplus_margin', 'healthy', 3, 10, 24.9, 'A generally healthy surplus margin.'),
  ('surplus_margin', 'strong', 4, 25, null, 'A strong surplus margin.'),
  ('savings_rate', 'critical', 1, null, 0, 'A negative savings rate indicates spending exceeds income.'),
  ('savings_rate', 'needs_attention', 2, 0, 9.9, 'A modest savings rate.'),
  ('savings_rate', 'healthy', 3, 10, 19.9, 'A generally healthy savings rate.'),
  ('savings_rate', 'strong', 4, 20, null, 'A strong savings rate.'),
  ('total_expense_ratio', 'critical', 1, 100, null, 'Expenses exceed net income.'),
  ('total_expense_ratio', 'needs_attention', 2, 90, 100, 'Expenses use nearly all net income.'),
  ('total_expense_ratio', 'healthy', 3, 60, 90, 'A generally healthy total expense ratio.'),
  ('total_expense_ratio', 'strong', 4, null, 60, 'A strong (low) total expense ratio.'),
  ('essential_expense_ratio', 'critical', 1, 75, null, 'Essential expenses use most of net income, leaving little flexibility.'),
  ('essential_expense_ratio', 'needs_attention', 2, 60, 75, 'Essential expenses use a large share of net income.'),
  ('essential_expense_ratio', 'healthy', 3, 45, 60, 'A generally healthy essential expense ratio.'),
  ('essential_expense_ratio', 'strong', 4, null, 45, 'Essential expenses leave substantial flexibility.'),
  ('housing_cost_ratio', 'critical', 1, 40, null, 'Housing costs commonly associated with housing stress for lower-income households — read alongside income level and tenure.'),
  ('housing_cost_ratio', 'needs_attention', 2, 30, 40, 'A high housing-cost ratio.'),
  ('housing_cost_ratio', 'healthy', 3, 20, 30, 'A generally healthy housing-cost ratio.'),
  ('housing_cost_ratio', 'strong', 4, null, 20, 'A low housing-cost ratio.'),
  ('fixed_commitment_ratio', 'critical', 1, 75, null, 'Fixed commitments use most of net income.'),
  ('fixed_commitment_ratio', 'needs_attention', 2, 60, 75, 'Fixed commitments use a large share of net income.'),
  ('fixed_commitment_ratio', 'healthy', 3, 45, 60, 'A generally healthy fixed-commitment ratio.'),
  ('fixed_commitment_ratio', 'strong', 4, null, 45, 'A low fixed-commitment ratio.'),
  ('positive_cashflow_consistency', 'critical', 1, null, 50, 'Six or fewer of the last 12 months had a positive surplus.'),
  ('positive_cashflow_consistency', 'needs_attention', 2, 50, 75, 'Seven to nine of the last 12 months had a positive surplus.'),
  ('positive_cashflow_consistency', 'healthy', 3, 75, 91.7, 'Ten to eleven of the last 12 months had a positive surplus.'),
  ('positive_cashflow_consistency', 'strong', 4, 91.7, null, 'Every one of the last 12 months had a positive surplus.'),
  ('discretionary_expense_ratio', 'critical', 1, 30, null, 'A very high discretionary spending share — subject to lifestyle goals.'),
  ('discretionary_expense_ratio', 'needs_attention', 2, 20, 30, 'A high discretionary spending share.'),
  ('discretionary_expense_ratio', 'healthy', 3, 10, 20, 'A generally healthy discretionary spending share.'),
  ('discretionary_expense_ratio', 'strong', 4, null, 10, 'A low discretionary spending share, subject to lifestyle goals.'),
  -- 8.2 Liquidity and income resilience
  ('emergency_fund_months', 'critical', 1, null, 1, 'Less than one month of essential-expense coverage.'),
  ('emergency_fund_months', 'vulnerable', 2, 1, 2.9, 'One to under three months of coverage.'),
  ('emergency_fund_months', 'adequate', 3, 3, 5.9, 'Three to under six months of coverage.'),
  ('emergency_fund_months', 'strong', 4, 6, 12, 'Six to twelve months of coverage — personalise for dual-income vs single-income vs self-employed households.'),
  ('immediate_liquidity_ratio', 'critical', 1, null, 1.0, 'Immediately accessible assets don''t cover 30-day obligations.'),
  ('immediate_liquidity_ratio', 'vulnerable', 2, 1.0, 1.24, 'A thin immediate liquidity buffer.'),
  ('immediate_liquidity_ratio', 'adequate', 3, 1.25, 1.99, 'An adequate immediate liquidity buffer.'),
  ('immediate_liquidity_ratio', 'strong', 4, 2.0, null, 'A strong immediate liquidity buffer.'),
  ('near_liquid_coverage', 'critical', 1, null, 3, 'Less than three months of short-term coverage.'),
  ('near_liquid_coverage', 'vulnerable', 2, 3, 5.9, 'Three to under six months of short-term coverage.'),
  ('near_liquid_coverage', 'adequate', 3, 6, 11.9, 'Six to under twelve months of short-term coverage.'),
  ('near_liquid_coverage', 'strong', 4, 12, null, 'Twelve months or more of short-term coverage.'),
  ('income_interruption_coverage', 'critical', 1, null, 3, 'Less than three months of coverage during an income interruption.'),
  ('income_interruption_coverage', 'vulnerable', 2, 3, 5.9, 'Three to under six months of coverage.'),
  ('income_interruption_coverage', 'adequate', 3, 6, 11.9, 'Six to under twelve months of coverage.'),
  ('income_interruption_coverage', 'strong', 4, 12, null, 'Twelve months or more of coverage.'),
  ('income_concentration', 'critical', 1, 90, null, 'A single income source provides nearly all household income.'),
  ('income_concentration', 'vulnerable', 2, 75, 90, 'A high reliance on a single income source.'),
  ('income_concentration', 'adequate', 3, 50, 75, 'A moderate reliance on a single income source.'),
  ('income_concentration', 'strong', 4, null, 50, 'Income is reasonably spread across sources.'),
  ('passive_income_ratio', 'critical', 1, null, 5, 'Passive income covers very little of essential expenses (approximation).'),
  ('passive_income_ratio', 'vulnerable', 2, 5, 19.9, 'Passive income covers a modest share (approximation).'),
  ('passive_income_ratio', 'adequate', 3, 20, 49.9, 'Passive income covers a meaningful share (approximation).'),
  ('passive_income_ratio', 'strong', 4, 50, null, 'Passive income covers half or more of income (approximation).'),
  -- 8.3 Debt (band order reversed: lower debt = tier 4)
  ('debt_service_ratio', 'high_risk', 1, 40, null, 'Debt repayments use 40% or more of net income.'),
  ('debt_service_ratio', 'elevated', 2, 30, 39.9, 'An elevated debt-service ratio.'),
  ('debt_service_ratio', 'manageable', 3, 20, 29.9, 'A manageable debt-service ratio.'),
  ('debt_service_ratio', 'strong', 4, null, 20, 'A low, strong debt-service ratio.'),
  ('debt_to_income', 'high_risk', 1, 6, null, 'Total debt is six times gross income or more — the same threshold APRA uses to classify high-DTI mortgage lending.'),
  ('debt_to_income', 'elevated', 2, 4, 5.99, 'An elevated debt-to-income ratio.'),
  ('debt_to_income', 'manageable', 3, 2, 3.99, 'A manageable debt-to-income ratio.'),
  ('debt_to_income', 'strong', 4, null, 2, 'A low, strong debt-to-income ratio.'),
  ('unsecured_debt_ratio', 'high_risk', 1, 30, null, 'Unsecured debt is 30% or more of annual net income.'),
  ('unsecured_debt_ratio', 'elevated', 2, 15, 29.9, 'An elevated unsecured-debt ratio.'),
  ('unsecured_debt_ratio', 'manageable', 3, 5, 14.9, 'A manageable unsecured-debt ratio.'),
  ('unsecured_debt_ratio', 'strong', 4, null, 5, 'A low unsecured-debt ratio.'),
  ('high_interest_debt_share', 'high_risk', 1, 25, null, 'A quarter or more of total debt is high-interest.'),
  ('high_interest_debt_share', 'elevated', 2, 10, 24.9, 'An elevated high-interest debt share.'),
  ('high_interest_debt_share', 'manageable', 3, 0.01, 9.9, 'A small high-interest debt share.'),
  ('high_interest_debt_share', 'strong', 4, 0, 0, 'No high-interest debt recorded.'),
  ('credit_utilization', 'high_risk', 1, 50, null, 'Revolving credit utilisation is 50% or more.'),
  ('credit_utilization', 'elevated', 2, 30, 49.9, 'An elevated credit-utilisation level.'),
  ('credit_utilization', 'manageable', 3, 10, 29.9, 'A manageable credit-utilisation level.'),
  ('credit_utilization', 'strong', 4, null, 10, 'A low credit-utilisation level.'),
  ('home_loan_lvr', 'high_risk', 1, 90, null, 'A very high loan-to-value ratio.'),
  ('home_loan_lvr', 'elevated', 2, 80, 89.9, 'An elevated loan-to-value ratio.'),
  ('home_loan_lvr', 'manageable', 3, 60, 79.9, 'A manageable loan-to-value ratio.'),
  ('home_loan_lvr', 'strong', 4, null, 60, 'A low, strong loan-to-value ratio.'),
  ('variable_rate_exposure', 'high_risk', 1, 75, null, 'Three-quarters or more of rate-classified debt is variable-rate.'),
  ('variable_rate_exposure', 'elevated', 2, 50, 74.9, 'An elevated variable-rate exposure.'),
  ('variable_rate_exposure', 'manageable', 3, 25, 49.9, 'A moderate variable-rate exposure.'),
  ('variable_rate_exposure', 'strong', 4, null, 25, 'A low variable-rate exposure.'),
  ('refinance_exposure_24m', 'high_risk', 1, 50, null, 'Half or more of total debt is due or resetting soon.'),
  ('refinance_exposure_24m', 'elevated', 2, 25, 49.9, 'An elevated near-term refinance exposure.'),
  ('refinance_exposure_24m', 'manageable', 3, 10, 24.9, 'A moderate near-term refinance exposure.'),
  ('refinance_exposure_24m', 'strong', 4, null, 10, 'A low near-term refinance exposure.'),
  -- 8.4 Assets and wealth structure
  ('liquid_asset_share', 'low_concern', 1, null, 5, 'A very low liquid-asset share.'),
  ('liquid_asset_share', 'developing', 2, 5, 14.9, 'A developing liquid-asset share.'),
  ('liquid_asset_share', 'balanced', 3, 15, 29.9, 'A generally balanced liquid-asset share.'),
  ('liquid_asset_share', 'strong', 4, 30, null, 'A strong liquid-asset share.'),
  ('investable_assets_ratio', 'low_concern', 1, null, 10, 'A low investable-assets ratio.'),
  ('investable_assets_ratio', 'developing', 2, 10, 24.9, 'A developing investable-assets ratio.'),
  ('investable_assets_ratio', 'balanced', 3, 25, 49.9, 'A generally balanced investable-assets ratio.'),
  ('investable_assets_ratio', 'strong', 4, 50, null, 'A strong investable-assets ratio.'),
  ('productive_asset_ratio', 'low_concern', 1, null, 40, 'A low productive-asset ratio.'),
  ('productive_asset_ratio', 'developing', 2, 40, 59.9, 'A developing productive-asset ratio.'),
  ('productive_asset_ratio', 'balanced', 3, 60, 79.9, 'A generally balanced productive-asset ratio.'),
  ('productive_asset_ratio', 'strong', 4, 80, null, 'A strong productive-asset ratio.'),
  ('depreciating_asset_ratio', 'low_concern', 1, 25, null, 'A high depreciating-asset ratio.'),
  ('depreciating_asset_ratio', 'developing', 2, 15, 25, 'An elevated depreciating-asset ratio.'),
  ('depreciating_asset_ratio', 'balanced', 3, 5, 14.9, 'A generally balanced depreciating-asset ratio.'),
  ('depreciating_asset_ratio', 'strong', 4, null, 5, 'A low depreciating-asset ratio.'),
  ('property_concentration', 'low_concern', 1, 85, null, 'Property makes up most of total assets — treat as an exposure indicator, not automatically poor allocation.'),
  ('property_concentration', 'developing', 2, 70, 85, 'A high property concentration.'),
  ('property_concentration', 'balanced', 3, 50, 69.9, 'A generally balanced property concentration.'),
  ('property_concentration', 'strong', 4, null, 50, 'A lower property concentration, subject to life stage and goals.'),
  ('largest_holding_concentration', 'low_concern', 1, 50, null, 'A single holding makes up half or more of the portfolio.'),
  ('largest_holding_concentration', 'developing', 2, 25, 50, 'A concentrated single holding.'),
  ('largest_holding_concentration', 'balanced', 3, 10, 24.9, 'A moderately diversified largest holding.'),
  ('largest_holding_concentration', 'strong', 4, null, 10, 'A well-diversified portfolio with no dominant single holding.'),
  ('net_worth_growth_12m', 'low_concern', 1, null, 0, 'Net worth declined over the last 12 months.'),
  ('net_worth_growth_12m', 'developing', 2, 0, 2.9, 'Modest net-worth growth.'),
  ('net_worth_growth_12m', 'balanced', 3, 3, 7.9, 'Solid net-worth growth.'),
  ('net_worth_growth_12m', 'strong', 4, 8, null, 'Strong net-worth growth, subject to market effects.'),
  -- 8.5 Investment
  ('investment_contribution_rate', 'low_concern', 1, null, 5, 'A low investment contribution rate.'),
  ('investment_contribution_rate', 'developing', 2, 5, 9.9, 'A developing investment contribution rate.'),
  ('investment_contribution_rate', 'healthy', 3, 10, 19.9, 'A healthy investment contribution rate.'),
  ('investment_contribution_rate', 'strong', 4, 20, null, 'A strong investment contribution rate.'),
  ('speculative_asset_ratio', 'high_concern', 1, 20, null, 'A high speculative-asset share of the investable portfolio.'),
  ('speculative_asset_ratio', 'developing', 2, 10, 20, 'An elevated speculative-asset share.'),
  ('speculative_asset_ratio', 'healthy', 3, 5, 9.9, 'A moderate speculative-asset share.'),
  ('speculative_asset_ratio', 'strong', 4, null, 5, 'A low speculative-asset share.'),
  ('asset_class_diversification', 'low_concern', 1, 1, 1, 'Only one material asset class held.'),
  ('asset_class_diversification', 'developing', 2, 2, 2, 'Two material asset classes held.'),
  ('asset_class_diversification', 'healthy', 3, 3, 4, 'Three to four material asset classes held.'),
  ('asset_class_diversification', 'strong', 4, 5, null, 'Five or more material asset classes held, where appropriate.'),
  ('portfolio_cost_ratio', 'high_concern', 1, 2, null, 'High annual portfolio costs.'),
  ('portfolio_cost_ratio', 'developing', 2, 1, 2, 'Elevated annual portfolio costs.'),
  ('portfolio_cost_ratio', 'healthy', 3, 0.5, 0.99, 'Moderate annual portfolio costs.'),
  ('portfolio_cost_ratio', 'strong', 4, null, 0.5, 'Low annual portfolio costs, subject to product type.'),
  -- 8.7 Insurance and protection
  ('life_cover_adequacy', 'high_gap', 1, null, 50, 'Life cover meets less than half of the modelled need.'),
  ('life_cover_adequacy', 'partial', 2, 50, 79.9, 'Life cover meets part of the modelled need.'),
  ('life_cover_adequacy', 'near_adequate', 3, 80, 99.9, 'Life cover is close to the modelled need.'),
  ('life_cover_adequacy', 'adequate', 4, 100, null, 'Life cover meets or exceeds the modelled need.'),
  ('tpd_cover_adequacy', 'high_gap', 1, null, 50, 'TPD cover meets less than half of the modelled need.'),
  ('tpd_cover_adequacy', 'partial', 2, 50, 79.9, 'TPD cover meets part of the modelled need.'),
  ('tpd_cover_adequacy', 'near_adequate', 3, 80, 99.9, 'TPD cover is close to the modelled need.'),
  ('tpd_cover_adequacy', 'adequate', 4, 100, null, 'TPD cover meets or exceeds the modelled need.'),
  ('major_asset_coverage', 'high_gap', 1, null, 80, 'Insured cover is well below the estimated replacement value.'),
  ('major_asset_coverage', 'partial', 2, 80, 94.9, 'Insured cover is below the estimated replacement value.'),
  ('major_asset_coverage', 'near_adequate', 3, 95, 99.9, 'Insured cover is close to the estimated replacement value.'),
  ('major_asset_coverage', 'adequate', 4, 100, null, 'Insured cover matches the estimated replacement value.'),
  ('income_protection_alignment', 'high_gap', 1, null, 0.5, 'Accessible reserves cover well under half of the income-protection waiting period (approximation).'),
  ('income_protection_alignment', 'partial', 2, 0.5, 0.99, 'Accessible reserves cover part of the waiting period (approximation).'),
  ('income_protection_alignment', 'near_adequate', 3, 1.0, 1.49, 'Accessible reserves cover the waiting period (approximation).'),
  ('income_protection_alignment', 'adequate', 4, 1.5, null, 'Accessible reserves cover the waiting period plus a buffer (approximation).'),
  ('policy_completeness', 'high_gap', 1, null, 25, 'Few relevant protection categories are in place.'),
  ('policy_completeness', 'partial', 2, 25, 49.9, 'Some relevant protection categories are in place.'),
  ('policy_completeness', 'near_adequate', 3, 50, 74.9, 'Most relevant protection categories are in place.'),
  ('policy_completeness', 'adequate', 4, 75, 100, 'Most or all relevant protection categories are in place.'),
  -- 8.8 Goals
  ('goal_progress', 'off_track', 1, null, 90, 'Forecast target-date funding is below 90%.'),
  ('goal_progress', 'at_risk', 2, 90, 99.9, 'Forecast target-date funding is close to target.'),
  ('goal_progress', 'on_track', 3, 100, 104.9, 'Forecast target-date funding meets the target.'),
  ('goal_progress', 'ahead', 4, 105, null, 'Forecast target-date funding exceeds the target.'),
  ('goal_contribution_adequacy', 'off_track', 1, null, 80, 'Planned contributions are well below the required amount.'),
  ('goal_contribution_adequacy', 'at_risk', 2, 80, 99.9, 'Planned contributions are below the required amount.'),
  ('goal_contribution_adequacy', 'on_track', 3, 100, 119.9, 'Planned contributions meet the required amount.'),
  ('goal_contribution_adequacy', 'ahead', 4, 120, null, 'Planned contributions exceed the required amount.'),
  ('on_track_goal_percentage', 'off_track', 1, null, 50, 'Fewer than half of high-priority goals are on track.'),
  ('on_track_goal_percentage', 'at_risk', 2, 50, 74.9, 'Around half of goals are on track.'),
  ('on_track_goal_percentage', 'on_track', 3, 75, 99.9, 'Most goals are on track.'),
  ('on_track_goal_percentage', 'ahead', 4, 100, 100, 'All goals are on track.'),
  ('goal_allocation_burden', 'off_track', 1, 100, null, 'Planned goal contributions exceed available monthly surplus.'),
  ('goal_allocation_burden', 'at_risk', 2, 80, 100, 'Planned goal contributions use most of the available surplus.'),
  ('goal_allocation_burden', 'on_track', 3, 50, 79.9, 'Planned goal contributions use a moderate share of the available surplus.'),
  ('goal_allocation_burden', 'ahead', 4, null, 50, 'Planned goal contributions leave unused flexibility.'),
  -- 8.9 Cross-border (lower exposure = tier 4)
  ('currency_mismatch', 'very_high', 1, 30, null, 'Unmatched foreign-currency obligations are 30% or more of net worth.'),
  ('currency_mismatch', 'high', 2, 15, 29.9, 'A high unmatched foreign-currency exposure.'),
  ('currency_mismatch', 'moderate', 3, 5, 14.9, 'A moderate unmatched foreign-currency exposure.'),
  ('currency_mismatch', 'low', 4, null, 5, 'A low unmatched foreign-currency exposure.'),
  ('remittance_burden', 'very_high', 1, 20, null, 'Remittances are 20% or more of net income.'),
  ('remittance_burden', 'high', 2, 10, 19.9, 'A high remittance burden.'),
  ('remittance_burden', 'moderate', 3, 5, 9.9, 'A moderate remittance burden.'),
  ('remittance_burden', 'low', 4, null, 5, 'A low remittance burden, leaving more flexibility.'),
  ('country_concentration', 'very_high', 1, 60, null, 'Assets in a single foreign country are 60% or more of total assets.'),
  ('country_concentration', 'high', 2, 40, 59.9, 'A high single-country concentration.'),
  ('country_concentration', 'moderate', 3, 20, 39.9, 'A moderate single-country concentration.'),
  ('country_concentration', 'low', 4, null, 20, 'A low single-country concentration.'),
  ('offshore_liquidity_access', 'very_high', 1, 90, null, 'Offshore emergency funds are restricted or take over 90 days to access.'),
  ('offshore_liquidity_access', 'high', 2, 31, 90, 'Offshore emergency funds take 31-90 days to access.'),
  ('offshore_liquidity_access', 'moderate', 3, 8, 30, 'Offshore emergency funds take 8-30 days to access.'),
  ('offshore_liquidity_access', 'low', 4, null, 7, 'Offshore emergency funds are accessible within 7 days.')
) as v(metric_code, band_label, band_tier, lower_bound, upper_bound, explanation);

-- 8.6 Retirement — country-specific (AU 12%+ super baseline vs India 10-20% total retirement saving)
insert into benchmark_target_ranges (metric_definition_id, country_code, band_label, band_tier, lower_bound, upper_bound, explanation)
select (select id from benchmark_metric_definitions where metric_code = v.metric_code), v.country_code, v.band_label, v.band_tier, v.lower_bound, v.upper_bound, v.explanation
from (values
  ('retirement_contribution_rate', 'AU', 'below_baseline', 1, null::numeric, 12::numeric, 'Below the 12% statutory superannuation guarantee baseline.'),
  ('retirement_contribution_rate', 'AU', 'baseline', 2, 12, 14.9, 'At or just above the statutory baseline.'),
  ('retirement_contribution_rate', 'AU', 'healthy_pathway', 3, 15, 19.9, 'A healthy retirement contribution pathway.'),
  ('retirement_contribution_rate', 'AU', 'strong_pathway', 4, 20, null, 'A strong retirement contribution pathway, subject to contribution caps.'),
  ('retirement_contribution_rate', 'IN', 'below_baseline', 1, null, 10, 'Below an indicative baseline retirement savings rate.'),
  ('retirement_contribution_rate', 'IN', 'developing', 2, 10, 14.9, 'A developing retirement savings rate.'),
  ('retirement_contribution_rate', 'IN', 'healthy_pathway', 3, 15, 19.9, 'A healthy retirement savings pathway.'),
  ('retirement_contribution_rate', 'IN', 'strong_pathway', 4, 20, null, 'A strong retirement savings pathway.'),
  ('projected_retirement_readiness', null, 'below_baseline', 1, null, 60, 'Projected retirement-income coverage is below 60% of the indicative target.'),
  ('projected_retirement_readiness', null, 'developing', 2, 60, 79.9, 'Projected retirement-income coverage is developing.'),
  ('projected_retirement_readiness', null, 'healthy_pathway', 3, 80, 99.9, 'Projected retirement-income coverage is close to the indicative target.'),
  ('projected_retirement_readiness', null, 'strong_pathway', 4, 100, null, 'Projected retirement-income coverage meets or exceeds the indicative target.')
) as v(metric_code, country_code, band_label, band_tier, lower_bound, upper_bound, explanation);

