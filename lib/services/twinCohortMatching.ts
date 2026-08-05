import type { SupabaseServerClient } from './dashboardData';
import type { TwinHouseholdContext } from './twinData';
import type { CohortTier } from '@/lib/engines/twin/taxonomy';

export interface BenchmarkCohortRow {
  id: string;
  cohort_code: string;
  country_code: string | null;
  region_code: string | null;
  urban_rural: string | null;
  age_band: string | null;
  income_band: string | null;
  household_type: string | null;
  life_stage: string | null;
  housing_tenure: string | null;
  employment_type: string | null;
  dependant_band: string | null;
  financial_dna_code: string | null;
  cross_border_flag: boolean;
  cohort_tier: number;
  sample_size: number | null;
  cohort_description: string;
  dataset_id: string | null;
}

export interface CohortMatchResult {
  cohort: BenchmarkCohortRow | null;
  tier: CohortTier;
  tierLabel: string;
  matchExplanation: string;
}

export function dependantBand(dependantsCount: number): '0' | '1' | '2' | '3+' {
  if (dependantsCount <= 0) return '0';
  if (dependantsCount === 1) return '1';
  if (dependantsCount === 2) return '2';
  return '3+';
}

const TIER_LABEL: Record<CohortTier, string> = {
  1: 'Exact Twin',
  2: 'Strong Match',
  3: 'Moderate Match',
  4: 'Broad Match',
  5: 'Planning Benchmark',
};

// Progressive fallback from the most specific eligible cohort to the
// broadest (spec section 6.4). Each tier is a strictly looser filter than
// the one before it; the first tier with at least one matching, active
// cohort wins. Tier 5 never needs a cohort row — it falls through to FHIP
// planning benchmarks only, which is why `cohort: null` at tier 5 is a valid,
// expected result rather than a failure.
export async function matchCohort(household: TwinHouseholdContext, supabase: SupabaseServerClient): Promise<CohortMatchResult> {
  // A fresh query builder per attempt — Supabase's PostgrestFilterBuilder
  // mutates and returns `this` on every .eq() call, so a single shared
  // builder reused across tiers would silently accumulate every earlier
  // tier's filters instead of starting each tier's WHERE clause from
  // scratch (this caused every match to fall through to tier 5).
  const base = () =>
    supabase
      .from('benchmark_cohorts')
      .select('id, cohort_code, country_code, region_code, urban_rural, age_band, income_band, household_type, life_stage, housing_tenure, employment_type, dependant_band, financial_dna_code, cross_border_flag, cohort_tier, sample_size, cohort_description, dataset_id')
      .eq('country_code', household.countryOfResidence);

  // Households are matched to the cohort tagged with their own number of
  // dependants wherever the cohort library distinguishes it (today: the
  // tier-3 life-stage cohorts, seeded across 0/1/2/3+ bands — see migration
  // 0023). Filtering on this at every tier keeps a 1-dependant and a
  // 3-dependant household in the same life-stage cohort from silently
  // sharing one peer benchmark, which they did before dependant_band was
  // wired in here.
  const depBand = dependantBand(household.dependantsCount);

  // Tier 1: country + age + income + household type + life stage + tenure + region
  if (household.ageBand && household.housingTenure && household.residenceType && household.residenceType !== 'unspecified') {
    const { data } = await base()
      .eq('age_band', household.ageBand)
      .eq('income_band', household.incomeBand)
      .eq('household_type', household.householdTypeCode)
      .eq('life_stage', household.lifeStage)
      .eq('housing_tenure', household.housingTenure)
      .eq('urban_rural', household.residenceType)
      .eq('dependant_band', depBand)
      .limit(1);
    if (data && data.length > 0) return buildResult(data[0] as BenchmarkCohortRow, 1);
  }

  // Tier 2: country + age + income + household type + life stage
  if (household.ageBand) {
    const { data } = await base()
      .eq('age_band', household.ageBand)
      .eq('income_band', household.incomeBand)
      .eq('household_type', household.householdTypeCode)
      .eq('life_stage', household.lifeStage)
      .eq('dependant_band', depBand)
      .limit(1);
    if (data && data.length > 0) return buildResult(data[0] as BenchmarkCohortRow, 2);
  }

  // Tier 3: country + age + household type + life stage + dependant band
  if (household.ageBand) {
    const { data } = await base()
      .eq('age_band', household.ageBand)
      .eq('household_type', household.householdTypeCode)
      .eq('life_stage', household.lifeStage)
      .eq('dependant_band', depBand)
      .limit(1);
    if (data && data.length > 0) return buildResult(data[0] as BenchmarkCohortRow, 3);
  }

  // Tier 3b: same as tier 3 but without the dependant-band constraint - a
  // genuine fallback for life-stage/household-type combinations the
  // dependant-band seed doesn't cover (e.g. retiree/pre-retiree cohorts),
  // rather than dropping all the way to the much broader tier 4.
  if (household.ageBand) {
    const { data } = await base()
      .eq('age_band', household.ageBand)
      .eq('household_type', household.householdTypeCode)
      .eq('life_stage', household.lifeStage)
      .limit(1);
    if (data && data.length > 0) return buildResult(data[0] as BenchmarkCohortRow, 3);
  }

  // Tier 4: country + (age OR life stage)
  {
    const { data } = await base().eq('life_stage', household.lifeStage).limit(1);
    if (data && data.length > 0) return buildResult(data[0] as BenchmarkCohortRow, 4);
  }
  if (household.ageBand) {
    const { data } = await base().eq('age_band', household.ageBand).limit(1);
    if (data && data.length > 0) return buildResult(data[0] as BenchmarkCohortRow, 4);
  }

  // Tier 5: no peer cohort available — FHIP planning benchmarks only.
  return {
    cohort: null,
    tier: 5,
    tierLabel: TIER_LABEL[5],
    matchExplanation: 'A sufficiently specific peer benchmark is not available. Showing broader country and life-stage planning ranges instead.',
  };
}

function buildResult(cohort: BenchmarkCohortRow, tier: CohortTier): CohortMatchResult {
  return {
    cohort,
    tier,
    tierLabel: TIER_LABEL[tier],
    matchExplanation: `Matched to "${cohort.cohort_description}" (${TIER_LABEL[tier]}).`,
  };
}
