// First line of defence for an uploaded benchmark file: extension allow-list,
// real content sniffing, MIME consistency, size and archive limits, text
// encoding. PURE; never throws on hostile input -- it returns `problems`.
import { openZip } from './zipReader';
import { resolveLimits, type Problem, type UploadLimits } from './types';

export { readZipEntries, tryReadZipEntries, openZip, ZipReadError } from './zipReader';

export type UploadKind = 'csv' | 'xlsx';

export interface InspectInput {
  fileName: string;
  declaredMime?: string | null;
  bytes: Uint8Array;
  limits?: Partial<UploadLimits>;
}

export interface InspectResult {
  ok: boolean;
  kind: UploadKind | null;
  problems: Problem[];
  /** Decoded text for a valid CSV (BOM stripped, UTF-16 transcoded). */
  text?: string;
}

const MACRO_EXT = new Set(['xlsm', 'xltm', 'xlam', 'xlsb']);
const LEGACY_EXCEL_EXT = new Set(['xls', 'xlt']);
const ARCHIVE_EXT = new Set(['zip', 'gz', 'tgz', '7z', 'rar', 'tar', 'bz2']);

const CSV_MIME = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'text/x-csv',
  'application/x-csv',
  'text/comma-separated-values',
]);
const XLSX_MIME = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/** Content families we positively recognise (and therefore refuse as csv/xlsx when mismatched). */
export function sniffContent(bytes: Uint8Array): 'pdf' | 'zip' | 'ole2' | 'png' | 'jpeg' | 'gif' | 'gzip' | 'exe' | 'unknown' {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(bytes, [0x4d, 0x5a])) return 'exe';
  return 'unknown';
}

function normaliseMime(m: string | null | undefined): string {
  return (m ?? '').split(';')[0].trim().toLowerCase();
}

/** Decodes CSV bytes to text; UTF-8 (BOM stripped) or UTF-16 LE/BE with a BOM only. */
export function decodeCsvBytes(bytes: Uint8Array): { ok: true; text: string } | { ok: false; problem: Problem } {
  const invalid = (message: string): { ok: false; problem: Problem } => ({
    ok: false,
    problem: { code: 'FILE_ENCODING_INVALID', message },
  });
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      const body = bytes.subarray(2);
      if (body.length % 2 !== 0) return invalid('The UTF-16 text has an odd number of bytes.');
      return { ok: true, text: new TextDecoder('utf-16le', { fatal: true }).decode(body) };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const body = bytes.subarray(2);
      if (body.length % 2 !== 0) return invalid('The UTF-16 text has an odd number of bytes.');
      const swapped = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i += 2) {
        swapped[i] = body[i + 1];
        swapped[i + 1] = body[i];
      }
      return { ok: true, text: new TextDecoder('utf-16le', { fatal: true }).decode(swapped) };
    }
    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const body = bytes.subarray(start);
    if (body.includes(0)) return invalid('The file contains NUL bytes; it is not a plain-text CSV.');
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(body) };
  } catch {
    return invalid('The file is not valid UTF-8 text (UTF-16 is accepted only with a byte-order mark).');
  }
}

export function inspectUpload(input: InspectInput): InspectResult {
  const limits = resolveLimits(input.limits);
  const problems: Problem[] = [];
  const fail = (code: string, message: string): InspectResult => {
    problems.push({ code, message });
    return { ok: false, kind: null, problems };
  };

  try {
    const ext = extensionOf(input.fileName ?? '');
    if (ext === 'csv' || ext === 'xlsx') {
      // allowed below
    } else if (MACRO_EXT.has(ext)) {
      return fail('FILE_EXT_MACRO', `Macro-enabled or binary workbooks (.${ext}) are not accepted. Save the data as .xlsx or .csv.`);
    } else if (LEGACY_EXCEL_EXT.has(ext)) {
      return fail('FILE_EXT_LEGACY_EXCEL', `Legacy Excel files (.${ext}) are not accepted. Save the data as .xlsx or .csv.`);
    } else if (ext === 'pdf') {
      return fail('FILE_EXT_PDF', 'PDF files are not accepted: an index level history must be uploaded as a CSV or XLSX data file.');
    } else if (ARCHIVE_EXT.has(ext)) {
      return fail('FILE_EXT_ARCHIVE', 'Archives (.zip, .gz, ...) are not accepted. Upload the .csv or .xlsx file itself.');
    } else if (ext === 'xml') {
      return fail('FILE_EXT_XML', 'XML files are not accepted. Upload a .csv or .xlsx file.');
    } else {
      return fail('FILE_EXT_UNSUPPORTED', `Only .csv and .xlsx files are accepted (this file is ".${ext || 'none'}").`);
    }

    const bytes = input.bytes;
    if (bytes.length === 0) return fail('FILE_EMPTY', 'The file is empty.');
    if (bytes.length > limits.maxBytes) {
      return fail('FILE_TOO_LARGE', `The file is ${bytes.length} bytes; the limit is ${limits.maxBytes} bytes.`);
    }

    const mime = normaliseMime(input.declaredMime);
    const sniff = sniffContent(bytes);

    if (ext === 'csv') {
      if (sniff !== 'unknown') {
        return fail('FILE_CONTENT_MISMATCH', `The file is named .csv but its content is ${sniff}, not CSV text.`);
      }
      if (!GENERIC_MIME.has(mime) && !CSV_MIME.has(mime)) {
        return fail('FILE_MIME_MISMATCH', `The declared type "${mime}" does not match a CSV file.`);
      }
      const decoded = decodeCsvBytes(bytes);
      if (!decoded.ok) {
        problems.push(decoded.problem);
        return { ok: false, kind: null, problems };
      }
      return { ok: true, kind: 'csv', problems, text: decoded.text };
    }

    // .xlsx
    if (sniff === 'ole2') {
      return fail('FILE_ENCRYPTED_OR_OLE2', 'The file is an older Office or password-protected container, not a plain .xlsx workbook.');
    }
    if (sniff !== 'zip') {
      return fail('FILE_CONTENT_MISMATCH', `The file is named .xlsx but its content is ${sniff === 'unknown' ? 'not a workbook' : sniff}.`);
    }
    if (!GENERIC_MIME.has(mime) && !XLSX_MIME.has(mime)) {
      return fail('FILE_MIME_MISMATCH', `The declared type "${mime}" does not match an XLSX workbook.`);
    }
    const zip = openZip(bytes, limits);
    if (!zip.ok) {
      problems.push(...zip.problems);
      return { ok: false, kind: null, problems };
    }
    // Enforce every entry's declared size at inflate time (catches a lying header).
    for (const e of zip.entries) {
      const r = zip.read(e.name);
      if (!r.ok) {
        problems.push(r.problem);
        return { ok: false, kind: null, problems };
      }
    }
    if (zip.has('xl/vbaProject.bin')) {
      return fail('XLSX_MACRO_PRESENT', 'The workbook contains a macro project (vbaProject.bin); macro workbooks are not accepted.');
    }
    if (!zip.has('[Content_Types].xml') || !zip.has('xl/workbook.xml')) {
      return fail('XLSX_STRUCTURE_INVALID', 'The archive is not an XLSX workbook (missing [Content_Types].xml or xl/workbook.xml).');
    }
    const ct = zip.read('[Content_Types].xml');
    if (ct.ok && new TextDecoder().decode(ct.bytes).includes('macroEnabled')) {
      return fail('XLSX_MACRO_PRESENT', 'The workbook is declared macro-enabled; macro workbooks are not accepted.');
    }
    return { ok: true, kind: 'xlsx', problems };
  } catch (err) {
    // Defence in depth: hostile input must never surface as an exception.
    return fail('FILE_INSPECTION_FAILED', `The file could not be inspected safely (${(err as Error)?.name ?? 'error'}).`);
  }
}
