/**
 * PDF statement routes: the outcome vocabulary every class reader shares (docs/ai/pdf_routes_liab_ret_auinv/00_COMMON_SPEC.md section 2).
 */

export type PdfFailureKind =
  | 'password_required'
  | 'image_only'
  | 'corrupt'
  | 'timeout'
  | 'page_limit'
  | 'not_this_class'
  | 'multiple_accounts'
  | 'layout_unsupported'
  | 'unread_lines';

/**
 * The ONLY two outcomes after which a model reading may be offered: the text is there and is a statement of this class, but the
 * certified layouts did not cover it (or did not cover every line of it). Every other outcome has either no text to read, a
 * document that is not this class, or more than one account, and a model call there is pure spend and pure invention risk.
 */
export const AI_ELIGIBLE_PDF_FAILURES: readonly PdfFailureKind[] = ['layout_unsupported', 'unread_lines'];

export function isAiEligiblePdfFailure(kind: PdfFailureKind): boolean {
  return AI_ELIGIBLE_PDF_FAILURES.includes(kind);
}

export interface PdfReadFailure {
  ok: false;
  kind: PdfFailureKind;
  /** Codes and counts only; never document text or figures. */
  detail?: string;
}

export function pdfFailure(kind: PdfFailureKind, detail?: string): PdfReadFailure {
  return detail === undefined ? { ok: false, kind } : { ok: false, kind, detail };
}

/** The user-facing words for each outcome. `label` is the plain name of the document class. Dates never appear here. */
export function pdfFailureMessage(kind: PdfFailureKind, label: string): string {
  switch (kind) {
    case 'password_required':
      return 'This PDF is password protected, so we could not open it. Please upload an unprotected copy.';
    case 'image_only':
      return `This PDF looks like a scan or a photo, so there is no text for us to read. Please download the ${label} again from your provider as a PDF, or add this manually.`;
    case 'corrupt':
      return 'We could not open this PDF. Please download it again and try once more.';
    case 'timeout':
      return 'Reading this PDF took too long, so we stopped. Please try again.';
    case 'page_limit':
      return 'This PDF is longer than we can read in one go (60 pages). Please upload the part you need.';
    case 'not_this_class':
      return `This does not look like a ${label}. Nothing was saved and nothing was charged. Please check you chose the right type of statement.`;
    case 'multiple_accounts':
      return 'This PDF contains more than one account. Please upload one account at a time. Nothing was saved.';
    case 'layout_unsupported':
    case 'unread_lines':
      return `We could not read every line of this ${label}, so we did not guess. You can upload a CSV export, or add this manually.`;
  }
}

/**
 * The stored `fdh_statement_uploads.error_code` for each outcome. Every value is an EXISTING member of the database check
 * (`FDH_ERROR_CODES` and the FDH-5 / canonical-upload additions), so the PDF routes need no migration.
 */
export const PDF_FAILURE_ERROR_CODE: Record<PdfFailureKind, string> = {
  password_required: 'password_required',
  image_only: 'ocr_required',
  corrupt: 'file_corrupt',
  timeout: 'extraction_timeout',
  page_limit: 'page_limit_exceeded',
  not_this_class: 'document_type_not_identified',
  multiple_accounts: 'layout_unsupported',
  layout_unsupported: 'layout_unsupported',
  unread_lines: 'layout_unsupported',
};

/**
 * Outcomes that END the document (`rejected`, terminal): the file is not usable as this class of statement and re-reading it cannot
 * change that. The other outcomes (an unreadable layout, a timeout) end as `failed`.
 */
export const PDF_TERMINAL_REFUSALS: readonly PdfFailureKind[] = [
  'password_required',
  'image_only',
  'corrupt',
  'page_limit',
  'not_this_class',
  'multiple_accounts',
];
