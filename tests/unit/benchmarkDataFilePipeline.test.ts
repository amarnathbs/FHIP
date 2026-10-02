// BENCH-1 Phase 2 -- end-to-end: inspect -> read -> table -> validate, for CSV
// and XLSX, all three shapes, including the XLSX-specific governance rules
// (explicit sheet, formulas, hidden rows/sheets, date systems).
import { describe, it, expect } from 'vitest';
import {
  readUploadToTable,
  validateUpload,
  csvToTable,
  xlsxToTable,
  readWorksheet,
  parseCsvText,
  BENCHMARK_UPLOAD_TEMPLATES,
  type CatalogueEntryLite,
  type UploadParams,
  type ValidationContext,
  type ValidationResult,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { buildXlsx, simpleSheet, utf8, type CellSpec, type SheetSpec } from './support/benchmarkDataFileFixtures';

const TODAY = '2026-10-01';
const TRI = 'IN_NIFTY_50_TRI';
const TRI2 = 'IN_SENSEX_TRI';
const entry = (k: string): CatalogueEntryLite => ({ benchmarkKey: k, returnVariant: 'total_return', currencyCode: 'INR', isActive: true });
const CATALOGUE = new Map([[TRI, entry(TRI)], [TRI2, entry(TRI2)]]);
const ctx = (o: Partial<ValidationContext> = {}): ValidationContext => ({ todayIso: TODAY, catalogue: CATALOGUE, existing: new Map(), ...o });
const params = (o: Partial<UploadParams> = {}): UploadParams => ({
  shape: 'single',
  mode: 'new_history',
  benchmarkKey: TRI,
  returnVariant: 'total_return',
  currencyCode: 'INR',
  historyClass: 'live',
  dateFormat: 'YYYY-MM-DD',
  numberLocale: 'plain',
  ...o,
});

function ingest(fileName: string, bytes: Uint8Array, p: UploadParams, c: Partial<ValidationContext> = {}, mime?: string) {
  const read = readUploadToTable({ fileName, declaredMime: mime, bytes, params: p });
  if (!read.ok) return { read, result: null as ValidationResult | null };
  return { read, result: validateUpload(read.table, p, ctx(c)) };
}
const codes = (r: ValidationResult | null) => (r ? r.issues.map((i) => i.code) : []);
const sheetOf = (name: string, header: string[], rows: CellSpec[][], extra: Partial<SheetSpec> = {}) => simpleSheet(name, header, rows, extra);

// 45292 = 2024-01-01 (Mon) in the 1900 system; 43830 in the 1904 system.
const S1900 = [45292, 45293, 45294];
const S1904 = [43830, 43831, 43832];

describe('CSV happy paths for the three shapes', () => {
  it('single: date,value', () => {
    const { result } = ingest('a.csv', utf8('date,value\n2024-01-01,1000.00\n2024-01-02,1001.50\n'), params());
    expect(result?.hardErrorCount).toBe(0);
    expect(result?.staged).toHaveLength(2);
  });

  it('multi: benchmark_key,date,value (UTF-8 BOM and CRLF)', () => {
    const bytes = utf8(`﻿benchmark_key,date,value\r\n${TRI},2024-01-01,1000\r\n${TRI2},2024-01-01,500\r\n`);
    const { result } = ingest('a.csv', bytes, params({ shape: 'multi', benchmarkKey: undefined }));
    expect(result?.hardErrorCount).toBe(0);
    expect(result?.staged.map((s) => s.benchmarkKey)).toEqual([TRI, TRI2]);
  });

  it('provider export: the downloadable NSE TRI template round-trips', () => {
    const t = BENCHMARK_UPLOAD_TEMPLATES.provider_nse_tri_export;
    const { result } = ingest(t.fileName, utf8(t.csv), params({ shape: 'provider_export', providerLayoutId: 'nse_tri_export', dateFormat: 'DD MMM YYYY' }));
    expect(result?.hardErrorCount).toBe(0);
    expect(result?.staged.map((s) => s.value)).toEqual([1000, 1001.5, 1002.25]);
  });

  it('European-style CSV: ";" delimiter, decimal comma, DD-MM-YYYY', () => {
    const bytes = utf8('Date;Value\n01-01-2024;1.234,50\n02-01-2024;1.240,00\n');
    const read = readUploadToTable({ fileName: 'a.csv', bytes, params: params({ dateFormat: 'DD-MM-YYYY', numberLocale: 'eu' }) });
    expect(read.ok && read.delimiter).toBe(';');
    const r = validateUpload((read as { table: ReturnType<typeof csvToTable> }).table, params({ dateFormat: 'DD-MM-YYYY', numberLocale: 'eu' }), ctx());
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => s.value)).toEqual([1234.5, 1240]);
  });

  it('the templates themselves are valid shapes (and the multi template is NOT publishable unedited)', () => {
    const single = BENCHMARK_UPLOAD_TEMPLATES.single_date_value;
    expect(ingest(single.fileName, utf8(single.csv), params()).result?.hardErrorCount).toBe(0);
    const multi = BENCHMARK_UPLOAD_TEMPLATES.multi_key_date_value;
    const m = ingest(multi.fileName, utf8(multi.csv), params({ shape: 'multi', benchmarkKey: undefined }));
    expect(codes(m.result)).toContain('BENCHMARK_UNKNOWN');
    for (const t of Object.values(BENCHMARK_UPLOAD_TEMPLATES)) {
      // No comment lines: a comment would corrupt a re-upload.
      expect(t.csv.split(/\r?\n/).some((l) => l.trim().startsWith('#'))).toBe(false);
    }
  });
});

describe('inspection failures stop the pipeline before any parsing', () => {
  it('wrong MIME, PDF content, macro workbook, oversize and bad encoding', () => {
    const csv = utf8('date,value\n2024-01-01,1\n');
    expect(ingest('a.csv', csv, params(), {}, 'application/pdf').read).toMatchObject({ ok: false, stage: 'inspection' });
    expect(ingest('a.csv', utf8('%PDF-1.4 ...'), params()).read.ok).toBe(false);
    expect(ingest('a.xlsm', csv, params()).read.ok).toBe(false);
    const big = readUploadToTable({ fileName: 'a.csv', bytes: csv, params: params(), limits: { maxBytes: 5 } });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.problems[0].code).toBe('FILE_TOO_LARGE');
    expect(ingest('a.csv', Uint8Array.from([0x64, 0xc3, 0x28]), params()).read.ok).toBe(false);
  });

  it('an XLSX without an explicit sheet returns the sheet list and stops', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('Data', ['date', 'value'], [['2024-01-01', 1]]), sheetOf('Other', ['a'], [])] });
    const read = readUploadToTable({ fileName: 'a.xlsx', bytes, params: params() });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.stage).toBe('sheet');
      expect(read.sheets?.map((s) => s.name)).toEqual(['Data', 'Other']);
      expect(read.problems[0].code).toBe('SHEET_NAME_REQUIRED');
    }
  });
});

describe('XLSX happy paths for the three shapes', () => {
  it('single: text dates and numeric levels', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('Data', ['date', 'value'], [['2024-01-01', 1000], ['2024-01-02', 1001.5]])] });
    const { result, read } = ingest('a.xlsx', bytes, params({ sheetName: 'Data' }));
    expect(result?.hardErrorCount).toBe(0);
    expect(result?.staged.map((s) => [s.rowNumber, s.date, s.value])).toEqual([[2, '2024-01-01', 1000], [3, '2024-01-02', 1001.5]]);
    expect(result?.disclosure).toMatchObject({ sheetProcessed: 'Data', sheetsAvailable: ['Data'], otherSheetsNotProcessed: [], headerRow: 1 });
    expect(read.ok && read.kind).toBe('xlsx');
  });

  it('multi: benchmark_key column from the sheet', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('M', ['benchmark_key', 'date', 'value'], [[TRI, '2024-01-01', 1000], [TRI2, '2024-01-01', 500]])] });
    const { result } = ingest('a.xlsx', bytes, params({ shape: 'multi', benchmarkKey: undefined, sheetName: 'M' }));
    expect(result?.hardErrorCount).toBe(0);
    expect(result?.staged.map((s) => s.benchmarkKey)).toEqual([TRI, TRI2]);
  });

  it('provider export: NSE TRI layout with Excel date cells (1900 system)', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('Export', ['Date', 'Total Returns Index'], S1900.map((d, i) => [{ date: d }, 1000 + i]))] });
    const { result } = ingest('a.xlsx', bytes, params({ shape: 'provider_export', providerLayoutId: 'nse_tri_export', dateFormat: 'excel_1900', sheetName: 'Export' }));
    expect(result?.hardErrorCount).toBe(0);
    expect(result?.staged.map((s) => s.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
  });
});

describe('XLSX: Excel date systems are explicit and cross-checked', () => {
  const sheetWith = (serials: number[], date1904: boolean) =>
    buildXlsx({ date1904, sheets: [sheetOf('D', ['date', 'value'], serials.map((d, i) => [{ date: d }, 1000 + i]))] });

  it('1900 workbook + excel_1900: serials become the right ISO dates', () => {
    const r = ingest('a.xlsx', sheetWith(S1900, false), params({ sheetName: 'D', dateFormat: 'excel_1900' })).result;
    expect(r?.hardErrorCount).toBe(0);
    expect(r?.staged.map((s) => s.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
  });

  it('1904 workbook + excel_1904: the different serials give the SAME real dates', () => {
    const r = ingest('a.xlsx', sheetWith(S1904, true), params({ sheetName: 'D', dateFormat: 'excel_1904' })).result;
    expect(r?.hardErrorCount).toBe(0);
    expect(r?.staged.map((s) => s.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
  });

  it('declaring the wrong system for the workbook is a hard DATE_SYSTEM_MISMATCH (dates would be 4 years off)', () => {
    const wrong1900 = ingest('a.xlsx', sheetWith(S1904, true), params({ sheetName: 'D', dateFormat: 'excel_1900' })).result;
    expect(codes(wrong1900)).toContain('DATE_SYSTEM_MISMATCH');
    expect(wrong1900?.staged).toEqual([]);
    const wrong1904 = ingest('a.xlsx', sheetWith(S1900, false), params({ sheetName: 'D', dateFormat: 'excel_1904' })).result;
    expect(codes(wrong1904)).toContain('DATE_SYSTEM_MISMATCH');
  });

  it('the same serial gives different ISO dates under the two systems (control)', () => {
    const a = ingest('a.xlsx', sheetWith([45000], false), params({ sheetName: 'D', dateFormat: 'excel_1900' })).result;
    const b = ingest('a.xlsx', sheetWith([45000], true), params({ sheetName: 'D', dateFormat: 'excel_1904' })).result;
    expect(a?.staged[0].date).toBe('2023-03-15');
    expect(codes(b)).toContain('DATE_FUTURE'); // 2027-03-16 is beyond the injected today
  });

  it('serial 60 (the non-existent 1900-02-29) is rejected on its row', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('D', ['date', 'value'], [[{ date: 59 }, 1], [{ date: 60 }, 2], [{ date: 61 }, 3]])] });
    const r = ingest('a.xlsx', bytes, params({ sheetName: 'D', dateFormat: 'excel_1900' })).result;
    const bad = r?.issues.find((i) => i.code === 'DATE_SERIAL_INVALID');
    expect(bad?.rowNumber).toBe(3);
    expect(r?.staged.map((s) => s.date)).toEqual(['1900-02-28', '1900-03-01']);
  });

  it('an Excel date cell under a TEXT date format is refused, not reinterpreted', () => {
    const r = ingest('a.xlsx', sheetWith(S1900, false), params({ sheetName: 'D', dateFormat: 'YYYY-MM-DD' })).result;
    expect(codes(r)).toContain('DATE_FORMAT_MISMATCH');
    expect(r?.staged).toEqual([]);
  });

  it('a fractional serial (date with a time of day) is rejected as a timestamp', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('D', ['date', 'value'], [[{ date: 45292.5 }, 1]])] });
    expect(codes(ingest('a.xlsx', bytes, params({ sheetName: 'D', dateFormat: 'excel_1900' })).result)).toContain('DATE_IS_TIMESTAMP');
  });

  it('a plain (non-date-formatted) number in the date column works under an Excel format', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('D', ['date', 'value'], [[45292, 1000]])] });
    expect(ingest('a.xlsx', bytes, params({ sheetName: 'D', dateFormat: 'excel_1900' })).result?.staged[0].date).toBe('2024-01-01');
  });
});

describe('XLSX: formula cells are rejected in required columns', () => {
  const formulaSheet = (cell: CellSpec, col: 'date' | 'value' | 'key') => {
    const row: CellSpec[] = col === 'key' ? [cell, '2024-01-02', 1001] : col === 'date' ? [cell, 1001] : ['2024-01-02', cell];
    const header = col === 'key' ? ['benchmark_key', 'date', 'value'] : ['date', 'value'];
    const ok: CellSpec[] = col === 'key' ? [TRI, '2024-01-01', 1000] : ['2024-01-01', 1000];
    return buildXlsx({ sheets: [sheetOf('S', header, [ok, row])] });
  };

  it('formula in the VALUE column (even with a cached number): error with the cell reference', () => {
    const r = ingest('a.xlsx', formulaSheet({ formula: 'B2*1', value: 1001 }, 'value'), params({ sheetName: 'S' })).result;
    const issue = r?.issues.find((i) => i.code === 'FORMULA_CELL_REJECTED');
    expect(issue).toMatchObject({ rowNumber: 3, severity: 'error', column: 'value' });
    expect(issue?.message).toContain('B3');
    expect(r?.staged.map((s) => s.rowNumber)).toEqual([2]);
    expect(r?.hardErrorCount).toBeGreaterThan(0);
  });

  it('formula in the DATE column', () => {
    const r = ingest('a.xlsx', formulaSheet({ formula: 'DATE(2024,1,2)', value: 45293 }, 'date'), params({ sheetName: 'S', dateFormat: 'excel_1900' })).result;
    expect(r?.issues.find((i) => i.code === 'FORMULA_CELL_REJECTED')).toMatchObject({ rowNumber: 3, column: 'date' });
    expect(r?.issues.find((i) => i.code === 'FORMULA_CELL_REJECTED')?.message).toContain('A3');
  });

  it('formula in the benchmark_key column of a multi file', () => {
    const r = ingest('a.xlsx', formulaSheet({ formula: '"IN_NIFTY_50_TRI"', value: TRI }, 'key'), params({ shape: 'multi', benchmarkKey: undefined, sheetName: 'S' })).result;
    expect(r?.issues.find((i) => i.code === 'FORMULA_CELL_REJECTED')).toMatchObject({ rowNumber: 3, column: 'benchmark_key' });
    expect(r?.staged.map((s) => s.rowNumber)).toEqual([2]);
  });

  it('negative control: the identical sheet with literal values has no formula error', () => {
    const bytes = buildXlsx({ sheets: [sheetOf('S', ['date', 'value'], [['2024-01-01', 1000], ['2024-01-02', 1001]])] });
    const r = ingest('a.xlsx', bytes, params({ sheetName: 'S' })).result;
    expect(codes(r)).not.toContain('FORMULA_CELL_REJECTED');
    expect(r?.hardErrorCount).toBe(0);
  });

  it('a formula in an UNUSED extra column is only a warning', () => {
    const bytes = buildXlsx({
      sheets: [sheetOf('S', ['Trade Date', 'Settle', 'Notes'], [['2024-01-01', 1000, { formula: 'A1&"x"', value: 'x' }], ['2024-01-02', 1001, 'plain']])],
    });
    const r = ingest('a.xlsx', bytes, params({ shape: 'provider_export', columnMap: { date: 'Trade Date', value: 'Settle' }, sheetName: 'S' })).result;
    expect(r?.hardErrorCount).toBe(0);
    const w = r?.issues.find((i) => i.code === 'FORMULA_CELL_IN_UNUSED_COLUMN');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toContain('C2');
    expect(r?.staged).toHaveLength(2);
  });

  it('error cells, date-formatted value cells and booleans in required columns are rejected', () => {
    const bytes = buildXlsx({
      sheets: [sheetOf('S', ['date', 'value'], [[{ error: '#REF!' }, 1], ['2024-01-02', { error: '#N/A' }], ['2024-01-03', { date: 45292 }], ['2024-01-04', { bool: true }]])],
    });
    const r = ingest('a.xlsx', bytes, params({ sheetName: 'S' })).result;
    expect(r?.issues.map((i) => [i.rowNumber, i.code])).toEqual([
      [2, 'DATE_CELL_ERROR'],
      [3, 'VALUE_CELL_ERROR'],
      [4, 'VALUE_CELL_IS_DATE'],
      [5, 'VALUE_NOT_NUMERIC'],
    ]);
  });
});

describe('XLSX: hidden rows and sheets are disclosed', () => {
  const bytes = () =>
    buildXlsx({
      sheets: [
        sheetOf('Data', ['date', 'value'], [['2024-01-01', 1000], ['2024-01-02', 1001], ['2024-01-03', 1002]], { hiddenRows: [3] }),
        { name: 'Archive', rows: [['x']], state: 'hidden' },
        sheetOf('Other', ['a'], []),
      ],
    });

  it('by default hidden rows are NOT processed, and the preview says exactly which', () => {
    const r = ingest('a.xlsx', bytes(), params({ sheetName: 'Data' })).result;
    expect(r?.staged.map((s) => s.rowNumber)).toEqual([2, 4]);
    expect(r?.disclosure.hiddenRowsSkipped).toEqual([3]);
    expect(r?.disclosure.hiddenRowsIncluded).toEqual([]);
    const w = r?.issues.find((i) => i.code === 'HIDDEN_ROWS_SKIPPED');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toContain('rows 3');
    expect(r?.requiredAcknowledgements).not.toContain('hidden_rows_included');
    expect(r?.disclosure.sheetsAvailable).toEqual(['Data', 'Archive', 'Other']);
    expect(r?.disclosure.otherSheetsNotProcessed).toEqual(['Archive', 'Other']);
  });

  it('when included on request they are processed, listed, and need an acknowledgement', () => {
    const r = ingest('a.xlsx', bytes(), params({ sheetName: 'Data', includeHiddenRows: true })).result;
    expect(r?.staged.map((s) => s.rowNumber)).toEqual([2, 3, 4]);
    expect(r?.disclosure.hiddenRowsIncluded).toEqual([3]);
    expect(r?.requiredAcknowledgements).toEqual(['hidden_rows_included']);
    expect(codes(r)).toContain('HIDDEN_ROWS_INCLUDED');
  });

  it('the hidden-row disclosure survives the adapter unchanged', () => {
    const ws = readWorksheet(bytes(), 'Data');
    const table = xlsxToTable(ws);
    expect(table.disclosure?.hiddenRowsSkipped).toEqual([3]);
    expect(table.sourceKind).toBe('xlsx');
    expect(table.date1904).toBe(false);
    expect(table.rows.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it('merged cells in the data area are a hard error from the reader', () => {
    const merged = buildXlsx({ sheets: [sheetOf('S', ['date', 'value'], [['2024-01-01', 1000], ['2024-01-02', 1001]], { merges: ['A3:B3'] })] });
    const r = ingest('a.xlsx', merged, params({ sheetName: 'S' })).result;
    expect(codes(r)).toContain('MERGED_CELLS_IN_DATA');
    expect(r?.hardErrorCount).toBeGreaterThan(0);
  });

  it('a header row below a banner is honoured and row numbers stay spreadsheet row numbers', () => {
    const bytes2 = buildXlsx({ sheets: [{ name: 'S', rows: [['Banner'], ['generated'], ['date', 'value'], ['2024-01-01', 1000], ['bad', 1001]] }] });
    const r = ingest('a.xlsx', bytes2, params({ sheetName: 'S', headerRow: 3 })).result;
    expect(r?.disclosure.headerRow).toBe(3);
    expect(r?.issues.map((i) => [i.rowNumber, i.code])).toEqual([[5, 'DATE_FORMAT_INVALID']]);
  });
});

describe('adapters', () => {
  it('csvToTable accepts a bare string[][] (positions become row numbers) and trims headers', () => {
    const t = csvToTable([[' date ', 'value '], ['2024-01-01', '1']]);
    expect(t.header).toEqual(['date', 'value']);
    expect(t.rows).toEqual([{ rowNumber: 2, cells: ['2024-01-01', '1'] }]);
    expect(t.sourceKind).toBe('csv');
  });

  it('csvToTable carries reader problems and reports a missing header row', () => {
    const t = csvToTable(parseCsvText('a,b\n1\n'));
    expect(t.sourceProblems.map((p) => p.code)).toContain('RAGGED_ROW');
    expect(csvToTable([], 1).sourceProblems[0].code).toBe('HEADER_ROW_MISSING');
  });
});
