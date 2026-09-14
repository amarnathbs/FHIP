/**
 * AIE-1.1 — local/private native PDF text extraction (TXT-01..12).
 *
 * DEPENDENCY DECISION (matches this codebase's own established precedent).
 * `pdf-parse` is already a dependency, already used by
 * `lib/services/investment-intelligence/pdfExtraction.ts` (R2) and
 * `lib/financial-data-hub/bank-pdf/textExtraction.ts` (FDH-5) — NO new PDF
 * library is introduced here. This file is a THIRD thin wrapper rather than
 * importing either existing one directly, for the identical reason FDH-5's
 * own header gives for not importing R2's function: each existing wrapper's
 * return shape and limits are tuned to (and in FDH-5's case, literally
 * imports constants from) its own domain. AIE-1.1 is domain-agnostic by
 * design — it must not import a bank-statement-specific constant file or a
 * CAS-statement-specific one. The extraction TECHNIQUE below (password/
 * corrupt/insufficient-text disambiguation, per-page array, sparse-page
 * detection) is carried over verbatim in substance from FDH-5's own
 * already-proven approach — nothing here is a new algorithm, only a new,
 * domain-neutral home for it. Entirely server-side, in-memory, no network
 * call — nothing leaves this process at this stage (architecture step 4 is
 * strictly BEFORE masking/AI-fallback).
 */

import { PDFParse, PasswordException } from 'pdf-parse';

export const AIE_PDF_MAX_PAGES = 60;
export const AIE_PDF_MAX_EXTRACTED_TEXT_CHARS = 2_000_000;
const MIN_CHARS_PER_PAGE = 40;
const MIN_TOTAL_CHARS = 80;

export type AiePdfExtractionFailureKind =
  | 'password_required'
  | 'wrong_password'
  | 'corrupt'
  | 'insufficient_text'
  | 'page_limit_exceeded'
  | 'unknown_error';

export interface AiePdfExtractionSuccess {
  ok: true;
  pages: string[];
  pageCount: number;
  concatenatedText: string;
  sparsePageIndexes: number[];
}
export interface AiePdfExtractionFailure {
  ok: false;
  kind: AiePdfExtractionFailureKind;
  message: string;
}
export type AiePdfExtractionResult = AiePdfExtractionSuccess | AiePdfExtractionFailure;

export async function extractPdfTextLocally(bytes: Uint8Array, password?: string): Promise<AiePdfExtractionResult> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: bytes, password: password || undefined });
    const info = await parser.getInfo();
    const pageCount = info.total ?? 0;
    if (pageCount > AIE_PDF_MAX_PAGES) {
      return { ok: false, kind: 'page_limit_exceeded', message: `${pageCount} pages exceeds the ${AIE_PDF_MAX_PAGES}-page limit.` };
    }

    const result = await parser.getText();
    const pages = (result.pages ?? []).map((p) =>
      p.text
        .split('\n')
        .filter((line) => !/^--\s*\d+\s+of\s+\d+\s*--$/.test(line.trim()))
        .join('\n'),
    );
    const totalChars = pages.reduce((sum, p) => sum + p.trim().length, 0);
    if (totalChars > AIE_PDF_MAX_EXTRACTED_TEXT_CHARS) {
      return { ok: false, kind: 'page_limit_exceeded', message: 'Extracted text exceeds the safe processing limit.' };
    }
    if (totalChars < MIN_TOTAL_CHARS || totalChars / Math.max(pages.length, 1) < MIN_CHARS_PER_PAGE) {
      return { ok: false, kind: 'insufficient_text', message: 'Not enough extractable text (possibly a scanned/image-only PDF).' };
    }

    const sparsePageIndexes = pages.map((p, idx) => ({ idx, len: p.trim().length })).filter((p) => p.len < MIN_CHARS_PER_PAGE).map((p) => p.idx);

    return { ok: true, pages, pageCount: pages.length, concatenatedText: pages.join('\n'), sparsePageIndexes };
  } catch (err) {
    if (err instanceof PasswordException) {
      return password
        ? { ok: false, kind: 'wrong_password', message: 'The supplied password did not open this document.' }
        : { ok: false, kind: 'password_required', message: 'This document is password-protected.' };
    }
    return { ok: false, kind: 'corrupt', message: 'Could not read this PDF.' };
  } finally {
    if (parser) await parser.destroy().catch(() => undefined);
  }
}
