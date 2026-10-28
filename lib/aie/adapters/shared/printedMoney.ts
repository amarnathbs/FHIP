/**
 * AIE document-fallback adapters -- deterministic normaliser for a money figure the model copied in the document's OWN printed
 * shape (28-10-2026, production defect: a real 10-page NAB statement read by AI in 43 parts; 16 provider outcomes were
 * `schema_rejected` because `transactions.N.balanceAfter` / `declaredClosingBalance.value` arrived as "1,234.56 CR" and the strict
 * decimal pattern refused them, discarding the whole billed part).
 *
 * WHAT THIS DOES. Turns a printed shape into the exact decimal string the strict schema requires, or says it cannot:
 *   currency symbol / code        "$1,234.56", "A$1,234.56", "AUD 1,234.56", "Rs. 1,23,456.78"  -> digits only
 *   thousands separator           "1,234.56", "1 234.56", Indian grouping "1,23,456.78"
 *   padding                       leading / trailing spaces, non-breaking spaces
 *   CR / DR marker                "1,234.56 CR" (credit, positive), "1,234.56 DR" (debit)
 *   negative wrappers             "(1,234.56)", "1,234.56-", "-1,234.56", "-$1,234.56", unicode minus
 * and reduces every negative form to ONE leading minus.
 *
 * WHAT THIS NEVER DOES (the safety properties the tests pin).
 *   - It never invents or rounds a digit: the digits of the result are the digits of the input, in order, with only the
 *     separators and markers removed. A figure the page does not print is still caught afterwards by `figureIsPrinted`, which
 *     checks the result against the source text.
 *   - It never guesses a sign. A figure with NO marker is positive (that is what it prints). A figure carrying two negative marks
 *     ("-1,234.56 DR", "(1,234.56)-") or a credit mark together with a negative mark ("-50.00 CR") is CONFLICTING and refused.
 *   - It refuses what is not clean afterwards: more than two decimals, a decimal comma ("1.234,56": ambiguous with a thousands
 *     separator), letters, two numbers, a misplaced separator ("12,34.56"), more than 15 integer digits.
 *
 * SIGN RULES (documented, pinned by tests).
 *   - kind 'balance' (a running or declared balance, which is SIGNED): CR = positive; DR, parentheses, a trailing minus or a
 *     leading minus = negative (overdrawn / in debit). Unmarked = positive.
 *   - kind 'amount' (a transaction amount, which this codebase carries as a POSITIVE MAGNITUDE with the direction in the separate
 *     credit/debit field): a CR / DR marker is NOT a sign. It is a direction hint and is checked against the row's own direction:
 *     "45.00 DR" on a row the model labelled `credit` is a contradiction and is refused (never a silent wrong direction). A minus
 *     or parentheses still produce a leading minus, which the existing mapper turns into the magnitude and records as
 *     `negative_amount_normalised` (unchanged behaviour).
 */

export type PrintedMoneyKind = 'balance' | 'amount';

export type PrintedMoneyResult =
  | { ok: true; value: string; marker: 'CR' | 'DR' | null; changed: boolean }
  | { ok: false; reason: 'empty' | 'not_a_number' | 'conflicting_signs' | 'direction_conflict' | 'not_clean' };

/** Exactly the strict schema's pattern (`aieLineItemMoney`). */
const CLEAN = /^-?\d{1,15}(\.\d{1,2})?$/;

const CURRENCY_CODES = /\b(?:AUD|NZD|USD|CAD|SGD|GBP|EUR|INR|Rs)\b\.?/gi;
const CURRENCY_SYMBOLS = /[A-Za-z]{0,2}[$₹£€]/g;

/** Integer part with a thousands separator: 1,234 / 12,345,678 / Indian 1,23,456 / space grouped 1 234. */
const GROUPED_INT = /^(?:\d{1,3}(?:[,   ]\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})$/;
const PLAIN_INT = /^\d{1,15}$/;

function cleanNumberCore(core: string): string | null {
  const m = /^([\d,   ]+?)(\.\d+)?$/.exec(core);
  if (!m) return null;
  const intPart = m[1];
  const dec = m[2] ?? '';
  if (dec.length > 3) return null; // ".dd" at most (the leading dot counts as one)
  let digits: string;
  if (PLAIN_INT.test(intPart)) digits = intPart;
  else if (GROUPED_INT.test(intPart)) digits = intPart.replace(/[,   ]/g, '');
  else return null;
  if (digits.length > 15) return null;
  return `${digits}${dec}`;
}

/** Placeholders that mean "no figure printed here" rather than "a figure I could not read". */
const NOT_PRINTED = /^(?:|-|--|—|–|n\/?a|nil|null|none|not printed|not available)$/i;

export function isNotPrintedPlaceholder(raw: string): boolean {
  return NOT_PRINTED.test(raw.trim());
}

export function normalisePrintedMoney(raw: string, kind: PrintedMoneyKind, direction?: 'credit' | 'debit'): PrintedMoneyResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_number' };
  // Fast path: already exactly what the strict schema accepts (the overwhelmingly common case).
  if (CLEAN.test(raw)) return { ok: true, value: raw, marker: null, changed: false };

  let s = raw.replace(/[−‒–—]/g, '-').replace(/[  ]/g, ' ').trim();
  if (s.length === 0) return { ok: false, reason: 'empty' };
  s = s.replace(CURRENCY_CODES, ' ').replace(CURRENCY_SYMBOLS, ' ').replace(/\s+/g, ' ').trim();

  const negative: string[] = [];
  let credit = false;
  let marker: 'CR' | 'DR' | null = null;
  let plus = false;

  // CR / DR marker, trailing ("1,234.56 CR", "1,234.56CR", "1,234.56 Cr.") or leading ("CR 1,234.56").
  const trailMarker = /^(.*?\d)\s*(CR|DR)\.?$/i.exec(s);
  const leadMarker = /^(CR|DR)\.?\s*(.+)$/i.exec(s);
  if (trailMarker) {
    s = trailMarker[1].trim();
    marker = trailMarker[2].toUpperCase() as 'CR' | 'DR';
  } else if (leadMarker && /\d/.test(leadMarker[2])) {
    s = leadMarker[2].trim();
    marker = leadMarker[1].toUpperCase() as 'CR' | 'DR';
  }
  if (marker === 'CR') credit = true;
  if (marker === 'DR') negative.push('DR');

  // A currency mark may sit between the sign and the digits ("-$1,234.56" -> "- 1,234.56"), so close spaces after a sign.
  s = s.replace(/^([-+])\s+/, '$1');
  if (/^\(.*\)$/.test(s)) {
    negative.push('parentheses');
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative.push('leading_minus');
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    plus = true;
    s = s.slice(1).trim();
  }
  if (s.endsWith('-')) {
    negative.push('trailing_minus');
    s = s.slice(0, -1).trim();
  }

  if (negative.length > 1 || (negative.length > 0 && (credit || plus))) return { ok: false, reason: 'conflicting_signs' };
  if (s.length === 0 || !/\d/.test(s)) return { ok: false, reason: s.length === 0 ? 'empty' : 'not_a_number' };

  const core = cleanNumberCore(s);
  if (core === null) return { ok: false, reason: 'not_clean' };

  let isNegative = negative.length > 0;
  if (kind === 'amount' && marker !== null) {
    // A CR / DR marker on an AMOUNT is a direction hint, never a sign; it must agree with the row's own direction.
    if (direction !== undefined && ((marker === 'CR' && direction === 'debit') || (marker === 'DR' && direction === 'credit'))) {
      return { ok: false, reason: 'direction_conflict' };
    }
    isNegative = negative.filter((n) => n !== 'DR').length > 0;
  }
  const isZero = /^0+(\.0+)?$/.test(core);
  const value = `${isNegative && !isZero ? '-' : ''}${core}`;
  if (!CLEAN.test(value)) return { ok: false, reason: 'not_clean' };
  return { ok: true, value, marker, changed: true };
}
