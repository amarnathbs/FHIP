/**
 * FDH-5 — Bank PDF Statement Engine: safe, server-side, page-segmented PDF
 * text extraction (spec sections 8, 13-16, 19-25, 33-35, 41, 87, 91-92).
 *
 * DEPENDENCY DECISION (spec section 123): uses `pdf-parse` (pure-TypeScript,
 * pdf.js-based), the SAME package Investment Intelligence R2 already added
 * and certified (`lib/services/investment-intelligence/pdfExtraction.ts`,
 * `docs/investment-intelligence/R2_IMPLEMENTATION_REPORT.md`) — no NEW PDF
 * parsing dependency is introduced for FDH-5. It runs entirely in this
 * Node/Next.js server process on bytes already held in memory: no network
 * call, no third-party AI/OCR API, nothing leaves this server (spec 19, 43).
 *
 * WHY THIS IS A NEW FILE RATHER THAN IMPORTING R2's `extractPdfText`
 * DIRECTLY. R2's function is correct and well-tested for its own purpose,
 * but it collapses the document to ONE concatenated string + a page COUNT —
 * exactly enough for a CAS statement's balance-sheet-style reading, but not
 * enough for FDH-5, which needs each page's text SEPARATELY (spec 87 page
 * provenance, spec 34 page-break transaction handling, spec 15 per-page
 * classification signal). Modifying R2's return shape would touch an
 * already-certified, unrelated module's contract for a caller it was never
 * designed for; adding a second, PDF-domain-specific wrapper with its own
 * narrow contract is the safer boundary — exactly the same reasoning
 * `bank-csv/dateFormats.ts`'s FDH-5 additions used for extending vs.
 * duplicating. The PASSWORD/CORRUPT/INSUFFICIENT-TEXT detection logic below
 * intentionally mirrors R2's already-proven approach (same library, same
 * `PasswordException` disambiguation rule, same "never fabricate text"
 * principle) rather than inventing a new one.
 *
 * NO RAW PDF LOGGING (spec 20). This module returns extracted text to its
 * caller for in-memory processing only; nothing here writes text, bytes or a
 * password to a log, and callers (`bank-pdf/orchestrator.ts` and the
 * processing service) are documented to do the same.
 */

import { PDFParse, PasswordException } from 'pdf-parse';
import { PDF_MAX_PAGES, PDF_MAX_EXTRACTED_TEXT_CHARS } from './constants';

export type PdfTextExtractionFailureKind =
  | 'password_required'
  | 'wrong_password'
  | 'corrupt'
  | 'insufficient_text'
  | 'page_limit_exceeded'
  | 'unknown_error';

export interface PdfTextExtractionSuccess {
  ok: true;
  /** One entry per page, 1-indexed by position (pages[0] is page 1) — the
   * page-separator marker lines `pdf-parse` inserts into its concatenated
   * output are never present here; each entry is that page's own text only
   * (spec 87). */
  pages: string[];
  pageCount: number;
  /** True when the extracted-text-per-page ratio was healthy across the
   * WHOLE document but at least one individual page fell short — a MIXED
   * text/image statement (spec 15's MIXED_CONTENT), not outright
   * IMAGE_ONLY. Never silently dropped: the caller decides how to treat
   * such a page (spec 7: prefer REVIEW_REQUIRED over guessing). */
  sparsePageIndexes: number[];
}
export interface PdfTextExtractionFailure {
  ok: false;
  kind: PdfTextExtractionFailureKind;
  error: string;
}
export type PdfTextExtractionResult = PdfTextExtractionSuccess | PdfTextExtractionFailure;

// Empirical floor carried over from Investment Intelligence R2's own
// certified heuristic (spec 15's own guidance: "use actual PDF structure").
// A genuinely digitally-generated bank statement page (header + a handful of
// transaction rows + footer) comfortably clears this; a scanned/image-only
// page produces close to nothing. Documented as a heuristic, not a proof —
// see FDH5_NATIVE_TEXT_EXTRACTION.md "Known limitation" section: this
// threshold was tuned against R2's CAS-statement fixtures, not re-derived
// from bank-statement-specific samples, and is deliberately conservative
// (low) so a genuine but sparse real page is not wrongly routed to OCR.
const MIN_CHARS_PER_PAGE = 40;
const MIN_TOTAL_CHARS = 80;

export async function extractPdfPages(bytes: Uint8Array, password?: string): Promise<PdfTextExtractionResult> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: bytes, password: password || undefined });
    const info = await parser.getInfo();
    const pageCount = info.total ?? 0;
    if (pageCount > PDF_MAX_PAGES) {
      return {
        ok: false,
        kind: 'page_limit_exceeded',
        error: `This statement has ${pageCount} pages, which exceeds the ${PDF_MAX_PAGES}-page limit for a single import.`,
      };
    }

    const result = await parser.getText();
    const pages = (result.pages ?? []).map((p) =>
      p.text
        .split('\n')
        .filter((line) => !/^--\s*\d+\s+of\s+\d+\s*--$/.test(line.trim()))
        .join('\n'),
    );
    const totalChars = pages.reduce((sum, p) => sum + p.trim().length, 0);
    if (totalChars > PDF_MAX_EXTRACTED_TEXT_CHARS) {
      return {
        ok: false,
        kind: 'page_limit_exceeded',
        error: 'This statement contains more extractable text than can be safely processed in one import.',
      };
    }

    if (totalChars < MIN_TOTAL_CHARS || totalChars / Math.max(pages.length, 1) < MIN_CHARS_PER_PAGE) {
      return {
        ok: false,
        kind: 'insufficient_text',
        error: 'This document does not contain enough extractable text to be read as a digitally-generated statement (it may be a scanned/image-only PDF).',
      };
    }

    const sparsePageIndexes = pages
      .map((p, idx) => ({ idx, len: p.trim().length }))
      .filter((p) => p.len < MIN_CHARS_PER_PAGE)
      .map((p) => p.idx);

    return { ok: true, pages, pageCount: pages.length, sparsePageIndexes };
  } catch (err) {
    if (err instanceof PasswordException) {
      // Same disambiguation rule Investment Intelligence R2 already proved
      // out: whether this means "a password is required" or "the supplied
      // password was wrong" is determined by whether the CALLER supplied
      // one, not by parsing pdf.js's internal exception message (not a
      // stable contract across pdf-parse versions) — spec 22/24's exact two
      // required states.
      return password
        ? { ok: false, kind: 'wrong_password', error: 'The supplied password did not open this document.' }
        : { ok: false, kind: 'password_required', error: 'This document is password-protected.' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'corrupt', error: `Could not read this PDF: ${message}` };
  } finally {
    // Always released — including on the password-failure path, so a retry
    // with the correct password does not leak parser state (spec 25: the
    // decrypt attempt and its in-memory artefacts are disposed regardless of
    // outcome).
    if (parser) await parser.destroy().catch(() => undefined);
  }
}
