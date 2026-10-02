// Typed-date helpers for text inputs (day first), the counterpart of
// lib/engines/date.ts's display formatter.
//
// PO rule (Document2 findings #8/#19): user-visible dates are day-first --
// dd-mm-yyyy for India, dd/mm/yyyy for Australia -- never ISO year-first and
// never US month-first. A native <input type="date"> renders in the BROWSER's
// locale (often month-first) and cannot be made to follow this rule, so date
// entry uses a text field that shows the placeholder DATE_INPUT_PLACEHOLDER
// and is read with parseDateInput(). The API wire format stays ISO
// (yyyy-mm-dd); this module only converts at the screen boundary.

/** The placeholder every typed date field shows. */
export const DATE_INPUT_PLACEHOLDER = 'DD-MM-YYYY';

/** One-line help for typed date fields (words, with a worked example). */
export const DATE_INPUT_HINT = 'Type the date as day-month-year, like 01-10-2026.';

/** Earliest and latest year a typed date may carry. */
export const DATE_INPUT_MIN_YEAR = 1900;
export const DATE_INPUT_MAX_YEAR = 2100;

// Day, month and 4-digit year separated by "-", "/" or "." (the same separator
// twice). Surrounding whitespace is ignored. One- or two-digit day and month.
const TYPED = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Reads a day-first typed date (DD-MM-YYYY, also DD/MM/YYYY or DD.MM.YYYY, one
 * or two digit day and month) and returns the ISO date-only string
 * "yyyy-mm-dd", or null when the text is not a real calendar date in range.
 * Never guesses: month-first and year-first text is rejected, not reinterpreted.
 */
export function parseDateInput(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const m = TYPED.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[3]);
  const year = Number(m[4]);
  if (year < DATE_INPUT_MIN_YEAR || year > DATE_INPUT_MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** True when the text is a valid day-first typed date. */
export function isDateInput(text: string | null | undefined): boolean {
  return parseDateInput(text) !== null;
}

/**
 * ISO date-only string -> DD-MM-YYYY (what a typed field shows), or '' when the
 * value is not an ISO date-only string. This is for filling an input, not for
 * displaying a stored date (use formatDateShort with the right currency).
 */
export function formatDateInput(iso: string | null | undefined): string {
  if (typeof iso !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}
