// Planning Benchmarks - PRODUCTION FIRST-LOAD FILES in the upload-template format.
//
// Turns the PO-approved first-load source CSVs (docs/planning-benchmarks/first_load/) into the files the staged
// upload screen (Admin > Benchmarks > Upload) reads: ONE file per dataset and kind (the upload rule is "one file
// loads one dataset and one kind"). Pure and deterministic: it reads local files only, uses no network, no clock
// and no randomness, so running it twice gives byte-identical output.
//
// Column and marker names are read from lib/planning-benchmarks/uploadSchema.ts (the single schema the templates,
// the validator and the screen all use). Nothing about the template is hard-coded here.
//
// What is NOT loaded, and why (the register, first_load/PROVENANCE_REGISTER.md section 1):
//   dataset 1  FHIP dependant-band model     draft, needs PO approval of the methodology (never loaded)
//   dataset 7  AU household debt context     superseded dataset, closed to upload
//   dataset 8  India household consumption   nothing importable (no metric holds a per-person amount)
//   dataset 11 FHIP Planning Benchmarks v1.0 draft, needs PO approval (never loaded)
//
// Run:   npx tsx scripts/planning-benchmarks/buildProductionFirstLoad.ts            (writes the output folder)
//        npx tsx scripts/planning-benchmarks/buildProductionFirstLoad.ts --retarget "<dataset name>=<version>" --out <folder>
//                                                                                   (only if production shows another dataset version)
//        npx tsx scripts/planning-benchmarks/buildProductionFirstLoad.ts --check    (fails if the folder is stale)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './firstLoadLib.mjs';
import { TEMPLATE_VERSION, columnNames, type UploadKind } from '../../lib/planning-benchmarks/uploadSchema';
import { safeCell } from '../../lib/planning-benchmarks/uploadValidate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const SOURCE_DIR = path.join(REPO_ROOT, 'docs', 'planning-benchmarks', 'first_load');
export const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'planning-benchmarks', 'production_first_load');

// ------------------------------------------------------------------------------------------------- plan ---

export interface PlanEntry {
  /** Upload order: cohorts first, then values per dataset, then target ranges. */
  order: number;
  kind: UploadKind;
  /** Dataset number in the register (PROVENANCE_REGISTER.md section 1). */
  sourceDataset: number;
  slug: string;
  sourceFile: string;
  /** Only for a source file that carries no dataset columns (the target ranges file). */
  fixedDataset?: { name: string; version: string };
}

export const PLAN: readonly PlanEntry[] = Object.freeze([
  { order: 1, kind: 'cohorts', sourceDataset: 4, slug: 'au_net_worth_income_by_age', sourceFile: '04_au_net_worth_income_by_age.cohorts.csv' },
  { order: 2, kind: 'values', sourceDataset: 2, slug: 'au_household_asset_composition', sourceFile: '02_au_household_asset_composition.values.csv' },
  { order: 3, kind: 'values', sourceDataset: 3, slug: 'au_household_wealth_distribution', sourceFile: '03_au_household_wealth_distribution.values.csv' },
  { order: 4, kind: 'values', sourceDataset: 4, slug: 'au_net_worth_income_by_age', sourceFile: '04_au_net_worth_income_by_age.values.csv' },
  { order: 5, kind: 'values', sourceDataset: 5, slug: 'au_high_dti_mortgage_threshold', sourceFile: '05_au_high_dti_mortgage_threshold.values.csv' },
  { order: 6, kind: 'values', sourceDataset: 6, slug: 'au_average_super_balance', sourceFile: '06_au_average_super_balance.values.csv' },
  { order: 7, kind: 'values', sourceDataset: 9, slug: 'india_household_assets_debt_rural_urban', sourceFile: '09_india_household_assets_debt_rural_urban.values.csv' },
  { order: 8, kind: 'values', sourceDataset: 10, slug: 'india_epf_eps_contribution_structure', sourceFile: '10_india_epf_eps_contribution_structure.values.csv' },
  {
    order: 9,
    kind: 'target_ranges',
    sourceDataset: 12,
    slug: 'au_asfa_retirement_standard',
    sourceFile: '12_au_asfa_retirement_standard.target_ranges.csv',
    // The ASFA source file has no dataset columns. The dataset is the one DATASET_METRIC_MAPPING.md maps retirement_balance
    // target ranges to (a test pins this text to that document; the validation scripts prove it exists on DEV).
    fixedDataset: { name: 'AU ASFA retirement standard', version: '1.0' },
  },
] as PlanEntry[]);

export interface SkippedDataset {
  sourceDataset: number;
  name: string;
  reason: string;
  /** Source files that exist for it and must never appear in the output. */
  sourceFiles: string[];
}

export const SKIPPED: readonly SkippedDataset[] = Object.freeze([
  { sourceDataset: 1, name: 'FHIP dependant-band household model', reason: 'DRAFT_NEEDS_PO_APPROVAL: methodology not defined, blank worksheet, never loaded without PO approval of the draft', sourceFiles: ['01_fhip_dependant_band_model.DRAFT_WORKSHEET.csv'] },
  { sourceDataset: 7, name: 'AU household debt context', reason: 'superseded dataset: closed to upload (the register lists 1 row, which cannot be uploaded)', sourceFiles: ['07_au_household_debt_context.values.csv'] },
  { sourceDataset: 8, name: 'India household consumption (rural/urban)', reason: 'BLOCKED (schema): per-person monthly amount, no metric holds it; nothing importable', sourceFiles: [] },
  { sourceDataset: 11, name: 'FHIP Planning Benchmarks v1.0', reason: 'DRAFT_NEEDS_PO_APPROVAL: 196-band draft, never loaded without PO approval of the draft', sourceFiles: ['11_fhip_planning_benchmarks_v1.DRAFT_FOR_PO_APPROVAL.target_ranges.csv'] },
] as SkippedDataset[]);

// ------------------------------------------------------------------------------------------ column maps ---
// Source column -> template column. Every template column must be fed by exactly one entry here or by a constant
// (the marker, the dataset). A source column that is neither mapped nor listed as dropped makes the build FAIL, so a
// changed source file can never be converted silently.

const DATE_COLUMNS: Record<UploadKind, readonly string[]> = {
  values: ['base_date', 'effective_from', 'observation_period_start', 'observation_period_end', 'retrieval_date'],
  target_ranges: ['effective_from', 'observation_period_start', 'observation_period_end', 'retrieval_date'],
  cohorts: [],
};

const SAME_NAME: Record<UploadKind, readonly string[]> = {
  values: ['dataset_name', 'dataset_version', 'cohort_code', 'metric_code', 'statistic_type', 'value_numeric', 'unit', 'original_currency', 'base_date', 'effective_from', 'is_derived', 'derivation_method', 'confidence_score'],
  target_ranges: ['metric_code', 'source_name', 'country_code', 'life_stage', 'household_type', 'band_label', 'band_tier', 'lower_bound', 'upper_bound', 'direction', 'explanation', 'evidence_level', 'model_version', 'effective_from'],
  cohorts: ['dataset_name', 'dataset_version', 'cohort_code', 'country_code', 'region_code', 'urban_rural', 'age_band', 'income_band', 'household_type', 'life_stage', 'housing_tenure', 'employment_type', 'dependant_band', 'financial_dna_code', 'cross_border_flag', 'cohort_tier', 'sample_size', 'cohort_description'],
};

/** Provenance: template column <- source x_ column. */
const RENAMED: Record<UploadKind, Record<string, string>> = {
  values: {
    source_release: 'x_release',
    observation_period_start: 'x_obs_period_start',
    observation_period_end: 'x_obs_period_end',
    source_file: 'x_source_file',
    source_locator: 'x_source_locator',
    retrieval_date: 'x_retrieval_date',
  },
  target_ranges: {
    source_release: 'x_release',
    observation_period_start: 'x_obs_period_start',
    observation_period_end: 'x_obs_period_end',
    source_file: 'x_source_file',
    source_locator: 'x_source_locator',
    retrieval_date: 'x_retrieval_date',
  },
  cohorts: { source_release: 'x_release', source_file: 'x_source_file', source_locator: 'x_source_locator' },
};

/**
 * Source columns the template has no field for. Each is either composed by the app (value_text is built from the
 * provenance columns), a database default (version), empty on every row (effective_to, asserted) or pure source
 * bookkeeping (the observation id, the unit multiplier already applied to value_numeric, the reference date which
 * equals base_date, asserted).
 */
const DROPPED: Record<UploadKind, readonly string[]> = {
  values: ['value_text', 'effective_to', 'version', 'x_obs_id', 'x_reference_date', 'x_unit_multiplier'],
  target_ranges: ['effective_to', 'x_obs_id'],
  cohorts: ['x_obs_id'],
};

/** Source columns that must be empty on every row (otherwise dropping them would lose information). */
const MUST_BE_EMPTY: Record<UploadKind, readonly string[]> = {
  values: ['effective_to'],
  target_ranges: ['effective_to'],
  cohorts: [],
};

// ------------------------------------------------------------------------- PO decisions of 07/10/2026 ---

export interface PoDeviation {
  id: string;
  /** Plan order of the file the deviation applies to. */
  order: number;
  metric: string;
  column: string;
  from: string;
  to: string;
  approvedOn: string;
  reason: string;
}

/**
 * Deviations from the register that the Product Owner approved ("go as per the recommendation", 07/10/2026). Each is asserted
 * against the source value, so a changed source cannot be altered silently, and each is recorded in MANIFEST.json and the trace.
 */
export const PO_DEVIATIONS: readonly PoDeviation[] = Object.freeze([
  {
    id: 'PO-DEV-A',
    order: 2,
    metric: 'property_concentration',
    column: 'statistic_type',
    from: 'share',
    to: 'mean',
    approvedOn: '07/10/2026',
    reason:
      'The register file says statistic "share"; the Twin reads median, then mean, then rate, then threshold, never "share", and the live seed row is "mean". With "mean" the sourced 55.7661 replaces the seed 56.2 instead of sitting unused beside it. The upload mapping is by metric, not by statistic, so property_concentration is permitted with "mean". The figure itself is unchanged.',
  },
] as PoDeviation[]);

export const LOCATOR_MAX = 300;
export const locatorSuffix = (text: string): string => ` | Caveat: ${text}`;

/**
 * The population caveats of the register that the values and target-range templates have no field for. They are appended to
 * source_locator (limit 300 characters), in plain language, after the locator the register gave. First match wins; a
 * metric-specific entry must come before a generic one for the same file.
 */
export const LOCATOR_CAVEATS: ReadonlyArray<{ order: number; metric?: string; text: string }> = Object.freeze([
  { order: 2, text: 'all private households; the 2019-20 survey went online during COVID-19 and may not compare directly with earlier years' },
  { order: 3, text: 'all private households; the 2019-20 survey went online during COVID-19 and may not compare directly with earlier years' },
  { order: 4, text: 'ABS age band as published (youngest is 15-24, not the app 18-24); gross household income; 2019-20 survey may not compare directly with earlier years' },
  { order: 5, text: 'the 6x is a limit on each lender (20% of its new lending per cohort), not a personal borrowing rule' },
  { order: 6, text: 'per INDIVIDUAL (balances summed across accounts by TFN), not per household' },
  { order: 7, metric: 'total_assets', text: 'average per household, as at 30/06/2018 (survey year 2019)' },
  { order: 7, metric: 'debt_to_asset_ratio', text: 'as at 30/06/2018 (survey year 2019); one decimal, copied from the MoSPI portal table' },
  { order: 8, text: 'of BASIC WAGES up to the ceiling; PIB restatement (EPFO blocked)' },
  { order: 9, text: 'ASFA copyright: reuse beyond fair dealing needs ASFA permission' },
] as Array<{ order: number; metric?: string; text: string }>);

// ----------------------------------------------------------------------------------------------- helpers ---

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO yyyy-mm-dd -> dd/mm/yyyy (the day-first order the template documents). Blank stays blank. */
export function toDayFirst(v: string, where: string): string {
  if (v === '') return '';
  const m = ISO.exec(v);
  if (!m) throw new Error(`${where}: "${v}" is not an ISO date`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error(`${where}: "${v}" is not a real date`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

const CRLF = '\r\n';
function csvQuote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.split('"').join('""')}"` : s;
}

/** The same serialisation the generator uses (header row 1, CRLF, minimal quoting). Used by the negative controls. */
export function serialiseCsv(names: readonly string[], rows: ReadonlyArray<Record<string, string>>): string {
  const lines = [names.map((n) => csvQuote(n)).join(',')];
  for (const r of rows) lines.push(names.map((n) => csvQuote(r[n] ?? '')).join(','));
  return lines.join(CRLF) + CRLF;
}

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readSource(file: string): { header: string[]; records: Array<Record<string, string>>; bytes: Buffer } {
  const p = path.join(SOURCE_DIR, file);
  const bytes = fs.readFileSync(p);
  const parsed = parseCsv(bytes.toString('utf8')) as { header: string[]; records: Array<Record<string, string>> };
  return { header: parsed.header, records: parsed.records, bytes };
}

// ------------------------------------------------------------------------------------------------- build ---

export interface BuiltFile {
  order: number;
  fileName: string;
  kind: UploadKind;
  sourceDataset: number;
  datasetName: string;
  datasetVersion: string;
  header: string[];
  rows: Array<Record<string, string>>;
  csv: string;
  sha256: string;
  bytes: number;
  sourceFile: string;
  sourceSha256: string;
  sourceRows: number;
  /** One entry per output row: the source observation id and the population note the template has no field for. */
  trace: Array<{ rowNumber: number; observationId: string; droppedNote: string; caveat: string; deviation: string }>;
}

export interface BuildResult {
  files: BuiltFile[];
  totals: Record<UploadKind, number>;
  skipped: SkippedDataset[];
  /** Non-empty only when the files were deliberately retargeted to other dataset versions (recorded in the manifest). */
  retarget: Record<string, string>;
}

export function fileNameFor(e: PlanEntry): string {
  return `${String(e.order).padStart(2, '0')}_${e.kind}_${e.slug}.csv`;
}

function convert(e: PlanEntry, retarget: Readonly<Record<string, string>>, matched: Set<string>): BuiltFile {
  const src = readSource(e.sourceFile);
  const kind = e.kind;
  const names = columnNames(kind);

  // 1. The source header must be exactly what we know how to convert.
  const known = new Set<string>([...SAME_NAME[kind], ...Object.values(RENAMED[kind]), ...DROPPED[kind]]);
  const unknown = src.header.filter((h) => !known.has(h));
  if (unknown.length > 0) throw new Error(`${e.sourceFile}: unmapped source column(s): ${unknown.join(', ')}. Extend the column map deliberately; nothing is converted silently.`);
  const missing = [...SAME_NAME[kind], ...Object.values(RENAMED[kind])].filter((h) => !src.header.includes(h) && !(e.fixedDataset && (h === 'dataset_name' || h === 'dataset_version')));
  if (missing.length > 0) throw new Error(`${e.sourceFile}: missing source column(s): ${missing.join(', ')}`);

  const rows: Array<Record<string, string>> = [];
  const trace: BuiltFile['trace'] = [];
  src.records.forEach((rec, i) => {
    const where = `${e.sourceFile} row ${i + 2}`;
    for (const c of MUST_BE_EMPTY[kind]) if ((rec[c] ?? '') !== '') throw new Error(`${where}: ${c} is "${rec[c]}" but the template has no such field`);
    if (kind === 'values') {
      if (rec.version !== '1') throw new Error(`${where}: version is "${rec.version}" (the database default is 1)`);
      if (rec.x_reference_date !== '' && rec.x_reference_date !== rec.base_date) throw new Error(`${where}: x_reference_date differs from base_date`);
    }
    const out: Record<string, string> = {};
    for (const n of names) {
      let v: string;
      if (n === 'template_version') v = TEMPLATE_VERSION[kind];
      else if (e.fixedDataset && n === 'dataset_name') v = e.fixedDataset.name;
      else if (e.fixedDataset && n === 'dataset_version') v = e.fixedDataset.version;
      else if (RENAMED[kind][n] !== undefined) v = rec[RENAMED[kind][n]] ?? '';
      else if (SAME_NAME[kind].includes(n)) v = rec[n] ?? '';
      else throw new Error(`template column "${n}" (${kind}) has no source mapping`);
      if (DATE_COLUMNS[kind].includes(n)) v = toDayFirst(v, `${where} ${n}`);
      out[n] = v;
    }
    // Optional, explicit retargeting to a dataset version that production shows (a CLI flag, never silent).
    if (retarget[out.dataset_name] !== undefined) {
      out.dataset_version = retarget[out.dataset_name];
      matched.add(out.dataset_name);
    }
    // PO-approved deviations from the register (explicit, asserted against the source value, recorded in the manifest).
    const deviationIds: string[] = [];
    for (const d of PO_DEVIATIONS) {
      if (d.order !== e.order || out.metric_code !== d.metric) continue;
      if (out[d.column] !== d.from) throw new Error(`${where}: deviation ${d.id} expects ${d.column} "${d.from}" but the source says "${out[d.column]}"`);
      out[d.column] = d.to;
      deviationIds.push(d.id);
    }
    // Short plain-language population caveat appended to source_locator (the template has no notes column).
    const cav = LOCATOR_CAVEATS.find((c) => c.order === e.order && (c.metric === undefined || c.metric === out.metric_code));
    let caveat = '';
    if (cav && out.source_locator !== undefined) {
      caveat = locatorSuffix(cav.text);
      out.source_locator = out.source_locator + caveat;
      if (out.source_locator.length > LOCATOR_MAX) throw new Error(`${where}: source_locator is ${out.source_locator.length} characters after the caveat (limit ${LOCATOR_MAX})`);
    }
    rows.push(out);
    const note = kind === 'values' ? (rec.value_text ?? '').split(' | ').slice(-1)[0] : '';
    trace.push({ rowNumber: i + 2, observationId: rec.x_obs_id ?? '', droppedNote: note, caveat, deviation: deviationIds.join(' ') });
  });

  // 2. Serialise: header row 1, CRLF, the same quoting as the downloadable templates. No cell is changed by the
  //    formula-injection neutraliser (a figure or a text must reach the database exactly as approved).
  const lines = [names.map((n) => csvQuote(n)).join(',')];
  for (const r of rows) {
    lines.push(
      names
        .map((n) => {
          const raw = r[n];
          if (safeCell(raw) !== raw) throw new Error(`${e.sourceFile}: cell "${n}" = "${raw.slice(0, 40)}" would be altered by the formula-injection neutraliser`);
          return csvQuote(raw);
        })
        .join(',')
    );
  }
  const csv = lines.join(CRLF) + CRLF;

  const datasetNames = new Set(rows.map((r) => `${r.dataset_name}\u0000${r.dataset_version}`));
  if (datasetNames.size !== 1) throw new Error(`${e.sourceFile}: the file names ${datasetNames.size} datasets; one file loads one dataset`);
  return {
    order: e.order,
    fileName: fileNameFor(e),
    kind,
    sourceDataset: e.sourceDataset,
    datasetName: rows[0].dataset_name,
    datasetVersion: rows[0].dataset_version,
    header: names,
    rows,
    csv,
    sha256: sha256(csv),
    bytes: Buffer.byteLength(csv, 'utf8'),
    sourceFile: e.sourceFile,
    sourceSha256: sha256(src.bytes),
    sourceRows: src.records.length,
    trace,
  };
}

export interface BuildOptions {
  /** dataset_name -> dataset_version to write instead of the approved one, when production shows another version. */
  retarget?: Readonly<Record<string, string>>;
}

export function buildProductionFirstLoad(opts: BuildOptions = {}): BuildResult {
  const retarget = opts.retarget ?? {};
  const matched = new Set<string>();
  // Skipped datasets must stay out: a plan entry may never name one of their source files.
  const banned = new Set(SKIPPED.flatMap((s) => s.sourceFiles));
  for (const e of PLAN) if (banned.has(e.sourceFile)) throw new Error(`${e.sourceFile} belongs to a dataset that must not be loaded`);
  const files = [...PLAN].sort((a, b) => a.order - b.order).map((e) => convert(e, retarget, matched));
  for (const k of Object.keys(retarget)) if (!matched.has(k)) throw new Error(`--retarget names "${k}", which is not a dataset in this load. Names are matched exactly.`);
  const totals: Record<UploadKind, number> = { values: 0, target_ranges: 0, cohorts: 0 };
  for (const f of files) totals[f.kind] += f.rows.length;
  return { files, totals, skipped: [...SKIPPED], retarget: { ...retarget } };
}

// ------------------------------------------------------------------------------------------------ outputs ---

export const MANIFEST_CSV = 'MANIFEST.csv';
export const MANIFEST_JSON = 'MANIFEST.json';
export const TRACE_CSV = 'TRACE_rows_to_source_observations.csv';

function manifestCsv(b: BuildResult): string {
  const head = ['upload_order', 'file', 'dataset_no', 'dataset_name', 'dataset_version', 'kind', 'rows', 'bytes', 'sha256', 'template_version', 'source_file', 'source_sha256'];
  const lines = [head.join(',')];
  for (const f of b.files) {
    lines.push([String(f.order), f.fileName, String(f.sourceDataset), f.datasetName, f.datasetVersion, f.kind, String(f.rows.length), String(f.bytes), f.sha256, TEMPLATE_VERSION[f.kind], f.sourceFile, f.sourceSha256].map(csvQuote).join(','));
  }
  return lines.join(CRLF) + CRLF;
}

function manifestJson(b: BuildResult): string {
  return (
    JSON.stringify(
      {
        generator: 'scripts/planning-benchmarks/buildProductionFirstLoad.ts',
        sourceFolder: 'docs/planning-benchmarks/first_load',
        totals: { values: b.totals.values, target_ranges: b.totals.target_ranges, cohorts: b.totals.cohorts, files: b.files.length },
        files: b.files.map((f) => ({ order: f.order, file: f.fileName, datasetNo: f.sourceDataset, dataset: f.datasetName, version: f.datasetVersion, kind: f.kind, rows: f.rows.length, bytes: f.bytes, sha256: f.sha256, templateVersion: TEMPLATE_VERSION[f.kind], sourceFile: f.sourceFile, sourceSha256: f.sourceSha256 })),
        poApprovedDeviations: PO_DEVIATIONS.map((d) => ({ id: d.id, file: PLAN.find((e) => e.order === d.order)!.sourceFile, metric: d.metric, column: d.column, from: d.from, to: d.to, approvedOn: d.approvedOn, reason: d.reason })),
        ...(Object.keys(b.retarget).length > 0 ? { retargeted: b.retarget } : {}),
        skipped: b.skipped.map((s) => ({ datasetNo: s.sourceDataset, name: s.name, reason: s.reason })),
      },
      null,
      2
    ) + '\n'
  );
}

function traceCsv(b: BuildResult): string {
  const lines = ['file,row,source_observation_id,register_population_note,caveat_appended_to_source_locator,po_approved_deviation'];
  for (const f of b.files) for (const t of f.trace) lines.push([f.fileName, String(t.rowNumber), t.observationId, t.droppedNote, t.caveat.replace(/^ \| /, ''), t.deviation].map(csvQuote).join(','));
  return lines.join(CRLF) + CRLF;
}

/** Every file the build produces, as name -> text. The only thing written to disk. */
export function outputFiles(b: BuildResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of b.files) out[f.fileName] = f.csv;
  out[MANIFEST_CSV] = manifestCsv(b);
  out[MANIFEST_JSON] = manifestJson(b);
  out[TRACE_CSV] = traceCsv(b);
  return out;
}

function flagValues(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]);
  });
  return out;
}

function main(): void {
  const check = process.argv.includes('--check');
  const retarget: Record<string, string> = {};
  for (const spec of flagValues('--retarget')) {
    const at = spec.lastIndexOf('=');
    if (at < 1 || at === spec.length - 1) throw new Error('--retarget needs "dataset name=version"');
    retarget[spec.slice(0, at)] = spec.slice(at + 1);
  }
  const outDirFlag = flagValues('--out')[0];
  if (check && (outDirFlag || Object.keys(retarget).length > 0)) throw new Error('--check works on the default folder only');
  if (Object.keys(retarget).length > 0 && !outDirFlag) throw new Error('--retarget needs --out <folder>: the committed folder always holds the approved versions');
  const OUT = outDirFlag ? path.resolve(outDirFlag) : OUTPUT_DIR;
  const b = buildProductionFirstLoad({ retarget });
  const out = outputFiles(b);
  if (check) {
    const stale: string[] = [];
    for (const [name, text] of Object.entries(out)) {
      const p = path.join(OUTPUT_DIR, name);
      if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) stale.push(name);
    }
    if (stale.length > 0) {
      console.error(`STALE: ${stale.join(', ')}. Run the generator again.`);
      process.exitCode = 1;
      return;
    }
    console.log('Output folder is current.');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(out)) fs.writeFileSync(path.join(OUT, name), text, 'utf8');
  console.log(`Wrote ${Object.keys(out).length} files to ${OUT}`);
  for (const f of b.files) console.log(`  ${f.fileName}  ${f.kind}  ${f.rows.length} rows  ${f.sha256}`);
  console.log(`Totals: values ${b.totals.values}, target ranges ${b.totals.target_ranges}, cohorts ${b.totals.cohorts}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
