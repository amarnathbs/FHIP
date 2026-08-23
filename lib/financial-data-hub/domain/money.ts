/**
 * Financial Data Hub — monetary primitives.
 *
 * WHY THIS FILE EXISTS. Persisted money is `numeric(20,4)` in Postgres, which
 * is exact. JavaScript `number` is IEEE-754 binary floating point, which is
 * not: `0.1 + 0.2 !== 0.3`. Any FDH arithmetic that compares or sums money
 * therefore converts to integer MINOR UNITS first, does the arithmetic in
 * integers, and converts back once.
 *
 * FDH-1 performs no FX conversion and reads no rate provider. These are the
 * primitives the later phases will use.
 */

import type { FdhCreditDebit } from '../constants/enums';

/**
 * Decimal places the FDH schema persists for a money column. Kept in one
 * place because it is the same number as the `numeric(20,4)` scale in
 * migrations 0045-0048 — if one changes the other must.
 */
export const FDH_MONEY_SCALE = 4;

/**
 * Minor-unit exponents for the currencies the platform supports today
 * (`currencies` table: AUD, INR, USD — all two-decimal). Kept explicit rather
 * than assumed, because zero-decimal (JPY) and three-decimal (KWD) currencies
 * exist and a future country would need an entry here rather than a silent
 * wrong answer.
 */
const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  AUD: 2,
  INR: 2,
  USD: 2,
};

/** Minor-unit exponent for a currency, defaulting to 2 for unknown codes. */
export function minorUnitExponent(currencyCode: string): number {
  return MINOR_UNIT_EXPONENTS[currencyCode.toUpperCase()] ?? 2;
}

/** The value of one minor unit — the natural tolerance for a money comparison. */
export function smallestUnit(currencyCode: string): number {
  return 10 ** -minorUnitExponent(currencyCode);
}

/**
 * Convert a money amount to an exact integer number of minor units.
 *
 * Rounds at the schema's persisted scale first, so a value that arrived with
 * float noise (e.g. `10.005000000000001`) resolves the same way it would after
 * a database round-trip.
 */
export function toMinorUnits(amount: number, currencyCode: string): number {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`FDH money: amount must be finite, received ${amount}`);
  }
  const exponent = minorUnitExponent(currencyCode);
  // Round to the stored scale before scaling up, then round again to kill the
  // residual binary error introduced by the multiplication itself.
  const atScale = Number(amount.toFixed(FDH_MONEY_SCALE));
  return Math.round(atScale * 10 ** exponent);
}

/** Inverse of `toMinorUnits`. */
export function fromMinorUnits(minorUnits: number, currencyCode: string): number {
  return minorUnits / 10 ** minorUnitExponent(currencyCode);
}

/**
 * Sum money exactly. Summing in minor units means a thousand two-decimal
 * values add up to the same answer every time, which naive float addition does
 * not guarantee.
 */
export function sumMoney(amounts: readonly number[], currencyCode: string): number {
  const total = amounts.reduce((acc, a) => acc + toMinorUnits(a, currencyCode), 0);
  return fromMinorUnits(total, currencyCode);
}

/** True when two amounts are equal to within `toleranceMinorUnits` minor units. */
export function moneyEquals(
  a: number,
  b: number,
  currencyCode: string,
  toleranceMinorUnits = 0,
): boolean {
  return Math.abs(toMinorUnits(a, currencyCode) - toMinorUnits(b, currencyCode))
    <= toleranceMinorUnits;
}

/**
 * The SIGNED economic value of a transaction.
 *
 * FDH persists `amount_original` as a strictly positive magnitude and keeps
 * direction in `credit_debit`. This is the one place the two are combined, so
 * no caller can invent its own sign convention.
 *
 * NOTE what this function does NOT do: it does not decide whether the
 * transaction is income or an expense. A credit may be a refund, a transfer
 * in, a loan drawdown or a reversal; a debit may be a transfer out, an
 * investment purchase or a debt repayment. Economic meaning lives in
 * `economic_transaction_type` and is never inferred from direction.
 */
export function toSignedAmount(amount: number, creditDebit: FdhCreditDebit): number {
  if (amount <= 0) {
    throw new RangeError(
      `FDH money: amount_original must be a positive magnitude, received ${amount}`,
    );
  }
  return creditDebit === 'credit' ? amount : -amount;
}

/** The largest magnitude `numeric(20,4)` can hold: 16 integral digits. */
export const FDH_MAX_MONEY = 10 ** 16 - 10 ** -FDH_MONEY_SCALE;

/** True when a value fits the persisted `numeric(20,4)` domain. */
export function fitsMoneyColumn(amount: number): boolean {
  return Number.isFinite(amount) && Math.abs(amount) <= FDH_MAX_MONEY;
}
