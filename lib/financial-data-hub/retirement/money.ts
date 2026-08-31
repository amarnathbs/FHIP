/**
 * FDH-12 — exact decimal money for retirement statement reconciliation
 * (spec sections 46, 142: "Use exact decimal arithmetic. Do not use binary
 * floating-point for reconciliation").
 *
 * WHY THIS FILE EXISTS ALONGSIDE `../domain/money.ts`. The FDH-1 primitives in
 * that file operate on JavaScript `number` inputs and convert to minor units.
 * That is correct where the caller already holds a number. FDH-12's inputs,
 * however, arrive as TEXT off a statement, and the whole point of spec section
 * 48's $0.01 negative control is that a one-cent discrepancy must survive the
 * whole pipeline. Converting text -> float -> minor units introduces a lossy
 * step for no reason. These functions go text -> integer minor units directly,
 * by string manipulation, so no IEEE-754 value is ever constructed.
 *
 * The internal representation is `bigint` minor units. `bigint` rather than
 * `number` because `numeric(20,4)` can hold 16 integral digits, which exceeds
 * `Number.MAX_SAFE_INTEGER` once scaled — an overflow that would silently
 * corrupt a large fund balance.
 *
 * All FDH-12 reconciliation arithmetic runs through here. Nothing in
 * `lib/financial-data-hub/retirement/` adds, subtracts or compares money with
 * the `+`, `-` or `===` operators on floats.
 */

/** Minor-unit exponent. Matches `../domain/money.ts`'s MINOR_UNIT_EXPONENTS —
 * AUD and INR are both two-decimal, which is every currency FDH-12 supports. */
export const RETIREMENT_MINOR_UNIT_EXPONENT = 2;

/**
 * BigInt constants, written as `BigInt(n)` calls rather than `0n` literals.
 *
 * WHY. `tsconfig.json` sets `"target": "ES2017"`, under which TypeScript
 * rejects BigInt LITERALS (TS2737) — the `bigint` type and the `BigInt()`
 * constructor are both fine, only the `123n` syntax is gated. Raising the
 * whole project's compile target to ES2020 to gain nicer syntax in one module
 * would change the emitted output of every file in the application, which is
 * not a change FDH-12 should make. These constants are the local, zero-blast-
 * radius alternative, and they are exported so callers do not each re-derive
 * them.
 */
export const ZERO: bigint = BigInt(0);
export const ONE: bigint = BigInt(1);
const TEN: bigint = BigInt(10);
const EIGHTEEN: bigint = BigInt(18);
export const HUNDRED: bigint = BigInt(100);

/** Largest magnitude `numeric(20,4)` can hold, in minor units. */
const MAX_MINOR_UNITS = TEN ** EIGHTEEN;

export class RetirementMoneyParseError extends Error {
  constructor(readonly raw: string, message: string) {
    super(message);
    this.name = 'RetirementMoneyParseError';
  }
}

/**
 * Parse a money string off a statement into exact integer minor units.
 *
 * Accepts: an optional leading/trailing currency symbol or code, thousands
 * separators (`,` or a space), a leading `+`/`-`, and accounting-style
 * parentheses for negatives (`(1,234.56)` — common on super member
 * statements' fee and tax lines).
 *
 * FAILS SAFE (spec section 143: "Rows must fail safely. Do not convert
 * malformed fields to zero."). A value this function cannot read with
 * certainty throws; it never returns 0, and it never returns a best guess.
 * Callers surface the failure as a review reason.
 */
export function parseMoneyToMinorUnits(raw: string): bigint {
  if (typeof raw !== 'string') {
    throw new RetirementMoneyParseError(String(raw), 'not a string');
  }
  let s = raw.trim();
  if (s === '') throw new RetirementMoneyParseError(raw, 'empty');

  let negative = false;
  // Accounting parentheses.
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Strip currency symbols and ISO codes from either end. Deliberately a
  // closed list rather than "any non-digit": a stray letter in the middle of a
  // number is a parse failure, not something to silently discard.
  s = s.replace(/^(AUD|INR|USD|A\$|Rs\.?|₹|\$)\s*/i, '');
  s = s.replace(/\s*(AUD|INR|USD|CR|DR)$/i, (m) => {
    if (/DR$/i.test(m.trim())) negative = !negative;
    return '';
  });
  s = s.trim();

  if (s.startsWith('-')) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) { s = s.slice(1).trim(); }

  // Remove thousands separators only where they sit between digit groups.
  s = s.replace(/(?<=\d)[,  ](?=\d{3}\b)/g, '');

  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new RetirementMoneyParseError(raw, `not a well-formed decimal amount: "${raw}"`);
  }

  const [intPart, fracPartRaw = ''] = s.split('.');
  // More precision than the currency has is a parse failure rather than a
  // silent rounding: a statement printing 1234.567 is telling us something we
  // do not understand, and guessing which way to round it is exactly the
  // "silently round away a material source mismatch" spec section 48 forbids.
  if (fracPartRaw.length > RETIREMENT_MINOR_UNIT_EXPONENT) {
    const excess = fracPartRaw.slice(RETIREMENT_MINOR_UNIT_EXPONENT);
    if (/[^0]/.test(excess)) {
      throw new RetirementMoneyParseError(
        raw,
        `more decimal places than the currency supports: "${raw}"`,
      );
    }
  }
  const fracPart = fracPartRaw.padEnd(RETIREMENT_MINOR_UNIT_EXPONENT, '0')
    .slice(0, RETIREMENT_MINOR_UNIT_EXPONENT);

  const magnitude = BigInt(intPart + fracPart);
  if (magnitude >= MAX_MINOR_UNITS) {
    throw new RetirementMoneyParseError(raw, `amount exceeds the persisted numeric(20,4) domain: "${raw}"`);
  }
  return negative ? -magnitude : magnitude;
}

/** Non-throwing form. Returns null on any parse failure — never 0. */
export function tryParseMoneyToMinorUnits(raw: string): bigint | null {
  try {
    return parseMoneyToMinorUnits(raw);
  } catch {
    return null;
  }
}

/** Render minor units back to the canonical decimal string the DB stores. */
export function minorUnitsToDecimalString(minorUnits: bigint): string {
  const negative = minorUnits < ZERO;
  const abs = negative ? -minorUnits : minorUnits;
  const s = abs.toString().padStart(RETIREMENT_MINOR_UNIT_EXPONENT + 1, '0');
  const intPart = s.slice(0, s.length - RETIREMENT_MINOR_UNIT_EXPONENT);
  const fracPart = s.slice(s.length - RETIREMENT_MINOR_UNIT_EXPONENT);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

/**
 * Convert a value that has already been through the database (and so is a
 * `number` or a PostgREST numeric string) into minor units.
 *
 * PostgREST returns `numeric` as a STRING by default, which is exactly what we
 * want — that path never touches a float. The `number` branch exists for
 * values that arrived through a typed client and rounds at the currency's
 * scale first, matching `../domain/money.ts`'s behaviour.
 */
export function toMinorUnits(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return tryParseMoneyToMinorUnits(value);
  if (!Number.isFinite(value)) return null;
  return tryParseMoneyToMinorUnits(value.toFixed(RETIREMENT_MINOR_UNIT_EXPONENT));
}

/** Exact sum. No float ever participates. */
export function sumMinorUnits(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, ZERO);
}

/** Absolute value, for variance reporting. */
export function absMinorUnits(v: bigint): bigint {
  return v < ZERO ? -v : v;
}
