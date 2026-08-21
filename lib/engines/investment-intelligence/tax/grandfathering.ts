// Investment Intelligence R6-P1 — grandfathering (Section 55(2)(ac), the
// 31-Jan-2018 FMV rule) for equity-oriented mutual fund units acquired
// before 1 February 2018.
//
// RESEARCHED FORMULA (verified against ClearTax/HDFC Sky/ICICI Direct
// explainers of Section 55(2)(ac), all in agreement):
//
//   cost_of_acquisition_for_LTCG = max( actualCost, min(fmv31Jan2018, salePrice) )
//
// This is the "three-way comparison" the spec warns is easy to get wrong.
// The classic WRONG implementation computes `min(max(actualCost, fmv), salePrice)`
// (capping the max of cost/FMV at the sale price) — that formula is
// deceptively similar but produces the wrong answer whenever actualCost
// exceeds salePrice (a genuine pre-existing loss): the wrong formula forces
// the basis down to salePrice, erasing a real loss to zero, whereas the
// correct formula's `min(fmv, salePrice)` term is still dominated by
// `actualCost` in the outer `max`, correctly preserving the real loss.
//
// Verify against the three branches this module is certified on:
//  (a) FMV > actualCost and FMV < salePrice → FMV becomes the basis (the
//      classic grandfathering benefit: gain since 2018 only).
//  (b) FMV > salePrice → basis is capped at salePrice, so grandfathering can
//      reduce the taxable gain to exactly zero but never invents a loss.
//  (c) FMV <= actualCost → grandfathering has no effect; actualCost is used.
//
// The 31-Jan-2018 FMV must be a REAL historical NAV data point (from R2's
// ii_prices_nav series). This module never estimates or fabricates it — if
// the caller has no FMV for a scheme, it must pass `fmvPerUnit: null`, and
// this module reports `basisSource: 'fmv_unavailable'` rather than silently
// falling back without saying so.

export const GRANDFATHERING_CUTOFF_DATE = '2018-02-01'; // lots acquired ON or AFTER this date are NOT eligible
export const GRANDFATHERING_FMV_DATE = '2018-01-31';

export interface GrandfatheringInput {
  acquisitionDate: string; // ISO
  actualCostPerUnit: number;
  salePricePerUnit: number;
  /** The scheme's 31-Jan-2018 NAV, or null if genuinely unavailable. */
  fmvPerUnit: number | null;
  /** Only equity-oriented funds are eligible for Section 112A LTCG
   * treatment (and therefore grandfathering) — debt/specified funds never
   * get LTCG treatment at all (see taxClassification.ts), so this flag lets
   * the caller short-circuit without even passing an FMV. */
  isEquityOriented: boolean;
}

export type GrandfatheringBasisSource = 'not_applicable' | 'actual_cost' | 'fmv_grandfathered' | 'fmv_unavailable';

export interface GrandfatheringResult {
  eligible: boolean;
  basisSource: GrandfatheringBasisSource;
  costBasisPerUnit: number;
  note: string | null;
}

/**
 * Apply the grandfathering three-way comparison for one lot's per-unit cost
 * basis. Returns `costBasisPerUnit` unchanged (= actualCostPerUnit) whenever
 * grandfathering doesn't apply (acquired on/after cutoff, not
 * equity-oriented, or FMV missing).
 */
export function applyGrandfathering(input: GrandfatheringInput): GrandfatheringResult {
  const { acquisitionDate, actualCostPerUnit, salePricePerUnit, fmvPerUnit, isEquityOriented } = input;

  if (!isEquityOriented) {
    return {
      eligible: false,
      basisSource: 'not_applicable',
      costBasisPerUnit: actualCostPerUnit,
      note: 'Grandfathering applies only to equity-oriented fund LTCG (Section 112A); this scheme is not equity-oriented.',
    };
  }

  if (acquisitionDate >= GRANDFATHERING_CUTOFF_DATE) {
    return {
      eligible: false,
      basisSource: 'not_applicable',
      costBasisPerUnit: actualCostPerUnit,
      note: `Acquired ${acquisitionDate}, on/after the ${GRANDFATHERING_CUTOFF_DATE} cutoff — grandfathering does not apply.`,
    };
  }

  if (fmvPerUnit === null) {
    return {
      eligible: true,
      basisSource: 'fmv_unavailable',
      costBasisPerUnit: actualCostPerUnit,
      note: 'Grandfathering FMV unavailable — using acquisition cost only. This lot is eligible in principle but no verified 31-Jan-2018 NAV was found for this scheme.',
    };
  }

  // The researched formula: max(actualCost, min(fmv, salePrice)).
  const lowerOfFmvAndSale = Math.min(fmvPerUnit, salePricePerUnit);
  const costBasisPerUnit = Math.max(actualCostPerUnit, lowerOfFmvAndSale);

  const basisSource: GrandfatheringBasisSource = costBasisPerUnit > actualCostPerUnit ? 'fmv_grandfathered' : 'actual_cost';

  return {
    eligible: true,
    basisSource,
    costBasisPerUnit,
    note:
      basisSource === 'fmv_grandfathered'
        ? `Grandfathered basis ₹${costBasisPerUnit.toFixed(4)}/unit applied (FMV ${fmvPerUnit}, capped at sale price ${salePricePerUnit} where relevant).`
        : null,
  };
}
