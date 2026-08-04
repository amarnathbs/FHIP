import type { SupabaseServerClient } from './dashboardData';
import type { BenchmarkClass, EvidenceLevel, StatisticType } from '@/lib/engines/twin/taxonomy';
import type { DistributionPoints } from '@/lib/engines/twin/percentile';

export interface PeerBenchmark {
  benchmarkValueId: string;
  benchmarkClass: BenchmarkClass;
  evidenceLevel: EvidenceLevel;
  isIndicative: boolean;
  statisticType: StatisticType;
  value: number;
  distribution: DistributionPoints;
  sourceCitation: string;
  sourceYear: number | null;
  sampleSize: number | null;
  isDerived: boolean;
  derivationMethod: string | null;
}

export interface HealthyRangeBand {
  bandLabel: string;
  bandTier: number;
  lowerBound: number | null;
  upperBound: number | null;
  explanation: string | null;
  evidenceLevel: EvidenceLevel;
  modelVersion: string;
  sourceCitation: string | null;
}

// Retrieves the peer/observed-market (or regulatory) benchmark for a metric,
// preferring an exact cohort match and falling back to the country-wide
// value from the same dataset family. Never mixes benchmark classes without
// carrying the class through — every returned value states which of the
// four classes it belongs to (spec section 1).
export async function loadPeerBenchmark(
  supabase: SupabaseServerClient,
  metricDefinitionId: string,
  cohortId: string | null,
  countryCode: string
): Promise<PeerBenchmark | null> {
  async function fetchRows(cohortFilter: string | null) {
    let query = supabase
      .from('benchmark_values')
      .select(
        'id, statistic_type, value_numeric, is_derived, derivation_method, base_date, confidence_score, dataset_id, benchmark_datasets!inner(benchmark_class, evidence_level, is_indicative, benchmark_source_id, benchmark_sources!inner(citation_text, country_code, publication_date))'
      )
      .eq('metric_definition_id', metricDefinitionId);
    query = cohortFilter === null ? query.is('cohort_id', null) : query.eq('cohort_id', cohortFilter);
    const { data } = await query;
    return data ?? [];
  }

  let rows = cohortId ? await fetchRows(cohortId) : [];
  if (rows.length === 0) {
    // Country-wide fallback — only accept rows whose source is scoped to
    // this country (or has no country, e.g. a global/internal source).
    const all = await fetchRows(null);
    // Supabase types the nested join loosely; narrow defensively at runtime.
    rows = all.filter((r) => {
      const ds = (r as { benchmark_datasets?: { benchmark_sources?: { country_code?: string | null } } }).benchmark_datasets;
      const src = ds?.benchmark_sources;
      return !src?.country_code || src.country_code === countryCode;
    });
  }
  if (rows.length === 0) return null;

  const byStat = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byStat.set(r.statistic_type, r);

  // Prefer median for the headline peer value; fall back to mean.
  const primary = byStat.get('median') ?? byStat.get('mean') ?? byStat.get('rate') ?? byStat.get('threshold') ?? rows[0];
  const ds = (primary as unknown as { benchmark_datasets: { benchmark_class: BenchmarkClass; evidence_level: EvidenceLevel; is_indicative: boolean; benchmark_sources: { citation_text: string; country_code: string | null; publication_date: string | null } } }).benchmark_datasets;

  const distribution: DistributionPoints = {};
  for (const stat of ['p10', 'p20', 'p25', 'p50', 'p75', 'p80', 'p90'] as const) {
    const row = byStat.get(stat);
    if (row) distribution[stat] = Number(row.value_numeric);
  }
  // "median" is the same statistical point as p50 — without this, a dataset
  // that stores its central value as statistic_type='median' (as the AU
  // wealth-distribution seed does) would interpolate percentiles using only
  // its outer p20/p80 points, skipping the more precise midpoint anchor.
  if (distribution.p50 === undefined && byStat.has('median')) {
    distribution.p50 = Number(byStat.get('median')!.value_numeric);
  }

  return {
    benchmarkValueId: primary.id,
    benchmarkClass: ds.benchmark_class,
    evidenceLevel: ds.evidence_level,
    isIndicative: ds.is_indicative,
    statisticType: primary.statistic_type as StatisticType,
    value: Number(primary.value_numeric),
    distribution,
    sourceCitation: ds.benchmark_sources.citation_text,
    sourceYear: ds.benchmark_sources.publication_date ? new Date(ds.benchmark_sources.publication_date).getFullYear() : null,
    sampleSize: null,
    isDerived: primary.is_derived,
    derivationMethod: primary.derivation_method,
  };
}

// Retrieves the FHIP Planning Benchmark (or externally-sourced planning
// standard such as ASFA) target range for a metric, preferring the most
// specific country + life-stage + household-type match and falling back to
// broader (null) criteria — mirrors the Twin's own cohort fallback spirit,
// but scoped just to target ranges.
export async function loadHealthyRange(
  supabase: SupabaseServerClient,
  metricDefinitionId: string,
  countryCode: string,
  lifeStage: string,
  householdType: string
): Promise<HealthyRangeBand[] | null> {
  async function fetchBands(country: string | null, life: string | null, household: string | null) {
    let query = supabase
      .from('benchmark_target_ranges')
      .select('band_label, band_tier, lower_bound, upper_bound, explanation, evidence_level, model_version, benchmark_sources(citation_text)')
      .eq('metric_definition_id', metricDefinitionId)
      .order('band_tier', { ascending: true });
    query = country === null ? query.is('country_code', null) : query.eq('country_code', country);
    query = life === null ? query.is('life_stage', null) : query.eq('life_stage', life);
    query = household === null ? query.is('household_type', null) : query.eq('household_type', household);
    const { data } = await query;
    return data ?? [];
  }

  // Tier 1: exact country + household type (life_stage null = applies broadly)
  let bands = await fetchBands(countryCode, null, householdType);
  if (bands.length === 0) bands = await fetchBands(countryCode, lifeStage, null);
  if (bands.length === 0) bands = await fetchBands(countryCode, null, null);
  if (bands.length === 0) bands = await fetchBands(null, null, null);
  if (bands.length === 0) return null;

  return bands.map((b) => ({
    bandLabel: b.band_label,
    bandTier: b.band_tier,
    lowerBound: b.lower_bound !== null ? Number(b.lower_bound) : null,
    upperBound: b.upper_bound !== null ? Number(b.upper_bound) : null,
    explanation: b.explanation,
    evidenceLevel: b.evidence_level as EvidenceLevel,
    modelVersion: b.model_version,
    sourceCitation: (b as unknown as { benchmark_sources: { citation_text: string } | null }).benchmark_sources?.citation_text ?? null,
  }));
}

export function healthyBandFor(bands: HealthyRangeBand[], tier = 3): { min: number | null; max: number | null; band: HealthyRangeBand } {
  const exact = bands.find((b) => b.bandTier === tier);
  if (exact) return { min: exact.lowerBound, max: exact.upperBound, band: exact };
  // No tier-3 band defined (e.g. ASFA only has tiers 2 and 4) — use the
  // highest tier below the requested one as the "healthy" floor.
  const sorted = [...bands].sort((a, b) => b.bandTier - a.bandTier);
  const best = sorted.find((b) => b.bandTier <= tier) ?? sorted[sorted.length - 1];
  return { min: best.lowerBound, max: best.upperBound, band: best };
}
