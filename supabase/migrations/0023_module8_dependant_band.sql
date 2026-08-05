-- Module 8 follow-up: wire the dependant_band dimension into cohort matching.
--
-- BACKGROUND: dependantBand() (lib/services/twinCohortMatching.ts) has
-- existed since Module 8 was built but was never called from matchCohort(),
-- and every one of the 27 seeded benchmark_cohorts rows had dependant_band
-- = null. Tracing the real consumption path
-- (lib/services/twinBenchmarkRetrieval.ts's loadPeerBenchmark) confirmed
-- this is a genuine, live gap: peer benchmarks are looked up by the EXACT
-- cohort_id matchCohort() returns, so a 1-dependant and a 3-dependant
-- household in the same life-stage cohort (e.g. AU_YOUNG_FAMILY) were
-- getting identical peer comparisons.
--
-- This migration:
--   1. Tags dependant_band='0' on the 19 existing childless/no-household-
--      type-specified cohorts (a trivial metadata fill-in - these already
--      represent zero dependants via their household_type/description, no
--      new data needed).
--   2. Tags dependant_band='2' on the 6 existing "couple_with_kids"
--      life-stage cohorts (treated as the 2-dependant variant) and adds two
--      new sibling cohort rows each for 1 and 3+ dependants (12 new rows).
--   3. Seeds real benchmark_values for all 18 dependant-band cohort
--      variants, across the 11 metrics that (a) plausibly vary by number of
--      dependants and (b) are actually looked up via loadPeerBenchmark's
--      cohort_id join (this rules out life_cover_adequacy/tpd_cover_adequacy/
--      premium_burden, which are computed entirely from the user's own data
--      via lib/engines/dashboard.ts's computeInsuranceAdequacy(dependantsCount)
--      and never query benchmark_values by cohort at all).
--
-- METHODOLOGY AND SOURCES (evidence_level='research_informed', is_derived=
-- true throughout - this is a disclosed FHIP model combining several real,
-- cited data points, not a single directly-observed statistic; requires the
-- same specialist review the rest of the FHIP Planning Benchmarks require):
--
-- - AU household income by life stage: reused from the existing
--   AU_AGE_25_34 ($119,808/yr) and AU_AGE_45_54 ($158,964/yr) ABS-sourced
--   rows already in benchmark_values.
-- - AU per-dependant household expense: Canstar Blue, "Cost of Raising
--   Kids" survey, July 2024 - average total household spend on children of
--   $12,876/yr (1 child), $14,568/yr (2), $15,636/yr (3), cross-checked
--   against UNSW Social Policy Research Centre's budget-standards estimate
--   (published via AIFS Family Matters No.100, 2019) of ~$170/week/child
--   ($8,840/yr) at the low-pay floor - both real, independent, dependant-
--   count-specific sources, in broad agreement on order of magnitude and on
--   the diminishing-marginal-cost-per-additional-child pattern.
-- - India per-dependant household expense: MoSPI Household Consumption
--   Expenditure Survey 2023-24 (official, already seeded as
--   MOSPI_HCES_2023_24) - urban Rs 6,996/month and rural Rs 4,122/month
--   PER CAPITA - scaled using a modified equivalence-scale child weight
--   (0.30 first child, 0.27 second, 0.24 third+, mirroring the same
--   diminishing pattern observed directly in the Canstar Blue AU data) to
--   avoid the well-documented overstatement from a naive full-per-capita
--   child cost. HCES does not publish a by-dependant-count cross-tab
--   directly, so this weighting is FHIP's own disclosed derivation.
-- - India household income: NABARD All-India Rural Financial Inclusion
--   Survey (NAFIS) 2021-22 - official rural household income Rs
--   12,698/month; urban derived from MoSPI Periodic Labour Force Survey
--   (PLFS) 2023-24 regular-salaried individual income (Rs 20,702/month) x
--   1.3 assumed earners/household (a disclosed assumption, not itself an
--   official statistic). Established-family income step-up for both India
--   cohorts uses the AU young->established income ratio (158964/119808 =
--   1.327), applied cross-country in the absence of a direct Indian
--   life-stage household-income breakdown - also disclosed, not observed.
-- - Childless (0-dependant) baseline expense/savings split: the widely used
--   "50/30/20" budgeting guideline (50% essential, 30% discretionary, 20%
--   savings of net income) and the common ~25% gross-income housing-
--   affordability guideline - the real per-dependant expense deltas above
--   are added on top of this baseline.
-- - Emergency fund / income-interruption scaling: the common financial-
--   planning consensus of a 3-6 month baseline for households without
--   dependants, +1 to +1.5 months per dependant (aiming for 6-9 months for
--   families with children) - a widely cited planning guideline, not
--   attributed to one single official body, seeded under FHIP Planning
--   Benchmarks like the rest of this migration's derived figures.
--
-- Full computation script (for audit/reproducibility):
-- see the session record for compute_dependant_bands.mjs, whose output
-- (rounded to 1 decimal place) is transcribed verbatim into section 3 below.

-- ---------------------------------------------------------------------------
-- 0. New benchmark sources (seeded for citation/governance completeness -
-- see 0012's own precedent for this pattern with MoSPI HCES's per-capita
-- rows). MOSPI_HCES_2023_24 and FHIP_PLANNING_V1 already exist and are
-- reused, not re-inserted here.
-- ---------------------------------------------------------------------------
insert into benchmark_sources (source_name, source_type, publisher, source_title, country_code, publication_date, reference_period_start, reference_period_end, citation_text, methodology_notes, quality_rating, status)
values
  ('AIFS_UNSW_COST_OF_CHILDREN_2019', 'official', 'Australian Institute of Family Studies / UNSW Social Policy Research Centre', 'New estimates of the costs of raising children in Australia (Family Matters No. 100)', 'AU', '2019-01-01', '2016-01-01', '2019-01-01', 'AIFS Family Matters No. 100 (2019), citing UNSW Social Policy Research Centre budget-standards research', 'Budget-standards methodology estimating the direct cost of children at low-pay and unemployed benchmark income levels; a minimum-standard estimate, not an average-household estimate.', 'high', 'active'),
  ('CANSTAR_BLUE_COST_OF_KIDS_2024', 'industry', 'Canstar Blue', 'Cost of Raising Kids survey', 'AU', '2024-07-01', '2024-01-01', '2024-07-01', 'Canstar Blue, Cost of Raising Kids consumer survey, July 2024', 'Consumer self-reported spending survey, not a government statistical collection; used here as the primary per-child-count anchor since it breaks out by exact number of children, cross-checked against the AIFS/UNSW budget-standards figure.', 'medium', 'active'),
  ('NABARD_NAFIS_2021_22', 'official', 'National Bank for Agriculture and Rural Development (India)', 'All India Rural Financial Inclusion Survey (NAFIS) 2021-22', 'IN', '2024-10-10', '2021-04-01', '2022-03-31', 'NABARD, All India Rural Financial Inclusion Survey, 2021-22', 'Official survey of rural Indian households; average monthly household income figure used as-is (2021-22 vintage, not inflation-adjusted to a later year) for transparency.', 'high', 'active'),
  ('MOSPI_PLFS_2023_24', 'official', 'Ministry of Statistics and Programme Implementation (India)', 'Periodic Labour Force Survey 2023-24', 'IN', '2024-12-01', '2023-07-01', '2024-06-30', 'MoSPI, Periodic Labour Force Survey, 2023-24', 'Reports average monthly INDIVIDUAL income by employment category; household-level urban income here is derived by applying a disclosed assumed-earners-per-household multiplier, not an official household figure.', 'high', 'active')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. New dataset carrying the derived dependant-band model. Tagged
-- fhip_planning/research_informed throughout, consistent with how this
-- schema already treats disclosed FHIP-derived combinations (see 0012
-- section 5f/5g's is_derived+derivation_method precedent).
-- ---------------------------------------------------------------------------
insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, evidence_level, is_indicative, requires_periodic_review, source_period, geography_level, statistic_coverage, sample_size, data_status, effective_from, approved_at)
select (select id from benchmark_sources where source_name = 'FHIP_PLANNING_V1'),
  'FHIP dependant-band household benchmark model', '1.0', 'fhip_planning', 'research_informed', true, true,
  '2024-2026 blend', 'country', 'mean (household-level, derived)', null, 'active', current_date, now()
on conflict (dataset_name, version) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Cohort taxonomy updates.
-- ---------------------------------------------------------------------------
-- 2a. Childless / broad-reference cohorts: dependant_band='0' (no new data
-- needed - their household_type/description already represent this).
update benchmark_cohorts
set dependant_band = '0'
where cohort_code in (
  'AU_YOUNG_PROFESSIONAL', 'AU_ESTABLISHED_NO_KIDS', 'AU_PRE_RETIREE', 'AU_RETIREE',
  'AU_AGE_18_24', 'AU_AGE_25_34', 'AU_AGE_35_44', 'AU_AGE_45_54', 'AU_AGE_55_64', 'AU_AGE_65_74', 'AU_AGE_75_PLUS',
  'IN_URBAN_YOUNG_PROFESSIONAL', 'IN_URBAN_ESTABLISHED_NO_KIDS', 'IN_URBAN_PRE_RETIREE', 'IN_URBAN_RETIREE',
  'IN_RURAL_YOUNG_PROFESSIONAL', 'IN_RURAL_ESTABLISHED_NO_KIDS', 'IN_RURAL_PRE_RETIREE', 'IN_RURAL_RETIREE',
  'IN_URBAN_ALL', 'IN_RURAL_ALL'
);

-- 2b. Existing "couple_with_kids" cohorts become the 2-dependant variant.
update benchmark_cohorts
set dependant_band = '2'
where cohort_code in (
  'AU_YOUNG_FAMILY', 'AU_ESTABLISHED_FAMILY',
  'IN_URBAN_YOUNG_FAMILY', 'IN_URBAN_ESTABLISHED_FAMILY',
  'IN_RURAL_YOUNG_FAMILY', 'IN_RURAL_ESTABLISHED_FAMILY'
);

-- 2c. New 1-dependant and 3+-dependant sibling cohorts (12 rows).
insert into benchmark_cohorts (dataset_id, cohort_code, country_code, region_code, urban_rural, age_band, income_band, household_type, life_stage, housing_tenure, employment_type, dependant_band, financial_dna_code, cross_border_flag, cohort_tier, sample_size, cohort_description)
select
  (select id from benchmark_datasets where dataset_name = c.dataset_name and version = '1.0'),
  c.cohort_code, c.country_code, null, c.urban_rural, c.age_band, null, c.household_type, c.life_stage, null, null, c.dependant_band, null, false, c.cohort_tier, null, c.cohort_description
from (values
  ('AU household wealth distribution', 'AU_YOUNG_FAMILY_1DEP', 'AU', null, 'AGE_25_34', 'couple_with_kids', 'young_family', '1', 3, 'Australian young family, age 25-34, couple with children (1 dependant)'),
  ('AU household wealth distribution', 'AU_YOUNG_FAMILY_3PLUSDEP', 'AU', null, 'AGE_25_34', 'couple_with_kids', 'young_family', '3+', 3, 'Australian young family, age 25-34, couple with children (3 or more dependants)'),
  ('AU household wealth distribution', 'AU_ESTABLISHED_FAMILY_1DEP', 'AU', null, 'AGE_45_54', 'couple_with_kids', 'established_family', '1', 3, 'Australian established family, age 45-54, couple with children (1 dependant)'),
  ('AU household wealth distribution', 'AU_ESTABLISHED_FAMILY_3PLUSDEP', 'AU', null, 'AGE_45_54', 'couple_with_kids', 'established_family', '3+', 3, 'Australian established family, age 45-54, couple with children (3 or more dependants)'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_YOUNG_FAMILY_1DEP', 'IN', 'urban', 'AGE_25_34', 'couple_with_kids', 'young_family', '1', 3, 'Urban Indian young family, age 25-34, couple with children (1 dependant)'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'IN', 'urban', 'AGE_25_34', 'couple_with_kids', 'young_family', '3+', 3, 'Urban Indian young family, age 25-34, couple with children (3 or more dependants)'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'IN', 'urban', 'AGE_45_54', 'couple_with_kids', 'established_family', '1', 3, 'Urban Indian established family, age 45-54, couple with children (1 dependant)'),
  ('India household consumption expenditure (rural/urban)', 'IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'IN', 'urban', 'AGE_45_54', 'couple_with_kids', 'established_family', '3+', 3, 'Urban Indian established family, age 45-54, couple with children (3 or more dependants)'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_YOUNG_FAMILY_1DEP', 'IN', 'rural', 'AGE_25_34', 'couple_with_kids', 'young_family', '1', 3, 'Rural Indian young family, age 25-34, couple with children (1 dependant)'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'IN', 'rural', 'AGE_25_34', 'couple_with_kids', 'young_family', '3+', 3, 'Rural Indian young family, age 25-34, couple with children (3 or more dependants)'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'IN', 'rural', 'AGE_45_54', 'couple_with_kids', 'established_family', '1', 3, 'Rural Indian established family, age 45-54, couple with children (1 dependant)'),
  ('India household consumption expenditure (rural/urban)', 'IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'IN', 'rural', 'AGE_45_54', 'couple_with_kids', 'established_family', '3+', 3, 'Rural Indian established family, age 45-54, couple with children (3 or more dependants)')
) as c(dataset_name, cohort_code, country_code, urban_rural, age_band, household_type, life_stage, dependant_band, cohort_tier, cohort_description)
on conflict (cohort_code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Benchmark values for all 18 dependant-band cohort variants (11 metrics
-- x 18 cohorts = 198 rows). Computed from the anchors documented above;
-- see header comment for the full derivation.
-- ---------------------------------------------------------------------------
insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, original_currency, base_date, is_derived, derivation_method, confidence_score, effective_from)
select
  (select id from benchmark_datasets where dataset_name = 'FHIP dependant-band household benchmark model' and version = '1.0'),
  (select id from benchmark_cohorts where cohort_code = v.cohort_code),
  (select id from benchmark_metric_definitions where metric_code = v.metric_code),
  'mean', v.value_numeric, v.unit, v.currency, current_date, true,
  'FHIP-derived: childless-baseline (50/30/20 + 25% housing guideline) plus a real, country-specific per-dependant expense delta (AU: Canstar Blue 2024 cost-of-children survey; India: MoSPI HCES 2023-24 per-capita MPCE scaled by a modified equivalence-scale child weight). See migration header for full citations.',
  55, current_date
from (values
  ('AU_YOUNG_FAMILY_1DEP', 'essential_expense_ratio', 43.4, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'housing_cost_ratio', 25, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'discretionary_expense_ratio', 24.6, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'fixed_commitment_ratio', 26.1, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'total_expense_ratio', 68.1, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'savings_rate', 31.9, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'expense_growth_12m', 3, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'monthly_surplus', 2551, 'currency', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'surplus_margin', 31.9, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'emergency_fund_months', 5, 'months', 'AUD'),
  ('AU_YOUNG_FAMILY_1DEP', 'income_interruption_coverage', 4.5, 'months', 'AUD'),
  ('AU_YOUNG_FAMILY', 'essential_expense_ratio', 45.2, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'housing_cost_ratio', 25, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'discretionary_expense_ratio', 23.9, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'fixed_commitment_ratio', 27.1, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'total_expense_ratio', 69.1, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'savings_rate', 30.9, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'expense_growth_12m', 3, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'monthly_surplus', 2466, 'currency', 'AUD'),
  ('AU_YOUNG_FAMILY', 'surplus_margin', 30.9, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY', 'emergency_fund_months', 5.8, 'months', 'AUD'),
  ('AU_YOUNG_FAMILY', 'income_interruption_coverage', 5.2, 'months', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'essential_expense_ratio', 46.3, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'housing_cost_ratio', 25, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'discretionary_expense_ratio', 23.5, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'fixed_commitment_ratio', 27.8, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'total_expense_ratio', 69.8, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'savings_rate', 30.2, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'expense_growth_12m', 3, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'monthly_surplus', 2413, 'currency', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'surplus_margin', 30.2, 'percentage', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'emergency_fund_months', 6.5, 'months', 'AUD'),
  ('AU_YOUNG_FAMILY_3PLUSDEP', 'income_interruption_coverage', 5.9, 'months', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'essential_expense_ratio', 40.1, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'housing_cost_ratio', 25, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'discretionary_expense_ratio', 26, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'fixed_commitment_ratio', 24.1, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'total_expense_ratio', 66.1, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'savings_rate', 33.9, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'expense_growth_12m', 3, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'monthly_surplus', 3595, 'currency', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'surplus_margin', 33.9, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'emergency_fund_months', 5, 'months', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_1DEP', 'income_interruption_coverage', 4.5, 'months', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'essential_expense_ratio', 41.5, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'housing_cost_ratio', 25, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'discretionary_expense_ratio', 25.4, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'fixed_commitment_ratio', 24.9, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'total_expense_ratio', 66.9, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'savings_rate', 33.1, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'expense_growth_12m', 3, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'monthly_surplus', 3511, 'currency', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'surplus_margin', 33.1, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'emergency_fund_months', 5.8, 'months', 'AUD'),
  ('AU_ESTABLISHED_FAMILY', 'income_interruption_coverage', 5.2, 'months', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'essential_expense_ratio', 42.3, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'housing_cost_ratio', 25, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'discretionary_expense_ratio', 25.1, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'fixed_commitment_ratio', 25.4, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'total_expense_ratio', 67.4, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'savings_rate', 32.6, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'expense_growth_12m', 3, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'monthly_surplus', 3457, 'currency', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'surplus_margin', 32.6, 'percentage', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'emergency_fund_months', 6.5, 'months', 'AUD'),
  ('AU_ESTABLISHED_FAMILY_3PLUSDEP', 'income_interruption_coverage', 5.9, 'months', 'AUD'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'essential_expense_ratio', 39.7, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'discretionary_expense_ratio', 26.1, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'fixed_commitment_ratio', 23.8, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'total_expense_ratio', 65.8, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'savings_rate', 34.2, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'monthly_surplus', 7353, 'currency', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'surplus_margin', 34.2, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'emergency_fund_months', 5, 'months', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_1DEP', 'income_interruption_coverage', 4.5, 'months', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'essential_expense_ratio', 48.5, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'discretionary_expense_ratio', 22.6, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'fixed_commitment_ratio', 29.1, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'total_expense_ratio', 71.1, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'savings_rate', 28.9, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'monthly_surplus', 6219, 'currency', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'surplus_margin', 28.9, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'emergency_fund_months', 5.8, 'months', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY', 'income_interruption_coverage', 5.2, 'months', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'essential_expense_ratio', 56.3, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'discretionary_expense_ratio', 19.5, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'fixed_commitment_ratio', 33.8, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'total_expense_ratio', 75.8, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'savings_rate', 24.2, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'monthly_surplus', 5212, 'currency', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'surplus_margin', 24.2, 'percentage', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'emergency_fund_months', 6.5, 'months', 'INR'),
  ('IN_URBAN_YOUNG_FAMILY_3PLUSDEP', 'income_interruption_coverage', 5.9, 'months', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'essential_expense_ratio', 37.3, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'discretionary_expense_ratio', 27.1, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'fixed_commitment_ratio', 22.4, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'total_expense_ratio', 64.4, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'savings_rate', 35.6, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'monthly_surplus', 10167, 'currency', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'surplus_margin', 35.6, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'emergency_fund_months', 5, 'months', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_1DEP', 'income_interruption_coverage', 4.5, 'months', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'essential_expense_ratio', 44, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'discretionary_expense_ratio', 24.4, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'fixed_commitment_ratio', 26.4, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'total_expense_ratio', 68.4, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'savings_rate', 31.6, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'monthly_surplus', 9034, 'currency', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'surplus_margin', 31.6, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'emergency_fund_months', 5.8, 'months', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY', 'income_interruption_coverage', 5.2, 'months', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'essential_expense_ratio', 49.8, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'discretionary_expense_ratio', 22.1, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'fixed_commitment_ratio', 29.9, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'total_expense_ratio', 71.9, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'savings_rate', 28.1, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'monthly_surplus', 8027, 'currency', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'surplus_margin', 28.1, 'percentage', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'emergency_fund_months', 6.5, 'months', 'INR'),
  ('IN_URBAN_ESTABLISHED_FAMILY_3PLUSDEP', 'income_interruption_coverage', 5.9, 'months', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'essential_expense_ratio', 42.2, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'discretionary_expense_ratio', 25.1, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'fixed_commitment_ratio', 25.3, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'total_expense_ratio', 67.3, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'savings_rate', 32.7, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'monthly_surplus', 3321, 'currency', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'surplus_margin', 32.7, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'emergency_fund_months', 5, 'months', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_1DEP', 'income_interruption_coverage', 4.5, 'months', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'essential_expense_ratio', 53.1, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'discretionary_expense_ratio', 20.7, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'fixed_commitment_ratio', 31.9, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'total_expense_ratio', 73.9, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'savings_rate', 26.1, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'monthly_surplus', 2654, 'currency', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'surplus_margin', 26.1, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'emergency_fund_months', 5.8, 'months', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY', 'income_interruption_coverage', 5.2, 'months', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'essential_expense_ratio', 62.9, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'discretionary_expense_ratio', 16.9, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'fixed_commitment_ratio', 37.7, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'total_expense_ratio', 79.7, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'savings_rate', 20.3, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'monthly_surplus', 2060, 'currency', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'surplus_margin', 20.3, 'percentage', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'emergency_fund_months', 6.5, 'months', 'INR'),
  ('IN_RURAL_YOUNG_FAMILY_3PLUSDEP', 'income_interruption_coverage', 5.9, 'months', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'essential_expense_ratio', 39.2, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'discretionary_expense_ratio', 26.3, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'fixed_commitment_ratio', 23.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'total_expense_ratio', 65.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'savings_rate', 34.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'monthly_surplus', 4649, 'currency', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'surplus_margin', 34.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'emergency_fund_months', 5, 'months', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_1DEP', 'income_interruption_coverage', 4.5, 'months', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'essential_expense_ratio', 47.4, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'discretionary_expense_ratio', 23, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'fixed_commitment_ratio', 28.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'total_expense_ratio', 70.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'savings_rate', 29.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'monthly_surplus', 3982, 'currency', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'surplus_margin', 29.5, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'emergency_fund_months', 5.8, 'months', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY', 'income_interruption_coverage', 5.2, 'months', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'essential_expense_ratio', 54.8, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'housing_cost_ratio', 25, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'discretionary_expense_ratio', 20.1, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'fixed_commitment_ratio', 32.9, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'total_expense_ratio', 74.9, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'savings_rate', 25.1, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'expense_growth_12m', 3, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'monthly_surplus', 3388, 'currency', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'surplus_margin', 25.1, 'percentage', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'emergency_fund_months', 6.5, 'months', 'INR'),
  ('IN_RURAL_ESTABLISHED_FAMILY_3PLUSDEP', 'income_interruption_coverage', 5.9, 'months', 'INR')
) as v(cohort_code, metric_code, value_numeric, unit, currency);
