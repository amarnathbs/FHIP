// Planning Benchmarks upload - the ALLOWED VALUES (the live lists a file may name).
//
// ONE source for three consumers, so they cannot drift (a unit test proves it):
//   1. the validator (uploadValidate.ts) refuses a row whose dataset, metric, unit or cohort is not in these lists;
//   2. the downloaded templates (the "Read me" sheet) and the companion "Allowed values" CSV print these lists;
//   3. the Upload tab's collapsible "Allowed values" panel shows these lists.
//
// WHAT "OPEN FOR UPLOAD" MEANS (derived from migration 0275, stage_planning_benchmark_upload, not guessed):
//   - a dataset is named by dataset_name + version, exactly (the match is case-sensitive, as in the database);
//   - a dataset whose status is suspended, archived or superseded cannot receive an upload (any kind);
//   - every other dataset (draft, under review, approved, active) can RECEIVE a staged file of any of the three
//     kinds. The database does not tie a dataset to one kind of file. Two further conditions are NOT about
//     staging but are shown so a person is not surprised later: a target-range file must cite, in source_name,
//     the one source of the dataset; and an observed or regulatory dataset that holds no figure yet can only be
//     ACTIVATED by a values file (pb_dataset_readiness);
//   - a metric is accepted when it is registered AND, once migration 0277 is installed, mapped to the dataset for
//     that kind of file (benchmark_dataset_metrics). Before 0277 any registered metric was accepted for any open
//     dataset: that is the fallback this module reports (mapping.installed = false) so the screen and the
//     validator can warn instead of failing. A value must carry the metric's own unit, and a band's bounds are in
//     the metric's unit (the target-range file has no unit column);
//   - a cohort_code in a values file must be a registered cohort (or blank for a country-wide figure).
// Statistics are NOT constrained per metric by the database: statistic_type is one closed list for every metric.
//
// Read-only and tenant-neutral: only global reference tables are read (sources, datasets, metric definitions,
// cohorts, bands, and the dataset id of each value), with explicit bounds, under the CALLER'S session client.
// A read that fails or is cut by its bound is reported (state 'unavailable', or a list flagged incomplete); it is
// never presented as a complete list.
//
// Pure apart from the loader's database reads: no clock (the caller injects today's database date).
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatDayFirst } from './dayFirst';
import { CLOSED_DATASET_STATUSES, KIND_LABEL, UPLOAD_KINDS, UPLOAD_SCHEMA, BOOLEAN_FALSE_WORDS, BOOLEAN_TRUE_WORDS, type UploadKind } from './uploadSchema';

export const ALLOWED_VALUES_LIMITS = Object.freeze({ datasets: 500, sources: 500, metrics: 2000, cohorts: 2000, bands: 5000, values: 5000, mappings: 5000 });

/** Sources whose status lets a dataset activate (pb_dataset_readiness). Informational only. */
export const ACTIVATION_SOURCE_STATUSES = ['approved', 'active'] as const;

// ------------------------------------------------------------------------------------------------ types ---

export interface KindAcceptance {
  accepted: boolean;
  /** Plain-language: why not, or the condition that applies. Never empty when accepted is false. */
  note: string;
}

/** One metric that is mapped to a dataset (migration 0277), with the kinds of file it applies to. */
export interface MappedMetric {
  code: string;
  name: string;
  unit: string;
  active: boolean;
  values: boolean;
  targetRanges: boolean;
  /** Live observed values this dataset holds for the metric; null when the count is unknown (a read was cut). */
  liveValues: number | null;
  /** Live planning bands of the metric that cite this dataset's source or no source; null when unknown. */
  liveBands: number | null;
  evidence: string | null;
}

export interface AllowedDataset {
  id: string;
  name: string;
  version: string;
  benchmarkClass: string;
  evidenceLevel: string;
  status: string;
  sourceName: string | null;
  sourceStatus: string | null;
  /** Rows in benchmark_values for this dataset; null when the count is unknown (the read was cut by its bound). */
  liveValueCount: number | null;
  open: boolean;
  closedReason: string | null;
  accepts: Record<UploadKind, KindAcceptance>;
  /** The metrics this dataset may receive (empty when the mapping is not installed or nothing is mapped yet). */
  mappedMetrics: MappedMetric[];
}

export interface BandTierInfo {
  tier: number;
  labels: string[];
}

export interface AllowedMetric {
  code: string;
  name: string;
  unit: string;
  category: string;
  direction: string;
  active: boolean;
  /** Live bands (benchmark_target_ranges rows with no end date, or an end date after today) for this metric. */
  bandCount: number;
  bandTiers: BandTierInfo[];
  bandHouseholdTypes: string[];
  bandCountries: string[];
}

export interface AllowedCohort {
  code: string;
  description: string;
  countryCode: string | null;
  regionCode: string | null;
  ageBand: string | null;
  householdType: string | null;
  lifeStage: string | null;
  urbanRural: string | null;
  tier: number | null;
  datasetName: string | null;
}

export interface AllowedValuesOk {
  state: 'ok';
  /** Today's database date, as read by the caller (shown day-first to people). */
  readOnIso: string;
  datasets: AllowedDataset[];
  metrics: AllowedMetric[];
  cohorts: AllowedCohort[];
  bandHouseholdTypes: string[];
  bandLifeStages: string[];
  bandCountries: string[];
  /** false when a list was cut by its read bound: the validator then does not refuse on absence. */
  complete: { datasets: boolean; metrics: boolean; cohorts: boolean; bands: boolean; mappings: boolean };
  /**
   * The dataset to metric mapping (migration 0277). installed=false means the table is not on this database yet:
   * uploads then behave as before (any registered metric) and every consumer shows a visible warning.
   */
  mapping: { installed: boolean; pairs: number };
  counts: { datasetsTotal: number; datasetsOpen: number; datasetsClosed: number; metricsTotal: number; metricsActive: number; cohortsTotal: number };
}

export interface AllowedValuesUnavailable {
  state: 'unavailable';
  reason: string;
}

export type AllowedValues = AllowedValuesOk | AllowedValuesUnavailable;

export const UNAVAILABLE_LINE = 'The allowed lists are unavailable right now (they could not be read from the database). Check the Datasets tab before you upload: this file cannot confirm dataset, metric or cohort names.';

// -------------------------------------------------------------------------------------------- derivation ---

type Row = Record<string, unknown>;
export interface RawReference {
  datasets: Row[];
  sources: Row[];
  metrics: Row[];
  cohorts: Row[];
  bands: Row[];
  valueDatasetIds: string[];
  /** dataset_id, metric_definition_id, effective_to of each value (for the live figure counts per mapped metric). */
  valueRows?: Row[];
  /** Rows of benchmark_dataset_metrics; undefined or null when the table is not installed. */
  mappings?: Row[] | null;
  /** Which reads were cut by their bound. */
  cut: { datasets: boolean; sources: boolean; metrics: boolean; cohorts: boolean; bands: boolean; values: boolean; mappings?: boolean };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const cmp = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};
const uniqSorted = (xs: Array<string | null>): string[] => Array.from(new Set(xs.filter((x): x is string => x !== null))).sort(cmp);
const isClosedStatus = (s: string): boolean => (CLOSED_DATASET_STATUSES as readonly string[]).includes(s);

/** The one rule: may this dataset receive an upload? */
export function datasetIsOpen(status: string): boolean {
  return !isClosedStatus(status);
}

export const MAPPING_NOT_INSTALLED_LINE = 'The dataset and metric mapping is not installed on this database yet (migration 0277), so a file is not checked against it: any registered metric is accepted for any open dataset until it is installed.';

const KIND_WORDS: Record<'values' | 'target_ranges', string> = { values: 'observed values', target_ranges: 'planning target ranges' };
export const kindWords = (k: 'values' | 'target_ranges'): string => KIND_WORDS[k];

/** The metrics of a dataset that apply to one kind of file. */
export function mappedFor(d: Pick<AllowedDataset, 'mappedMetrics'>, kind: 'values' | 'target_ranges'): MappedMetric[] {
  return d.mappedMetrics.filter((m) => (kind === 'values' ? m.values : m.targetRanges));
}

function acceptanceFor(
  d: { name: string; version: string; benchmarkClass: string; status: string; sourceName: string | null; liveValueCount: number | null; mappedMetrics: MappedMetric[] },
  mappingInstalled: boolean
): Record<UploadKind, KindAcceptance> {
  if (!datasetIsOpen(d.status)) {
    const note = `No. The dataset is ${d.status}, and a ${CLOSED_DATASET_STATUSES.join(', ')} dataset cannot receive an upload.`;
    return { values: { accepted: false, note }, target_ranges: { accepted: false, note }, cohorts: { accepted: false, note } };
  }
  const needsFirstValue = (d.benchmarkClass === 'observed_market' || d.benchmarkClass === 'regulatory_statutory') && d.liveValueCount === 0;
  const activationNote = needsFirstValue ? ' It holds no figure yet, so it can only be activated by an observed values file.' : '';
  const kindNote = (k: 'values' | 'target_ranges', yes: string): KindAcceptance => {
    if (!mappingInstalled) return { accepted: true, note: `${yes} (The mapping is not installed yet, so the metric is not checked against the dataset.)` };
    const n = mappedFor(d, k).length;
    if (n === 0) return { accepted: false, note: `No. No metric is mapped to this dataset for ${KIND_WORDS[k]} files yet, so nothing can be uploaded to it in this kind of file.` };
    return { accepted: true, note: `${yes} ${n} ${n === 1 ? 'metric is' : 'metrics are'} mapped to it for ${KIND_WORDS[k]} files (see the allowed metrics list).` };
  };
  return {
    values: kindNote('values', 'Yes. The metric, its unit and the cohort must come from the lists below.'),
    target_ranges: kindNote('target_ranges', `Yes.${d.sourceName ? ` source_name must be exactly "${d.sourceName}".` : ''}${activationNote}`),
    cohorts: { accepted: true, note: `Yes.${activationNote}` },
  };
}

/** Pure: raw reference rows -> the lists. Everything the validator, the files and the screen print comes from here. */
export function deriveAllowedValues(raw: RawReference, readOnIso: string): AllowedValuesOk {
  const sourceById = new Map<string, { name: string | null; status: string | null }>();
  for (const s of raw.sources) {
    if (typeof s.id === 'string') sourceById.set(s.id, { name: str(s.source_name), status: str(s.status) });
  }
  const valueCountByDataset = new Map<string, number>();
  for (const id of raw.valueDatasetIds) valueCountByDataset.set(id, (valueCountByDataset.get(id) ?? 0) + 1);
  const mappingInstalled = raw.mappings !== undefined && raw.mappings !== null;
  const mappingRows: Row[] = raw.mappings ?? [];
  const metricById = new Map<string, Row>();
  for (const m of raw.metrics) if (typeof m.id === 'string') metricById.set(m.id, m);
  const isLive = (to: unknown): boolean => {
    const t = str(to);
    return t === null || t > readOnIso;
  };
  const liveValuesByPair = new Map<string, number>();
  for (const v of raw.valueRows ?? []) {
    if (!isLive(v.effective_to)) continue;
    const k = `${String(v.dataset_id ?? '')}|${String(v.metric_definition_id ?? '')}`;
    liveValuesByPair.set(k, (liveValuesByPair.get(k) ?? 0) + 1);
  }
  const mappedOf = (datasetId: string, sourceId: string): MappedMetric[] =>
    mappingRows
      .filter((x) => String(x.dataset_id ?? '') === datasetId)
      .map((x): MappedMetric | null => {
        const m = metricById.get(String(x.metric_definition_id ?? ''));
        if (!m || str(m.metric_code) === null) return null;
        const mid = String(m.id);
        const liveBands = raw.cut.bands
          ? null
          : raw.bands.filter((b) => String(b.metric_definition_id ?? '') === mid && isLive(b.effective_to) && (str(b.benchmark_source_id) === null || String(b.benchmark_source_id) === sourceId)).length;
        return {
          code: String(m.metric_code),
          name: str(m.metric_name) ?? String(m.metric_code),
          unit: str(m.unit) ?? '',
          active: m.active_flag !== false,
          values: x.applies_to_values === true,
          targetRanges: x.applies_to_target_ranges === true,
          liveValues: raw.cut.values || !raw.valueRows ? null : (liveValuesByPair.get(`${datasetId}|${mid}`) ?? 0),
          liveBands,
          evidence: str(x.evidence_note),
        };
      })
      .filter((x): x is MappedMetric => x !== null)
      .sort((a, b) => cmp(a.code, b.code));

  const datasets: AllowedDataset[] = raw.datasets
    .filter((d) => str(d.dataset_name) !== null && str(d.version) !== null)
    .map((d) => {
      const id = String(d.id ?? '');
      const src = sourceById.get(String(d.benchmark_source_id ?? ''));
      const status = str(d.data_status) ?? 'unknown';
      const liveValueCount = raw.cut.values ? null : (valueCountByDataset.get(id) ?? 0);
      const mappedMetrics = mappedOf(id, String(d.benchmark_source_id ?? ''));
      const base = {
        name: String(d.dataset_name),
        version: String(d.version),
        benchmarkClass: str(d.benchmark_class) ?? '',
        status,
        sourceName: src?.name ?? null,
        liveValueCount,
        mappedMetrics,
      };
      const open = datasetIsOpen(status);
      return {
        ...base,
        id,
        evidenceLevel: str(d.evidence_level) ?? '',
        sourceStatus: src?.status ?? null,
        open,
        closedReason: open ? null : `status is ${status}`,
        accepts: acceptanceFor(base, mappingInstalled),
      };
    })
    // Open datasets first, then by name and version: a stable, predictable order for people and for tests.
    .sort((a, b) => (a.open === b.open ? cmp(a.name, b.name) || cmp(a.version, b.version) : a.open ? -1 : 1));

  // Live bands: no end date, or an end date after today (the Twin read path's own rule).
  const liveBands = raw.bands.filter((b) => {
    const to = str(b.effective_to);
    return to === null || to > readOnIso;
  });
  const bandsByMetric = new Map<string, Row[]>();
  for (const b of liveBands) {
    const k = String(b.metric_definition_id ?? '');
    const arr = bandsByMetric.get(k);
    if (arr) arr.push(b);
    else bandsByMetric.set(k, [b]);
  }

  const metrics: AllowedMetric[] = raw.metrics
    .filter((m) => str(m.metric_code) !== null)
    .map((m) => {
      const bands = bandsByMetric.get(String(m.id ?? '')) ?? [];
      const byTier = new Map<number, Set<string>>();
      for (const b of bands) {
        const t = Number(b.band_tier);
        if (!Number.isInteger(t)) continue;
        const set = byTier.get(t) ?? new Set<string>();
        const label = str(b.band_label);
        if (label) set.add(label);
        byTier.set(t, set);
      }
      return {
        code: String(m.metric_code),
        name: str(m.metric_name) ?? String(m.metric_code),
        unit: str(m.unit) ?? '',
        category: str(m.category_code) ?? '',
        direction: str(m.comparison_direction) ?? '',
        active: m.active_flag !== false,
        bandCount: bands.length,
        bandTiers: Array.from(byTier.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([tier, labels]) => ({ tier, labels: Array.from(labels).sort(cmp) })),
        bandHouseholdTypes: uniqSorted(bands.map((b) => str(b.household_type))),
        bandCountries: uniqSorted(bands.map((b) => str(b.country_code))),
      };
    })
    .sort((a, b) => cmp(a.code, b.code));

  const datasetNameById = new Map<string, string>();
  for (const d of raw.datasets) if (typeof d.id === 'string' && str(d.dataset_name)) datasetNameById.set(d.id, String(d.dataset_name));
  const cohorts: AllowedCohort[] = raw.cohorts
    .filter((c) => str(c.cohort_code) !== null)
    .map((c) => ({
      code: String(c.cohort_code),
      description: str(c.cohort_description) ?? '',
      countryCode: str(c.country_code),
      regionCode: str(c.region_code),
      ageBand: str(c.age_band),
      householdType: str(c.household_type),
      lifeStage: str(c.life_stage),
      urbanRural: str(c.urban_rural),
      tier: typeof c.cohort_tier === 'number' ? c.cohort_tier : null,
      datasetName: datasetNameById.get(String(c.dataset_id ?? '')) ?? null,
    }))
    .sort((a, b) => cmp(a.code, b.code));

  const open = datasets.filter((d) => d.open).length;
  return {
    state: 'ok',
    readOnIso,
    datasets,
    metrics,
    cohorts,
    bandHouseholdTypes: uniqSorted(liveBands.map((b) => str(b.household_type))),
    bandLifeStages: uniqSorted(liveBands.map((b) => str(b.life_stage))),
    bandCountries: uniqSorted(liveBands.map((b) => str(b.country_code))),
    complete: { datasets: !raw.cut.datasets && !raw.cut.sources, metrics: !raw.cut.metrics, cohorts: !raw.cut.cohorts, bands: !raw.cut.bands, mappings: !raw.cut.mappings },
    mapping: { installed: mappingInstalled, pairs: mappingRows.length },
    counts: {
      datasetsTotal: datasets.length,
      datasetsOpen: open,
      datasetsClosed: datasets.length - open,
      metricsTotal: metrics.length,
      metricsActive: metrics.filter((m) => m.active).length,
      cohortsTotal: cohorts.length,
    },
  };
}

// -------------------------------------------------------------------------------------------------- loader ---

/** A read failed because the table does not exist (PostgREST schema cache or Postgres), not because of a transient fault. */
export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === 'PGRST205' || error.code === '42P01' || /does not exist|schema cache|Could not find the table/i.test(error.message ?? '')));
}

/** Is the mapping table installed? A cheap read for the preview. 'unavailable' is never reported as 'installed'. */
export async function loadMappingStatus(supabase: Pick<SupabaseClient, 'from'>): Promise<'installed' | 'not_installed' | 'unavailable'> {
  try {
    const r = await supabase.from('benchmark_dataset_metrics').select('id').limit(1);
    if (r.error) return isMissingRelation(r.error) ? 'not_installed' : 'unavailable';
    return Array.isArray(r.data) ? 'installed' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Reads the reference lists under the caller's session client. Any failed read, or a client that throws, is
 * `unavailable` (never an empty "ok" list). A list cut by its bound is flagged incomplete.
 */
export async function loadAllowedValues(supabase: Pick<SupabaseClient, 'from'>, todayIso: string): Promise<AllowedValues> {
  const L = ALLOWED_VALUES_LIMITS;
  try {
    const [datasets, sources, metrics, cohorts, bands, values, mappings] = await Promise.all([
      supabase.from('benchmark_datasets').select('id, dataset_name, version, benchmark_class, evidence_level, data_status, benchmark_source_id').limit(L.datasets),
      supabase.from('benchmark_sources').select('id, source_name, status').limit(L.sources),
      supabase.from('benchmark_metric_definitions').select('id, metric_code, metric_name, category_code, unit, comparison_direction, active_flag').limit(L.metrics),
      supabase.from('benchmark_cohorts').select('dataset_id, cohort_code, country_code, region_code, urban_rural, age_band, household_type, life_stage, cohort_tier, cohort_description').limit(L.cohorts),
      supabase.from('benchmark_target_ranges').select('metric_definition_id, benchmark_source_id, country_code, life_stage, household_type, band_label, band_tier, effective_to').limit(L.bands),
      supabase.from('benchmark_values').select('dataset_id, metric_definition_id, effective_to').limit(L.values),
      supabase.from('benchmark_dataset_metrics').select('dataset_id, metric_definition_id, applies_to_values, applies_to_target_ranges, evidence_note').limit(L.mappings),
    ]);
    for (const r of [datasets, sources, metrics, cohorts, bands, values]) {
      if (r.error || !Array.isArray(r.data)) return { state: 'unavailable', reason: 'a reference table could not be read' };
    }
    // The mapping table is the one read that may legitimately be absent (migration 0277 not applied yet): that is
    // reported as "not installed" and uploads fall back to the previous behaviour with a visible warning. Any other
    // failure of that read is as fatal as a failure of the other reads.
    let mappingRows: Row[] | null = null;
    if (mappings.error) {
      if (!isMissingRelation(mappings.error)) return { state: 'unavailable', reason: 'a reference table could not be read' };
    } else if (!Array.isArray(mappings.data)) {
      return { state: 'unavailable', reason: 'a reference table could not be read' };
    } else {
      mappingRows = mappings.data as Row[];
    }
    const rows = (r: { data: unknown }): Row[] => r.data as Row[];
    const raw: RawReference = {
      datasets: rows(datasets),
      sources: rows(sources),
      metrics: rows(metrics),
      cohorts: rows(cohorts),
      bands: rows(bands),
      valueDatasetIds: rows(values).map((v) => String(v.dataset_id ?? '')),
      valueRows: rows(values),
      mappings: mappingRows,
      cut: {
        datasets: rows(datasets).length >= L.datasets,
        sources: rows(sources).length >= L.sources,
        metrics: rows(metrics).length >= L.metrics,
        cohorts: rows(cohorts).length >= L.cohorts,
        bands: rows(bands).length >= L.bands,
        values: rows(values).length >= L.values,
        mappings: mappingRows !== null && mappingRows.length >= L.mappings,
      },
    };
    return deriveAllowedValues(raw, todayIso);
  } catch {
    return { state: 'unavailable', reason: 'the reference tables could not be reached' };
  }
}

// ------------------------------------------------------------------------------------- lookup for validation ---

export interface AllowedIndex {
  datasetsByKey: Map<string, AllowedDataset>;
  datasetsByName: Map<string, AllowedDataset[]>;
  metricsByCode: Map<string, AllowedMetric>;
  cohortCodes: Set<string>;
}

const keyOf = (name: string, version: string) => `${name}\u0000${version}`;

export function buildAllowedIndex(av: AllowedValuesOk): AllowedIndex {
  const datasetsByKey = new Map<string, AllowedDataset>();
  const datasetsByName = new Map<string, AllowedDataset[]>();
  for (const d of av.datasets) {
    datasetsByKey.set(keyOf(d.name, d.version), d);
    const arr = datasetsByName.get(d.name);
    if (arr) arr.push(d);
    else datasetsByName.set(d.name, [d]);
  }
  return {
    datasetsByKey,
    datasetsByName,
    metricsByCode: new Map(av.metrics.map((m) => [m.code, m])),
    cohortCodes: new Set(av.cohorts.map((c) => c.code)),
  };
}

export function findDataset(ix: AllowedIndex, name: string, version: string): AllowedDataset | undefined {
  return ix.datasetsByKey.get(keyOf(name, version));
}

// ----------------------------------------------------------------------------------- "did you mean" hints ---

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The closest candidates to what a person typed: same letters ignoring case, spaces and punctuation, one
 * containing the other, or a small edit distance. A hint only: the value is never changed for the person.
 */
export function nearestMatches(input: string, candidates: readonly string[], max = 3): string[] {
  const n = norm(input);
  if (n === '') return [];
  const scored: Array<{ c: string; score: number }> = [];
  for (const c of new Set(candidates)) {
    const m = norm(c);
    if (m === '') continue;
    let score: number | null = null;
    if (m === n) score = 0;
    else if (n.length >= 3 && (m.includes(n) || n.includes(m))) score = 1 + Math.abs(m.length - n.length) / 100;
    else {
      const cap = Math.max(2, Math.floor(Math.max(n.length, m.length) * 0.3));
      const d = editDistance(n, m, cap);
      if (d <= cap) score = 2 + d;
    }
    if (score !== null) scored.push({ c, score });
  }
  return scored.sort((a, b) => a.score - b.score || cmp(a.c, b.c)).slice(0, max).map((s) => s.c);
}

/** "A; B; C and 9 more (see the Allowed values list)" - bounded, so a message never runs to a page. */
export function listForMessage(items: readonly string[], limit = 12): string {
  if (items.length <= limit) return items.join('; ');
  return `${items.slice(0, limit).join('; ')}; and ${items.length - limit} more (see the Allowed values list)`;
}

export function didYouMean(input: string, candidates: readonly string[]): string {
  const hits = nearestMatches(input, candidates);
  return hits.length === 0 ? '' : ` Did you mean ${hits.map((h) => `"${h}"`).join(' or ')}? (This is a hint only; nothing was changed in your file.)`;
}

// -------------------------------------------------------------------------------------------- the sections ---

export interface ListSection {
  id: 'datasets' | 'metrics' | 'dataset_metrics' | 'cohorts' | 'band_values' | 'closed_lists';
  heading: string;
  intro: string;
  columns: string[];
  rows: string[][];
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

export function datasetsHeading(av: AllowedValuesOk): string {
  const n = av.counts.datasetsOpen;
  return `${plural(n, 'dataset is', 'datasets are')} open for upload today`;
}
export function metricsHeading(av: AllowedValuesOk): string {
  return `${plural(av.counts.metricsTotal, 'metric is', 'metrics are')} registered and can be uploaded to${av.counts.metricsActive === av.counts.metricsTotal ? '' : ` (${av.counts.metricsActive} active)`}`;
}
export function cohortsHeading(av: AllowedValuesOk): string {
  return `${plural(av.counts.cohortsTotal, 'cohort exists', 'cohorts exist')}`;
}

const tiersText = (m: AllowedMetric): string => (m.bandTiers.length === 0 ? 'none yet' : m.bandTiers.map((t) => `${t.tier} ${t.labels.join('/')}`.trim()).join('; '));
const orNone = (xs: string[]): string => (xs.length === 0 ? 'none yet' : xs.join(', '));

function closedListRows(kind: UploadKind | 'all'): string[][] {
  const kinds: UploadKind[] = kind === 'all' ? [...UPLOAD_KINDS] : [kind];
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const k of kinds) {
    for (const col of UPLOAD_SCHEMA[k].columns) {
      const label = kind === 'all' ? `${col.name} (${KIND_LABEL[k]})` : col.name;
      if (col.type === 'enum' && col.name !== 'template_version') {
        const id = `${k}|${col.name}`;
        if (!seen.has(id)) {
          seen.add(id);
          rows.push([label, (col.enumValues ?? []).join(', '), 'A closed list. Any other word is refused.']);
        }
      } else if (col.type === 'boolean') {
        rows.push([label, `${BOOLEAN_TRUE_WORDS[0]} or ${BOOLEAN_FALSE_WORDS[0]}`, `Also accepted: ${[...BOOLEAN_TRUE_WORDS.slice(1), ...BOOLEAN_FALSE_WORDS.slice(1)].join(', ')} (not case sensitive).`]);
      } else if (col.type === 'integer' && col.min !== undefined && col.max !== undefined) {
        rows.push([label, `whole number from ${col.min} to ${col.max}`, col.description]);
      }
    }
  }
  return rows;
}

/**
 * The allowed metrics PER DATASET (migration 0277), the list the validator enforces: a row is refused unless its
 * dataset and metric appear here for its kind of file. The same rows go to the Read me sheet, the companion CSV and
 * the screen. When the mapping is not installed the section says so instead of listing anything.
 */
export function datasetMetricsSection(av: AllowedValuesOk, kind: 'values' | 'target_ranges' | 'all'): ListSection {
  const columns = ['dataset_name', 'dataset_version', 'metric_code', 'plain name', 'unit', 'observed values file', 'planning target ranges file', 'figures live today', 'dataset status'];
  if (!av.mapping.installed) {
    return { id: 'dataset_metrics', heading: 'Allowed metrics per dataset: not installed yet', intro: MAPPING_NOT_INSTALLED_LINE, columns, rows: [] };
  }
  const rows: string[][] = [];
  for (const d of av.datasets) {
    for (const m of d.mappedMetrics) {
      if (kind === 'values' && !m.values) continue;
      if (kind === 'target_ranges' && !m.targetRanges) continue;
      const live = [m.values ? `${m.liveValues === null ? 'unknown' : m.liveValues} values` : '', m.targetRanges ? `${m.liveBands === null ? 'unknown' : m.liveBands} bands` : ''].filter(Boolean).join(', ');
      rows.push([d.name, d.version, m.code, m.name, m.unit, m.values ? 'yes' : 'no', m.targetRanges ? 'yes' : 'no', live, d.status]);
    }
  }
  const noMetric = av.datasets.filter((d) => d.open && d.mappedMetrics.length === 0).map((d) => `${d.name} (version ${d.version})`);
  return {
    id: 'dataset_metrics',
    heading: `${plural(av.mapping.pairs, 'dataset and metric pair is', 'dataset and metric pairs are')} mapped (which metrics each dataset may receive)`,
    intro:
      'A row in an upload file is refused unless its metric is listed here for its dataset and for its kind of file. The check never changes your file and never guesses. ' +
      (noMetric.length > 0 ? `Open datasets with no metric mapped yet, so nothing can be uploaded to them until one is added on the Upload tab: ${listForMessage(noMetric)}. ` : '') +
      'A holder of the activate permission maintains this list on the Upload tab, and every change is recorded.' +
      (av.complete.mappings ? '' : ' This list was cut at its read limit and may be incomplete.'),
    columns,
    rows,
  };
}

/**
 * The lists a file of this kind (or, for the companion CSV and the screen, every kind) may name, as printable
 * sections. Pure. The XLSX Read me, the CSV and the screen all render these, so they always agree.
 */
export function allowedValuesSections(av: AllowedValuesOk, kind: UploadKind | 'all'): ListSection[] {
  const sections: ListSection[] = [];
  const wantsValues = kind === 'all' || kind === 'values';
  const wantsRanges = kind === 'all' || kind === 'target_ranges';
  const wantsCohorts = kind === 'all' || kind === 'cohorts';

  const acceptingFor = (k: UploadKind) => av.datasets.filter((d) => d.accepts[k].accepted).length;
  const kindSentence =
    kind === 'all'
      ? `Observed values files: ${acceptingFor('values')} accepted. Planning target ranges files: ${acceptingFor('target_ranges')} accepted. Cohorts files: ${acceptingFor('cohorts')} accepted.`
      : `${KIND_LABEL[kind]} files: ${acceptingFor(kind)} of these accept this kind of file.`;
  sections.push({
    id: 'datasets',
    heading: datasetsHeading(av),
    intro:
      `${av.counts.datasetsTotal} datasets are registered; ${av.counts.datasetsClosed} cannot receive an upload. ` +
      `Type dataset_name and dataset_version exactly as written here (capital letters and spaces count). An upload never creates a dataset. ${kindSentence}` +
      (av.complete.datasets ? '' : ' This list was cut at its read limit and may be incomplete: check the Datasets tab.'),
    columns: ['dataset_name', 'dataset_version', 'class', 'evidence level', 'status', 'source', 'source status', 'figures held today', 'observed values file', 'planning target ranges file', 'cohorts file'],
    rows: av.datasets.map((d) => [
      d.name,
      d.version,
      d.benchmarkClass,
      d.evidenceLevel,
      d.status,
      d.sourceName ?? 'none',
      d.sourceStatus ?? 'unknown',
      d.liveValueCount === null ? 'unknown' : String(d.liveValueCount),
      d.accepts.values.note,
      d.accepts.target_ranges.note,
      d.accepts.cohorts.note,
    ]),
  });

  if (wantsValues || wantsRanges) {
    const valuesText = 'In an observed values file, unit must equal the unit shown here for the metric. statistic_type may be any statistic in the closed lists below: the system does not restrict which statistics a metric may carry.';
    const rangesText = 'In a planning target ranges file there is no unit column: lower_bound and upper_bound must be in the unit shown here. A metric may carry bands for any household type; household types and tiers already live are shown for reference.';
    sections.push({
      id: 'metrics',
      heading: metricsHeading(av),
      intro: `${kind === 'all' ? `${valuesText} ${rangesText}` : wantsValues && !wantsRanges ? valuesText : rangesText} An upload cannot create a metric.${av.mapping.installed ? ' A registered metric may only be uploaded into a dataset it is mapped to: see the allowed metrics per dataset below.' : ''}${av.complete.metrics ? '' : ' This list was cut at its read limit and may be incomplete.'}`,
      columns: ['metric_code', 'plain name', 'unit (values and band bounds)', 'direction', 'category', 'status', 'band tiers live today', 'household types in live bands', 'countries in live bands'],
      rows: av.metrics.map((m) => [m.code, m.name, m.unit, m.direction, m.category, m.active ? 'active' : 'inactive (retired)', tiersText(m), orNone(m.bandHouseholdTypes), orNone(m.bandCountries)]),
    });
    sections.push(datasetMetricsSection(av, kind === 'all' ? 'all' : wantsValues ? 'values' : 'target_ranges'));
  }

  if (wantsValues || wantsCohorts) {
    sections.push({
      id: 'cohorts',
      heading: cohortsHeading(av),
      intro:
        kind === 'cohorts'
          ? 'A cohort_code already listed here is left alone when the details are identical and is refused when they differ (cohorts cannot be edited by an upload).'
          : 'In an observed values file, cohort_code must be one of these, or blank for a country-wide figure. A cohort that is not listed here must first be loaded and activated as a Cohorts file.' + (av.complete.cohorts ? '' : ' This list was cut at its read limit and may be incomplete.'),
      columns: ['cohort_code', 'description', 'country', 'age band', 'household type', 'life stage', 'urban or rural', 'cohort tier', 'dataset it was loaded with'],
      rows: av.cohorts.map((c) => [c.code, c.description, c.countryCode ?? 'any', c.ageBand ?? '', c.householdType ?? '', c.lifeStage ?? '', c.urbanRural ?? '', c.tier === null ? '' : String(c.tier), c.datasetName ?? '']),
    });
  }

  if (wantsRanges) {
    sections.push({
      id: 'band_values',
      heading: 'Household types, life stages and countries already used by live bands',
      intro: 'household_type and life_stage are free text in the database, so a new word is accepted, but a word that no live band uses is flagged in the check so a spelling slip is noticed. Countries are two-letter codes.',
      columns: ['column', 'values in live bands today'],
      rows: [
        ['household_type', orNone(av.bandHouseholdTypes)],
        ['life_stage', orNone(av.bandLifeStages)],
        ['country_code', orNone(av.bandCountries)],
      ],
    });
  }

  sections.push({
    id: 'closed_lists',
    heading: 'Closed lists (the only words a column accepts)',
    intro: 'These lists are fixed by the database. Any other word is refused in the check, row by row.',
    columns: ['column', 'allowed', 'note'],
    rows: closedListRows(kind),
  });
  return sections;
}

/** Stable, human-readable stamp used on the Read me sheet and the CSV. Day-first. */
export function readOnLine(av: AllowedValuesOk): string {
  return `Lists read from the database on ${formatDayFirst(av.readOnIso)} (when you downloaded this file). If a dataset, metric or cohort is not listed here, the upload will refuse it.`;
}

