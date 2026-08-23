// Investment Intelligence R2 — exact decimal parsing/arithmetic.
//
// No Decimal/BigNumber library exists anywhere in this codebase (checked:
// lib/engines/money.ts uses plain JS `number` arithmetic, acceptable there
// because it only ever formats already-computed forecast totals for
// display — it is NOT an authoritative parser of externally-supplied
// numeric TEXT). R2 spec section 13 explicitly forbids using ordinary JS
// floating-point arithmetic as the AUTHORITATIVE representation of parsed
// money/NAV/unit values, so this module is a new, minimal, dependency-free
// fixed-point decimal implementation built specifically for that
// requirement — internally a BigInt scaled by 10^SCALE, never a `number`
// at any point between "text on a statement" and "value handed to the
// numeric(20,6)/numeric(18,2) database column".
//
// This is now the established approach for Investment Intelligence R2+;
// any future R3+ numeric parsing should reuse this module rather than
// re-inventing another one.

// NOTE: this file avoids BigInt LITERAL syntax (`0n`, `1n`, ...) throughout
// — tsconfig.json's compilerOptions.target is ES2017 (a pre-existing,
// project-wide setting this module does not change), which disallows
// BigInt literal notation even though BigInt itself is fully supported at
// runtime on every Node version this project targets. `BigInt(0)` /
// `BigInt(1)` etc. are used instead everywhere a literal would otherwise
// appear — functionally identical, just spelled without the `n` suffix.
const SCALE = 6; // matches ii_transactions.units/price_per_unit's numeric(20,6) precision exactly; currency columns (numeric(18,2)) are a strict subset
const SCALE_FACTOR = BigInt(10) ** BigInt(SCALE);
export const ZERO: bigint = BigInt(0);
const ONE: bigint = BigInt(1);

export interface ParsedDecimal {
  ok: true;
  scaled: bigint; // exact value * 10^SCALE
  /** True if the source text carried more than SCALE fractional digits and had to be rounded (half-up) to fit. Callers should surface this as a parser warning, never silently. */
  roundedFromHigherPrecision: boolean;
}
export interface ParsedDecimalError {
  ok: false;
  error: string;
}

const CURRENCY_PREFIXES = ['₹', 'Rs.', 'Rs', 'INR', 'A$', 'AUD', '$'];

/**
 * Parse a raw numeric-looking string exactly, as text — never via
 * parseFloat/Number(). Supports (spec section 13):
 *  - Indian comma grouping (1,25,000.50) and Western grouping (125,000.50)
 *    — both work because grouping commas are simply stripped, wherever
 *    they occur; only ONE decimal point is ever permitted.
 *  - A leading currency symbol/code (₹, Rs., Rs, INR, $, A$, AUD).
 *  - A leading or trailing minus sign.
 *  - Parenthesised negatives, e.g. "(1,234.56)" -> -1234.56 (common
 *    accounting-statement convention for debits/reversals).
 *  - Zero values, explicitly signed zero collapses to unsigned zero.
 *  - Bare "-" / "" / "NA" / "N/A" / "Nil" are explicitly INVALID (a CAS
 *    occasionally prints these for "not applicable" cells) — the caller
 *    must decide what an absent numeric field means for that column, this
 *    function never guesses zero on their behalf.
 */
export function parseExactDecimal(raw: string): ParsedDecimal | ParsedDecimalError {
  if (raw == null) return { ok: false, error: 'Empty value' };
  let s = raw.trim();
  if (s.length === 0) return { ok: false, error: 'Empty value' };

  const upper = s.toUpperCase();
  if (upper === 'NA' || upper === 'N/A' || upper === 'NIL' || upper === '-' || upper === '--') {
    return { ok: false, error: `Not a numeric value: "${raw}"` };
  }

  let negative = false;

  // Parenthesised negative: "(1,234.56)"
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Strip a recognised currency prefix (case-sensitive on purpose — "Rs"
  // must not eat into a genuine number).
  for (const prefix of CURRENCY_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length).trim();
      break;
    }
  }

  // Leading/trailing sign (after any currency prefix has been removed —
  // e.g. "Rs. -500" or "-Rs. 500" style statements).
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1).trim();
  }

  if (s.length === 0) return { ok: false, error: `Not a numeric value: "${raw}"` };

  // Strip grouping commas (any position — Indian 2-3-3 or Western 3-3-3
  // grouping are both just "commas that aren't the decimal point").
  const withoutCommas = s.replace(/,/g, '');

  if (!/^\d+(\.\d+)?$/.test(withoutCommas)) {
    return { ok: false, error: `Malformed numeric value: "${raw}"` };
  }

  const [intPartRaw, fracPartRaw = ''] = withoutCommas.split('.');
  const intPart = intPartRaw.replace(/^0+(?=\d)/, ''); // strip leading zeros, keep a lone "0"

  let roundedFromHigherPrecision = false;
  let fracPart = fracPartRaw;
  if (fracPart.length > SCALE) {
    // Round half-up at the SCALE-th digit rather than silently truncate.
    const keep = fracPart.slice(0, SCALE);
    const nextDigit = fracPart.charCodeAt(SCALE) - 48;
    roundedFromHigherPrecision = true;
    let scaledInt = BigInt(intPart || '0') * SCALE_FACTOR + BigInt(keep || '0');
    if (nextDigit >= 5) scaledInt += ONE;
    if (negative) scaledInt = -scaledInt;
    return { ok: true, scaled: scaledInt, roundedFromHigherPrecision };
  }
  fracPart = fracPart.padEnd(SCALE, '0');

  let scaled = BigInt(intPart || '0') * SCALE_FACTOR + BigInt(fracPart || '0');
  if (negative && scaled !== ZERO) scaled = -scaled;

  return { ok: true, scaled, roundedFromHigherPrecision };
}

/** Format a SCALE-scaled BigInt back into an exact decimal string, e.g. for a numeric DB column. `dp` truncates trailing precision for display only — the value itself is never re-derived via float division. */
export function scaledToDecimalString(scaled: bigint, dp = SCALE): string {
  const neg = scaled < ZERO;
  const abs = neg ? -scaled : scaled;
  const intPart = abs / SCALE_FACTOR;
  const fracPart = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0');
  const fracTrimmedToDp = fracPart.slice(0, dp);
  const sign = neg && (intPart !== ZERO || /[1-9]/.test(fracTrimmedToDp)) ? '-' : '';
  return dp > 0 ? `${sign}${intPart.toString()}.${fracTrimmedToDp}` : `${sign}${intPart.toString()}`;
}

/** Convenience: parse straight to a JS number, ONLY for display/formatting call sites that already accept float rounding (e.g. a UI badge) — never for a value headed to a database numeric column or a reconciliation comparison. */
export function scaledToNumber(scaled: bigint): number {
  return Number(scaledToDecimalString(scaled));
}

export function addScaled(a: bigint, b: bigint): bigint {
  return a + b;
}
export function subScaled(a: bigint, b: bigint): bigint {
  return a - b;
}
export function absScaled(a: bigint): bigint {
  return a < ZERO ? -a : a;
}
export function compareScaled(a: bigint, b: bigint): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
export function isZeroScaled(a: bigint): boolean {
  return a === ZERO;
}

/** Parse a plain decimal (already-normalised, e.g. from a fixture number) into scaled form without any of the text-cleanup rules above — used when the input is already a trusted JS number/string, not raw statement text. */
export function fromPlainNumber(n: number): bigint {
  const parsed = parseExactDecimal(n.toString());
  if (!parsed.ok) throw new Error(`Unexpected: could not parse plain number "${n}" as decimal`);
  return parsed.scaled;
}

export const DECIMAL_SCALE = SCALE;
