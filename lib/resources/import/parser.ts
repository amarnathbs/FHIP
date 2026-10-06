// Resources Bulk Upload -- file -> ParsedTable. Pure (no database, no clock).
//
// Steps: inspect (file-security) -> read CSV / the single upload sheet of an
// XLSX -> map header cells onto the canonical schema -> reject forbidden /
// unknown / duplicate / missing columns -> check the template version ->
// produce one trimmed string per cell. Formula cells are never evaluated; they
// are reported. Anything wrong with a CELL is returned as a row-level issue so
// the preview can show it next to the row.

import { parseCsvText, listWorkbookSheets, readWorksheet, excelSerialToIsoDate } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { FORBIDDEN_COLUMNS } from './common-schema';
import { INGEST_LIMITS, inspectImportFile, mapIngestProblem, sha256Hex } from './file-security';
import { IMPORT_LIMITS, TEMPLATE_VERSION, type ImportIssue, type ImportSchema, type ParsedTable, type RawImportRow } from './types';

export interface ParseInput {
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
}

export type ParseOutcome =
  | { ok: true; fileSha256: string; table: ParsedTable; cellIssues: ImportIssue[] }
  | { ok: false; fileSha256: string | null; issues: ImportIssue[] };

function fileIssue(code: ImportIssue['code'], message: string, field: string | null = null): ImportIssue {
  return { row: null, field, code, message, severity: 'error' };
}

/** Lenient header normalisation: case, surrounding space, BOM, NBSP, spaces and hyphens -> underscore. */
export function normaliseHeader(raw: string): string {
  return raw
    .replace(/[﻿ ​]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function isTemplateVersionOk(v: string): boolean {
  const t = v.trim();
  return t === TEMPLATE_VERSION || t === '1';
}

interface RawGrid {
  header: string[];
  /** One entry per data row; cells are already strings. */
  rows: { rowNumber: number; cells: string[]; cellIssues: ImportIssue[] }[];
  sheetName: string | null;
  kind: 'csv' | 'xlsx';
}

function readCsv(text: string): { ok: true; grid: RawGrid } | { ok: false; issues: ImportIssue[] } {
  // ',' is the CSV contract; no delimiter guessing (a wrong guess silently re-maps columns).
  const parsed = parseCsvText(text, { delimiter: ',', maxRows: IMPORT_LIMITS.maxRows + 2, headerRow: 1 });
  const issues: ImportIssue[] = [];
  if (parsed.truncated) issues.push(fileIssue('TOO_MANY_ROWS', `The file has more than ${IMPORT_LIMITS.maxRows} records. Split it into smaller files.`));
  for (const p of parsed.problems) {
    if (p.code === 'TOO_MANY_ROWS') continue;
    issues.push(fileIssue('FILE_PARSE_ERROR', p.message));
  }
  if (issues.length > 0) return { ok: false, issues };
  if (parsed.rows.length === 0) return { ok: false, issues: [fileIssue('EMPTY_FILE', 'The file has no header row.')] };
  const header = parsed.rows[0].map((h) => h.replace(/﻿/g, '').trim());
  const rows = parsed.rows.slice(1).map((cells, i) => {
    const cellIssues: ImportIssue[] = [];
    return { rowNumber: parsed.lineNumbers[i + 1], cells, cellIssues };
  });
  return { ok: true, grid: { header, rows, sheetName: null, kind: 'csv' } };
}

function readXlsx(bytes: Uint8Array, schema: ImportSchema): { ok: true; grid: RawGrid } | { ok: false; issues: ImportIssue[] } {
  const listing = listWorkbookSheets(bytes, INGEST_LIMITS);
  if (listing.sheets.length === 0) {
    return { ok: false, issues: listing.problems.length > 0 ? listing.problems.map(mapIngestProblem) : [fileIssue('INVALID_FILE_TYPE', 'The workbook has no sheets.')] };
  }
  if (listing.sheets.length > IMPORT_LIMITS.maxSheets) {
    return { ok: false, issues: [fileIssue('INVALID_FILE_TYPE', `The workbook has ${listing.sheets.length} sheets; the limit is ${IMPORT_LIMITS.maxSheets}.`)] };
  }
  const wanted = schema.uploadSheetName.toLowerCase();
  const sheet = listing.sheets.find((s) => s.name.trim().toLowerCase() === wanted);
  if (!sheet) {
    return {
      ok: false,
      issues: [fileIssue('UPLOAD_SHEET_MISSING', `The workbook has no sheet named "${schema.uploadSheetName}". Only that sheet is imported. Download the template again and paste your rows into it.`)],
    };
  }
  const ws = readWorksheet(bytes, sheet.name, { headerRow: 1, includeHiddenRows: true, limits: INGEST_LIMITS });
  const fatal = ws.problems.filter((p) => p.code !== 'TOO_MANY_ROWS');
  if (fatal.length > 0) return { ok: false, issues: fatal.map(mapIngestProblem) };

  const rows: RawGrid['rows'] = [];
  const formulaAt = new Map<string, string>();
  for (const f of ws.formulaCells) formulaAt.set(`${f.rowNumber}:${f.column}`, f.ref);
  const colLetter = (i: number) => {
    let n = i + 1;
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  for (const r of ws.rows) {
    const cellIssues: ImportIssue[] = [];
    const cells = r.cells.map((c, idx) => {
      const ref = formulaAt.get(`${r.rowNumber}:${colLetter(idx)}`);
      const field = normaliseHeader(ws.header[idx] ?? '') || null;
      if (ref !== undefined) {
        cellIssues.push({ row: r.rowNumber, field, code: 'FORMULA_NOT_ALLOWED', message: `Cell ${ref} contains a formula. Formulas are never evaluated. Copy the cells and paste them as values.`, severity: 'error' });
        return '';
      }
      switch (c.kind) {
        case 'empty':
          return '';
        case 'string':
          return c.raw;
        case 'boolean':
          return c.raw === 'TRUE' ? 'true' : 'false';
        case 'error':
          cellIssues.push({ row: r.rowNumber, field, code: 'INVALID_CELL_VALUE', message: `Cell ${colLetter(idx)}${r.rowNumber} holds a spreadsheet error value.`, severity: 'error' });
          return '';
        case 'date': {
          const iso = excelSerialToIsoDate(c.numberValue as number, ws.date1904);
          if (iso === null) {
            cellIssues.push({ row: r.rowNumber, field, code: 'INVALID_DATE', message: `Cell ${colLetter(idx)}${r.rowNumber} is a date cell that is not a real calendar date.`, severity: 'error' });
            return '';
          }
          return iso;
        }
        case 'number':
          return c.raw;
      }
    });
    rows.push({ rowNumber: r.rowNumber, cells, cellIssues });
  }
  return { ok: true, grid: { header: ws.header.map((h) => h.trim()), rows, sheetName: sheet.name, kind: 'xlsx' } };
}

/** Parse + structurally validate an uploaded file against ONE schema. Never throws. */
export function parseImportFile(input: ParseInput, schema: ImportSchema): ParseOutcome {
  let fileSha256: string | null = null;
  try {
    fileSha256 = sha256Hex(input.bytes);
    const inspected = inspectImportFile(input);
    if (!inspected.ok) return { ok: false, fileSha256, issues: inspected.issues };

    const read = inspected.kind === 'csv' ? readCsv(inspected.text ?? '') : readXlsx(input.bytes, schema);
    if (!read.ok) return { ok: false, fileSha256, issues: read.issues };
    const { grid } = read;

    // ---- header -> canonical keys ----
    const known = new Set(schema.columns.map((c) => c.key));
    const forbidden = new Set(FORBIDDEN_COLUMNS);
    const issues: ImportIssue[] = [];
    const colKey: (string | null)[] = [];
    const seen = new Map<string, number>();
    grid.header.forEach((raw, idx) => {
      const key = normaliseHeader(raw);
      if (!key) {
        colKey.push(null);
        return;
      }
      if (forbidden.has(key)) {
        issues.push(fileIssue('FORBIDDEN_COLUMN', `The column "${raw}" is not allowed in an upload file. Workflow state, visibility, approvals, scheduling and the content type are never imported: every upload becomes a private draft and the screen you chose decides the type.`, key));
        colKey.push(null);
        return;
      }
      if (!known.has(key)) {
        issues.push(fileIssue('UNKNOWN_COLUMN', `The column "${raw}" is not part of the ${schema.templateFileBase} template. Remove it or download a fresh template.`, key));
        colKey.push(null);
        return;
      }
      if (seen.has(key)) {
        issues.push(fileIssue('DUPLICATE_COLUMN', `The column "${key}" appears more than once.`, key));
        colKey.push(null);
        return;
      }
      seen.set(key, idx);
      colKey.push(key);
    });
    for (const c of schema.columns) {
      if (c.required && !seen.has(c.key)) issues.push(fileIssue('MISSING_REQUIRED_COLUMN', `The required column "${c.key}" is missing.`, c.key));
    }
    if (issues.length > 0) return { ok: false, fileSha256, issues };

    // ---- rows ----
    const rows: RawImportRow[] = [];
    const cellIssues: ImportIssue[] = [];
    for (const r of grid.rows) {
      const values: Record<string, string> = {};
      let nonEmpty = false;
      r.cells.forEach((cell, idx) => {
        const key = colKey[idx];
        const v = (cell ?? '').trim();
        if (v !== '') nonEmpty = true;
        if (key) values[key] = v;
        else if (v !== '' && !grid.header[idx]?.trim()) {
          // data under a blank header: never silently dropped
          issues.push(fileIssue('UNKNOWN_COLUMN', `Row ${r.rowNumber} has a value in a column that has no header.`));
        }
      });
      if (!nonEmpty) continue; // wholly blank row
      for (const key of seen.keys()) if (values[key] === undefined) values[key] = '';
      // CSV: a leading '=' is a formula by spreadsheet rules; neither format may carry one.
      for (const [key, v] of Object.entries(values)) {
        if (v.startsWith('=')) {
          cellIssues.push({ row: r.rowNumber, field: key, code: 'FORMULA_NOT_ALLOWED', message: 'This value starts with "=" and would be treated as a formula. Formulas are never evaluated.', severity: 'error' });
          values[key] = '';
        }
      }
      cellIssues.push(...r.cellIssues);
      rows.push({ rowNumber: r.rowNumber, values });
    }
    if (issues.length > 0) return { ok: false, fileSha256, issues };
    if (rows.length === 0) return { ok: false, fileSha256, issues: [fileIssue('EMPTY_FILE', 'The file has a header but no data rows.')] };
    if (rows.length > IMPORT_LIMITS.maxRows) {
      return { ok: false, fileSha256, issues: [fileIssue('TOO_MANY_ROWS', `The file has ${rows.length} rows; the limit is ${IMPORT_LIMITS.maxRows} per file. Split it into smaller files.`)] };
    }

    // ---- template version (file level) ----
    const badVersions = new Set<string>();
    for (const r of rows) if (!isTemplateVersionOk(r.values.template_version ?? '')) badVersions.add(r.values.template_version || '(blank)');
    if (badVersions.size > 0) {
      return {
        ok: false,
        fileSha256,
        issues: [fileIssue('TEMPLATE_VERSION_UNSUPPORTED', `Only template version ${TEMPLATE_VERSION} is supported. This file says: ${[...badVersions].slice(0, 5).join(', ')}. Download the current template and copy your rows into it.`, 'template_version')],
      };
    }

    return { ok: true, fileSha256, table: { headers: [...seen.keys()], rows, sheetName: grid.sheetName, kind: grid.kind }, cellIssues };
  } catch {
    // Hostile input must never surface as an exception.
    return { ok: false, fileSha256, issues: [fileIssue('FILE_PARSE_ERROR', 'The file could not be read safely.')] };
  }
}
