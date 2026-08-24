/**
 * FDH-5 — Bank PDF Statement Engine: adapter contract (spec sections 26-31,
 * 55-56).
 *
 * `PdfBankAdapter` is a pure, side-effect-free description of one bank's PDF
 * statement layout plus the logic to recognise and read it — the direct PDF
 * analogue of `bank-csv/adapters/types.ts`'s `BankCsvAdapter`, extending the
 * SAME parser-registry architecture for a second `document_format` rather
 * than inventing a parallel one (spec 26). Adapters never touch the
 * database and never do I/O.
 *
 * conceptually maps to spec 26's `detect()` / `extractStatementMetadata()` /
 * `extractTransactions()` / `validateExtraction()` / `normalize()` — realised
 * here as: `detect()` = `scoreText()` (below) driven by `detection.ts`;
 * `extractStatementMetadata()` = `metadataPatterns`; `extractTransactions()`
 * = `rowReconstruction.ts` driven by `dateLineRegex`/`headerFooterPatterns`;
 * `normalize()` = `bank-pdf/normalize.ts`; `validateExtraction()` =
 * `bank-pdf/orchestrator.ts`'s certification decision (reusing
 * `bank-csv/orchestrator.ts`'s `decideCertification` exactly, see that
 * module's header comment).
 */

import type { FdhCsvAmountConvention } from '../../constants/enums';
import type { SupportedDateFormat } from '../../bank-csv/dateFormats';

export type PdfAdapterCertificationState = 'certified' | 'experimental';

/** Layout evidence used to identify which adapter a given extracted PDF text
 * matches (spec 28-29) — text markers, never the filename. Matched
 * case-insensitively as a plain substring search over the WHOLE document's
 * extracted text (concatenation of all pages), which is sufficient
 * precision for the priority-bank statement layouts FDH-5 certifies (spec
 * 96's ambiguity threshold is what actually adjudicates a close call, not
 * this matching primitive's own precision). */
export interface PdfAdapterSignature {
  /** Every one of these substrings must be present for this adapter to be
   * considered at all (e.g. the bank's own name/brand plus "Statement of
   * Account" or equivalent boilerplate) — spec 29: a user-selected
   * institution alone is never sufficient proof. */
  requiredMarkers: string[];
  /** Column-header labels expected in the transaction table (e.g. "Date",
   * "Transaction Details", "Debit", "Credit", "Balance") — presence
   * increases confidence but a missing one does not disqualify outright. */
  optionalMarkers?: string[];
}

export interface PdfStatementMetadataPatterns {
  /** First capture group = the raw balance text (spec 36-37). */
  openingBalance?: RegExp;
  closingBalance?: RegExp;
  /** First capture group = the raw masked/last-4-or-so account text — never
   * a full account number pattern (spec 37 reuses FDH's existing masked-
   * identifier discipline; adapters must not capture 7+ consecutive
   * digits). */
  maskedAccountIdentifier?: RegExp;
  statementPeriodStart?: RegExp;
  statementPeriodEnd?: RegExp;
}

export interface PdfBankAdapter {
  /** Stable identifier, matches `fdh_parser_registry.parser_key`. Includes
   * a layout-version suffix (`_v1`, `_v2`, ...) so a later certified layout
   * change is a NEW adapter entry, never a silent in-place rewrite (spec
   * 30-31: multi-layout banks / layout drift). */
  id: string;
  institutionCode: string | null;
  country: 'AU' | 'IN' | null;
  version: string;
  certificationState: PdfAdapterCertificationState;
  displayName: string;
  signature: PdfAdapterSignature;
  /** Which extraction method(s) this specific adapter entry is certified
   * against (spec 55-56) — kept separate from `certificationState`. An
   * adapter row with only `['native_text']` must never be presented to a
   * user as "certified" for a scanned/OCR version of the same bank's
   * layout. */
  certifiedExtractionMethods: ('native_text' | 'ocr')[];
  amountConvention: FdhCsvAmountConvention;
  dateFormat: SupportedDateFormat;
  /** Matches the START of a transaction line: capture group 1 = the raw
   * date text, capture group 2 (optional) = the remainder of that same
   * line. Anchored at line start (`^`) — see `rowReconstruction.ts`. */
  dateLineRegex: RegExp;
  /** Lines to discard outright before block-building — repeated table
   * headers, page-footer boilerplate, "continued" markers (spec 35). */
  headerFooterPatterns: RegExp[];
  metadataPatterns: PdfStatementMetadataPatterns;
  /** Pure confidence scorer over the WHOLE extracted document text, in
   * [0, 1] — mirrors `scoreHeaderAgainstSignature`'s discipline exactly
   * (bank-csv/adapters/types.ts). */
  scoreText(fullText: string): number;
}

export function normaliseMarkerText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ');
}

/** Generic confidence scorer shared by every PDF adapter — fraction of
 * required markers present (mandatory: ALL must be present or the score is
 * 0, matching `scoreHeaderAgainstSignature`'s exact-match discipline and its
 * documented reason: a near-miss on a REQUIRED signal must never silently
 * score close enough to a real match), weighted 0.8, plus up to 0.2 for
 * optional markers found. */
export function scoreTextAgainstSignature(fullText: string, signature: PdfAdapterSignature): number {
  const normalised = normaliseMarkerText(fullText);
  const requiredHits = signature.requiredMarkers.filter((m) => normalised.includes(normaliseMarkerText(m))).length;
  if (requiredHits < signature.requiredMarkers.length) return 0;
  const requiredScore = 0.8;
  const optional = signature.optionalMarkers ?? [];
  const optionalHits = optional.filter((m) => normalised.includes(normaliseMarkerText(m))).length;
  const optionalScore = optional.length > 0 ? 0.2 * (optionalHits / optional.length) : 0.2;
  return Math.min(1, requiredScore + optionalScore);
}
