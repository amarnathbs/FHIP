-- FHIP production bootstrap — PART 10 of 10
-- Migrations 0023-0028: dependant-band cohort matching, forecast report render
-- tokens, report content library + pillar-triggered recommendations (schema +
-- seed), retirement timing hierarchy.
-- Run this AFTER parts 1-9 have already been applied (production schema at 0022).
-- Run in the Supabase SQL Editor, in one go, against the PRODUCTION project.


-- === migrations/0023_module8_dependant_band.sql ===
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

-- === migrations/0024_forecast_report_render_tokens.sql ===
-- Real PDF export pipeline for the Consolidated Forecasting Report
-- (Phase 2 universal formatting fixes — this report previously had no
-- server-rendered PDF at all, only a plain browser window.print() button
-- with no controllable page numbers). Mirrors report_exports'
-- render_token/render_token_expires_at pattern (0022_report_pdf_export.sql)
-- so the headless-Chromium renderer (lib/services/forecastReportPdfRenderer.ts)
-- can open the bare print route (app/(app)/forecast/report/print) without a
-- real user session. A dedicated table, not a reuse of report_exports,
-- because this report isn't a saved/versioned `reports` row — it's always
-- rendered live from the current forecast data, so there's no report_id to
-- attach a token to and no PDF file to persist in storage; the API route
-- streams the rendered PDF straight back to the caller.
create table forecast_report_render_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
create index idx_forecast_report_render_tokens_expires on forecast_report_render_tokens(expires_at);

alter table forecast_report_render_tokens enable row level security;
-- No policies for authenticated/anon roles — this table is only ever
-- accessed via the service-role client (minted by the export API route,
-- redeemed and immediately deleted by the print route), the same
-- server-only usage pattern as report_exports.render_token.

-- === migrations/0025_report_content_and_pillar_signals.sql ===
-- Free/Paid Report v3, Phase 3a — content-library foundation.
--
-- Part A: extend action_recommendation_master so the SAME library that
-- already drives the Forecasting Engine's recommendations (542 rows,
-- forecast-category/status triggered) can also be triggered by a Financial
-- Health Score pillar's band, for the Free/Paid report's action sections.
-- This is a deliberate extension of the existing table, not a second
-- parallel schema (per the user's confirmed shared-library decision) —
-- action_recommendation_conditions needs no change at all, since its
-- field_name column is already free-text (pillar_code/score_band are just
-- new condition field_name values an admin can use, exactly like
-- forecast_category/forecast_status are today).
alter table action_recommendation_master
  add column trigger_type text not null default 'forecast_variance'
    check (trigger_type in ('forecast_variance', 'score_pillar')),
  add column pillar_code text,
  add column score_band text;

-- forecast_category/forecast_status were NOT NULL because every existing
-- row is forecast-triggered — pillar-triggered rows have no natural
-- forecast_category, so both become nullable. All 542 existing rows are
-- unaffected (trigger_type defaults to 'forecast_variance' and both columns
-- stay populated for them).
alter table action_recommendation_master
  alter column forecast_category drop not null,
  alter column forecast_status drop not null;

alter table action_recommendation_master
  drop constraint if exists action_recommendation_master_forecast_category_check;
alter table action_recommendation_master
  add constraint action_recommendation_master_forecast_category_check
  check (forecast_category is null or forecast_category in (
    'net_worth', 'retirement', 'goal', 'debt', 'investment_growth', 'cross_border', 'resilience', 'data_quality'
  ));

alter table action_recommendation_master
  drop constraint if exists action_recommendation_master_forecast_status_check;
alter table action_recommendation_master
  add constraint action_recommendation_master_forecast_status_check
  check (forecast_status is null or forecast_status in (
    'ahead_of_plan', 'on_track', 'slightly_behind', 'at_risk', 'significantly_off_track', 'review_required'
  ));

-- Data-integrity guard: a row's required fields must match its trigger_type
-- — mirrors the existing not-null pattern rather than allowing a
-- half-configured row of either kind.
alter table action_recommendation_master
  add constraint action_recommendation_master_trigger_fields_check
  check (
    (trigger_type = 'forecast_variance' and forecast_category is not null and forecast_status is not null)
    or
    (trigger_type = 'score_pillar' and pillar_code is not null and score_band is not null)
  );

create index idx_action_recommendation_master_pillar on action_recommendation_master(trigger_type, pillar_code, score_band, is_active);

-- Part B: report_content_library — replaces lib/engines/reportCopy.ts's
-- hardcoded string constants with DB-editable rows. Seeded 1:1 with today's
-- exact wording in the next migration (0026) — this phase changes WHERE the
-- content lives, not what it says.
create table report_content_library (
  id uuid primary key default gen_random_uuid(),
  content_key text not null,
  locale text not null default 'en',
  -- 'fixed' = single unconditional string (e.g. REPORT_WHAT_IT_IS);
  -- 'banded' = one row per status_band under the same content_key (e.g.
  -- confidenceExplanation's high/medium/low); 'code_label' = one row per
  -- raw DB code under the same content_key (categoryLabel's ~20 mappings).
  content_type text not null check (content_type in ('fixed', 'banded', 'code_label')),
  status_band text,
  code_value text,
  title text,
  body_template text not null,
  is_active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (content_key, locale, status_band, code_value)
);
create index idx_report_content_library_lookup on report_content_library(content_key, locale, is_active);

alter table report_content_library enable row level security;
create policy "read report content library" on report_content_library for select using (true);
-- Writes go through the service-role admin client only (same pattern as
-- action_recommendation_master's admin routes) — no insert/update/delete
-- policy for authenticated/anon roles.

-- === migrations/0026_report_content_library_seed.sql ===
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

-- === migrations/0027_pillar_recommendations_seed.sql ===
-- Free/Paid Report v3, Phase 3a — starter pillar-triggered recommendation
-- rows. 2 per Health Score component (10 components x needs_attention +
-- excellent bands = 20 rows), using the trigger_type='score_pillar' /
-- pillar_code / score_band columns added in migration 0025. Deliberately
-- generic (no country_code) and with no deterministic $ impact calculator
-- (calculation_method_code='NO_CALCULATION', matching the existing
-- review_required-style rows imported for forecast-variance triggers) —
-- these are meant to bootstrap the Free/Paid report's action sections
-- (Phase 3a task #213), not to duplicate the country-specific forecast
-- library. include_in_forecasting=false / include_in_monthly_report=true
-- since these are report-only, the mirror image of the imported 542 rows.
insert into action_recommendation_master (
  recommendation_code, trigger_type, pillar_code, score_band,
  forecast_category, sub_category, scenario_name, scenario_description,
  variance_result, forecast_status, severity, action_type,
  action_title_template, action_content_template, financial_impact_template,
  calculation_method_code, required_input_fields, supported_placeholders,
  priority_score, country_code, currency_code, customer_segment,
  is_active, requires_ai, include_in_forecasting, include_in_monthly_report,
  admin_notes
) values
  ('PILLAR_CASH_FLOW_ATTENTION', 'score_pillar', 'cash_flow', 'needs_attention', null, 'pillar_score_band', 'Cash flow pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the cash_flow component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_cash_flow',
   $$Review your monthly cash flow$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Track income against expenses for a full month, and look for discretionary spending that can be trimmed to widen your monthly surplus.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_CASH_FLOW_MAINTAIN', 'score_pillar', 'cash_flow', 'excellent', null, 'pillar_score_band', 'Cash flow pillar is strong', 'Health Score pillar-triggered scenario. Applies when the cash_flow component''s status band is excellent.', 'favourable', null, 'low', 'maintain_cash_flow',
   $$Keep up your cash flow discipline$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep monitoring income and expenses regularly so this stays on track as circumstances change.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_SAVINGS_ATTENTION', 'score_pillar', 'savings', 'needs_attention', null, 'pillar_score_band', 'Savings pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the savings component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_savings',
   $$Increase your savings rate$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Consider automating a fixed transfer to savings each pay cycle so a portion of income is set aside before it can be spent.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_SAVINGS_MAINTAIN', 'score_pillar', 'savings', 'excellent', null, 'pillar_score_band', 'Savings pillar is strong', 'Health Score pillar-triggered scenario. Applies when the savings component''s status band is excellent.', 'favourable', null, 'low', 'maintain_savings',
   $$Maintain your savings habit$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Continue the current savings routine and revisit the target amount as income or goals change.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_EMERGENCY_FUND_ATTENTION', 'score_pillar', 'emergency_fund', 'needs_attention', null, 'pillar_score_band', 'Emergency fund pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the emergency_fund component''s status band is needs_attention.', 'unfavourable', null, 'high', 'build_emergency_fund',
   $$Build up your emergency fund buffer$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Aim to hold accessible cash covering several months of essential expenses, building it up gradually if a lump sum isn't available now.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   80, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_EMERGENCY_FUND_MAINTAIN', 'score_pillar', 'emergency_fund', 'excellent', null, 'pillar_score_band', 'Emergency fund pillar is strong', 'Health Score pillar-triggered scenario. Applies when the emergency_fund component''s status band is excellent.', 'favourable', null, 'low', 'maintain_emergency_fund',
   $$Maintain your emergency fund$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep the buffer at its current level and review it after any major change in income or expenses.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_DEBT_ATTENTION', 'score_pillar', 'debt', 'needs_attention', null, 'pillar_score_band', 'Debt pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the debt component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_debt',
   $$Review your debt repayment plan$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review outstanding balances and interest rates, and consider directing extra surplus toward the highest-cost debt first.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_DEBT_MAINTAIN', 'score_pillar', 'debt', 'excellent', null, 'pillar_score_band', 'Debt pillar is strong', 'Health Score pillar-triggered scenario. Applies when the debt component''s status band is excellent.', 'favourable', null, 'low', 'maintain_debt',
   $$Keep your debt levels under control$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Continue keeping debt low relative to income and assets, and avoid taking on new high-cost borrowing.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_NET_WORTH_ATTENTION', 'score_pillar', 'net_worth', 'needs_attention', null, 'pillar_score_band', 'Net worth pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the net_worth component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_net_worth',
   $$Review your net worth trajectory$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review the balance between assets and liabilities and consider whether saving, debt reduction or asset growth would help most.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_NET_WORTH_MAINTAIN', 'score_pillar', 'net_worth', 'excellent', null, 'pillar_score_band', 'Net worth pillar is strong', 'Health Score pillar-triggered scenario. Applies when the net_worth component''s status band is excellent.', 'favourable', null, 'low', 'maintain_net_worth',
   $$Maintain your net worth growth$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep tracking assets and liabilities regularly so this position is maintained.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_INVESTMENT_ATTENTION', 'score_pillar', 'investment', 'needs_attention', null, 'pillar_score_band', 'Investment pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the investment component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_investment',
   $$Review your investment plan$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review contribution consistency and diversification across your recorded holdings.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_INVESTMENT_MAINTAIN', 'score_pillar', 'investment', 'excellent', null, 'pillar_score_band', 'Investment pillar is strong', 'Health Score pillar-triggered scenario. Applies when the investment component''s status band is excellent.', 'favourable', null, 'low', 'maintain_investment',
   $$Maintain your investment discipline$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep contributing consistently and review diversification periodically.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_RETIREMENT_ATTENTION', 'score_pillar', 'retirement', 'needs_attention', null, 'pillar_score_band', 'Retirement pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the retirement component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_retirement',
   $$Review your retirement savings plan$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review whether current retirement contributions are on track for your target retirement age and lifestyle.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_RETIREMENT_MAINTAIN', 'score_pillar', 'retirement', 'excellent', null, 'pillar_score_band', 'Retirement pillar is strong', 'Health Score pillar-triggered scenario. Applies when the retirement component''s status band is excellent.', 'favourable', null, 'low', 'maintain_retirement',
   $$Maintain your retirement savings trajectory$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep contributions consistent and revisit your retirement target periodically.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_INSURANCE_ATTENTION', 'score_pillar', 'insurance', 'needs_attention', null, 'pillar_score_band', 'Insurance pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the insurance component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_insurance',
   $$Review your insurance coverage$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Review recorded cover against income, debt and dependants, and identify any obvious gaps to discuss with a qualified adviser.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   70, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_INSURANCE_MAINTAIN', 'score_pillar', 'insurance', 'excellent', null, 'pillar_score_band', 'Insurance pillar is strong', 'Health Score pillar-triggered scenario. Applies when the insurance component''s status band is excellent.', 'favourable', null, 'low', 'maintain_insurance',
   $$Keep your insurance coverage up to date$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Revisit cover after major life changes such as a new dependant, property purchase or income change.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_RESILIENCE_ATTENTION', 'score_pillar', 'resilience', 'needs_attention', null, 'pillar_score_band', 'Resilience pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the resilience component''s status band is needs_attention.', 'unfavourable', null, 'high', 'review_resilience',
   $$Strengthen your financial resilience$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Visit the Financial Resilience page to see which underlying factor — liquidity, income stability, insurance or debt pressure — is weighing this down most.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   80, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_RESILIENCE_MAINTAIN', 'score_pillar', 'resilience', 'excellent', null, 'pillar_score_band', 'Resilience pillar is strong', 'Health Score pillar-triggered scenario. Applies when the resilience component''s status band is excellent.', 'favourable', null, 'low', 'maintain_resilience',
   $$Maintain your financial resilience$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep monitoring liquidity, income stability and insurance cover so this position holds up under stress.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),

  ('PILLAR_BEHAVIOUR_ATTENTION', 'score_pillar', 'behaviour', 'needs_attention', null, 'pillar_score_band', 'Behaviour pillar needs attention', 'Health Score pillar-triggered scenario. Applies when the behaviour component''s status band is needs_attention.', 'unfavourable', null, 'medium', 'review_behaviour',
   $$Build stronger financial habits$$, $$Your {{pillar_label}} score is currently in the "{{score_band}}" band. Regular check-ins — paying bills on time, sticking to a budget, automating savings — are what this component measures; even one new habit can help.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   60, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.'),
  ('PILLAR_BEHAVIOUR_MAINTAIN', 'score_pillar', 'behaviour', 'excellent', null, 'pillar_score_band', 'Behaviour pillar is strong', 'Health Score pillar-triggered scenario. Applies when the behaviour component''s status band is excellent.', 'favourable', null, 'low', 'maintain_behaviour',
   $$Keep up your good financial habits$$, $$Your {{pillar_label}} score is in the "{{score_band}}" band. Keep up the regular reviews and on-time payments that got you here.$$, $$No deterministic financial impact is calculated for this pillar-level signal.$$,
   'NO_CALCULATION', ARRAY['pillar_code','score_band']::text[], ARRAY['pillar_label','score_band']::text[],
   40, null, null, 'base', true, false, false, true, 'Pillar-triggered starter content — Phase 3a bootstrap.')
on conflict (recommendation_code) do nothing;

-- Conditions: every row above is gated purely on pillar_code + score_band
-- (an AND-chain, condition_group=1, mirroring the existing forecast_category
-- + forecast_status pattern used by every imported row).
insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator, comparison_value, data_type, logical_operator, evaluation_order)
select code, 1, 'pillar_code', 'equals', pillar, 'text', 'AND', 1
from (values
  ('PILLAR_CASH_FLOW_ATTENTION', 'cash_flow'), ('PILLAR_CASH_FLOW_MAINTAIN', 'cash_flow'),
  ('PILLAR_SAVINGS_ATTENTION', 'savings'), ('PILLAR_SAVINGS_MAINTAIN', 'savings'),
  ('PILLAR_EMERGENCY_FUND_ATTENTION', 'emergency_fund'), ('PILLAR_EMERGENCY_FUND_MAINTAIN', 'emergency_fund'),
  ('PILLAR_DEBT_ATTENTION', 'debt'), ('PILLAR_DEBT_MAINTAIN', 'debt'),
  ('PILLAR_NET_WORTH_ATTENTION', 'net_worth'), ('PILLAR_NET_WORTH_MAINTAIN', 'net_worth'),
  ('PILLAR_INVESTMENT_ATTENTION', 'investment'), ('PILLAR_INVESTMENT_MAINTAIN', 'investment'),
  ('PILLAR_RETIREMENT_ATTENTION', 'retirement'), ('PILLAR_RETIREMENT_MAINTAIN', 'retirement'),
  ('PILLAR_INSURANCE_ATTENTION', 'insurance'), ('PILLAR_INSURANCE_MAINTAIN', 'insurance'),
  ('PILLAR_RESILIENCE_ATTENTION', 'resilience'), ('PILLAR_RESILIENCE_MAINTAIN', 'resilience'),
  ('PILLAR_BEHAVIOUR_ATTENTION', 'behaviour'), ('PILLAR_BEHAVIOUR_MAINTAIN', 'behaviour')
) as t(code, pillar)
on conflict do nothing;

insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator, comparison_value, data_type, logical_operator, evaluation_order)
select code, 1, 'score_band', 'equals', band, 'text', 'AND', 2
from (values
  ('PILLAR_CASH_FLOW_ATTENTION', 'needs_attention'), ('PILLAR_CASH_FLOW_MAINTAIN', 'excellent'),
  ('PILLAR_SAVINGS_ATTENTION', 'needs_attention'), ('PILLAR_SAVINGS_MAINTAIN', 'excellent'),
  ('PILLAR_EMERGENCY_FUND_ATTENTION', 'needs_attention'), ('PILLAR_EMERGENCY_FUND_MAINTAIN', 'excellent'),
  ('PILLAR_DEBT_ATTENTION', 'needs_attention'), ('PILLAR_DEBT_MAINTAIN', 'excellent'),
  ('PILLAR_NET_WORTH_ATTENTION', 'needs_attention'), ('PILLAR_NET_WORTH_MAINTAIN', 'excellent'),
  ('PILLAR_INVESTMENT_ATTENTION', 'needs_attention'), ('PILLAR_INVESTMENT_MAINTAIN', 'excellent'),
  ('PILLAR_RETIREMENT_ATTENTION', 'needs_attention'), ('PILLAR_RETIREMENT_MAINTAIN', 'excellent'),
  ('PILLAR_INSURANCE_ATTENTION', 'needs_attention'), ('PILLAR_INSURANCE_MAINTAIN', 'excellent'),
  ('PILLAR_RESILIENCE_ATTENTION', 'needs_attention'), ('PILLAR_RESILIENCE_MAINTAIN', 'excellent'),
  ('PILLAR_BEHAVIOUR_ATTENTION', 'needs_attention'), ('PILLAR_BEHAVIOUR_MAINTAIN', 'excellent')
) as t(code, band)
on conflict do nothing;

-- === migrations/0028_retirement_timing_hierarchy.sql ===
-- Forecasting Engine P1 fix FHIP-FC-RET-001 — retirement timing hierarchy.
-- Today the retirement forecast has exactly one path (DOB + retirement_age);
-- if date_of_birth isn't on file it gives up entirely. These two nullable
-- columns add the remaining tiers: retirement_date (an explicit target date,
-- when known — takes priority over the age-based calculation) and
-- retirement_timing_override_months (a manual "months until retirement"
-- fallback, usable when no DOB is on file at all — collapses what the
-- source review called two separate tiers, "current age + retirement age
-- for migrated records" and "user-entered years remaining", into one stored
-- value, since both are just different ways of arriving at the same
-- months-until-retirement number and this app has no legacy-migration
-- concept to distinguish them).
alter table forecast_profiles
  add column retirement_date date,
  add column retirement_timing_override_months int check (retirement_timing_override_months >= 0);
