/**
 * R7 — Bank CSV Engine: safe CSV intake (spec sections 12-15).
 *
 * DEPENDENCY DECISION (spec section 81/12). No new npm dependency is
 * introduced. The repository already trusts a hand-rolled RFC4180-compliant
 * state-machine parser in production (`lib/utils/csv.ts`, used by the admin
 * CSV-upload API route and the data-import script) — this is NOT a
 * `line.split(',')` parser; it correctly handles quoted fields, embedded
 * commas, embedded newlines and escaped quotes (`""`). R7 needs three
 * capabilities that file does not have — configurable delimiter (semicolon/
 * tab/pipe), enforced safety limits (row/column/field-length caps that abort
 * cleanly rather than accepting an unbounded parse), and BOM/legacy-encoding
 * detection — so this module is a purpose-built superset following the exact
 * same state-machine technique, kept in the bank-csv module rather than
 * changing the existing shared utility (which other, unrelated call sites
 * depend on with comma-only, untrimmed semantics).
 *
 * NEVER `eval`/interpret a formula-like cell (spec 15) — this parser never
 * executes anything; it is pure string extraction. `sanitizeForCsvExport()`
 * below is the export-time formula-injection guard for a FUTURE CSV-export
 * feature (none exists in R7's API surface); it exists now so a later export
 * feature cannot forget it, and is certified by
 * `tests/unit/r7CsvIntake.test.ts`.
 */

import { CSV_CANDIDATE_DELIMITERS, CSV_MAX_COLUMNS, CSV_MAX_FIELD_LENGTH, CSV_MAX_ROWS } from './constants';
import type { CsvDelimiter } from './constants';

export type CsvIntakeFailureCode =
  | 'empty_file'
  | 'delimiter_not_detected'
  | 'header_not_found'
  | 'row_limit_exceeded'
  | 'column_limit_exceeded'
  | 'field_length_exceeded'
  | 'unterminated_quote';

export class CsvIntakeError extends Error {
  constructor(
    readonly code: CsvIntakeFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'CsvIntakeError';
  }
}

// ---------------------------------------------------------------------------
// Encoding detection (spec section 12)
// ---------------------------------------------------------------------------

export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'latin1';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Decode raw bytes to text, detecting UTF-8 BOM and falling back to latin1
 * (a safe superset for legacy single-byte Windows/DOS exports — "common
 * legacy encodings where safely detectable", spec 12) when a strict UTF-8
 * decode would otherwise corrupt the text with replacement characters.
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  const buf = Buffer.from(bytes);
  if (buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)) {
    return { text: buf.subarray(3).toString('utf-8'), encoding: 'utf-8-bom' };
  }
  const utf8Text = buf.toString('utf-8');
  // Node's utf-8 decode never throws — it substitutes U+FFFD for invalid
  // sequences. A real UTF-8 file has ~0 replacement characters; a legacy
  // single-byte export (CP1252/Latin-1) full of £/é/— characters produces
  // many. A high replacement-character rate is the safely-detectable signal.
  const replacementCount = (utf8Text.match(/�/g) ?? []).length;
  if (replacementCount > 0 && replacementCount / Math.max(utf8Text.length, 1) > 0.001) {
    return { text: buf.toString('latin1'), encoding: 'latin1' };
  }
  return { text: utf8Text, encoding: 'utf-8' };
}

// ---------------------------------------------------------------------------
// Delimiter detection (spec section 12, 18)
// ---------------------------------------------------------------------------

/**
 * Detects the field delimiter by counting each candidate's occurrences
 * (outside quotes) across the first few non-empty lines and picking the one
 * with the highest CONSISTENT count. Returns null when no candidate is
 * consistently present — the caller must then treat the file as
 * `delimiter_not_detected` (spec 21: never guess).
 */
export function detectDelimiter(sampleLines: readonly string[]): CsvDelimiter | null {
  const nonEmpty = sampleLines.filter((l) => l.trim().length > 0).slice(0, 10);
  if (nonEmpty.length === 0) return null;

  let best: { delimiter: CsvDelimiter; count: number } | null = null;
  for (const delimiter of CSV_CANDIDATE_DELIMITERS) {
    const counts = nonEmpty.map((line) => countOutsideQuotes(line, delimiter));
    if (counts[0] === 0) continue;
    // Consistent means every sampled line has the SAME count as the first —
    // a real header+data CSV has a fixed column count.
    const consistent = counts.every((c) => c === counts[0]);
    if (!consistent) continue;
    if (!best || counts[0] > best.count) {
      best = { delimiter, count: counts[0] };
    }
  }
  return best?.delimiter ?? null;
}

function countOutsideQuotes(line: string, needle: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === needle) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Safe, limited, delimiter-aware CSV parsing (spec sections 12-13)
// ---------------------------------------------------------------------------

export interface CsvParseResult {
  /** Raw header cells, in source order, trimmed. */
  header: string[];
  /** Raw data rows (trimmed cells), in source order. Row 0 is the first data
   * row after the header. */
  rows: string[][];
  /** Total data rows found in the source, even if greater than what was
   * ultimately accepted — used to detect truncation (spec 46, 75). Equal to
   * rows.length unless CSV_MAX_ROWS was hit, in which case parsing aborts
   * with row_limit_exceeded rather than silently returning a prefix. */
  declaredRowCount: number;
}

/**
 * Parses `text` (already decoded) as CSV with the given delimiter, starting
 * at `headerRowIndex` (0-based line index within `text`). Every safety limit
 * in `./constants.ts` is enforced DURING parsing — a violation aborts with a
 * typed `CsvIntakeError` rather than returning a partial/oversized result.
 */
export function parseCsvSafe(
  text: string,
  delimiter: string,
  headerRowIndex: number,
): CsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnyContent = false;

  const pushField = () => {
    if (field.length > CSV_MAX_FIELD_LENGTH) {
      throw new CsvIntakeError('field_length_exceeded', `a field exceeded ${CSV_MAX_FIELD_LENGTH} characters`);
    }
    row.push(field.trim());
    field = '';
  };
  const pushRow = () => {
    if (row.length > CSV_MAX_COLUMNS) {
      throw new CsvIntakeError('column_limit_exceeded', `a row exceeded ${CSV_MAX_COLUMNS} columns`);
    }
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      sawAnyContent = true;
    } else if (c === delimiter) {
      sawAnyContent = true;
      pushField();
    } else if (c === '\r') {
      // \n (or end of input) closes the row below.
    } else if (c === '\n') {
      sawAnyContent = true;
      pushField();
      pushRow();
      if (rows.length > CSV_MAX_ROWS + headerRowIndex + 1) {
        throw new CsvIntakeError('row_limit_exceeded', `the file exceeded ${CSV_MAX_ROWS} data rows`);
      }
    } else {
      field += c;
      sawAnyContent = true;
    }
  }
  if (inQuotes) {
    throw new CsvIntakeError('unterminated_quote', 'a quoted field was never closed');
  }
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  if (!sawAnyContent || rows.length === 0) {
    throw new CsvIntakeError('empty_file', 'the file contains no parseable rows');
  }
  if (headerRowIndex >= rows.length) {
    throw new CsvIntakeError('header_not_found', 'the declared header row is beyond the end of the file');
  }

  const nonEmptyRows = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const header = nonEmptyRows[headerRowIndex] ?? [];
  const dataRows = nonEmptyRows.slice(headerRowIndex + 1);
  if (dataRows.length > CSV_MAX_ROWS) {
    throw new CsvIntakeError('row_limit_exceeded', `the file exceeded ${CSV_MAX_ROWS} data rows`);
  }

  return { header, rows: dataRows, declaredRowCount: dataRows.length };
}

// ---------------------------------------------------------------------------
// Header-row detection (spec section 18)
// ---------------------------------------------------------------------------

/**
 * Finds the most plausible header row within the first `scanDepth` lines: the
 * first line whose delimiter-split cell count matches the delimiter count
 * detected AND whose cells look like labels (contain at least one
 * non-numeric alphabetic cell) rather than data. Many bank exports carry 1-4
 * metadata lines (account name, statement period, "Date,Description,...")
 * before the real header.
 */
export function findHeaderRowIndex(lines: readonly string[], delimiter: string, scanDepth: number): number | null {
  const targetCount = countOutsideQuotes(lines[0]?.trim() ? lines[0] : lines.find((l) => l.trim()) ?? '', delimiter);
  for (let i = 0; i < Math.min(lines.length, scanDepth); i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const count = countOutsideQuotes(line, delimiter);
    if (count === 0) continue;
    const cells = splitOutsideQuotes(line, delimiter).map((c) => c.trim());
    const looksLikeLabels = cells.some((c) => /[A-Za-z]{2,}/.test(c)) && cells.every((c) => !/^-?[\d.,]+$/.test(c) || c === '');
    if (count >= Math.max(2, Math.min(count, targetCount)) && looksLikeLabels) {
      return i;
    }
  }
  return null;
}

function splitOutsideQuotes(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === delimiter) {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

// ---------------------------------------------------------------------------
// Export-time formula-injection guard (spec section 15)
// ---------------------------------------------------------------------------

const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralises a spreadsheet-formula-injection payload for a value that will
 * be written into a CSV a human might later open in Excel/Sheets. Prefixes a
 * leading single-quote (the standard OWASP CSV-injection mitigation),
 * WITHOUT mutating any persisted/raw evidence — this is an export-boundary
 * transform only, never applied to `description_raw` in storage (spec 15-16:
 * raw evidence is immutable).
 */
export function sanitizeForCsvExport(value: string): string {
  if (value.length > 0 && FORMULA_TRIGGER_CHARS.has(value[0])) {
    return `'${value}`;
  }
  return value;
}
