/**
 * PDF statement routes: local text extraction, shared by the three classes.
 *
 * REUSE: the bank-PDF engine's `extractPdfPages` (pdf-parse, entirely in this server process, no network, no OCR, no third party;
 * the deadline, page ceiling and text ceiling are its own). This wrapper only maps its failure kinds onto the route vocabulary and
 * turns pages into trimmed, whitespace-normalised, page-tagged lines. Nothing here writes, logs or stores document text.
 */

import { extractPdfPages } from '../bank-pdf/textExtraction';
import { toLines, type PdfLine } from './lineParse';
import { pdfFailure, type PdfReadFailure } from './types';

export interface PdfStatementText {
  ok: true;
  pageCount: number;
  pages: string[];
  lines: PdfLine[];
  /** All pages joined by a newline, whitespace-normalised per line. This is the text that is masked and sent to a model if (and only if) the fallback is offered. */
  text: string;
}

export type PdfStatementTextResult = PdfStatementText | PdfReadFailure;

export async function readStatementPdf(bytes: Uint8Array): Promise<PdfStatementTextResult> {
  const r = await extractPdfPages(bytes);
  if (!r.ok) {
    switch (r.kind) {
      case 'password_required':
      case 'wrong_password':
        return pdfFailure('password_required');
      case 'insufficient_text':
        return pdfFailure('image_only');
      case 'page_limit_exceeded':
        return pdfFailure('page_limit');
      case 'timeout':
        return pdfFailure('timeout');
      default:
        return pdfFailure('corrupt');
    }
  }
  const lines = toLines(r.pages);
  return { ok: true, pageCount: r.pageCount, pages: r.pages, lines, text: lines.map((l) => l.text).join('\n') };
}
