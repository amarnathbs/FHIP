/**
 * FDH-9 — payslip text/money normalisation.
 *
 * WHY THIS IS NOT `bank-csv/amountParsing`. A bank CSV amount arrives in a
 * known column under a known, DETECTED convention (single signed / debit-credit
 * columns / DR-CR indicator — see FDH_CSV_AMOUNT_CONVENTIONS). A payslip amount
 * arrives as free text on a line whose layout differs per employer. The two
 * problems share only the phrase "parse a number", so this module solves the
 * payslip one narrowly rather than widening a certified R7 contract for a
 * caller it was never designed for — the same boundary reasoning FDH-5's
 * `textExtraction.ts` header records for R2's PDF extractor.
 *
 * INDIAN DIGIT GROUPING IS THE REASON THIS FILE IS CAREFUL. Indian payslips
 * write fifteen lakh as `15,00,000.00`, not `1,500,000.00`. A parser that
 * strips only groups of exactly three digits, or that treats the last comma as
 * a decimal separator, silently produces a wrong salary. The rule used here is
 * deliberately simple and total: a comma is ALWAYS a group separator and a dot
 * is ALWAYS the decimal point, for both AU and India, because both locales use
 * `.` for decimals. European `1.234,56` is NOT accepted, and is rejected rather
 * than guessed at — no AU or India payslip uses it, and guessing would be the
 * kind of silent wrongness this module exists to prevent.
 */

/** Characters that may legitimately precede/follow an amount on a payslip. */
const CURRENCY_SYMBOLS = /[$₹]|(?:\b(?:AUD|INR|Rs\.?|INR\.)\b)/gi;

/**
 * Parse a money token from payslip text.
 *
 * Returns `undefined` — never `0` — when the token is not a number. A payslip
 * that does not disclose a figure is materially different from one that
 * discloses zero, and FDH-9 never collapses the two.
 *
 * Handles: `$4,250.00`, `₹1,50,000.00`, `4250`, `4,250.5`, `(120.00)` and
 * `-120.00` (both negative), `1,50,000` (Indian grouping), `Rs. 75,000`.
 */
export function parsePayslipMoney(token: string | undefined | null): number | undefined {
  if (token === undefined || token === null) return undefined;

  let text = String(token).trim();
  if (!text) return undefined;

  // Accounting negatives: (120.00) means -120.00.
  let negative = false;
  const parenthesised = /^\((.*)\)$/.exec(text);
  if (parenthesised) {
    negative = true;
    text = parenthesised[1].trim();
  }

  text = text.replace(CURRENCY_SYMBOLS, '').trim();

  if (/^-/.test(text)) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  // A trailing minus (`120.00-`) is used by some payroll systems.
  if (/-$/.test(text)) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  }

  // Reject anything that is not digits, commas, spaces and at most one dot.
  if (!/^[\d, ]*(?:\.\d+)?$/.test(text)) return undefined;
  if ((text.match(/\./g) ?? []).length > 1) return undefined;

  // European decimal-comma format is explicitly NOT guessed at.
  if (/,\d{1,2}$/.test(text) && !text.includes('.')) return undefined;

  const cleaned = text.replace(/[, ]/g, '');
  if (!cleaned || !/^\d*(?:\.\d+)?$/.test(cleaned)) return undefined;
  if (cleaned === '' || cleaned === '.') return undefined;

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return undefined;

  return negative ? -value : value;
}

/**
 * Every money-looking token on a line, left to right.
 *
 * Payslip lines routinely carry two or three figures — the current-period
 * amount and the year-to-date amount, sometimes with a rate or units in
 * between. The caller decides which column means what; this function only
 * finds candidates, and never assumes the last one is the total.
 */
export function extractMoneyTokens(line: string): number[] {
  const matches = line.match(/\(?\s*(?:[$₹]|Rs\.?\s*)?-?\s*\d[\d, ]*(?:\.\d+)?\s*-?\)?/g) ?? [];
  const out: number[] = [];
  for (const raw of matches) {
    const value = parsePayslipMoney(raw);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * Money tokens from a line, restricted to tokens that are actually SHAPED like
 * a payslip amount.
 *
 * WHY THIS EXISTS. `extractMoneyTokens` finds every number, which is right for
 * a known amount column but wrong for a whole payslip line. Real payslips are
 * full of small bare integers that are not money:
 *
 *     Pay Period: 03/08/2026 - 16/08/2026     -> 03, 08, 2026, 16 ...
 *     ABN 12 345 678 901                      -> 12345678901
 *     Ordinary Hours   76.00 hrs @ 52.63
 *
 * Treating "03" as this fortnight's base pay is exactly the kind of silent
 * wrongness FDH-9 must not produce. A token counts as money-shaped when it
 * carries a currency symbol, a decimal fraction, comma grouping, or is a run of
 * at least three digits (so India's `50000` still qualifies, while a day or
 * month number does not).
 *
 * Date substrings are removed BEFORE scanning, so `16/08/2026` cannot
 * contribute `2026` as an amount.
 */
const DATE_LIKE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4}/g;

export function extractAmountTokens(line: string): number[] {
  const withoutDates = line.replace(DATE_LIKE, ' ');
  const matches = withoutDates.match(/\(?\s*(?:[$₹]|Rs\.?\s*)?-?\s*\d[\d, ]*(?:\.\d+)?\s*-?\)?/g) ?? [];
  const out: number[] = [];
  for (const raw of matches) {
    const token = raw.trim();
    const digitsOnly = token.replace(/[^\d]/g, '');
    const moneyShaped =
      /[$₹]|Rs\.?/i.test(token)
      || /\.\d{1,2}\b/.test(token)
      || /\d,\d/.test(token)
      || digitsOnly.length >= 3;
    if (!moneyShaped) continue;
    const value = parsePayslipMoney(token);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** Collapse whitespace and lowercase, for label matching. */
export function normaliseLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Employer-name normalisation, used for matching and duplicate detection only
 * — never displayed. Strips the legal-suffix noise that makes "ABC Pty Ltd",
 * "ABC PTY. LTD." and "ABC Private Limited" look like three employers.
 */
const LEGAL_SUFFIXES = [
  'pty ltd', 'pty limited', 'proprietary limited', 'private limited', 'pvt ltd',
  'pvt limited', 'limited', 'ltd', 'llp', 'inc', 'incorporated', 'plc', 'corp',
  'corporation', 'company', 'co',
];

export function normaliseEmployerName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  let out = normaliseLabel(name);
  if (!out) return undefined;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (out.endsWith(` ${suffix}`)) {
        out = out.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return out || undefined;
}

/**
 * Date parsing for payslip text.
 *
 * AU writes `15/08/2026` (DD/MM/YYYY); India writes `15/08/2026` too. Neither
 * uses MM/DD/YYYY, so a slash/dot/dash-separated numeric date is read as
 * day-first for both — stated explicitly rather than left to chance, because
 * getting this backwards silently shifts a pay period by months. `2026-08-15`
 * (ISO) is also accepted, as is `15 Aug 2026` / `15 August 2026`.
 *
 * Returns an ISO `YYYY-MM-DD` string, or undefined.
 */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  // Reject impossible days (31 Feb) using a real date round-trip.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parsePayslipDate(token: string | undefined | null): string | undefined {
  if (!token) return undefined;
  const text = String(token).trim();
  if (!text) return undefined;

  // ISO first — unambiguous.
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (isoMatch) return iso(+isoMatch[1], +isoMatch[2], +isoMatch[3]);

  // `15 Aug 2026` / `15 August 2026` / `Aug 15 2026`
  const dmy = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})$/.exec(text);
  if (dmy) {
    const month = MONTHS[dmy[2].toLowerCase().slice(0, 4)] ?? MONTHS[dmy[2].toLowerCase().slice(0, 3)];
    if (month) return iso(normaliseYear(+dmy[3]), month, +dmy[1]);
  }
  const mdy = /^([A-Za-z]{3,9})[\s-]+(\d{1,2})[\s,-]+(\d{2,4})$/.exec(text);
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase().slice(0, 4)] ?? MONTHS[mdy[1].toLowerCase().slice(0, 3)];
    if (month) return iso(normaliseYear(+mdy[3]), month, +mdy[2]);
  }

  // Numeric, DAY FIRST for both AU and India.
  const numeric = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(text);
  if (numeric) return iso(normaliseYear(+numeric[3]), +numeric[2], +numeric[1]);

  return undefined;
}

function normaliseYear(year: number): number {
  if (year >= 1000) return year;
  // Two-digit years on a payslip are recent, not 19xx.
  return year >= 70 ? 1900 + year : 2000 + year;
}

/** Find the first parseable date anywhere in a line. */
export function findDateInLine(line: string): string | undefined {
  const candidates = line.match(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4}|[A-Za-z]{3,9}[\s-]+\d{1,2}[\s,-]+\d{2,4}/g) ?? [];
  for (const c of candidates) {
    const parsed = parsePayslipDate(c.trim());
    if (parsed) return parsed;
  }
  return undefined;
}
