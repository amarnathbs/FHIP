// Resources Bulk Upload -- server-side file security. Authoritative: the browser's
// file type / size / extension are never trusted.
//
// This DELEGATES the hard parts to the already-certified, dependency-free
// hostile-input readers under lib/services/investment-intelligence/
// benchmarkData/fileIngest (strict ZIP central-directory reader with bounded
// inflate, linear XML scanner that refuses DTDs/entities, RFC-4180 CSV reader).
// It deliberately does NOT use SheetJS to READ uploads (unmaintained, known
// CVEs); SheetJS is used only to WRITE the downloadable templates.
//
// Guarantees:
//  * only .csv and .xlsx are accepted (.xls, .xlsm/.xlsb, .ods, zip, pdf, ... rejected);
//  * extension, sniffed content and declared MIME must agree;
//  * max 10 MB, bounded decompression (declared size enforced at inflate time),
//    zip-bomb / zip64 / encrypted / overlapping / path-traversal archives rejected;
//  * formulas are never evaluated (a formula cell is a hard error);
//  * the raw file is NEVER stored -- the caller keeps only the SHA-256 and the
//    normalised rows.

import { createHash } from 'node:crypto';
import { inspectUpload, tryReadZipEntries } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { IMPORT_LIMITS, type ImportIssue } from './types';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const INGEST_LIMITS = Object.freeze({
  maxBytes: IMPORT_LIMITS.maxFileBytes,
  // The ingest readers count raw sheet rows INCLUDING empty styled ones; this is a physical ceiling,
  // not the 500-record limit (that one is enforced on non-empty rows by the parser).
  maxRows: 5000,
  maxZipEntries: IMPORT_LIMITS.maxZipEntries,
  maxZipUncompressedBytes: IMPORT_LIMITS.maxZipUncompressedBytes,
  maxZipEntryBytes: IMPORT_LIMITS.maxZipEntryBytes,
  maxXmlBytes: IMPORT_LIMITS.maxZipEntryBytes,
  maxZipRatio: 100,
});

function fileLevel(code: ImportIssue['code'], message: string): ImportIssue {
  return { row: null, field: null, code, message, severity: 'error' };
}

/** Maps an ingest-library problem code onto the PO's error-code vocabulary. */
export function mapIngestProblem(problem: { code: string; message: string }): ImportIssue {
  const c = problem.code;
  if (c === 'FILE_TOO_LARGE') return fileLevel('FILE_TOO_LARGE', `The file is larger than the ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB limit.`);
  if (c === 'FILE_EMPTY') return fileLevel('EMPTY_FILE', 'The file is empty.');
  if (c === 'TOO_MANY_ROWS') return fileLevel('TOO_MANY_ROWS', `The file has more than ${IMPORT_LIMITS.maxRows} rows.`);
  if (c.startsWith('FILE_') || c.startsWith('ZIP_') || c.startsWith('XLSX_MACRO') || c === 'XLSX_STRUCTURE_INVALID' || c.startsWith('XML_')) {
    return fileLevel('INVALID_FILE_TYPE', problem.message);
  }
  return fileLevel('FILE_PARSE_ERROR', problem.message);
}

export type InspectOutcome = { ok: true; kind: 'csv' | 'xlsx'; text?: string } | { ok: false; issues: ImportIssue[] };

/**
 * The shared inspector refuses a workbook whose [Content_Types].xml merely CONTAINS the text "macroEnabled".
 * That is too blunt for this feature: workbooks written by common tools (including the SheetJS library that
 * writes our own downloadable templates) carry a harmless Default mapping for the .bin extension whose content
 * type mentions macroEnabled, although the workbook holds no macro and no binary part. A workbook is
 * macro-enabled only when the WORKBOOK PART itself is declared macro-enabled (an Override for /xl/workbook.xml)
 * or a vbaProject part exists (already refused by the shared inspector with its own message).
 *
 * The shared inspector has already, by the time this check runs: opened the archive with every size/ratio/path
 * limit, inflated every entry against its declared size, confirmed there is no vbaProject.bin and confirmed the
 * workbook structure. Only the final blunt text check is re-decided here, precisely.
 */
export function isWorkbookPartMacroEnabled(bytes: Uint8Array): boolean {
  const z = tryReadZipEntries(bytes, INGEST_LIMITS);
  if (!z.ok) return true; // cannot tell: refuse
  const ct = z.entries.get('[Content_Types].xml');
  if (!ct) return true;
  const text = new TextDecoder().decode(ct);
  for (const m of text.matchAll(/<Override\b[^>]*>/g)) {
    const tag = m[0];
    if (/PartName="\/xl\/(workbook|vbaProject)[^"]*"/i.test(tag) && /macroEnabled/i.test(tag)) return true;
  }
  return z.entries.has('xl/vbaProject.bin');
}

/** Extension, content sniffing, MIME consistency, size, archive limits, encoding. Never throws. */
export function inspectImportFile(input: { fileName: string; declaredMime?: string | null; bytes: Uint8Array }): InspectOutcome {
  let r = inspectUpload({ fileName: input.fileName, declaredMime: input.declaredMime ?? null, bytes: input.bytes, limits: INGEST_LIMITS });
  if (!r.ok && r.problems.length === 1 && r.problems[0].code === 'XLSX_MACRO_PRESENT' && /declared macro-enabled/i.test(r.problems[0].message) && !isWorkbookPartMacroEnabled(input.bytes)) {
    r = { ok: true, kind: 'xlsx', problems: [] };
  }
  if (!r.ok || r.kind === null) {
    return { ok: false, issues: r.problems.length > 0 ? r.problems.map(mapIngestProblem) : [fileLevel('INVALID_FILE_TYPE', 'The file could not be read as a CSV or XLSX file.')] };
  }
  return { ok: true, kind: r.kind, text: r.text };
}
