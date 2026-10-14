// Planning Benchmarks production first-load: run the generated files through the REAL upload validator.
//
// Shared by the DEV read-only script, the PGlite rehearsal and the unit test, so all three use the same code path as
// the Upload screen: readUploadFile (the shared ingest library) -> validateUploadTable (uploadValidate.ts) with the
// live allowed lists (allowedValues.ts, which include the dataset to metric mapping of migration 0277).
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './firstLoadLib.mjs';
import { readUploadFile, validateUploadTable, type UploadIssue, type ValidatedUpload } from '../../lib/planning-benchmarks/uploadValidate';
import type { AllowedValuesOk, AllowedCohort } from '../../lib/planning-benchmarks/allowedValues';
import type { UploadKind } from '../../lib/planning-benchmarks/uploadSchema';
import { OUTPUT_DIR, serialiseCsv, type BuiltFile } from './buildProductionFirstLoad';

export interface FileCheck {
  file: string;
  kind: UploadKind;
  readOk: boolean;
  readProblems: string[];
  rowsRead: number;
  rowsAccepted: number;
  errors: UploadIssue[];
  warnings: UploadIssue[];
  datasetName: string | null;
  datasetVersion: string | null;
}

export function checkBytes(file: string, kind: UploadKind, bytes: Uint8Array, allowed: AllowedValuesOk, todayIso: string): FileCheck {
  const read = readUploadFile({ fileName: file, bytes });
  if (!read.ok) {
    return { file, kind, readOk: false, readProblems: read.problems.map((p) => `${p.code}: ${p.message}`), rowsRead: 0, rowsAccepted: 0, errors: [], warnings: [], datasetName: null, datasetVersion: null };
  }
  const metricUnits = new Map<string, string>(allowed.metrics.map((m) => [m.code, m.unit]));
  const v: ValidatedUpload = validateUploadTable(read.table, kind, { todayIso, metricUnits, allowed });
  return {
    file,
    kind,
    readOk: true,
    readProblems: [],
    rowsRead: v.rowsRead,
    rowsAccepted: v.rows.length,
    errors: v.issues.filter((i) => i.severity === 'error'),
    warnings: v.issues.filter((i) => i.severity === 'warning'),
    datasetName: v.datasetName,
    datasetVersion: v.datasetVersion,
  };
}

/** The shipped files exactly as they sit in the output folder (what the PO uploads), not a rebuild in memory. */
export function readShippedFile(fileName: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(OUTPUT_DIR, fileName)));
}

/**
 * What the lists look like once the cohorts file (upload 1) has been activated: the same lists plus the cohort rows it
 * carries. Used to answer "does the values file pass once the cohort exists" without writing anything.
 */
export function withCohortsActivated(allowed: AllowedValuesOk, cohortsFile: BuiltFile): AllowedValuesOk {
  const add: AllowedCohort[] = cohortsFile.rows
    .filter((r) => !allowed.cohorts.some((c) => c.code === r.cohort_code))
    .map((r) => ({
      code: r.cohort_code,
      description: r.cohort_description,
      countryCode: r.country_code || null,
      regionCode: r.region_code || null,
      ageBand: r.age_band || null,
      householdType: r.household_type || null,
      lifeStage: r.life_stage || null,
      urbanRural: r.urban_rural || null,
      tier: Number(r.cohort_tier),
      datasetName: r.dataset_name,
    }));
  return { ...allowed, cohorts: [...allowed.cohorts, ...add].sort((a, b) => (a.code < b.code ? -1 : 1)), counts: { ...allowed.counts, cohortsTotal: allowed.cohorts.length + add.length } };
}

// ------------------------------------------------------------------------------------ negative controls ---

export interface Tamper {
  id: string;
  describe: string;
  /** The issue code the validator MUST raise for the tampered file (and that the untouched file must not have). */
  expectCode: string;
  apply: (rows: Array<Record<string, string>>) => void;
}

/** Tampers a copy of one shipped file and proves the validator refuses it. A control that does not fail is itself a defect. */
export const TAMPERS: Record<string, Tamper[]> = {
  values: [
    { id: 'NC-F1', describe: 'metric not mapped to the dataset: the first row is pointed at a dataset the metric does not belong to', expectCode: 'METRIC_NOT_MAPPED', apply: (r) => (r[0].dataset_name = r[0].dataset_name === 'AU high-DTI mortgage threshold' ? 'AU household wealth distribution' : 'AU high-DTI mortgage threshold') },
    { id: 'NC-F2', describe: 'unit differs from the metric unit: the first row carries a different unit', expectCode: 'UNIT_MISMATCH', apply: (r) => (r[0].unit = r[0].unit === 'percentage' ? 'ratio' : 'percentage') },
    { id: 'NC-F3', describe: 'thousands separator inside a figure', expectCode: 'NUMBER_FORMAT', apply: (r) => (r[0].value_numeric = '1,245,200') },
    { id: 'NC-F4', describe: 'month-first date (30 is not a month)', expectCode: 'DATE_FORMAT', apply: (r) => (r[0].retrieval_date = '10/30/2026') },
    { id: 'NC-F5', describe: 'template from another generation', expectCode: 'TEMPLATE_VERSION_MISMATCH', apply: (r) => (r[0].template_version = 'FHIP-PB-VALUES-0') },
    { id: 'NC-F6', describe: 'dataset name that does not exist', expectCode: 'DATASET_NOT_FOUND', apply: (r) => (r[0].dataset_name = r[0].dataset_name + ' (typo)') },
    { id: 'NC-F7', describe: 'a duplicate row (same metric, cohort and statistic)', expectCode: 'DUPLICATE_KEY', apply: (r) => r.push({ ...r[0] }) },
  ],
  target_ranges: [
    { id: 'NC-F8', describe: 'band cites a source that is not the dataset source', expectCode: 'SOURCE_MISMATCH', apply: (r) => (r[0].source_name = 'ABS_SIH_2019_20') },
    { id: 'NC-F9', describe: 'lower bound above upper bound', expectCode: 'BOUND_ORDER', apply: (r) => ((r[0].lower_bound = '999999'), (r[0].upper_bound = '1')) },
    { id: 'NC-F10', describe: 'metric not mapped to the dataset for target ranges', expectCode: 'METRIC_NOT_MAPPED', apply: (r) => (r[0].metric_code = 'net_worth') },
  ],
  cohorts: [
    { id: 'NC-F11', describe: 'cohort tier outside 1 to 5', expectCode: 'OUT_OF_RANGE', apply: (r) => (r[0].cohort_tier = '9') },
    { id: 'NC-F12', describe: 'urban_rural outside the closed list', expectCode: 'NOT_IN_LIST', apply: (r) => (r[0].urban_rural = 'suburban') },
  ],
};

export function tamperedBytes(file: BuiltFile, t: Tamper): Uint8Array {
  const parsed = parseCsv(file.csv) as { header: string[]; records: Array<Record<string, string>> };
  const rows = parsed.records.map((r) => ({ ...r }));
  t.apply(rows);
  return new TextEncoder().encode(serialiseCsv(file.header, rows));
}

export interface ControlResult {
  id: string;
  file: string;
  describe: string;
  expectCode: string;
  untouchedHadCode: boolean;
  tamperedErrorCount: number;
  tamperedHasCode: boolean;
  refused: boolean;
}

export function runNegativeControls(file: BuiltFile, allowed: AllowedValuesOk, todayIso: string): ControlResult[] {
  const out: ControlResult[] = [];
  const untouched = checkBytes(file.fileName, file.kind, new TextEncoder().encode(file.csv), allowed, todayIso);
  for (const t of TAMPERS[file.kind]) {
    const tampered = checkBytes(file.fileName, file.kind, tamperedBytes(file, t), allowed, todayIso);
    const hasCode = tampered.errors.some((e) => e.code === t.expectCode);
    out.push({
      id: t.id,
      file: file.fileName,
      describe: t.describe,
      expectCode: t.expectCode,
      untouchedHadCode: untouched.errors.some((e) => e.code === t.expectCode),
      tamperedErrorCount: tampered.errors.length,
      tamperedHasCode: hasCode,
      refused: tampered.errors.length > 0 && hasCode,
    });
  }
  return out;
}
