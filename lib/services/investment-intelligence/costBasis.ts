// Investment Intelligence — Performance tab Holdings "Cost Value" (2026-09-19).
//
// WHY THIS EXISTS, AND WHY IT DOES NOT USE ii_tax_lots. The Holdings table's
// Cost Value column was originally sourced from ii_tax_lots (units_remaining
// x cost_per_unit). Found live: ii_tax_lots is only ever populated as a
// side effect of the Tax & Cost tab's capital-gains simulation, and that
// route returns early and writes nothing at all when a position has zero
// disposals (`if (disposals.length === 0) return ...` — see
// app/api/investment-intelligence/tax/summary/route.ts). A pure buy-and-hold
// position — the overwhelmingly common case, and the case for every
// position in the Product Owner's own real statement — therefore NEVER
// gets a tax-lot row, under ANY existing pathway, regardless of which tab
// is visited. Cost Value is a simple "what did I pay for what I still
// hold" question that does not need a tax-lot record at all, so this
// computes it directly and independently from the transaction ledger.
//
// This is DELIBERATELY NOT a tax-grade FIFO cost-basis figure — it uses a
// simple average-cost method, is not tied to any specific lot, and is not
// suitable for capital-gains tax computation (the Tax & Cost tab's own
// FIFO ii_tax_lots engine remains the sole authority for that). It exists
// purely to answer "what do I actually hold, at what cost" for display,
// matching the Product Owner's own reference workbook's Holdings tab,
// which computes it the same simple way (net of purchase amounts).
//
// Direction is read from the SAME signed unit delta reconciliation.ts's
// own unitDeltaForTransaction() already produces for the certified
// reconciliation engine — never a second, independently-guessed
// purchase/redemption classification that could quietly disagree with it.
// A transaction with zero unit delta (a fee, a tax charge, an
// un-reinvested dividend) contributes to neither cost nor units — it is a
// cash event, not a change in what is held.

export interface CostBasisTransaction {
  grossAmount: number; // as stored — sign follows the source statement's own convention (a reversal is already negative)
  unitDelta: number; // signed, from reconciliation.ts's unitDeltaForTransaction — positive = units acquired, negative = units disposed
}

export interface CostBasisResult {
  costValue: number | null; // null when the position has never had a single unit-acquiring transaction (nothing to base a cost on)
  unitsAtCost: number; // running unit count this cost value corresponds to — should track the position's real unit balance when the ledger is complete
}

/**
 * Average-cost running total, replayed over a position's own transactions
 * in date order. Not FIFO, not lot-specific — see module header for why
 * that is the deliberate, correct choice for this display-only purpose.
 */
export function computeCostValue(transactionsInDateOrder: readonly CostBasisTransaction[]): CostBasisResult {
  let runningCost = 0;
  let runningUnits = 0;
  let everAcquired = false;

  for (const t of transactionsInDateOrder) {
    if (t.unitDelta > 0) {
      runningCost += Math.abs(t.grossAmount);
      runningUnits += t.unitDelta;
      everAcquired = true;
    } else if (t.unitDelta < 0) {
      // Disposal: reduce cost basis proportionally at the average cost per
      // unit held immediately before this disposal, never below zero units
      // (a disposal larger than the running balance is a data-quality
      // condition this function does not try to paper over — it clamps
      // rather than going negative, and the caller's own reconciliation
      // check is what should have already flagged that scenario).
      const avgCostPerUnit = runningUnits > 0 ? runningCost / runningUnits : 0;
      const unitsRemoved = Math.min(Math.abs(t.unitDelta), runningUnits);
      runningCost -= avgCostPerUnit * unitsRemoved;
      runningUnits -= unitsRemoved;
    }
    // unitDelta === 0 (fee/tax/non-reinvested dividend): cash event only, contributes to neither cost nor units.
  }

  return { costValue: everAcquired ? runningCost : null, unitsAtCost: runningUnits };
}
