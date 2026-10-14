// Planning Benchmarks staged upload - read, parse and validate an uploaded file (pure, no database).
//
// The file-safety half (extension and content sniffing, size, ZIP/XML limits, macro refusal, encoding,
// explicit sheet choice, formula cells, hidden rows) is the shared ingest library the Market Index Data
// upload already uses. This module adds only what is specific to benchmark rows: the column schema, the
// per-cell parsing and the cross-field rules. Every rule here is enforced a second time inside the database
// RPC (migration 0275); the app-side pass exists to give row-level messages before anything is staged.
import {
  inspectUpload,
  parseCsvText,
  listWorkbookSheets,
  readWorksheet,
  csvToTable,
  xlsxToTable,
  neutraliseCsvCell,
  type SheetInfo,
  type TableCell,
  type TableRow,
  type UploadTable,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { formatDayFirst, parseExcelSerialDate, parseFileDateText } from './dates';
import { BOOLEAN_FALSE_WORDS, BOOLEAN_TRUE_WORDS, TEMPLATE_VERSION, UPLOAD_LIMITS, UPLOAD_SCHEMA, type ColumnDef, type UploadKind } from './uploadSchema';
import { MAPPING_NOT_INSTALLED_LINE, buildAllowedIndex, didYouMean, findDataset, kindWords, listForMessage, mappedFor, type AllowedDataset, type AllowedIndex, type AllowedValuesOk } from './allowedValues';
import { formatCount } from './figureFormat';

export interface UploadIssue {
  severity: 'error' | 'warning';
  code: string;
  /** The row number as the operator sees it in the spreadsheet (header row is row 1). Null for a file-level issue. */
  rowNumber: number | null;
  column: string | null;
  message: string;
}

export type StageRow = Record<string, string | number | boolean | null>;

export interface ValidateContext {
  /** Database date form, injected so tests are deterministic. */
  todayIso: string;
  /** metric_code -> unit, from benchmark_metric_definitions. */
  metricUnits: ReadonlyMap<string, string>;
  /**
   * The live allowed lists (datasets, metrics, cohorts) that the Read me sheet and the screen also print. When
   * present, a row naming a dataset that is not open for upload, a metric or cohort that is not listed, or a
   * target-range source that is not the dataset's own is refused here, in plain words that name the allowed
   * values. The database refuses the same things again at staging; this pass gives the row-level message first.
   */
  allowed?: AllowedValuesOk;
}

export interface ValidatedUpload {
  kind: UploadKind;
  templateVersion: string;
  datasetName: string | null;
  datasetVersion: string | null;
  rows: StageRow[];
  issues: UploadIssue[];
  errorCount: number;
  warningCount: number;
  rowsRead: number;
  blankRowsSkipped: number;
  disclosure: UploadTable['disclosure'] | null;
}

// -------------------------------------------------------------------------------------------- reading ---

export interface ReadInput {
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
  sheetName?: string;
  includeHiddenRows?: boolean;
}

export type ReadResult =
  | { ok: true; fileKind: 'csv' | 'xlsx'; table: UploadTable; sheets?: SheetInfo[] }
  | { ok: false; stage: 'inspection' | 'sheet'; problems: Array<{ code: string; message: string }>; sheets?: SheetInfo[] };

const LIMITS = { maxBytes: UPLOAD_LIMITS.maxBytes, maxRows: UPLOAD_LIMITS.maxRows };

/** Header row is always row 1 (the template contract). */
export function readUploadFile(input: ReadInput): ReadResult {
  const inspected = inspectUpload({ fileName: input.fileName, declaredMime: input.declaredMime, bytes: input.bytes, limits: LIMITS });
  if (!inspected.ok || inspected.kind === null) return { ok: false, stage: 'inspection', problems: inspected.problems };

  if (inspected.kind === 'csv') {
    const parsed = parseCsvText(inspected.text ?? '', { delimiter: 'auto', maxRows: LIMITS.maxRows + 1, headerRow: 1 });
    return { ok: true, fileKind: 'csv', table: csvToTable(parsed, 1) };
  }

  const listing = listWorkbookSheets(input.bytes, LIMITS);
  if (listing.problems.length > 0 && listing.sheets.length === 0) return { ok: false, stage: 'inspection', problems: listing.problems };
  if (!input.sheetName) {
    return {
      ok: false,
      stage: 'sheet',
      sheets: listing.sheets,
      problems: [{ code: 'SHEET_NAME_REQUIRED', message: `Choose the sheet to process. Available sheets: ${listing.sheets.map((s) => s.name).join(', ') || '(none)'}.` }],
    };
  }
  const ws = readWorksheet(input.bytes, input.sheetName, { headerRow: 1, includeHiddenRows: input.includeHiddenRows === true, limits: LIMITS });
  return { ok: true, fileKind: 'xlsx', table: xlsxToTable(ws), sheets: listing.sheets };
}

// ------------------------------------------------------------------------------------------ cell parsing ---

type Parsed = { ok: true; value: string | number | boolean | null } | { ok: false; code: string; message: string };

const DECIMAL = /^-?\d+(\.\d+)?$/;
const EXPONENT = /^-?\d+(\.\d+)?[eE][+-]?\d+$/;
const MAX_ABS = 1e14;

function cellKind(c: TableCell | undefined): 'empty' | 'text' | 'number' | 'serial' | 'formula' | 'error' {
  if (c === null || c === undefined) return 'empty';
  if (typeof c === 'string') return c.trim() === '' ? 'empty' : 'text';
  if ('excelSerial' in c) return 'serial';
  if ('numberValue' in c) return 'number';
  if ('formulaRef' in c) return 'formula';
  return 'error';
}

function cellText(c: TableCell | undefined): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c.trim();
  if ('numberValue' in c) return c.raw.trim();
  if ('excelSerial' in c) return String(c.excelSerial);
  if ('formulaRef' in c) return c.text.trim();
  return c.errorValue;
}

function parseDecimal(text: string, fromNumberCell: boolean): { ok: true; n: number } | { ok: false; message: string } {
  let t = text;
  if (fromNumberCell && EXPONENT.test(t)) {
    const n = Number(t);
    if (!Number.isFinite(n)) return { ok: false, message: 'is not a finite number' };
    if (Math.abs(n * 1e4 - Math.round(n * 1e4)) > 1e-6) return { ok: false, message: 'has more than 4 decimal places' };
    t = n.toFixed(4);
  }
  if (!DECIMAL.test(t)) {
    if (/%/.test(t)) return { ok: false, message: 'contains a percent sign (write percentage points as a plain number)' };
    if (/[,\s]/.test(t)) return { ok: false, message: 'contains a comma or a space (write plain digits with a decimal point)' };
    return { ok: false, message: 'is not a plain number' };
  }
  const decimals = (t.split('.')[1] ?? '').length;
  if (decimals > 4) return { ok: false, message: 'has more than 4 decimal places (it is never rounded for you)' };
  const n = Number(t);
  if (!Number.isFinite(n) || Math.abs(n) >= MAX_ABS) return { ok: false, message: 'is too large' };
  return { ok: true, n };
}

function parseCell(def: ColumnDef, cell: TableCell | undefined, date1904: boolean): Parsed {
  const k = cellKind(cell);
  if (k === 'formula') return { ok: false, code: 'FORMULA_CELL_REJECTED', message: 'holds a formula. Copy the cells and paste them as values.' };
  if (k === 'error') return { ok: false, code: 'CELL_ERROR_VALUE', message: 'holds a spreadsheet error value.' };
  if (k === 'empty') return def.required ? { ok: false, code: 'MISSING_VALUE', message: 'is required.' } : { ok: true, value: null };

  const text = cellText(cell);
  const fail = (code: string, message: string): Parsed => ({ ok: false, code, message });

  switch (def.type) {
    case 'text': {
      if (k === 'serial') return fail('TEXT_EXPECTED', 'must be text, not a date.');
      if (def.maxLength && text.length > def.maxLength) return fail('TOO_LONG', `is longer than ${def.maxLength} characters.`);
      return { ok: true, value: text };
    }
    case 'code': {
      if (k === 'serial') return fail('CODE_FORMAT', 'is not a valid code.');
      if (def.name === 'original_currency') return /^[A-Z]{3}$/.test(text) ? { ok: true, value: text } : fail('CURRENCY_FORMAT', 'must be a three-letter upper-case currency such as AUD or INR.');
      if (def.maxLength && text.length > def.maxLength) return fail('TOO_LONG', `is longer than ${def.maxLength} characters.`);
      return /^[A-Za-z0-9_]+$/.test(text) ? { ok: true, value: text } : fail('CODE_FORMAT', 'may contain only letters, digits and underscores.');
    }
    case 'country':
      return /^[A-Z]{2}$/.test(text) ? { ok: true, value: text } : fail('COUNTRY_FORMAT', 'must be a two-letter upper-case country code such as AU or IN.');
    case 'enum': {
      const v = text.toLowerCase();
      return (def.enumValues ?? []).includes(v) ? { ok: true, value: v } : fail('NOT_IN_LIST', `must be one of: ${(def.enumValues ?? []).join(', ')}.`);
    }
    case 'boolean': {
      const v = text.toLowerCase();
      if ((BOOLEAN_TRUE_WORDS as readonly string[]).includes(v)) return { ok: true, value: true };
      if ((BOOLEAN_FALSE_WORDS as readonly string[]).includes(v)) return { ok: true, value: false };
      return fail('BOOLEAN_FORMAT', 'must be true or false.');
    }
    case 'integer': {
      if (!/^\d+$/.test(text)) return fail('INTEGER_FORMAT', 'must be a whole number.');
      const n = Number(text);
      if (def.min !== undefined && n < def.min) return fail('OUT_OF_RANGE', `must be at least ${def.min}.`);
      if (def.max !== undefined && n > def.max) return fail('OUT_OF_RANGE', `must be at most ${def.max}.`);
      return { ok: true, value: n };
    }
    case 'number': {
      if (k === 'serial') return fail('NUMBER_FORMAT', 'is a date, not a number.');
      const r = parseDecimal(text, k === 'number');
      if (!r.ok) return fail('NUMBER_FORMAT', r.message + '.');
      if (def.min !== undefined && r.n < def.min) return fail('OUT_OF_RANGE', `must be at least ${def.min}.`);
      if (def.max !== undefined && r.n > def.max) return fail('OUT_OF_RANGE', `must be at most ${def.max}.`);
      return { ok: true, value: r.n };
    }
    case 'date': {
      if (k === 'serial') {
        const iso = parseExcelSerialDate(Number((cell as { excelSerial: number }).excelSerial), date1904);
        return iso ? { ok: true, value: iso } : fail('DATE_FORMAT', 'is not a real calendar date.');
      }
      if (k === 'number') return fail('DATE_FORMAT', 'is a number, not a date. Format the cell as a date or write it as text.');
      const iso = parseFileDateText(text);
      return iso ? { ok: true, value: iso } : fail('DATE_FORMAT', 'is not an accepted date. Write the year first, then month, then day with dashes, or the day first (for example 01/02/2026). Two-digit years and month-first dates are refused.');
    }
  }
}

// --------------------------------------------------------------------------------------------- validation ---

function headerIndexMap(header: string[]): { index: Map<string, number>; duplicates: string[] } {
  const index = new Map<string, number>();
  const duplicates: string[] = [];
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (key === '') return;
    if (index.has(key)) duplicates.push(key);
    else index.set(key, i);
  });
  return { index, duplicates };
}

export function composeProvenanceText(r: { source_release: string; observation_period_start: string; observation_period_end: string | null; source_file: string; source_locator: string; retrieval_date: string }): string {
  const period = r.observation_period_end ? `${formatDayFirst(r.observation_period_start)}-${formatDayFirst(r.observation_period_end)}` : `from ${formatDayFirst(r.observation_period_start)}`;
  return `${r.source_release} | obs ${period} | ${r.source_file} ${r.source_locator} | retrieved ${formatDayFirst(r.retrieval_date)}`;
}

export function validateUploadTable(table: UploadTable, kind: UploadKind, ctx: ValidateContext): ValidatedUpload {
  const issues: UploadIssue[] = [];
  const add = (severity: 'error' | 'warning', code: string, rowNumber: number | null, column: string | null, message: string) =>
    issues.push({ severity, code, rowNumber, column, message });
  const schema = UPLOAD_SCHEMA[kind];
  const out: ValidatedUpload = {
    kind,
    templateVersion: TEMPLATE_VERSION[kind],
    datasetName: null,
    datasetVersion: null,
    rows: [],
    issues,
    errorCount: 0,
    warningCount: 0,
    rowsRead: table.rows.length,
    blankRowsSkipped: 0,
    disclosure: table.disclosure ?? null,
  };
  const finish = (): ValidatedUpload => {
    out.errorCount = issues.filter((i) => i.severity === 'error').length;
    out.warningCount = issues.length - out.errorCount;
    return out;
  };

  for (const p of table.sourceProblems) add('error', p.code, p.rowNumber ?? null, null, p.message);

  // ---- header (row 1) ----
  const { index, duplicates } = headerIndexMap(table.header);
  if (table.header.length === 0) {
    add('error', 'HEADER_MISSING', 1, null, 'Row 1 (the header row) is empty or missing.');
    return finish();
  }
  for (const d of duplicates) add('error', 'DUPLICATE_COLUMN', table.headerRow, d, `The column "${d}" appears more than once in the header row.`);
  const known = new Set(schema.columns.map((c) => c.name));
  for (const h of table.header) {
    const key = h.trim().toLowerCase();
    if (key !== '' && !known.has(key)) add('error', 'UNKNOWN_COLUMN', table.headerRow, key, `The column "${key.slice(0, 60)}" is not part of this template. Columns cannot be added or renamed.`);
  }
  for (const c of schema.columns) {
    if (!index.has(c.name) && c.required) add('error', 'MISSING_COLUMN', table.headerRow, c.name, `The required column "${c.name}" is missing from the header row.`);
  }
  if (issues.some((i) => i.severity === 'error' && ['HEADER_MISSING', 'MISSING_COLUMN', 'UNKNOWN_COLUMN', 'DUPLICATE_COLUMN'].includes(i.code))) return finish();

  // ---- hidden rows / other sheets disclosure ----
  const d = table.disclosure;
  if (d?.hiddenRowsSkipped && d.hiddenRowsSkipped.length > 0) add('warning', 'HIDDEN_ROWS_SKIPPED', null, null, `${d.hiddenRowsSkipped.length} hidden row(s) were not processed (rows ${d.hiddenRowsSkipped.slice(0, 20).join(', ')}).`);
  if (d?.hiddenRowsIncluded && d.hiddenRowsIncluded.length > 0) add('warning', 'HIDDEN_ROWS_INCLUDED', null, null, `${d.hiddenRowsIncluded.length} hidden row(s) were included because you asked for them.`);
  if (d?.otherSheetsNotProcessed && d.otherSheetsNotProcessed.length > 0) add('warning', 'OTHER_SHEETS_NOT_PROCESSED', null, null, `These sheets were not processed: ${d.otherSheetsNotProcessed.join(', ')}.`);

  if (table.rows.length > UPLOAD_LIMITS.maxRows) {
    add('error', 'TOO_MANY_ROWS', null, null, `The file has more than ${formatCount(UPLOAD_LIMITS.maxRows)} data rows.`);
    return finish();
  }

  const date1904 = table.date1904 === true;
  const cellAt = (row: TableRow, name: string): TableCell | undefined => {
    const i = index.get(name);
    return i === undefined ? undefined : row.cells[i];
  };

  // ---- rows ----
  const allowedIndex = ctx.allowed ? buildAllowedIndex(ctx.allowed) : null;
  const reportedOnce = new Set<string>();
  for (const row of table.rows) {
    if (row.cells.every((c) => cellKind(c) === 'empty')) {
      out.blankRowsSkipped++;
      continue;
    }
    // A row can be longer than the header only with stray cells; disclose, never ignore silently.
    if (row.cells.length > table.header.length && row.cells.slice(table.header.length).some((c) => cellKind(c) !== 'empty')) {
      add('error', 'EXTRA_CELLS', row.rowNumber, null, 'This row has values to the right of the last header column.');
      continue;
    }
    const rec: Record<string, string | number | boolean | null> = {};
    let rowOk = true;
    for (const def of schema.columns) {
      const p = parseCell(def, cellAt(row, def.name), date1904);
      if (!p.ok) {
        add('error', p.code, row.rowNumber, def.name, `${def.name} ${p.message}`);
        rowOk = false;
        continue;
      }
      rec[def.name] = p.value;
    }
    if (!rowOk) continue;

    if (rec.template_version !== TEMPLATE_VERSION[kind]) {
      add('error', 'TEMPLATE_VERSION_MISMATCH', row.rowNumber, 'template_version', `template_version is "${String(rec.template_version).slice(0, 40)}" but this upload kind needs "${TEMPLATE_VERSION[kind]}". Download the current template for this kind.`);
      continue;
    }
    // A problem several rows share (an unlisted dataset, an unknown metric) is reported once, on the first row
    // that has it; every such row is still refused, so nothing is staged.
    let rowFailed = false;
    const rowAdd: Add = (severity, code, rowNumber, column, message, onceKey) => {
      if (severity === 'error') rowFailed = true;
      if (onceKey !== undefined) {
        if (reportedOnce.has(onceKey)) return;
        reportedOnce.add(onceKey);
      }
      add(severity, code, rowNumber, column, message);
    };
    semanticChecks(kind, rec, row.rowNumber, ctx, rowAdd, allowedIndex);
    if (rowFailed) continue;

    out.rows.push({ row_no: row.rowNumber, ...rec });
  }

  // ---- one dataset per file ----
  const pairs = new Set(out.rows.map((r) => `${r.dataset_name}\u0000${r.dataset_version}`));
  if (pairs.size > 1) {
    add('error', 'MIXED_DATASET', null, 'dataset_name', 'One file must target exactly one dataset and version. This file names more than one.');
  } else if (out.rows.length > 0) {
    out.datasetName = String(out.rows[0].dataset_name);
    out.datasetVersion = String(out.rows[0].dataset_version);
  }

  // ---- duplicate keys inside the file ----
  const keyOf = (r: StageRow): string => {
    if (kind === 'values') return [r.cohort_code ?? '', r.metric_code, r.statistic_type].join('|');
    if (kind === 'target_ranges') return [r.metric_code, r.country_code ?? '', r.life_stage ?? '', r.household_type ?? '', r.band_tier].join('|');
    return String(r.cohort_code);
  };
  const seen = new Map<string, number>();
  for (const r of out.rows) {
    const k = keyOf(r);
    const first = seen.get(k);
    if (first !== undefined) add('error', 'DUPLICATE_KEY', Number(r.row_no), null, `This row repeats the key of row ${first}. Each ${kind === 'values' ? 'metric, cohort and statistic' : kind === 'target_ranges' ? 'metric, country, life stage, household type and band tier' : 'cohort code'} may appear once per file.`);
    else seen.set(k, Number(r.row_no));
  }

  if (table.rows.length - out.blankRowsSkipped === 0 && !issues.some((i) => i.severity === 'error')) add('error', 'NO_DATA_ROWS', null, null, 'The file has a header row but no data rows.');

  return finish();
}

type Add = (severity: 'error' | 'warning', code: string, rowNumber: number | null, column: string | null, message: string, onceKey?: string) => void;

/**
 * Wrong-parameter protection against the LIVE lists (the same lists the Read me sheet prints): the dataset must
 * be open for upload, the metric and cohort must be listed, and a target-range file must cite the dataset's own
 * source. Every message names what is allowed and may add a "did you mean" hint, which never changes the file.
 */
function allowedValueChecks(kind: UploadKind, r: Record<string, string | number | boolean | null>, rowNumber: number, av: AllowedValuesOk, ix: AllowedIndex, add: Add): void {
  const name = String(r.dataset_name);
  const version = String(r.dataset_version);
  const dataset = findDataset(ix, name, version);
  const openDatasets = av.datasets.filter((d) => d.open);
  const openLabels = openDatasets.map((d) => `${d.name} (version ${d.version})`);
  if (!dataset) {
    if (av.complete.datasets) {
      const sameName = ix.datasetsByName.get(name);
      const message = sameName
        ? `The dataset "${name.slice(0, 200)}" exists, but not as version "${version.slice(0, 40)}". Its version(s): ${sameName.map((d) => d.version).join(', ')}. An upload never creates a dataset.`
        : `The dataset "${name.slice(0, 200)}" version "${version.slice(0, 40)}" is not a registered dataset, so nothing can be uploaded to it. Datasets open for upload (${openDatasets.length}): ${listForMessage(openLabels)}.${didYouMean(name, av.datasets.map((d) => d.name))} An upload never creates a dataset.`;
      add('error', 'DATASET_NOT_FOUND', rowNumber, 'dataset_name', message, `dataset|${name}|${version}`);
    }
  } else if (!dataset.open) {
    add(
      'error',
      'DATASET_NOT_OPEN',
      rowNumber,
      'dataset_name',
      `The dataset "${dataset.name}" version ${dataset.version} is ${dataset.status}, so it cannot receive an upload. Datasets open for upload (${openDatasets.length}): ${listForMessage(openLabels)}.${didYouMean(dataset.name, openDatasets.map((d) => d.name))}`,
      `dataset|${name}|${version}`
    );
  }

  if (kind !== 'cohorts') {
    const code = String(r.metric_code);
    const metric = ix.metricsByCode.get(code);
    if (!metric) {
      if (av.complete.metrics) {
        add(
          'error',
          'UNKNOWN_METRIC',
          rowNumber,
          'metric_code',
          `The metric "${code.slice(0, 80)}" is not registered. An upload cannot create metrics. ${av.metrics.length} metrics are registered${didYouMean(code, av.metrics.map((m) => m.code)) || `: ${listForMessage(av.metrics.map((m) => m.code))}`}.`,
          `metric|${code}`
        );
      }
    } else if (!metric.active) {
      add('warning', 'METRIC_INACTIVE', rowNumber, 'metric_code', `The metric ${code} is marked inactive (retired). Check that it is the right metric before you activate.`, `metric-inactive|${code}`);
    }
    if (metric && dataset && dataset.open) datasetMetricCheck(kind, code, dataset, av, add, rowNumber);
  }

  if (kind === 'values' && typeof r.cohort_code === 'string' && r.cohort_code !== '' && av.complete.cohorts && !ix.cohortCodes.has(r.cohort_code)) {
    add(
      'error',
      'COHORT_NOT_FOUND',
      rowNumber,
      'cohort_code',
      `The cohort "${r.cohort_code.slice(0, 64)}" is not a registered cohort. Leave cohort_code blank for a country-wide figure.${didYouMean(r.cohort_code, av.cohorts.map((c) => c.code)) || ` Registered cohorts (${av.cohorts.length}): ${listForMessage(av.cohorts.map((c) => c.code))}.`} A cohort that is not registered must first be loaded and activated as a Cohorts file.`,
      `cohort|${r.cohort_code}`
    );
  }

  if (kind === 'target_ranges' && dataset && dataset.sourceName !== null && r.source_name !== dataset.sourceName) {
    add(
      'error',
      'SOURCE_MISMATCH',
      rowNumber,
      'source_name',
      `source_name is "${String(r.source_name).slice(0, 100)}" but the source of the dataset "${dataset.name}" is "${dataset.sourceName}". Bands must cite the one source of their dataset.`,
      `source|${name}|${version}|${String(r.source_name)}`
    );
  }
  if (kind === 'target_ranges' && av.complete.bands) {
    if (typeof r.household_type === 'string' && r.household_type !== '' && av.bandHouseholdTypes.length > 0 && !av.bandHouseholdTypes.includes(r.household_type)) {
      add(
        'warning',
        'HOUSEHOLD_TYPE_NEW',
        rowNumber,
        'household_type',
        `No live band uses household_type "${r.household_type.slice(0, 60)}". Household types in live bands: ${listForMessage(av.bandHouseholdTypes)}.${didYouMean(r.household_type, av.bandHouseholdTypes)} A new word is accepted, so check the spelling.`,
        `household|${r.household_type}`
      );
    }
    if (typeof r.life_stage === 'string' && r.life_stage !== '' && av.bandLifeStages.length > 0 && !av.bandLifeStages.includes(r.life_stage)) {
      add(
        'warning',
        'LIFE_STAGE_NEW',
        rowNumber,
        'life_stage',
        `No live band uses life_stage "${r.life_stage.slice(0, 60)}". Life stages in live bands: ${listForMessage(av.bandLifeStages)}.${didYouMean(r.life_stage, av.bandLifeStages)} A new word is accepted, so check the spelling.`,
        `life|${r.life_stage}`
      );
    }
  }
}

/**
 * Dataset to metric mapping (migration 0277). A registered metric may only go into a dataset it is mapped to, for
 * the kind of file it applies to. The message names the metrics that ARE allowed for that dataset and kind, says
 * where the metric IS mapped when it is somewhere else, and may add a "did you mean" hint over the allowed ones. It
 * never changes the file. When the mapping is not installed on this database the check cannot run: one visible
 * warning per file says so (the fallback is the previous behaviour, not a silent pass).
 */
function datasetMetricCheck(kind: 'values' | 'target_ranges', code: string, dataset: AllowedDataset, av: AllowedValuesOk, add: Add, rowNumber: number): void {
  if (!av.mapping.installed) {
    add('warning', 'MAPPING_NOT_INSTALLED', null, null, `${MAPPING_NOT_INSTALLED_LINE} Check by hand that every metric in this file belongs to the dataset "${dataset.name}".`, 'mapping-not-installed');
    return;
  }
  if (!av.complete.mappings) return;
  const allowed = mappedFor(dataset, kind);
  if (allowed.some((m) => m.code === code)) return;
  const other: 'values' | 'target_ranges' = kind === 'values' ? 'target_ranges' : 'values';
  const otherKindHas = mappedFor(dataset, other).some((m) => m.code === code);
  const elsewhere = av.datasets.filter((d) => d !== dataset && mappedFor(d, kind).some((m) => m.code === code)).map((d) => `${d.name} (version ${d.version})`);
  const where = elsewhere.length > 0 ? ` ${code} is mapped to: ${listForMessage(elsewhere, 4)}. Check that you chose the right dataset.` : ` ${code} is not mapped to any dataset for ${kindWords(kind)} files yet.`;
  const onceKey = `map|${dataset.name}|${dataset.version}|${kind}|${code}`;
  if (allowed.length === 0) {
    add(
      'error',
      'METRIC_NOT_MAPPED',
      rowNumber,
      'metric_code',
      `No metric is mapped to the dataset "${dataset.name}" version ${dataset.version} for ${kindWords(kind)} files yet, so the metric "${code}" cannot be uploaded to it in this kind of file.${otherKindHas ? ` ${code} is mapped to it for ${kindWords(other)} files: use that kind of file.` : where} A holder of the activate permission can map metrics on the Upload tab (Dataset metric mapping). Nothing was changed in your file.`,
      onceKey
    );
    return;
  }
  const labels = allowed.map((m) => `${m.code} (${m.unit})`);
  add(
    'error',
    'METRIC_NOT_MAPPED',
    rowNumber,
    'metric_code',
    `The metric "${code}" is registered but is not mapped to the dataset "${dataset.name}" version ${dataset.version} for ${kindWords(kind)} files, so this row was refused. Metrics allowed for that dataset in ${kindWords(kind)} files (${allowed.length}): ${listForMessage(labels)}.${didYouMean(code, allowed.map((m) => m.code))}${otherKindHas ? ` ${code} is mapped to it for ${kindWords(other)} files only: use that kind of file.` : where} Nothing was changed in your file.`,
    onceKey
  );
}

function semanticChecks(kind: UploadKind, r: Record<string, string | number | boolean | null>, rowNumber: number, ctx: ValidateContext, add: Add, ix: AllowedIndex | null): void {
  if (ix && ctx.allowed) allowedValueChecks(kind, r, rowNumber, ctx.allowed, ix, add);
  const dateNotFuture = (col: string) => {
    const v = r[col];
    if (typeof v === 'string' && v > ctx.todayIso) add('error', 'DATE_IN_FUTURE', rowNumber, col, `${col} is ${formatDayFirst(v)}, which is in the future.`);
  };
  const periodOrder = () => {
    if (typeof r.observation_period_start === 'string' && typeof r.observation_period_end === 'string' && r.observation_period_start > r.observation_period_end) {
      add('error', 'PERIOD_ORDER', rowNumber, 'observation_period_end', 'The observation period ends before it starts.');
    }
  };

  if (kind === 'values') {
    const code = String(r.metric_code);
    const unit = ctx.metricUnits.get(code) ?? ix?.metricsByCode.get(code)?.unit;
    if (unit === undefined) {
      // With a complete allowed list the check above already refused it, naming the registered metrics.
      if (!ix || !ctx.allowed?.complete.metrics) add('error', 'UNKNOWN_METRIC', rowNumber, 'metric_code', `The metric "${code.slice(0, 80)}" is not registered. An upload cannot create metrics.`);
    } else if (unit !== r.unit) {
      add('error', 'UNIT_MISMATCH', rowNumber, 'unit', `The unit is "${String(r.unit)}" but the metric ${code} is defined in "${unit}". Upload this metric in "${unit}" (the unit is never converted for you).`);
    }
    if (r.unit === 'currency' && !r.original_currency) add('error', 'CURRENCY_REQUIRED', rowNumber, 'original_currency', 'A currency amount needs original_currency.');
    if (r.unit !== 'currency' && r.original_currency) add('error', 'CURRENCY_NOT_ALLOWED', rowNumber, 'original_currency', 'original_currency must be blank unless the unit is currency.');
    if (r.is_derived === true && !r.derivation_method) add('error', 'DERIVATION_REQUIRED', rowNumber, 'derivation_method', 'A derived figure needs derivation_method.');
    if (r.is_derived === false && r.derivation_method) add('warning', 'DERIVATION_IGNORED', rowNumber, 'derivation_method', 'derivation_method is filled in but is_derived is false.');
    dateNotFuture('base_date');
    dateNotFuture('effective_from');
    dateNotFuture('retrieval_date');
    periodOrder();
    if (r.unit === 'percentage' && typeof r.value_numeric === 'number' && r.value_numeric !== 0 && Math.abs(r.value_numeric) <= 1) {
      add('warning', 'LOOKS_LIKE_FRACTION', rowNumber, 'value_numeric', `The value ${r.value_numeric} is for a percentage metric but looks like a fraction. Percentages are stored as percentage points (56.2, not 0.562).`);
    }
    if (typeof r.observation_period_start === 'string' && typeof r.source_release === 'string' && typeof r.source_file === 'string' && typeof r.source_locator === 'string' && typeof r.retrieval_date === 'string') {
      r.value_text = composeProvenanceText({
        source_release: r.source_release,
        observation_period_start: r.observation_period_start,
        observation_period_end: typeof r.observation_period_end === 'string' ? r.observation_period_end : null,
        source_file: r.source_file,
        source_locator: r.source_locator,
        retrieval_date: r.retrieval_date,
      });
    }
  } else if (kind === 'target_ranges') {
    const code = String(r.metric_code);
    if (!ctx.metricUnits.has(code) && !ix?.metricsByCode.has(code) && (!ix || !ctx.allowed?.complete.metrics)) {
      add('error', 'UNKNOWN_METRIC', rowNumber, 'metric_code', `The metric "${code.slice(0, 80)}" is not registered. An upload cannot create metrics.`);
    }
    if (r.lower_bound === null && r.upper_bound === null) add('error', 'BOUND_REQUIRED', rowNumber, 'lower_bound', 'A band needs a lower bound, an upper bound, or both.');
    if (typeof r.lower_bound === 'number' && typeof r.upper_bound === 'number' && r.lower_bound > r.upper_bound) add('error', 'BOUND_ORDER', rowNumber, 'upper_bound', 'The lower bound is above the upper bound.');
    dateNotFuture('effective_from');
    dateNotFuture('retrieval_date');
    periodOrder();
  } else {
    if (r.cross_border_flag === null) r.cross_border_flag = false;
  }
}

// ----------------------------------------------------------------------------------- formula-safe output ---

/**
 * Every text cell this feature GENERATES (templates, example rows) passes through here before it is quoted:
 * spreadsheet-formula-injection protection (values starting with = + - @ or a tab or carriage return are
 * neutralised), the same function the Market Index error CSV uses.
 */
export function safeCell(s: string): string {
  return neutraliseCsvCell(s);
}
