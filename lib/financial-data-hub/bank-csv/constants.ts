/**
 * R7 — Bank CSV Engine: safe intake limits (spec section 13).
 *
 * Explicit, conservative bounds chosen from the shape of a real bank CSV
 * export: even a multi-year, multi-account transaction history rarely
 * exceeds tens of thousands of rows, and a bank CSV's row is a handful of
 * short fields. These bounds exist so a malformed or adversarial input fails
 * cleanly (a controlled `row_limit_exceeded`-shaped rejection) rather than
 * exhausting memory or CPU. `fdh_statement_uploads.file_size_bytes` is
 * already capped at `FDH_MAX_FILE_SIZE_BYTES['text/csv']` (10 MB) by FDH-3's
 * file-validation gate before this module ever runs — the limits here are a
 * SECOND, independent layer over the already-accepted bytes.
 */

/** Never parse more than this many data rows from a single CSV. A file
 * declaring more rows than this is rejected outright rather than silently
 * truncated (spec section 46: no half-import becomes authoritative
 * unnoticed) — see `R7_CANONICAL_TRANSACTION_CONTRACT.md` for the exact
 * REJECTED-vs-PARTIAL decision table. */
export const CSV_MAX_ROWS = 50_000;

/** Never scan more than this many lines while looking for the header row. */
export const CSV_HEADER_SCAN_DEPTH = 25;

/** Never accept more columns than this in one row — a defence against a
 * pathological (or adversarial) file with thousands of empty delimiters. */
export const CSV_MAX_COLUMNS = 100;

/** Never accept a single field longer than this many characters — a
 * malformed unterminated quote must not allow one "field" to swallow
 * megabytes of the file. */
export const CSV_MAX_FIELD_LENGTH = 10_000;

/** Delimiters the detector tries, in this priority order (spec section 12). */
export const CSV_CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_CANDIDATE_DELIMITERS)[number];

/** Minimum score gap between the best and second-best adapter candidate for
 * detection to resolve as DETECTED rather than AMBIGUOUS (spec section 21). */
export const DETECTION_CONFIDENCE_GAP = 0.15;

/** Minimum absolute confidence for the best candidate to be DETECTED at all
 * (below this, even a lone candidate is UNSUPPORTED rather than guessed). */
export const DETECTION_MIN_CONFIDENCE = 0.6;

/** Economic-fingerprint algorithm version — bump when the fingerprint
 * inputs or normalisation change, so historical fingerprints are never
 * silently reinterpreted (spec section 35). */
export const ECONOMIC_FINGERPRINT_VERSION = 'r7-fp-v1';

/** Canonical R7 parser/normalisation version, recorded on every processed
 * document and every transaction it produces (spec section 16, 37). */
export const R7_PARSER_VERSION = 'r7-bank-csv-1.0.0';
