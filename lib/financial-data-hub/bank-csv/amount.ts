/**
 * R7 — Bank CSV Engine: amount-field parsing (spec sections 25-26).
 *
 * Every bank CSV expresses money as TEXT: "1,234.56", "(1,234.56)" for a
 * negative/parenthesised amount, "-1234.56", "$1,234.56", "₹1,234.56". This
 * module turns that text into an exact positive-magnitude number and a
 * separately-reported sign, doing NO binary-floating-point arithmetic on the
 * value itself (it only strips characters and calls `Number()` once on a
 * clean digit-and-decimal-point string). The canonical persisted value goes
 * through `lib/financial-data-hub/domain/money.ts` from there on, which is
 * the single place minor-unit-exact arithmetic happens.
 */

export interface ParsedAmount {
  ok: boolean;
  /** Positive magnitude, or null when parsing failed. */
  magnitude: number | null;
  /** True when the raw text itself signalled a negative value (leading '-'
   * or parenthesised) — the CALLER combines this with any separate debit/
   * credit/Dr-Cr column to reach the final canonical direction (spec 25). */
  isNegative: boolean;
}

const CURRENCY_SYMBOLS = /[$₹€£]/g;

export function parseAmountField(raw: string): ParsedAmount {
  const fail: ParsedAmount = { ok: false, magnitude: null, isNegative: false };
  let s = raw.trim();
  if (!s) return fail;

  let isNegative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    isNegative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    isNegative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  s = s.replace(CURRENCY_SYMBOLS, '').trim();
  // Thousands separators: comma-grouped (1,234.56) is the only convention
  // this module accepts — a space-grouped or period-grouped (European)
  // convention is NOT guessed; such a value fails to parse cleanly here
  // (it will not match \d[\d,]*\.\d{0,4} once commas are stripped) and the
  // caller surfaces it as a data-validation issue rather than silently
  // misreading it.
  s = s.replace(/,/g, '');

  if (!/^\d+(\.\d{1,4})?$/.test(s)) return fail;
  const magnitude = Number(s);
  if (!Number.isFinite(magnitude)) return fail;
  return { ok: true, magnitude, isNegative };
}

/** Rounds to the money scale FDH persists (numeric(20,4)) — protects against
 * float noise from the single `Number()` parse above before the value is
 * ever compared or summed via `domain/money.ts`. */
export function roundToMoneyScale(value: number): number {
  return Number(value.toFixed(4));
}
