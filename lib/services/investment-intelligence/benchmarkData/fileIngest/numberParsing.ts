// Strict index-LEVEL parsing with an explicit number locale. No inference: a
// value is read under exactly one grammar chosen by the operator.
//
//   plain  12345.67      no grouping at all, '.' decimal
//   en     12,345.67     groups of 3 (grouping optional), '.' decimal
//   in     1,23,456.78   Indian grouping: last group 3 digits, earlier groups 2
//                        (first group 1-2 digits), '.' decimal
//   eu     12.345,67     '.' groups of 3, ',' decimal
//
// Rejected under every locale: NaN/Infinity, scientific notation, a leading
// '+', a trailing decimal separator, currency symbols, percentages,
// parenthesised negatives, blanks and placeholders ('-', 'N/A', 'null'),
// spreadsheet-formula-looking text, more than 6 decimals (numeric(18,6)) and
// values of 1e12 or more. Zero and negatives parse here; the validator
// rejects them as non-positive.
import type { NumberLocaleId } from './types';

export type LevelParseResult =
  | { ok: true; value: number; text: string }
  | { ok: false; code: string; message: string };

export const MAX_DECIMALS = 6;
export const MAX_LEVEL_EXCLUSIVE = 1e12;
const MAX_TEXT_LENGTH = 64;

const PLACEHOLDERS = new Set(['-', '--', '---', 'n/a', 'na', 'null', 'none', 'nil', '#n/a', 'n.a.', 'n.a', '.', '..']);
const NON_FINITE = new Set(['nan', 'infinity', '+infinity', '-infinity', 'inf', '+inf', '-inf']);
const CURRENCY_CHARS = '₹$€£¥';
const CURRENCY_PREFIXES = ['rs', 'inr', 'usd', 'eur', 'gbp', 'aud', 'sgd', 'jpy'];

function fail(code: string, message: string): LevelParseResult {
  return { ok: false, code, message };
}

function allDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

function groupingValid(intPart: string, sep: string, locale: NumberLocaleId): boolean {
  if (!intPart.includes(sep)) return allDigits(intPart);
  const groups = intPart.split(sep);
  if (!groups.every(allDigits)) return false;
  const first = groups[0];
  const rest = groups.slice(1);
  if (locale === 'in') {
    if (first.length < 1 || first.length > 2) return false;
    const last = rest[rest.length - 1];
    if (last.length !== 3) return false;
    return rest.slice(0, -1).every((g) => g.length === 2);
  }
  // en / eu: groups of exactly 3
  if (first.length < 1 || first.length > 3) return false;
  return rest.every((g) => g.length === 3);
}

function describeLocale(locale: NumberLocaleId): string {
  switch (locale) {
    case 'plain':
      return 'plain numbers such as 12345.67';
    case 'en':
      return 'English grouping such as 12,345.67';
    case 'in':
      return 'Indian grouping such as 1,23,456.78';
    case 'eu':
      return 'European format such as 12.345,67';
  }
}

export function parseLevel(raw: string | number, locale: NumberLocaleId): LevelParseResult {
  if (typeof raw === 'number') return fromNumber(raw);
  // String.prototype.trim is linear (a trailing-whitespace regex would not be on long runs of spaces).
  const s = raw.trim();
  if (s === '') return fail('VALUE_EMPTY', 'The value is empty.');
  if (s.length > MAX_TEXT_LENGTH) return fail('VALUE_BAD_FORMAT', 'The value is far too long to be an index level.');
  const lower = s.toLowerCase();

  if (s.includes('%')) {
    return fail('VALUE_IS_PERCENT', 'An index LEVEL is required, not a percentage return.');
  }
  if (NON_FINITE.has(lower)) return fail('VALUE_NOT_FINITE', `"${s.slice(0, 20)}" is not a finite number.`);
  if (PLACEHOLDERS.has(lower)) return fail('VALUE_PLACEHOLDER', `"${s.slice(0, 20)}" is a placeholder, not an index level.`);
  if (s[0] === '#') return fail('VALUE_PLACEHOLDER', `"${s.slice(0, 20)}" is a spreadsheet error, not an index level.`);
  if (s[0] === '=' || s[0] === '@') {
    return fail('VALUE_FORMULA_LIKE', 'The value looks like a spreadsheet formula, not an index level.');
  }
  if (s[0] === '+') return fail('VALUE_LEADING_PLUS', 'A leading "+" is not accepted; write the level without a sign.');
  if (s.includes('(') || s.includes(')')) {
    return fail('VALUE_PARENTHESES_NEGATIVE', 'Parenthesised (negative) numbers are not accepted.');
  }
  for (const ch of s) {
    if (CURRENCY_CHARS.includes(ch)) {
      return fail('VALUE_HAS_CURRENCY', 'Remove the currency symbol: the currency is chosen on the upload form.');
    }
  }
  if (CURRENCY_PREFIXES.some((p) => lower.startsWith(p) && lower.length > p.length)) {
    return fail('VALUE_HAS_CURRENCY', 'Remove the currency code: the currency is chosen on the upload form.');
  }
  // Scientific notation: digits/separators then e/E then an (optionally signed) exponent.
  const sciBody = lower[0] === '-' ? lower.slice(1) : lower;
  const ePos = sciBody.indexOf('e');
  if (ePos > 0 && allDigitsOrSeps(sciBody.slice(0, ePos)) && /^[+-]?\d+$/.test(sciBody.slice(ePos + 1))) {
    return fail('VALUE_SCIENTIFIC', 'Scientific notation (1e5) is not accepted.');
  }

  let neg = false;
  let body = s;
  if (body[0] === '-') {
    neg = true;
    body = body.slice(1);
  }
  if (body === '') return fail('VALUE_PLACEHOLDER', 'The value is just a dash.');

  const decSep = locale === 'eu' ? ',' : '.';
  const grpSep = locale === 'eu' ? '.' : ',';
  const decCount = body.split(decSep).length - 1;
  if (decCount > 1) return fail('VALUE_BAD_FORMAT', `"${s.slice(0, 30)}" has more than one decimal separator for ${describeLocale(locale)}.`);
  const dec = body.indexOf(decSep);
  const intPart = dec >= 0 ? body.slice(0, dec) : body;
  const fracPart = dec >= 0 ? body.slice(dec + 1) : '';

  if (dec >= 0 && fracPart === '') return fail('VALUE_BAD_FORMAT', 'A trailing decimal separator is not accepted.');
  if (intPart === '') return fail('VALUE_BAD_FORMAT', 'Digits are required before the decimal separator.');
  if (dec >= 0 && !allDigits(fracPart)) {
    // A grouping separator after the decimal separator, or stray characters.
    return fail('VALUE_BAD_FORMAT', `"${s.slice(0, 30)}" is not a number in the selected format (${describeLocale(locale)}).`);
  }

  if (locale === 'plain') {
    if (!allDigits(intPart)) {
      return fail(
        intPart.includes(',') || intPart.includes('.') ? 'VALUE_BAD_GROUPING' : 'VALUE_NOT_NUMERIC',
        intPart.includes(',') || intPart.includes('.')
          ? 'Thousands separators are not allowed with the plain number format (12345.67).'
          : `"${s.slice(0, 30)}" is not a number.`,
      );
    }
  } else if (!groupingValid(intPart, grpSep, locale)) {
    const looksNumeric = [...intPart].every((c) => c === grpSep || (c >= '0' && c <= '9'));
    return fail(
      looksNumeric ? 'VALUE_BAD_GROUPING' : 'VALUE_NOT_NUMERIC',
      looksNumeric
        ? `The thousands separators in "${s.slice(0, 30)}" do not match the selected format (${describeLocale(locale)}).`
        : `"${s.slice(0, 30)}" is not a number.`,
    );
  }

  const digits = intPart.split(grpSep).join('');
  if (digits.length > 1 && digits[0] === '0') {
    return fail('VALUE_BAD_FORMAT', 'Leading zeros are not accepted.');
  }
  if (fracPart.length > MAX_DECIMALS) {
    // Trailing zeros beyond the limit carry no precision.
    if (!/^0+$/.test(fracPart.slice(MAX_DECIMALS))) {
      return fail('VALUE_TOO_PRECISE', `At most ${MAX_DECIMALS} decimal places are accepted.`);
    }
  }
  return finish(neg, digits, fracPart.slice(0, Math.max(MAX_DECIMALS, 0)));
}

function allDigitsOrSeps(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!((c >= '0' && c <= '9') || c === '.' || c === ',')) return false;
  }
  return true;
}

function finish(neg: boolean, intDigits: string, frac: string): LevelParseResult {
  const fracTrim = frac.replace(/0+$/, '');
  const abs = fracTrim === '' ? intDigits : `${intDigits}.${fracTrim}`;
  const num = Number(abs);
  if (!Number.isFinite(num)) return fail('VALUE_NOT_FINITE', 'The value is not a finite number.');
  // Judge size on the decimal digits: a double cannot tell 999999999999.999999 from 1e12.
  if (intDigits.replace(/^0+/, '').length > 12) {
    return fail('VALUE_TOO_LARGE', 'The value is too large (it must be below 1,000,000,000,000).');
  }
  if (num === 0) return { ok: true, value: 0, text: '0' };
  return { ok: true, value: neg ? -num : num, text: neg ? `-${abs}` : abs };
}

function fromNumber(n: number): LevelParseResult {
  if (!Number.isFinite(n)) return fail('VALUE_NOT_FINITE', 'The value is not a finite number.');
  if (Math.abs(n) >= MAX_LEVEL_EXCLUSIVE) {
    return fail('VALUE_TOO_LARGE', 'The value is too large (it must be below 1,000,000,000,000).');
  }
  let t = String(n);
  if (t.includes('e') || t.includes('E')) {
    // Only reachable for magnitudes below 1e-6: more precision than numeric(18,6) holds.
    return n === 0 ? { ok: true, value: 0, text: '0' } : fail('VALUE_TOO_PRECISE', `At most ${MAX_DECIMALS} decimal places are accepted.`);
  }
  const neg = t.startsWith('-');
  if (neg) t = t.slice(1);
  const dot = t.indexOf('.');
  const intDigits = dot >= 0 ? t.slice(0, dot) : t;
  const frac = dot >= 0 ? t.slice(dot + 1) : '';
  if (frac.length > MAX_DECIMALS && !/^0+$/.test(frac.slice(MAX_DECIMALS))) {
    return fail('VALUE_TOO_PRECISE', `At most ${MAX_DECIMALS} decimal places are accepted.`);
  }
  return finish(neg, intDigits, frac.slice(0, MAX_DECIMALS));
}
