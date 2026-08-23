/**
 * FDH-5 — Bank PDF Statement Engine: PDF structural classification (spec
 * sections 13-16).
 *
 * Determines TEXT_NATIVE / IMAGE_ONLY / MIXED_CONTENT / ENCRYPTED / CORRUPT /
 * UNSUPPORTED from ACTUAL PDF STRUCTURE — never from the filename (spec 15).
 * "Native text first" (spec 14): this module always attempts native
 * extraction before anything else; it never OCRs a clean text PDF merely
 * because OCR tooling might exist.
 */

import type { FdhPdfClassification } from '../constants/enums';
import { extractPdfPages, type PdfTextExtractionResult } from './textExtraction';

export interface PdfClassificationResult {
  classification: FdhPdfClassification;
  pageCount: number | null;
  /** Present only for TEXT_NATIVE/MIXED_CONTENT — ephemeral, in-memory only,
   * never persisted (spec 21, 75). */
  pages: string[] | null;
  sparsePageIndexes: number[];
  /** Controlled diagnostic — never a stack trace or library message leaked
   * to a user (spec 84); safe to log (spec 20). */
  reasonCode:
    | 'ok'
    | 'password_required'
    | 'wrong_password'
    | 'corrupt'
    | 'page_limit_exceeded'
    | 'insufficient_text'
    | 'unknown_error';
}

/**
 * Classifies one PDF's structure and, when it is text-native or mixed,
 * returns the extracted per-page text in the SAME call (spec 14: attempting
 * extraction is how TEXT_NATIVE is actually distinguished from IMAGE_ONLY —
 * there is no cheaper structural signal that would not itself risk a false
 * classification). `password`, when supplied, is used ONLY for this one
 * in-memory attempt and is never retained by this function or its caller
 * (spec 22-25).
 */
export async function classifyPdf(bytes: Uint8Array, password?: string): Promise<PdfClassificationResult> {
  const extraction: PdfTextExtractionResult = await extractPdfPages(bytes, password);

  if (!extraction.ok) {
    const mapping: Record<typeof extraction.kind, FdhPdfClassification> = {
      password_required: 'encrypted',
      wrong_password: 'encrypted',
      corrupt: 'corrupt',
      page_limit_exceeded: 'unsupported',
      insufficient_text: 'image_only',
      unknown_error: 'unsupported',
    };
    return {
      classification: mapping[extraction.kind],
      pageCount: null,
      pages: null,
      sparsePageIndexes: [],
      reasonCode: extraction.kind,
    };
  }

  const classification: FdhPdfClassification = extraction.sparsePageIndexes.length > 0 ? 'mixed_content' : 'text_native';
  return {
    classification,
    pageCount: extraction.pageCount,
    pages: extraction.pages,
    sparsePageIndexes: extraction.sparsePageIndexes,
    reasonCode: 'ok',
  };
}
