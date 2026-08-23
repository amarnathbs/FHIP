/**
 * FDH-5 — Bank PDF Statement Engine: safe intake limits (spec sections 17,
 * 18, 81-82).
 *
 * FDH-3's `FDH_MAX_FILE_SIZE_BYTES['application/pdf']` (20 MB,
 * `lib/financial-data-hub/domain/fileValidation.ts`) already bounds the raw
 * upload; these are the SECOND, independent layer of defence over the
 * already-accepted bytes — a page-count ceiling and a per-statement
 * transaction-row ceiling, both existing purely to make a pathological or
 * adversarial PDF (a "PDF bomb") fail cleanly and quickly rather than
 * consume unbounded worker time or memory (spec 18, 81-82).
 */

/** Never process a PDF with more pages than this in the synchronous request
 * path (spec 18). A genuine multi-year bank statement export is rarely more
 * than a few dozen pages; this leaves generous headroom while still being a
 * real, enforced ceiling. A PDF over this limit fails cleanly as
 * `PDF_PAGE_LIMIT_EXCEEDED` (error_code `page_limit_exceeded`) rather than
 * being silently truncated or left to run unbounded. */
export const PDF_MAX_PAGES = 60;

/** Never accept more transaction rows than this from a single statement
 * (spec 97-99's own scale ceiling — 5,000 transactions is the largest
 * certified synthetic case). A file that appears to declare more is rejected
 * outright rather than silently truncated, mirroring R7's
 * `CSV_MAX_ROWS` discipline (`bank-csv/constants.ts`). */
export const PDF_MAX_TRANSACTION_ROWS = 5_000;

/** Never scan more raw extracted characters than this while looking for
 * table/row structure — a defensive bound independent of the page limit
 * (a pathologically dense single page must not itself cause unbounded
 * regex work). ~200KB is far beyond what even a very dense multi-page
 * bank statement's text layer occupies. */
export const PDF_MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

/** Minimum statement-level extraction confidence required to proceed past
 * `extracted` into `ready_for_approval`/`approved` without forcing a human
 * review (spec 44-45). Below this, the document is routed to
 * `review_required` (or fails outright as `extraction_low_confidence` when
 * even the ATTEMPT to extract critical fields substantially failed) rather
 * than importing uncertain financial data (spec 7). */
export const PDF_MIN_EXTRACTION_CONFIDENCE = 0.85;

/** Minimum score gap between the best and second-best PDF adapter candidate
 * for detection to resolve as DETECTED rather than AMBIGUOUS (spec 96) —
 * mirrors R7's `DETECTION_CONFIDENCE_GAP` for the same reason: weakening
 * this to force a fixture to pass is explicitly disallowed by the spec.
 */
export const PDF_DETECTION_CONFIDENCE_GAP = 0.15;

/** Minimum absolute confidence for the best PDF adapter candidate to be
 * DETECTED at all (spec 29, 96) — below this, even a lone candidate is
 * UNSUPPORTED_LAYOUT rather than guessed. */
export const PDF_DETECTION_MIN_CONFIDENCE = 0.6;

/** Economic-fingerprint algorithm version used for PDF-sourced rows.
 * DELIBERATELY THE SAME VERSION STRING as R7's CSV engine
 * (`ECONOMIC_FINGERPRINT_VERSION` in `bank-csv/constants.ts`) — the
 * fingerprint ALGORITHM (`bank-csv/fingerprint.ts`'s
 * `computeEconomicFingerprint`) is reused byte-for-byte, unmodified, so a
 * CSV-sourced transaction and a PDF-sourced transaction describing the same
 * economic event fingerprint identically regardless of which engine produced
 * them (spec 57-59's cross-format duplicate detection requirement — this is
 * the mechanism that makes it possible without a second dedup engine). */
export { ECONOMIC_FINGERPRINT_VERSION } from '../bank-csv/constants';

/** Canonical FDH-5 parser/normalisation version, recorded on every processed
 * PDF document and every transaction it produces (spec 16, 27, 37, 86). */
export const FDH5_PARSER_VERSION = 'fdh5-bank-pdf-1.0.0';

/** Rolling-window rate limit for password attempts on one document (spec 24)
 * — mirrors `MAX_UPLOAD_SESSIONS_PER_HOUR`'s discipline
 * (`services/uploadLifecycle.ts`): a sensible, documented per-document limit,
 * not a cracking-resistant enterprise throttle (FDH-5 does not attempt to
 * "resist cracking" beyond this — it exists to stop casual retry abuse, spec
 * 24: "do not attempt cracking" is a statement about FDH-5's OWN behaviour,
 * not a claim about resisting an attacker). */
export const MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR = 8;
