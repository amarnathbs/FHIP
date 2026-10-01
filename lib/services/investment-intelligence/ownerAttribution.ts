/**
 * Investment Intelligence -- divide ONE position's value across its owners by
 * their ownership shares (2026-10-01, PO decision: "a joint split between
 * household members is published ONCE and divided by the percentage split").
 *
 * PURE. The position is counted ONCE in every total; this module only says how
 * that single number is attributed. 1,000,000 at 60/40 -> 600,000 / 400,000,
 * household total 1,000,000, never 2,000,000. The shares always sum EXACTLY to
 * the value: rounding uses the largest-remainder method at a fixed number of
 * decimals (default 4, the storage precision of every register amount), so
 * attributing 100.00 across thirds gives 33.33 / 33.33 / 33.34-style results that
 * add back to the original rather than drifting by a cent.
 */

export const OWNERSHIP_TOTAL_BASIS_POINTS = 10000;

export interface AttributionShare<K extends string = string> {
  key: K;
  basisPoints: number;
}
export interface AttributedAmount<K extends string = string> {
  key: K;
  basisPoints: number;
  amount: number;
}

/**
 * Divides `value` by the shares. Returns null -- never a guess -- when the shares
 * are not a valid split (empty, a non-integer / non-positive share, or a total
 * other than exactly 10000), so a malformed allocation can never fabricate or
 * duplicate value. Order of the input is preserved.
 */
export function attributeByBasisPoints<K extends string>(value: number, shares: readonly AttributionShare<K>[], decimals = 4): AttributedAmount<K>[] | null {
  if (!Number.isFinite(value) || shares.length === 0) return null;
  let total = 0;
  for (const s of shares) {
    if (!Number.isInteger(s.basisPoints) || s.basisPoints <= 0) return null;
    total += s.basisPoints;
  }
  if (total !== OWNERSHIP_TOTAL_BASIS_POINTS) return null;

  const unit = 10 ** decimals;
  const sign = value < 0 ? -1 : 1;
  const totalUnits = Math.round(Math.abs(value) * unit); // value in integer units
  const exact = shares.map((s) => (totalUnits * s.basisPoints) / OWNERSHIP_TOTAL_BASIS_POINTS);
  const floors = exact.map((e) => Math.floor(e));
  let remainder = totalUnits - floors.reduce((a, b) => a + b, 0);
  // Largest fractional remainder first; ties go to the earlier owner (deterministic).
  const order = exact.map((e, i) => ({ i, frac: e - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  const units = [...floors];
  for (const o of order) {
    if (remainder <= 0) break;
    units[o.i] += 1;
    remainder -= 1;
  }
  return shares.map((s, i) => ({ key: s.key, basisPoints: s.basisPoints, amount: (sign * units[i]) / unit }));
}
