// Convenience orchestration: inspect -> parse -> UploadTable. Pure; the caller
// then runs `validateUpload(table, params, ctx)`.
//
//   const r = readUploadToTable({ fileName, declaredMime, bytes, params });
//   if (!r.ok) -> show r.problems (and r.sheets so an XLSX operator can pick a sheet)
//   else validateUpload(r.table, params, ctx)
import { inspectUpload } from './fileInspection';
import { parseCsvText, type CsvDelimiter } from './csvReader';
import { listWorkbookSheets, readWorksheet, type SheetInfo } from './xlsxReader';
import { csvToTable, xlsxToTable, type UploadTable } from './validator';
import { resolveLimits, type Problem, type UploadLimits, type UploadParams } from './types';

export interface ReadUploadInput {
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
  params: UploadParams;
  limits?: Partial<UploadLimits>;
  /** CSV only; default auto-detection (see csvReader). */
  delimiter?: CsvDelimiter | 'auto';
}

export type ReadUploadResult =
  | { ok: true; kind: 'csv' | 'xlsx'; table: UploadTable; sheets?: SheetInfo[]; delimiter?: string }
  | { ok: false; stage: 'inspection' | 'sheet'; kind: 'csv' | 'xlsx' | null; problems: Problem[]; sheets?: SheetInfo[] };

export function readUploadToTable(input: ReadUploadInput): ReadUploadResult {
  const limits = resolveLimits(input.limits);
  const headerRow = input.params.headerRow ?? 1;
  const inspected = inspectUpload({ fileName: input.fileName, declaredMime: input.declaredMime, bytes: input.bytes, limits });
  if (!inspected.ok || inspected.kind === null) {
    return { ok: false, stage: 'inspection', kind: inspected.kind, problems: inspected.problems };
  }

  if (inspected.kind === 'csv') {
    const parsed = parseCsvText(inspected.text ?? '', {
      delimiter: input.delimiter ?? 'auto',
      maxRows: limits.maxRows + headerRow,
      headerRow,
    });
    return { ok: true, kind: 'csv', table: csvToTable(parsed, headerRow), delimiter: parsed.delimiter };
  }

  const listing = listWorkbookSheets(input.bytes, limits);
  if (listing.problems.length > 0 && listing.sheets.length === 0) {
    return { ok: false, stage: 'inspection', kind: 'xlsx', problems: listing.problems };
  }
  if (!input.params.sheetName) {
    return {
      ok: false,
      stage: 'sheet',
      kind: 'xlsx',
      sheets: listing.sheets,
      problems: [
        {
          code: 'SHEET_NAME_REQUIRED',
          message: `Choose the sheet to process explicitly. Available sheets: ${listing.sheets.map((s) => s.name).join(', ') || '(none)'}.`,
        },
      ],
    };
  }
  const ws = readWorksheet(input.bytes, input.params.sheetName, {
    headerRow,
    includeHiddenRows: input.params.includeHiddenRows === true,
    limits,
  });
  return { ok: true, kind: 'xlsx', table: xlsxToTable(ws), sheets: listing.sheets };
}
