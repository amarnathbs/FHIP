/**
 * PDF statement routes: the small, pure parsing primitives every deterministic layout reader shares.
 *
 * Exact money: amounts are integer MINOR UNITS (cents / paise) end to end; no IEEE-754 value takes part in a comparison.
 * Dates are validated against the calendar and returned as ISO `yyyy-mm-dd`; they are only ever RENDERED day-first elsewhere.
 * Nothing here guesses: an amount, date or identifier that does not fit the stated grammar returns `null`, and the reader
 * above it turns that into `unread_lines` (and so into the AI fallback or a refusal), never into a silent drop.
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_NAME = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** A date token as it may be printed. Two-digit years and year-less forms are deliberately NOT matched. */
export const DATE_TOKEN_SOURCE = String.raw`\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{1,2}\s+${MONTH_NAME}\s+\d{4}`;
const DATE_RE = new RegExp(`^(?:${DATE_TOKEN_SOURCE})$`, 'i');

function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `30/06/2026`, `30-06-2026`, `30.06.2026`, `30 Jun 2026`, `30 June 2026` -> `2026-06-30`; anything else -> null. Day first, always. */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim();
  if (!DATE_RE.test(s)) return null;
  let d: number;
  let m: number;
  let y: number;
  const numeric = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (numeric) {
    d = Number(numeric[1]);
    m = Number(numeric[2]);
    y = Number(numeric[3]);
  } else {
    const named = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!named) return null;
    d = Number(named[1]);
    m = MONTHS[named[2].toLowerCase()] ?? 0;
    y = Number(named[3]);
  }
  if (!isRealDate(y, m, d)) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Finds the first and second dates in a line such as `01/07/2026 to 31/07/2026` or `from 1 Aug 2026 - 31 Aug 2026`. */
export function parseDateRange(text: string): { start: string; end: string } | null {
  const re = new RegExp(DATE_TOKEN_SOURCE, 'gi');
  const found: string[] = [];
  for (const m of text.matchAll(re)) {
    const iso = parseStatementDate(m[0]);
    if (iso) found.push(iso);
  }
  if (found.length < 2) return null;
  const [start, end] = found;
  if (start > end) return null;
  return { start, end };
}

/** The first valid date token in the text, or null. */
export function firstDate(text: string): string | null {
  const re = new RegExp(DATE_TOKEN_SOURCE, 'i');
  const m = text.match(re);
  return m ? parseStatementDate(m[0]) : null;
}

export interface ParsedMoney {
  /** Signed minor units. A minus sign or brackets make it negative; CR/DR are reported in `suffix` and do NOT change the sign. */
  minor: number;
  negative: boolean;
  bracketed: boolean;
  suffix: 'CR' | 'DR' | null;
}

const MONEY_BODY = String.raw`\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const MONEY_FULL = new RegExp(String.raw`^(\()?\s*(-)?\s*(?:[$₹]|Rs\.?|AUD|INR)?\s*(-)?\s*(${MONEY_BODY})\s*(\))?\s*(CR|DR|Cr|Dr)?$`);

/**
 * One money token: `$1,234.56`, `1,23,456.78`, `Rs. 62,400.00`, `-$812.00`, `($231.00)`, `500.00 CR`. Grouping commas are
 * stripped (Western and lakh grouping read the same). `requireDecimals` demands exactly two decimals (every table amount).
 */
export function parseMoney(raw: string, options: { requireDecimals?: boolean } = {}): ParsedMoney | null {
  const m = raw.trim().match(MONEY_FULL);
  if (!m) return null;
  const bracketOpen = Boolean(m[1]);
  const bracketClose = Boolean(m[5]);
  if (bracketOpen !== bracketClose) return null;
  const body = m[4];
  const hasDecimals = /\.\d{1,2}$/.test(body);
  if (options.requireDecimals && !/\.\d{2}$/.test(body)) return null;
  // `1,23` (a single comma group of two digits with nothing after) is not a plausible amount.
  if (!hasDecimals && /,\d{2}$/.test(body)) return null;
  const [intPart, frac = ''] = body.replace(/,/g, '').split('.');
  const minor = Number(intPart) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return null;
  const negative = Boolean(m[2] || m[3]) || bracketOpen;
  const suffix = m[6] ? (m[6].toUpperCase() as 'CR' | 'DR') : null;
  return { minor: negative ? -minor : minor, negative, bracketed: bracketOpen, suffix };
}

/** Minor units to a plain decimal string with two places: `123456` -> `1234.56`, `-5` -> `-0.05`. */
export function minorToDecimalString(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const s = `${Math.floor(abs / 100)}.${pad(abs % 100)}`;
  return neg ? `-${s}` : s;
}

export function minorToNumber(minor: number): number {
  return minor / 100;
}

/** A quantity or unit price as an exact decimal string (up to 6 places), commas stripped; null when it is not one. */
export function parseExactDecimal(raw: string): string | null {
  const s = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  return s;
}

/** Multiply two exact decimal strings and round half up to minor units (cents). Uses BigInt scaling, never floats. */
export function multiplyToMinor(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = af.length + bf.length;
  const prod = BigInt(ai + af) * BigInt(bi + bf); // scaled by 10^scale
  const numerator = prod * BigInt(100);
  const denom = BigInt(10) ** BigInt(scale);
  const q = numerator / denom;
  const r = numerator % denom;
  const rounded = r * BigInt(2) >= denom ? q + BigInt(1) : q;
  return Number(rounded);
}

/** Last four digits of an identifier as `****1234`; null when fewer than four digits are present. A full number is never returned. */
export function maskedLastFour(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `****${digits.slice(-4)}`;
}

/** One non-blank line of a page, with the page number kept. */
export interface PdfLine {
  page: number;
  text: string;
}

export function normaliseWhitespace(s: string): string {
  return s.replace(/[   \t]/g, ' ').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

export function toLines(pages: readonly string[]): PdfLine[] {
  const out: PdfLine[] = [];
  pages.forEach((p, i) => {
    for (const raw of p.split('\n')) {
      const text = normaliseWhitespace(raw);
      if (text) out.push({ page: i + 1, text });
    }
  });
  return out;
}

/** Value after a label on the same line, with an optional colon: `valueAfterLabel('Opening balance: $5', /^opening balance/i)` -> `$5`. */
export function valueAfterLabel(line: string, label: RegExp): string | null {
  const m = line.match(label);
  if (!m) return null;
  const rest = line.slice(m[0].length).replace(/^\s*[:\-]?\s*/, '');
  return rest.length > 0 ? rest : null;
}
