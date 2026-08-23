// Shared helpers for authoring R2 golden fixture scenarios. Deliberately
// duplicates a small "direction" table independently of
// lib/services/investment-intelligence/reconciliation.ts's DIRECTION_TABLE
// — this is fixture-authoring infrastructure (used only to keep the
// running "Unit Balance" column internally consistent within the
// generated statement text), not a re-export of the code under test, so
// it does not make the resulting tests tautological.
const FIXTURE_DIRECTION = {
  purchase: 1,
  sip: 1,
  switch_in: 1,
  stp_in: 1,
  transfer_in: 1,
  reinvestment: 1,
  redemption: -1,
  switch_out: -1,
  stp_out: -1,
  swp: -1,
  transfer_out: -1,
  dividend: 0,
  fee: 0,
  tax: 0,
  transfer: 0,
  merger: 0,
  segregation: 0,
  adjustment: 0,
  reversal: -1, // fixtures use reversal to reverse a prior inflow, so it is a net outflow by construction here
  unclassified: 0,
};

/**
 * Given an opening balance and a list of transaction "deltas"
 * ({description, expectedType, amount, units, nav, date, ref, indianFormat}),
 * returns the same list with `balanceAfter` computed as a running total,
 * plus the final closing units.
 */
export function withRunningBalance(openingUnits, txns) {
  let balance = openingUnits;
  const out = [];
  for (const t of txns) {
    const direction = FIXTURE_DIRECTION[t.expectedType] ?? 0;
    const units = t.units ?? 0;
    balance = round6(balance + direction * units);
    out.push({ ...t, balanceAfter: balance });
  }
  return { transactions: out, closingUnits: balance };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function pan(seed) {
  // Deterministic synthetic PAN-shaped string, never a real PAN.
  return `ABCDE${String(seed).padStart(4, '0')}F`;
}
