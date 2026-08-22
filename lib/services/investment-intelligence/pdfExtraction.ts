// Investment Intelligence R2 — safe, server-side PDF text extraction
// (spec section 11).
//
// Uses `pdf-parse` (pure-TypeScript, pdf.js-based, runs entirely in this
// Node/Next.js process on the raw bytes already held in memory — NO
// network call, NO third-party AI/OCR API, nothing leaves this server).
// This is the ONLY PDF-parsing dependency added for R2 (see
// docs/investment-intelligence/R2_IMPLEMENTATION_REPORT.md for why it was
// chosen and how it was verified to make zero outbound network requests
// when given `data:` bytes rather than a `url`).
//
// This module NEVER fabricates text for a document it cannot read: a
// scanned/image-only PDF is detected (insufficient extracted text relative
// to page count) and reported as such, not silently treated as empty/zero
// holdings.

import { PDFParse, PasswordException } from 'pdf-parse';

export type PdfExtractionFailureKind = 'password_required' | 'wrong_password' | 'corrupt' | 'insufficient_text' | 'unknown_error';

export interface PdfExtractionSuccess {
  ok: true;
  text: string;
  pageCount: number;
}
export interface PdfExtractionFailure {
  ok: false;
  kind: PdfExtractionFailureKind;
  error: string;
}
export type PdfExtractionResult = PdfExtractionSuccess | PdfExtractionFailure;

// Empirical floor: a genuinely digitally-generated multi-page CAS statement
// (CAMS/KFintech) prints well over 200 characters of text per page (headers,
// column labels, transaction rows). A scanned/image-only PDF, or a PDF
// with an empty/near-empty text layer, produces close to nothing per page.
// This is a heuristic, documented as such — never used to CLAIM certainty
// a document IS scanned, only to safely refuse to proceed on one that
// clearly has no usable text layer, per spec section 11 ("detect
// insufficient text, mark unsupported/review_required, do not fabricate
// data").
const MIN_CHARS_PER_PAGE = 40;
const MIN_TOTAL_CHARS = 80;

export async function extractPdfText(bytes: Uint8Array, password?: string): Promise<PdfExtractionResult> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: bytes, password: password || undefined });
    const result = await parser.getText();
    // pdf-parse inserts "-- N of M --" page-separator marker lines into the
    // concatenated .text output. These are a library formatting artifact,
    // not statement content, and would corrupt line-based parsing
    // (transaction rows, headings) downstream if left in — stripped here,
    // once, at the extraction boundary, rather than in every parser.
    const rawText = result.text ?? '';
    const text = rawText
      .split('\n')
      .filter((line) => !/^--\s*\d+\s+of\s+\d+\s*--$/.test(line.trim()))
      .join('\n');
    const pageCount = result.pages?.length ?? 1;

    if (text.trim().length < MIN_TOTAL_CHARS || text.trim().length / Math.max(pageCount, 1) < MIN_CHARS_PER_PAGE) {
      return {
        ok: false,
        kind: 'insufficient_text',
        error: 'This document does not contain enough extractable text to be a digitally-generated statement (it may be a scanned/image-only PDF). R2 does not perform OCR and will not fabricate data from an unreadable document.',
      };
    }

    return { ok: true, text, pageCount };
  } catch (err) {
    if (err instanceof PasswordException) {
      // Whether this means "a password is required" or "the supplied
      // password was wrong" is determined by whether the CALLER supplied
      // one — not by parsing pdf.js's internal exception message/cause,
      // which is not a stable contract across pdf-parse versions. This is
      // simpler and just as correct: PDFParse only throws PasswordException
      // when either (a) no password was given to an encrypted file, or
      // (b) a password WAS given and it did not work — those are exactly
      // the two cases spec section 10 requires distinguishing.
      return password
        ? { ok: false, kind: 'wrong_password', error: 'The supplied password did not open this document. Please check the password and try again.' }
        : { ok: false, kind: 'password_required', error: 'This document is password-protected. Please supply the document password to continue.' };
    }
    const message = err instanceof Error ? err.message : String(err);
    // pdf.js's own InvalidPDFException / FormatError / generic parse
    // failures all land here — treated uniformly as "corrupt", a safe,
    // retryable, non-fabricating outcome (spec section 37: "corrupted PDF").
    return { ok: false, kind: 'corrupt', error: `Could not read this PDF: ${message}` };
  } finally {
    // Always released, per pdf-parse's own documented contract — even on
    // the password-failure path, so a retry with the correct password does
    // not leak parser state (spec section 10: "processing must remain
    // retryable").
    if (parser) await parser.destroy().catch(() => undefined);
  }
}
