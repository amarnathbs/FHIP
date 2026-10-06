// A small, deterministic stand-in for the Planning Benchmarks reference tables (datasets, sources, metric
// definitions, cohorts, bands, values). Used by the allowed-values tests, which read it through the real
// loader (loadAllowedValues) via the in-memory Supabase fake, so the lists in every test are DERIVED, not hand-typed.
import type { Row } from './inMemorySupabase';

export const FIXTURE_TODAY = '2026-10-07';

export function pbReferenceTables(): Record<string, Row[]> {
  return {
    benchmark_sources: [
      { id: 'src-abs', source_name: 'ABS_SIH_2019_20', status: 'active' },
      { id: 'src-fhip', source_name: 'FHIP_PLANNING_V1', status: 'approved' },
      { id: 'src-draft', source_name: 'MOSPI_HCES_2023_24', status: 'draft' },
    ],
    benchmark_datasets: [
      { id: 'ds-wealth', dataset_name: 'AU household wealth distribution', version: '1.0', benchmark_class: 'observed_market', evidence_level: 'official_statistical', data_status: 'active', benchmark_source_id: 'src-abs' },
      { id: 'ds-fhip', dataset_name: 'FHIP Planning Benchmarks v1.0', version: '1.0', benchmark_class: 'fhip_planning', evidence_level: 'research_informed', data_status: 'active', benchmark_source_id: 'src-fhip' },
      { id: 'ds-debt', dataset_name: 'AU household debt context', version: '1.0', benchmark_class: 'observed_market', evidence_level: 'official_statistical', data_status: 'superseded', benchmark_source_id: 'src-abs' },
      { id: 'ds-india', dataset_name: 'India household consumption expenditure (rural/urban)', version: '1.0', benchmark_class: 'observed_market', evidence_level: 'official_statistical', data_status: 'draft', benchmark_source_id: 'src-draft' },
      { id: 'ds-old', dataset_name: 'Archived legacy set', version: '0.9', benchmark_class: 'platform_peer', evidence_level: 'platform_derived', data_status: 'archived', benchmark_source_id: 'src-abs' },
    ],
    benchmark_metric_definitions: [
      { id: 'm-nw', metric_code: 'net_worth', metric_name: 'Net worth', category_code: 'assets_networth', unit: 'currency', comparison_direction: 'higher_better', active_flag: true },
      { id: 'm-sr', metric_code: 'savings_rate', metric_name: 'Savings rate', category_code: 'expenses_savings', unit: 'percentage', comparison_direction: 'higher_better', active_flag: true },
      { id: 'm-ef', metric_code: 'emergency_fund_months', metric_name: 'Emergency fund (months of expenses)', category_code: 'liquidity_resilience', unit: 'months', comparison_direction: 'target_range', active_flag: true },
      { id: 'm-old', metric_code: 'retired_ratio', metric_name: 'Retired ratio', category_code: 'investments', unit: 'ratio', comparison_direction: 'context_only', active_flag: false },
    ],
    benchmark_cohorts: [
      { dataset_id: 'ds-wealth', cohort_code: 'AU_AGE_25_34', country_code: 'AU', region_code: null, urban_rural: null, age_band: 'AGE_25_34', household_type: null, life_stage: null, cohort_tier: 4, cohort_description: 'Households with a reference person aged 25 to 34' },
      { dataset_id: 'ds-india', cohort_code: 'IN_URBAN_ALL', country_code: 'IN', region_code: null, urban_rural: 'urban', age_band: null, household_type: null, life_stage: null, cohort_tier: 2, cohort_description: 'All urban households in India' },
    ],
    benchmark_target_ranges: [
      { metric_definition_id: 'm-sr', country_code: 'AU', life_stage: null, household_type: 'single', band_label: 'critical', band_tier: 1, effective_to: null },
      { metric_definition_id: 'm-sr', country_code: 'AU', life_stage: null, household_type: 'single', band_label: 'strong', band_tier: 4, effective_to: null },
      // An END-DATED band: it must not count as live (its household type must not appear in the lists).
      { metric_definition_id: 'm-sr', country_code: 'AU', life_stage: null, household_type: 'retired_couple', band_label: 'old', band_tier: 2, effective_to: '2020-01-01' },
      { metric_definition_id: 'm-ef', country_code: 'IN', life_stage: 'early_career', household_type: 'family', band_label: 'healthy', band_tier: 3, effective_to: null },
    ],
    benchmark_values: [
      { dataset_id: 'ds-wealth' },
      { dataset_id: 'ds-wealth' },
      { dataset_id: 'ds-fhip' },
    ],
  };
}
