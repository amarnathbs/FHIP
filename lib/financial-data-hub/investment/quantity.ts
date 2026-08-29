/**
 * FDH-11 — exact decimal handling for SECURITY QUANTITIES (spec sections 48,
 * 49, 97). Deliberately separate from `lib/financial-data-hub/domain/money.ts`
 * (spec section 97: "Money tolerance must not be reused blindly for security
 * quantities") — money persists at 4dp; a managed-fund unit or a DRP
 * fractional share can carry more precision than that, and the tolerance for
 * "is this quantity the same" is not the tolerance for "is this dollar
 * amount the same".
 *
 * Same integer-scaled-arithmetic technique as `money.ts` (JS `number` is
 * binary floating point; `0.1 + 0.2 !== 0.3`), but scaled to
 * `QUANTITY_SCALE` decimal places and operating on `bigint` so quantities of
 * any realistic magnitude/precision never lose exactness — this mirrors
 * `lib/services/investment-intelligence/decimal.ts`'s own bigint-scaled
 * approach (R2), independently reimplemented here because this module must
 * never import Investment Intelligence code (`tests/unit/fdh11Isolation.test.ts`).
 */

/** Matches `ii_holding_snapshots.units numeric(20,6)` / `ii_transactions.units
 * numeric(20,6)` (see migration 0033) — six decimal places is enough for a
 * managed-fund unit price's fractional remainder and any realistic DRP
 * fractional-share allocation, without pretending to infinite precision. */
export const QUANTITY_SCALE = 6;

export interface ExactQuantityParseResult {
  ok: boolean;
  scaled: bigint | null;
  error: string | null;
}

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** Parse a quantity supplied as a string (never a JS number — spec section
 * 48's "never integer-cast holdings" applies just as much to float-cast). */
export function parseExactQuantity(raw: string): ExactQuantityParseResult {
  const trimmed = raw.trim();
  if (!DECIMAL_STRING_RE.test(trimmed)) {
    return { ok: false, scaled: null, error: `Not a valid decimal quantity: "${raw}"` };
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = unsigned.split('.');
  if (fracPart.length > QUANTITY_SCALE) {
    // Never silently round away precision the statement actually supplied —
    // a caller that needs a display value should never call this, they
    // should keep the raw string; this function is for exact arithmetic.
    return { ok: false, scaled: null, error: `Quantity "${raw}" exceeds ${QUANTITY_SCALE} decimal places` };
  }
  const paddedFrac = fracPart.padEnd(QUANTITY_SCALE, '0');
  const combined = `${intPart}${paddedFrac}`.replace(/^0+(?=\d)/, '');
  let scaled = BigInt(combined || '0');
  if (negative) scaled = -scaled;
  return { ok: true, scaled, error: null };
}

export function scaledQuantityToString(scaled: bigint): string {
  const negative = scaled < BigInt(0);
  const abs = negative ? -scaled : scaled;
  const s = abs.toString().padStart(QUANTITY_SCALE + 1, '0');
  const intPart = s.slice(0, s.length - QUANTITY_SCALE);
  const fracPart = s.slice(s.length - QUANTITY_SCALE).replace(/0+$/, '');
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative && scaled !== BigInt(0) ? `-${body}` : body;
}

export function sumExactQuantities(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, BigInt(0));
}

/**
 * True when two quantities are equal to within `toleranceScaled` scaled
 * units. Default tolerance is ZERO — spec section 49's negative control
 * (expected 120.0000, statement 120.0001) requires this to report a
 * variance, not hide it behind rounding, so callers must opt IN to any
 * tolerance rather than getting one for free the way money comparisons do.
 */
export function quantityEquals(a: bigint, b: bigint, toleranceScaled = BigInt(0)): boolean {
  const diff = a > b ? a - b : b - a;
  return diff <= toleranceScaled;
}
