// Validation of an uploaded benchmark level history. PURE: the table, the
// operator's explicit parameters and a context snapshot (catalogue, existing
// published levels, entitlement scope, injected "today") go in; a
// ValidationResult comes out. Nothing is ever dropped, synthesised or
// interpolated: rows that fail a rule are reported with their source row
// number and are NOT staged, and the caller must block publication while any
// hard error remains.
//
// INPUT TABLE. Both readers convert to the same `UploadTable` with a small
// adapter: `csvToTable` (from parseCsvText output) and `xlsxToTable` (from
// readWorksheet output). Cell positions are the header positions.
import { formatDateShort } from '@/lib/engines/date';
import { parseMarketDate } from './dateParsing';
import { parseLevel } from './numberParsing';
import { resolveLayout, type ResolvedMapping } from './layouts';
import { resolveLimits, type Problem, type UploadParams, type ValidationContext } from './types';
import type { CsvParseResult } from './csvReader';
import type { WorksheetResult } from './xlsxReader';

export const VALIDATOR_VERSION = 'bench1-file-validator-v1';

export const MIN_MARKET_DATE = '1900-01-01';
export const LARGE_MOVE_FRACTION = 0.1;
export const SCALE_RATIO_HIGH = 5;
export const SCALE_RATIO_LOW = 0.2;
export const GAP_WEEKDAY_THRESHOLD = 3;
export const LEVEL_TOLERANCE = 1e-6;
const MAX_EXCERPT = 120;
const MAX_INDIVIDUAL_WARNINGS_PER_BENCHMARK = 100;
const DAY_MS = 86_400_000;

// -------------------------------------------------------------- types ---

export type TableCell =
  | string // CSV field or XLSX string cell, exactly as in the file
  | null // empty
  | { excelSerial: number } // XLSX cell formatted as a date
  | { numberValue: number; raw: string } // XLSX numeric cell
  | { formulaRef: string; text: string } // XLSX cell that holds a formula (never evaluated)
  | { errorValue: string }; // XLSX error cell (#N/A, #REF!, ...)

export interface TableRow {
  /** The row number the operator sees in the file / spreadsheet (header row inclusive). */
  rowNumber: number;
  cells: TableCell[];
  hidden?: boolean;
}

export interface UploadTable {
  header: string[];
  headerRow: number;
  rows: TableRow[];
  sourceKind: 'csv' | 'xlsx';
  /** XLSX workbook date system, when known. */
  date1904?: boolean;
  /** Reader problems; every one becomes a hard validation error. */
  sourceProblems: Problem[];
  disclosure?: {
    sheetProcessed?: string;
    sheetsAvailable?: string[];
    hiddenRowsSkipped?: number[];
    hiddenRowsIncluded?: number[];
    otherSheetsNotProcessed?: string[];
  };
}

export type StagedRowFlag = 'weekend' | 'large_move' | 'scale_change';

export interface StagedRow {
  rowNumber: number;
  benchmarkKey: string;
  date: string;
  value: number;
  valueText: string;
  existing: number | null;
  classification: 'new' | 'identical' | 'correction';
  flags: StagedRowFlag[];
}

export interface ValidationIssue {
  rowNumber: number | null;
  column?: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
  rawExcerpt?: string;
}

export type Acknowledgement = 'scale_change' | 'large_moves' | 'weekend_rows' | 'coverage_gaps' | 'hidden_rows_included';

export interface BenchmarkSummary {
  benchmarkKey: string;
  earliestDate: string | null;
  latestDate: string | null;
  newRows: number;
  identicalRows: number;
  correctionRows: number;
  gaps: Array<{ from: string; to: string; weekdaysMissing: number }>;
}

export interface ValidationResult {
  validatorVersion: string;
  /** Non-blank data rows read. */
  rowsTotal: number;
  /** Rows with no error (includes identical duplicates that were collapsed). */
  rowsValid: number;
  /** Rows with at least one error. When a file-level hard error stops row checks, every row counts as invalid. */
  rowsInvalid: number;
  /** Rows deliberately left out because their index name is not in `indexNameToKey` (disclosed, never silent). */
  rowsExcluded: number;
  duplicatesCollapsed: number;
  staged: StagedRow[];
  issues: ValidationIssue[];
  hardErrorCount: number;
  perBenchmark: BenchmarkSummary[];
  requiredAcknowledgements: Acknowledgement[];
  disclosure: {
    sheetProcessed?: string;
    sheetsAvailable?: string[];
    hiddenRowsSkipped?: number[];
    hiddenRowsIncluded?: number[];
    otherSheetsNotProcessed?: string[];
    headerRow: number;
    layoutId: string;
    columnMapping: Record<string, string>;
    /** Human name of the layout the header was read as (absent in previews stored before this field existed). */
    layoutLabel?: string;
    /** true = the layout's header set was never compared with a real download. */
    layoutUnverified?: boolean;
    /** How the layout was decided (absent in older stored previews). */
    layoutMatchedBy?: 'header' | 'chosen' | 'fixed' | 'column_map';
    /** Header columns that were NOT loaded (exact header text). Absent in older stored previews. */
    ignoredColumns?: string[];
  };
}

// ----------------------------------------------------------- adapters ---

/**
 * CSV adapter. Accepts the full `parseCsvText` result (preferred: row numbers
 * are then the true line numbers and reader problems are carried) or a bare
 * `string[][]` (row numbers are then 1-based record positions).
 */
export function csvToTable(input: CsvParseResult | string[][], headerRow = 1): UploadTable {
  const rows = Array.isArray(input) ? input : input.rows;
  const lines = Array.isArray(input) ? rows.map((_, i) => i + 1) : input.lineNumbers;
  const sourceProblems: Problem[] = Array.isArray(input) ? [] : [...input.problems];
  const hIdx = lines.findIndex((l) => l >= headerRow);
  if (hIdx < 0) {
    sourceProblems.push({ code: 'HEADER_ROW_MISSING', message: `Row ${headerRow} (the header row) was not found.` });
    return { header: [], headerRow, rows: [], sourceKind: 'csv', sourceProblems };
  }
  const header = rows[hIdx].map((h) => h.replace(/﻿/g, '').trim());
  const out: TableRow[] = [];
  for (let i = hIdx + 1; i < rows.length; i++) out.push({ rowNumber: lines[i], cells: rows[i] });
  return { header, headerRow: lines[hIdx], rows: out, sourceKind: 'csv', sourceProblems };
}

function columnIndexFromLetters(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * XLSX adapter. Formula cells (any cell with an <f> element, even with a cached
 * value) become `{ formulaRef }` cells; the validator turns those in REQUIRED
 * columns into hard FORMULA_CELL_REJECTED errors. Hidden-row / sheet
 * disclosure and the workbook date system are carried through.
 */
export function xlsxToTable(ws: WorksheetResult): UploadTable {
  const formula = new Map<string, string>();
  for (const f of ws.formulaCells) formula.set(`${f.rowNumber}:${columnIndexFromLetters(f.column)}`, f.ref);
  const rows: TableRow[] = ws.rows.map((r) => ({
    rowNumber: r.rowNumber,
    hidden: r.hidden,
    cells: r.cells.map((c, idx): TableCell => {
      const ref = formula.get(`${r.rowNumber}:${idx}`);
      if (ref !== undefined) return { formulaRef: ref, text: c.raw };
      switch (c.kind) {
        case 'empty':
          return null;
        case 'string':
          return c.raw;
        case 'boolean':
          return c.raw;
        case 'error':
          return { errorValue: c.raw };
        case 'date':
          return { excelSerial: c.numberValue as number };
        case 'number':
          return { numberValue: c.numberValue as number, raw: c.raw };
      }
    }),
  }));
  return {
    header: ws.header,
    headerRow: ws.headerRow,
    rows,
    sourceKind: 'xlsx',
    date1904: ws.date1904,
    sourceProblems: [...ws.problems],
    disclosure: {
      sheetProcessed: ws.disclosure.sheetProcessed,
      sheetsAvailable: ws.disclosure.sheetsAvailable,
      hiddenRowsSkipped: ws.disclosure.hiddenRowsSkipped,
      hiddenRowsIncluded: ws.disclosure.hiddenRowsIncluded,
      otherSheetsNotProcessed: ws.disclosure.otherSheetsNotProcessed,
    },
  };
}

// ------------------------------------------------------------ helpers ---

function cellText(c: TableCell | undefined): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if ('excelSerial' in c) return String(c.excelSerial);
  if ('numberValue' in c) return c.raw;
  if ('formulaRef' in c) return c.text;
  return c.errorValue;
}

function isFormulaCell(c: TableCell | undefined): c is { formulaRef: string; text: string } {
  return c !== null && c !== undefined && typeof c === 'object' && 'formulaRef' in c;
}

function isBlank(row: TableRow): boolean {
  return row.cells.every((c) => c === null || c === undefined || (typeof c === 'string' && c.trim() === ''));
}

function excerpt(s: string): string {
  return s.length > MAX_EXCERPT ? s.slice(0, MAX_EXCERPT - 1) + '…' : s;
}

function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

function isoFromDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function isWeekendDay(n: number): boolean {
  const dow = new Date(n * DAY_MS).getUTCDay();
  return dow === 0 || dow === 6;
}

function sameLevel(a: number, b: number): boolean {
  return Math.abs(a - b) <= LEVEL_TOLERANCE;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date inside a message the operator reads: day-first (dd-mm-yyyy, the India
 * format for this module), never ISO year-first (PO rule, Document2 findings
 * #8/#19). Internal values and the API stay ISO; only the sentence changes.
 */
function fd(iso: string): string {
  return ISO_RE.test(iso) ? formatDateShort(iso, 'INR') : iso;
}

interface Candidate {
  rowNumber: number;
  key: string;
  date: string;
  value: number;
  valueText: string;
}

// ---------------------------------------------------------- the validator ---

export function validateUpload(table: UploadTable, params: UploadParams, ctx: ValidationContext): ValidationResult {
  const limits = resolveLimits(ctx.limits);
  const issues: ValidationIssue[] = [];
  const rowInvalid = new Set<number>();

  const push = (
    severity: 'error' | 'warning',
    rowNumber: number | null,
    code: string,
    message: string,
    extra: { column?: string; raw?: string } = {},
  ) => {
    const issue: ValidationIssue = { rowNumber, code, severity, message };
    if (extra.column !== undefined) issue.column = extra.column;
    if (extra.raw !== undefined) issue.rawExcerpt = excerpt(extra.raw);
    issues.push(issue);
    if (severity === 'error' && rowNumber !== null) rowInvalid.add(rowNumber);
  };

  const dataRows = table.rows.filter((r) => !isBlank(r));
  const disclosureBase = {
    sheetProcessed: table.disclosure?.sheetProcessed,
    sheetsAvailable: table.disclosure?.sheetsAvailable,
    hiddenRowsSkipped: table.disclosure?.hiddenRowsSkipped,
    hiddenRowsIncluded: table.disclosure?.hiddenRowsIncluded,
    otherSheetsNotProcessed: table.disclosure?.otherSheetsNotProcessed,
    headerRow: table.headerRow,
  };

  /** Result for a file-level hard stop: no row is evaluated, none is valid. */
  let layoutExtras: Pick<ValidationResult['disclosure'], 'layoutLabel' | 'layoutUnverified' | 'layoutMatchedBy' | 'ignoredColumns'> = {};
  const stop = (layoutId: string, columnMapping: Record<string, string>): ValidationResult => ({
    validatorVersion: VALIDATOR_VERSION,
    rowsTotal: dataRows.length,
    rowsValid: 0,
    rowsInvalid: dataRows.length,
    rowsExcluded: 0,
    duplicatesCollapsed: 0,
    staged: [],
    issues,
    hardErrorCount: issues.filter((i) => i.severity === 'error').length,
    perBenchmark: [],
    requiredAcknowledgements: [],
    disclosure: { ...disclosureBase, layoutId, columnMapping, ...layoutExtras },
  });

  for (const p of table.sourceProblems) push('error', p.rowNumber ?? null, p.code, p.message);
  // Reader problems are hard errors but still allow a row-level preview; only
  // file-level problems found below (layout, parameters, limits) stop row checks.
  const readerIssueCount = issues.length;

  if (!ISO_RE.test(ctx.todayIso)) {
    push('error', null, 'CONTEXT_INVALID', 'The validation context has no valid "today" date.');
    return stop('unresolved', {});
  }
  if (!/^[A-Z]{3}$/.test(params.currencyCode)) {
    push('error', null, 'CURRENCY_INVALID', 'The currency must be a three-letter upper-case ISO code, for example INR.');
  }
  if (params.mode !== 'new_history' && params.mode !== 'correction') {
    push('error', null, 'MODE_INVALID', 'The upload mode must be new history or correction.');
  }
  if (params.returnVariant !== 'price' && params.returnVariant !== 'total_return' && params.returnVariant !== 'net_total_return') {
    push('error', null, 'VARIANT_INVALID', 'The return variant must be price, total return or net total return.');
  }

  const resolution = resolveLayout(table.header, params);
  if (!resolution.ok) {
    push('error', null, resolution.code, resolution.message);
    return stop('unresolved', {});
  }
  const mapping: ResolvedMapping = resolution.mapping;
  const layoutId = resolution.layout.id;
  const columnMapping: Record<string, string> = { date: mapping.dateColumn, value: mapping.valueColumn };
  if (mapping.keyColumn) columnMapping.benchmark_key = mapping.keyColumn;
  if (mapping.indexNameColumn) columnMapping.index_name = mapping.indexNameColumn;
  if (resolution.layout.matchedBy === 'header' || resolution.layout.matchedBy === 'chosen') layoutExtras = { layoutLabel: resolution.layout.label, layoutUnverified: resolution.layout.unverified, layoutMatchedBy: resolution.layout.matchedBy, ignoredColumns: resolution.ignoredColumns };

  if (table.sourceKind === 'xlsx' && table.date1904 !== undefined) {
    if (params.dateFormat === 'excel_1900' && table.date1904) {
      push('error', null, 'DATE_SYSTEM_MISMATCH', 'The workbook uses the 1904 date system but the 1900 Excel date system was selected; the dates would be four years and a day off.');
    } else if (params.dateFormat === 'excel_1904' && !table.date1904) {
      push('error', null, 'DATE_SYSTEM_MISMATCH', 'The workbook uses the 1900 date system but the 1904 Excel date system was selected; the dates would be off by four years and a day.');
    }
  }

  const colIndex = (name: string | undefined): number => (name === undefined ? -1 : table.header.findIndex((h) => h === name));
  const dateIdx = colIndex(mapping.dateColumn);
  const valueIdx = colIndex(mapping.valueColumn);
  const keyIdx = colIndex(mapping.keyColumn);
  const nameIdx = colIndex(mapping.indexNameColumn);
  const requiredIdx = new Set([dateIdx, valueIdx, keyIdx, nameIdx].filter((i) => i >= 0));

  // Where does each row's benchmark key come from?
  const mapGiven = params.indexNameToKey !== undefined && Object.keys(params.indexNameToKey).length > 0;
  let fixedKey: string | null = null;
  if (keyIdx < 0) {
    if (nameIdx >= 0) {
      if (mapGiven && params.benchmarkKey) {
        push('error', null, 'BENCHMARK_AND_INDEX_MAP_BOTH', 'Supply either a single benchmark or an index-name mapping, not both.');
      } else if (!mapGiven && !params.benchmarkKey) {
        push('error', null, 'BENCHMARK_REQUIRED', 'This file carries an index-name column: choose the benchmark, or map each index name to a benchmark key.');
      } else if (!mapGiven) fixedKey = params.benchmarkKey as string;
    } else if (!params.benchmarkKey) {
      push('error', null, 'BENCHMARK_REQUIRED', 'Choose the benchmark this file belongs to.');
    } else fixedKey = params.benchmarkKey;
  }

  if (dataRows.length === 0) push('error', null, 'NO_DATA_ROWS', 'The file has no data rows below the header.');
  if (dataRows.length > limits.maxRows) {
    push('error', null, 'TOO_MANY_ROWS', `The file has ${dataRows.length} data rows; the limit is ${limits.maxRows}.`);
    return stop(layoutId, columnMapping);
  }
  // File-level hard errors found so far stop row processing.
  if (issues.slice(readerIssueCount).some((i) => i.severity === 'error')) return stop(layoutId, columnMapping);

  // Distinct index names without a map must be exactly one.
  if (nameIdx >= 0 && !mapGiven) {
    const names = new Set<string>();
    for (const r of dataRows) names.add(cellText(r.cells[nameIdx]).trim());
    if (names.size > 1) {
      push(
        'error',
        null,
        'INDEX_NAME_MULTIPLE_WITHOUT_MAP',
        `The file contains ${names.size} different index names (${[...names].slice(0, 5).join('; ')}) but only one benchmark was chosen. Map each index name to a benchmark key.`,
      );
      return stop(layoutId, columnMapping);
    }
  }

  // ---- per-row parsing ----
  const candidates: Candidate[] = [];
  const keyProblems = new Map<string, Array<{ code: string; message: string }>>();
  const keyIssueRows = new Map<string, { firstRow: number; count: number }>(); // key|code
  const keysSeen = new Set<string>();
  const excludedNames = new Map<string, number>();
  let rowsExcluded = 0;
  const formulaUnused = new Map<number, { first: string; count: number }>();

  const catalogueProblems = (key: string): Array<{ code: string; message: string }> => {
    const cached = keyProblems.get(key);
    if (cached) return cached;
    const out: Array<{ code: string; message: string }> = [];
    const entry = ctx.catalogue.get(key);
    if (!entry) out.push({ code: 'BENCHMARK_UNKNOWN', message: `"${key.slice(0, 60)}" is not a benchmark in the catalogue.` });
    else {
      if (!entry.isActive) out.push({ code: 'BENCHMARK_INACTIVE', message: `The benchmark "${key}" is not active in the catalogue.` });
      if (entry.returnVariant !== params.returnVariant) {
        out.push({
          code: 'VARIANT_MISMATCH',
          message: `The benchmark "${key}" is a ${entry.returnVariant} series in the catalogue but the upload is declared as ${params.returnVariant}.`,
        });
      }
      if (entry.currencyCode !== params.currencyCode) {
        out.push({
          code: 'CURRENCY_MISMATCH',
          message: `The benchmark "${key}" is in ${entry.currencyCode} in the catalogue but the upload is declared as ${params.currencyCode}.`,
        });
      }
    }
    keyProblems.set(key, out);
    return out;
  };

  for (const row of dataRows) {
    const n = row.rowNumber;
    let formulaBlocked = false;

    // Formula cells: rejected in required columns, only noted elsewhere.
    row.cells.forEach((c, idx) => {
      if (isFormulaCell(c)) {
        if (requiredIdx.has(idx)) {
          formulaBlocked = true;
          push('error', n, 'FORMULA_CELL_REJECTED', `Cell ${c.formulaRef} contains a formula. Formulas are not accepted in required columns: paste values instead.`, {
            column: table.header[idx],
            raw: c.text,
          });
        } else {
          const e = formulaUnused.get(idx);
          if (e) e.count++;
          else formulaUnused.set(idx, { first: c.formulaRef, count: 1 });
        }
      }
    });

    // ---- benchmark key ----
    let key: string | null = null;
    let excluded = false;
    if (keyIdx >= 0) {
      const raw = cellText(row.cells[keyIdx]).trim();
      if (!isFormulaCell(row.cells[keyIdx])) {
        if (raw === '') push('error', n, 'BENCHMARK_KEY_EMPTY', 'The benchmark_key is empty.', { column: table.header[keyIdx] });
        else key = raw;
      }
    } else if (nameIdx >= 0 && mapGiven) {
      const rawName = cellText(row.cells[nameIdx]).trim();
      if (!isFormulaCell(row.cells[nameIdx])) {
        const map = params.indexNameToKey as Record<string, string>;
        if (rawName === '') push('error', n, 'INDEX_NAME_EMPTY', 'The index name is empty.', { column: table.header[nameIdx] });
        else if (Object.prototype.hasOwnProperty.call(map, rawName)) key = map[rawName];
        else {
          excluded = true;
          rowsExcluded++;
          excludedNames.set(rawName, (excludedNames.get(rawName) ?? 0) + 1);
        }
      }
    } else key = fixedKey;
    if (excluded) continue;

    if (key !== null) {
      keysSeen.add(key);
      for (const p of catalogueProblems(key)) {
        rowInvalid.add(n);
        const k = `${key}|${p.code}`;
        const e = keyIssueRows.get(k);
        if (e) e.count++;
        else keyIssueRows.set(k, { firstRow: n, count: 1 });
      }
    }

    // ---- date ----
    let iso: string | null = null;
    {
      const c = row.cells[dateIdx] ?? null;
      if (!isFormulaCell(c)) {
        let res;
        if (c !== null && typeof c === 'object' && 'errorValue' in c) {
          res = { ok: false as const, code: 'DATE_CELL_ERROR', message: `The date cell holds a spreadsheet error (${c.errorValue}).` };
        } else if (c !== null && typeof c === 'object' && 'excelSerial' in c) {
          res = parseMarketDate({ excelSerial: c.excelSerial }, params.dateFormat, { date1904: table.date1904 });
        } else if (c !== null && typeof c === 'object' && 'numberValue' in c) {
          res =
            params.dateFormat === 'excel_1900' || params.dateFormat === 'excel_1904'
              ? parseMarketDate({ excelSerial: c.numberValue }, params.dateFormat, { date1904: table.date1904 })
              : parseMarketDate(c.raw, params.dateFormat, { date1904: table.date1904 });
        } else res = parseMarketDate(typeof c === 'string' ? c : '', params.dateFormat, { date1904: table.date1904 });
        if (!res.ok) push('error', n, res.code, res.message, { column: table.header[dateIdx], raw: cellText(c) });
        else {
          iso = res.iso;
          if (iso > ctx.todayIso) {
            push('error', n, 'DATE_FUTURE', `The date ${fd(iso)} is in the future (today is ${fd(ctx.todayIso)}).`, { column: table.header[dateIdx], raw: cellText(c) });
            iso = null;
          } else if (iso < MIN_MARKET_DATE) {
            push('error', n, 'DATE_OUTSIDE_ENTITLEMENT_SCOPE', `The date ${fd(iso)} is before ${fd(MIN_MARKET_DATE)}, the earliest date accepted.`, { column: table.header[dateIdx], raw: cellText(c) });
            iso = null;
          } else {
            const scope = ctx.entitlementDateScope;
            if (scope && ((scope.from && iso < scope.from) || (scope.to && iso > scope.to))) {
              push(
                'error',
                n,
                'DATE_OUTSIDE_ENTITLEMENT_SCOPE',
                `The date ${fd(iso)} is outside the entitlement's data-date scope (${scope.from ? fd(scope.from) : 'start'} to ${scope.to ? fd(scope.to) : 'open'}).`,
                { column: table.header[dateIdx], raw: cellText(c) },
              );
              iso = null;
            }
          }
        }
      }
    }

    // ---- value ----
    let value: number | null = null;
    let valueText = '';
    {
      const c = row.cells[valueIdx] ?? null;
      if (!isFormulaCell(c)) {
        let res: ReturnType<typeof parseLevel>;
        if (c !== null && typeof c === 'object' && 'errorValue' in c) {
          res = { ok: false, code: 'VALUE_CELL_ERROR', message: `The value cell holds a spreadsheet error (${c.errorValue}).` };
        } else if (c !== null && typeof c === 'object' && 'excelSerial' in c) {
          res = { ok: false, code: 'VALUE_CELL_IS_DATE', message: 'The value cell is formatted as a date; an index level was expected.' };
        } else if (c !== null && typeof c === 'object' && 'numberValue' in c) {
          res = parseLevel(c.numberValue, params.numberLocale);
        } else res = parseLevel(typeof c === 'string' ? c : '', params.numberLocale);
        if (!res.ok) push('error', n, res.code, res.message, { column: table.header[valueIdx], raw: cellText(c) });
        else if (res.value <= 0) {
          push('error', n, 'VALUE_NOT_POSITIVE', `The level ${res.text} is not positive; an index level must be greater than zero.`, {
            column: table.header[valueIdx],
            raw: cellText(c),
          });
        } else {
          value = res.value;
          valueText = res.text;
        }
      }
    }

    if (key !== null && iso !== null && value !== null && catalogueProblems(key).length === 0 && !formulaBlocked) {
      candidates.push({ rowNumber: n, key, date: iso, value, valueText });
    }
  }

  // Key-level (catalogue) issues, once per key and code.
  for (const [k, e] of keyIssueRows) {
    const [key, code] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
    const p = (keyProblems.get(key) ?? []).find((x) => x.code === code);
    if (!p) continue;
    const rowNo = keyIdx >= 0 || nameIdx >= 0 ? e.firstRow : null;
    const suffix = e.count > 1 ? ` (${e.count} rows affected; first is row ${e.firstRow})` : '';
    issues.push({ rowNumber: rowNo, column: keyIdx >= 0 ? table.header[keyIdx] : undefined, code, severity: 'error', message: p.message + suffix });
  }
  // Remove undefined `column` keys for tidy output.
  for (const i of issues) if (i.column === undefined) delete i.column;

  for (const [idx, e] of formulaUnused) {
    push(
      'warning',
      null,
      'FORMULA_CELL_IN_UNUSED_COLUMN',
      `${e.count} cell(s) in the unused column "${table.header[idx] ?? idx}" contain formulas (first: ${e.first}). They are ignored.`,
      { column: table.header[idx] },
    );
  }
  if (excludedNames.size > 0) {
    const list = [...excludedNames.entries()].slice(0, 10).map(([name, c]) => `${name} (${c})`);
    push(
      'warning',
      null,
      'INDEX_NAME_NOT_SELECTED',
      `${rowsExcluded} rows for ${excludedNames.size} index name(s) that are not in the mapping were left out: ${list.join('; ')}${excludedNames.size > 10 ? '; ...' : ''}.`,
    );
  }
  const skipped = table.disclosure?.hiddenRowsSkipped ?? [];
  if (skipped.length > 0) {
    push(
      'warning',
      null,
      'HIDDEN_ROWS_SKIPPED',
      `${skipped.length} hidden row(s) were NOT processed (rows ${skipped.slice(0, 20).join(', ')}${skipped.length > 20 ? ', ...' : ''}). Include them explicitly or unhide and re-upload.`,
    );
  }
  const included = table.disclosure?.hiddenRowsIncluded ?? [];
  if (params.includeHiddenRows && included.length > 0) {
    push(
      'warning',
      null,
      'HIDDEN_ROWS_INCLUDED',
      `${included.length} hidden row(s) were processed at the operator's request (rows ${included.slice(0, 20).join(', ')}${included.length > 20 ? ', ...' : ''}).`,
    );
  }

  // ---- duplicates within the file ----
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const g = groups.get(`${c.key}|${c.date}`);
    if (g) g.push(c);
    else groups.set(`${c.key}|${c.date}`, [c]);
  }
  const survivors: Candidate[] = [];
  let duplicatesCollapsed = 0;
  for (const g of groups.values()) {
    if (g.length === 1) {
      survivors.push(g[0]);
      continue;
    }
    if (g.every((x) => sameLevel(x.value, g[0].value))) {
      survivors.push(g[0]);
      for (const dup of g.slice(1)) {
        duplicatesCollapsed++;
        push('warning', dup.rowNumber, 'DUPLICATE_IDENTICAL_COLLAPSED', `Row ${dup.rowNumber} repeats ${dup.key} ${fd(dup.date)} with the same level as row ${g[0].rowNumber}; kept once.`);
      }
    } else {
      for (const x of g) {
        const others = g.filter((o) => o !== x).map((o) => o.rowNumber);
        push(
          'error',
          x.rowNumber,
          'DUPLICATE_CONFLICT',
          `${x.key} ${fd(x.date)} appears with different levels (rows ${[x.rowNumber, ...others].join(', ')}).`,
          { column: table.header[valueIdx], raw: x.valueText },
        );
      }
    }
  }

  // ---- classification against published levels ----
  const staged: StagedRow[] = [];
  for (const c of survivors) {
    const existing = ctx.existing.get(c.key)?.get(c.date) ?? null;
    let classification: StagedRow['classification'];
    if (existing === null) {
      if (params.mode === 'correction') {
        push('error', c.rowNumber, 'CORRECTION_TARGET_MISSING', `Correction mode: no published level exists for ${c.key} on ${fd(c.date)}, so there is nothing to correct.`, {
          column: table.header[dateIdx],
        });
        continue;
      }
      classification = 'new';
    } else if (sameLevel(existing, c.value)) classification = 'identical';
    else if (params.mode === 'new_history') {
      push(
        'error',
        c.rowNumber,
        'CONFLICT_WITH_PUBLISHED',
        `${c.key} ${fd(c.date)} is already published at ${existing}; the file says ${c.valueText}. Use correction mode to change a published level.`,
        { column: table.header[valueIdx], raw: c.valueText },
      );
      continue;
    } else classification = 'correction';
    staged.push({
      rowNumber: c.rowNumber,
      benchmarkKey: c.key,
      date: c.date,
      value: c.value,
      valueText: c.valueText,
      existing,
      classification,
      flags: [],
    });
  }
  // A row with any error must not be staged (e.g. duplicate conflict handled above; defensive).
  const stagedClean = staged.filter((s) => !rowInvalid.has(s.rowNumber));
  stagedClean.sort((a, b) => (a.benchmarkKey < b.benchmarkKey ? -1 : a.benchmarkKey > b.benchmarkKey ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ---- review flags per benchmark (never errors, never drops rows) ----
  const byKey = new Map<string, StagedRow[]>();
  for (const s of stagedClean) {
    const g = byKey.get(s.benchmarkKey);
    if (g) g.push(s);
    else byKey.set(s.benchmarkKey, [s]);
  }
  const acks = new Set<Acknowledgement>();
  const perBenchmark: BenchmarkSummary[] = [];

  for (const key of [...new Set([...keysSeen, ...byKey.keys()])].sort()) {
    const rows = byKey.get(key) ?? [];
    const existingForKey = ctx.existing.get(key);
    const summary: BenchmarkSummary = {
      benchmarkKey: key,
      earliestDate: rows.length > 0 ? rows[0].date : null,
      latestDate: rows.length > 0 ? rows[rows.length - 1].date : null,
      newRows: rows.filter((r) => r.classification === 'new').length,
      identicalRows: rows.filter((r) => r.classification === 'identical').length,
      correctionRows: rows.filter((r) => r.classification === 'correction').length,
      gaps: [],
    };
    perBenchmark.push(summary);
    if (rows.length === 0) continue;

    // weekend rows (aggregated)
    const weekend = rows.filter((r) => isWeekendDay(dayNumber(r.date)));
    if (weekend.length > 0) {
      for (const r of weekend) r.flags.push('weekend');
      acks.add('weekend_rows');
      push(
        'warning',
        weekend[0].rowNumber,
        'WEEKEND_ROW',
        `${key}: ${weekend.length} row(s) are dated on a Saturday or Sunday (rows ${weekend.slice(0, 10).map((r) => r.rowNumber).join(', ')}${weekend.length > 10 ? ', ...' : ''}). They are kept and need review (special sessions exist; weekend carry-forward values do not).`,
      );
    }

    // large moves and scale changes between consecutive incoming levels
    let largeMoves = 0;
    let largeOverflow = 0;
    let scaleReports = 0;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const ratio = cur.value / prev.value;
      if (ratio > SCALE_RATIO_HIGH || ratio < SCALE_RATIO_LOW) {
        cur.flags.push('scale_change');
        acks.add('scale_change');
        if (scaleReports++ < MAX_INDIVIDUAL_WARNINGS_PER_BENCHMARK) {
          push(
            'warning',
            cur.rowNumber,
            'SUSPECTED_SCALE_CHANGE',
            `${key} ${fd(cur.date)}: the level moves from ${prev.valueText} (${fd(prev.date)}) to ${cur.valueText}, a factor of ${ratio.toFixed(3)}. This may be a rebasing or unit change; confirm before publishing.`,
            { column: table.header[valueIdx], raw: cur.valueText },
          );
        }
      } else if (Math.abs(ratio - 1) > LARGE_MOVE_FRACTION + 1e-9) {
        cur.flags.push('large_move');
        acks.add('large_moves');
        if (largeMoves++ < MAX_INDIVIDUAL_WARNINGS_PER_BENCHMARK) {
          push(
            'warning',
            cur.rowNumber,
            'LARGE_MOVE',
            `${key} ${fd(cur.date)}: the level moves ${((ratio - 1) * 100).toFixed(2)}% from ${prev.valueText} (${fd(prev.date)}) to ${cur.valueText}. Large real moves happen; review it.`,
            { column: table.header[valueIdx], raw: cur.valueText },
          );
        } else largeOverflow++;
      }
    }
    if (largeOverflow > 0) {
      push('warning', null, 'LARGE_MOVE', `${key}: ${largeOverflow} further large day-over-day moves were flagged but are not listed individually.`);
    }

    // first / last incoming level against the nearest published neighbour
    if (existingForKey && existingForKey.size > 0) {
      for (const edge of rows.length === 1 ? [rows[0]] : [rows[0], rows[rows.length - 1]]) {
        const target = dayNumber(edge.date);
        let best: { date: string; level: number; dist: number } | null = null;
        for (const [d, level] of existingForKey) {
          if (!(level > 0)) continue;
          const dist = Math.abs(dayNumber(d) - target);
          if (best === null || dist < best.dist) best = { date: d, level, dist };
        }
        if (best) {
          const ratio = edge.value / best.level;
          if ((ratio > SCALE_RATIO_HIGH || ratio < SCALE_RATIO_LOW) && !edge.flags.includes('scale_change')) {
            edge.flags.push('scale_change');
            acks.add('scale_change');
            push(
              'warning',
              edge.rowNumber,
              'SUSPECTED_SCALE_CHANGE',
              `${key} ${fd(edge.date)}: the incoming level ${edge.valueText} differs by a factor of ${ratio.toFixed(3)} from the published level ${best.level} on ${fd(best.date)}. This may be a rebasing or unit change; confirm before publishing.`,
              { column: table.header[valueIdx], raw: edge.valueText },
            );
          }
        }
      }
    }

    // weekday coverage gaps inside the incoming range (nothing is synthesised)
    const present = new Set<number>(rows.map((r) => dayNumber(r.date)));
    const first = dayNumber(rows[0].date);
    const last = dayNumber(rows[rows.length - 1].date);
    if (existingForKey) {
      for (const d of existingForKey.keys()) {
        const dn = dayNumber(d);
        if (dn >= first && dn <= last) present.add(dn);
      }
    }
    const sorted = [...present].sort((a, b) => a - b);
    let gapReports = 0;
    for (let i = 1; i < sorted.length; i++) {
      let missing = 0;
      let from = -1;
      let to = -1;
      for (let d = sorted[i - 1] + 1; d < sorted[i]; d++) {
        if (!isWeekendDay(d)) {
          missing++;
          if (from < 0) from = d;
          to = d;
        }
      }
      if (missing > GAP_WEEKDAY_THRESHOLD) {
        summary.gaps.push({ from: isoFromDay(from), to: isoFromDay(to), weekdaysMissing: missing });
        acks.add('coverage_gaps');
        if (gapReports++ < MAX_INDIVIDUAL_WARNINGS_PER_BENCHMARK) {
          push('warning', null, 'COVERAGE_GAP', `${key}: no levels for ${missing} consecutive weekdays from ${fd(isoFromDay(from))} to ${fd(isoFromDay(to))}. Missing dates are never filled in.`);
        }
      }
    }
  }

  if (params.includeHiddenRows && included.length > 0) acks.add('hidden_rows_included');

  const order: Acknowledgement[] = ['scale_change', 'large_moves', 'weekend_rows', 'coverage_gaps', 'hidden_rows_included'];
  const rowsInvalid = rowInvalid.size;
  return {
    validatorVersion: VALIDATOR_VERSION,
    rowsTotal: dataRows.length,
    rowsValid: dataRows.length - rowsInvalid - rowsExcluded,
    rowsInvalid,
    rowsExcluded,
    duplicatesCollapsed,
    staged: stagedClean,
    issues,
    hardErrorCount: issues.filter((i) => i.severity === 'error').length,
    perBenchmark,
    requiredAcknowledgements: order.filter((a) => acks.has(a)),
    disclosure: { ...disclosureBase, layoutId, columnMapping, ...layoutExtras },
  };
}
