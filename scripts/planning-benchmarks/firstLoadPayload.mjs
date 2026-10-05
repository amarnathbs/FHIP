// File discovery + payload building for the Planning Benchmarks first load (offline; no database).
//
// The payload keeps NATURAL keys for entities that may be created earlier in the same run (sources, datasets,
// cohorts); the console runner resolves ids from live GETs so a later row can reference them. Only metric
// definition ids (never created by an import) come from the read-only export.
import fs from 'node:fs';
import path from 'node:path';
import { readCsvFile, coerceCell, buildSourceBody, VALUES_DB_COLUMNS, COHORT_DB_COLUMNS, TARGET_RANGE_DB_COLUMNS } from './firstLoadLib.mjs';

// New dataset VERSIONS only. The 12 registered datasets already exist.
export const DATASET_DB_COLUMNS = [
  'dataset_name',
  'version',
  'benchmark_class',
  'evidence_level',
  'is_indicative',
  'requires_periodic_review',
  'source_period',
  'geography_level',
  'statistic_coverage',
  'sample_size',
  'effective_from',
  'effective_to',
  'review_due_at',
];
export const DATASET_HEADER = ['source_name', ...DATASET_DB_COLUMNS];
const DATASET_BOOLEAN_COLS = new Set(['is_indicative', 'requires_periodic_review']);

export function isDraftFile(name) {
  return /\.DRAFT/i.test(name);
}

export function listImportFiles(dir) {
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.csv'));
  const importable = names.filter((n) => !isDraftFile(n));
  return {
    sources: importable.filter((n) => n === 'sources.csv'),
    datasets: importable.filter((n) => n === 'datasets.csv'),
    cohorts: importable.filter((n) => n.endsWith('.cohorts.csv')).sort(),
    values: importable.filter((n) => n.endsWith('.values.csv')).sort(),
    targetRanges: importable.filter((n) => n.endsWith('.target_ranges.csv')).sort(),
    drafts: names.filter(isDraftFile).sort(),
  };
}

function bodyFrom(record, cols) {
  const body = {};
  for (const c of cols) {
    let v = coerceCell(c, record[c]);
    if (v === undefined) continue;
    if (DATASET_BOOLEAN_COLS.has(c) && typeof v === 'string') v = /^(true|t|1|yes)$/i.test(v);
    body[c] = v;
  }
  return body;
}

export function loadImportSet(dir) {
  const files = listImportFiles(dir);
  const rd = (n) => readCsvFile(path.join(dir, n));
  const set = { files, sources: [], datasets: [], cohorts: [], values: [], targetRanges: [] };
  for (const n of files.sources) for (const r of rd(n).records) set.sources.push({ file: n, record: r });
  for (const n of files.datasets) for (const r of rd(n).records) set.datasets.push({ file: n, record: r });
  for (const n of files.cohorts) for (const r of rd(n).records) set.cohorts.push({ file: n, record: r });
  for (const n of files.values) for (const r of rd(n).records) set.values.push({ file: n, record: r });
  for (const n of files.targetRanges) for (const r of rd(n).records) set.targetRanges.push({ file: n, record: r });
  return set;
}

/** Build the JSON the console runner posts. metricIds: { metric_code: uuid } from the read-only export. */
export function buildPayload(set, metricIds) {
  const needMetric = (code) => {
    if (!metricIds[code]) throw new Error(`metric_code "${code}" not present in the exported metric id map`);
    return metricIds[code];
  };
  const codes = [...new Set([...set.values.map((v) => v.record.metric_code), ...set.targetRanges.map((t) => t.record.metric_code)])].sort();
  return {
    format: 'fhip-planning-benchmarks-first-load/1',
    metricIds: Object.fromEntries(codes.map((c) => [c, needMetric(c)])),
    sources: set.sources.map(({ file, record }) => ({ file, body: buildSourceBody(record) })),
    datasets: set.datasets.map(({ file, record }) => ({ file, sourceName: record.source_name, body: bodyFrom(record, DATASET_DB_COLUMNS) })),
    cohorts: set.cohorts.map(({ file, record }) => ({
      file,
      datasetKey: `${record.dataset_name}||${record.dataset_version}`,
      body: bodyFrom(record, COHORT_DB_COLUMNS),
    })),
    values: set.values.map(({ file, record }) => ({
      file,
      datasetKey: `${record.dataset_name}||${record.dataset_version}`,
      cohortCode: (record.cohort_code ?? '').trim(),
      metricCode: record.metric_code,
      body: bodyFrom(record, VALUES_DB_COLUMNS),
    })),
    targetRanges: set.targetRanges.map(({ file, record }) => ({
      file,
      metricCode: record.metric_code,
      sourceName: (record.source_name ?? '').trim(),
      body: bodyFrom(record, TARGET_RANGE_DB_COLUMNS),
    })),
  };
}
