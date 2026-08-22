// Investment Intelligence R6-P1 — per-lot-consumption capital-gains
// computation. Ties together: FIFO lot matching (taxLotEngine.ts), holding
// period (holdingPeriod.ts), scheme classification (schemeClassification.ts),
// grandfathering (grandfathering.ts), and effective-dated rule resolution
// (ruleVersions.ts, keyed by the DISPOSAL's own date).
//
// A debt/specified mutual fund UNIT ACQUIRED ON/AFTER 1 April 2023 NEVER
// gets LTCG treatment — every gain is short-term at slab rate regardless of
// holding period (Section 50AA, Finance Act 2023 "specified mutual fund"
// rule). A unit ACQUIRED BEFORE 1 April 2023 is NOT covered by Section 50AA
// (which only catches acquisitions on/after that date) and instead retains
// the pre-existing debt-fund treatment — R6-DEBTFIX (2026-08-22) fixed a
// defect where this per-lot acquisition-date gate was documented in
// ruleVersions.ts (`DebtSpecifiedRules.specifiedFundAcquiredOnOrAfter`) but
// never actually read here, so every debt/specified lot — regardless of its
// OWN acquisition date — was unconditionally forced to STCG. See
// ruleVersions.ts's `LegacyDebtFundRegime` and
// docs/investment-intelligence/R6_DEBT_FUND_ACQUISITION_DATE_FIX.md for the
// full defect history, legal research, and live-DEV before/after proof.

import { computeHoldingPeriod } from './holdingPeriod';
import { applyGrandfathering, type GrandfatheringResult } from './grandfathering';
import { resolveRuleVersion, type TaxRuleVersion } from './ruleVersions';
import type { LotConsumption } from './taxLotEngine';
import type { SchemeClassificationResult } from './schemeClassification';

export type GainType = 'stcg' | 'ltcg';

export interface DisposalTaxResult {
  disposalEventId: string;
  lotId: string;
  instrumentKey: string;
  acquisitionDate: string;
  disposalDate: string;
  unitsConsumed: number;
  classification: SchemeClassificationResult['classification'];
  gainType: GainType | 'unresolved';
  holdingDays: number | null;
  ruleVersion: string | null;
  ruleVersionPlaceholder: boolean;
  saleValue: number;
  costBasisUsed: number;
  /** R6-FINAL addition: the RAW pre-grandfathering cost basis
   * (unitsConsumed * lot costPerUnit), i.e. `costBasisUsed` before any
   * Section 55(2)(ac) FMV step-up is applied. Equal to `costBasisUsed`
   * whenever grandfathering does not apply (debt/specified, unresolved,
   * short-term, or actual-cost-wins branches) — only diverges when
   * `grandfathering.basisSource === 'fmv_grandfathered'`. Added so
   * ii_tax_lot_consumptions (migration 0058's own schema — see
   * taxRepository.ts's persistTaxLotConsumptions) has a genuine value for
   * its `cost_basis_pre_grandfathering` column, not a recomputation. */
  costBasisPreGrandfathering: number;
  taxableGain: number | null;
  grandfathering: GrandfatheringResult | null;
  note: string;
}

export interface ComputeDisposalTaxInputs {
  consumption: LotConsumption;
  saleValuePerUnit: number;
  classification: SchemeClassificationResult;
  /** Only relevant for equity-oriented lots acquired before 1-Feb-2018;
   * ignored otherwise. Pass null when unknown/unavailable. */
  fmv31Jan2018PerUnit: number | null;
  ruleVersions?: readonly TaxRuleVersion[];
}

/**
 * Compute the tax treatment of a single FIFO lot consumption. Pure function
 * — no I/O. `classification.classification === 'unresolved'` short-circuits
 * to an unresolved result rather than guessing a treatment (spec: excluded
 * from any confident tax figure, surfaced as a data-quality gap).
 */
export function computeDisposalTax(inputs: ComputeDisposalTaxInputs): DisposalTaxResult {
  const { consumption: c, saleValuePerUnit, classification, fmv31Jan2018PerUnit, ruleVersions } = inputs;
  const saleValue = c.unitsConsumed * saleValuePerUnit;

  if (classification.classification === 'unresolved') {
    return {
      disposalEventId: c.disposalEventId,
      lotId: c.lotId,
      instrumentKey: c.instrumentKey,
      acquisitionDate: c.acquisitionDate,
      disposalDate: c.disposalDate,
      unitsConsumed: c.unitsConsumed,
      classification: 'unresolved',
      gainType: 'unresolved',
      holdingDays: null,
      ruleVersion: null,
      ruleVersionPlaceholder: false,
      saleValue,
      costBasisUsed: c.costBasis,
      costBasisPreGrandfathering: c.costBasis,
      taxableGain: null,
      grandfathering: null,
      note: `Scheme tax classification is unresolved (${classification.basis}) — excluded from confident tax figures. ${classification.note}`,
    };
  }

  const ruleVersion = resolveRuleVersion(c.disposalDate, ruleVersions);
  const rules = ruleVersion.ruleDefinition;

  // --- Debt/specified mutual fund. -----------------------------------------
  if (classification.classification === 'debt_specified') {
    const taxableGain = saleValue - c.costBasis;
    const acquiredUnderSection50AA = c.acquisitionDate >= rules.debtSpecified.specifiedFundAcquiredOnOrAfter;

    if (acquiredUnderSection50AA) {
      // Section 50AA (Finance Act 2023): units acquired ON/AFTER the cutoff
      // are always short-term at slab rate, regardless of holding period.
      const holding = computeHoldingPeriod(c.acquisitionDate, c.disposalDate, 12); // informational only
      return {
        disposalEventId: c.disposalEventId,
        lotId: c.lotId,
        instrumentKey: c.instrumentKey,
        acquisitionDate: c.acquisitionDate,
        disposalDate: c.disposalDate,
        unitsConsumed: c.unitsConsumed,
        classification: classification.classification,
        gainType: 'stcg', // always short-term, regardless of holding period
        holdingDays: holding.holdingDays,
        ruleVersion: ruleVersion.version,
        ruleVersionPlaceholder: rules.placeholder,
        saleValue,
        costBasisUsed: c.costBasis,
        costBasisPreGrandfathering: c.costBasis,
        taxableGain,
        grandfathering: null, // grandfathering never applies to debt/specified funds
        note: `Debt/specified mutual fund unit acquired ${c.acquisitionDate}, on/after the 1 April 2023 Section 50AA cutoff (Finance Act 2023) — always short-term at slab rate regardless of holding period; no indexation, no LTCG treatment.`,
      };
    }

    // Acquired BEFORE the Section 50AA cutoff: this lot is NOT a "specified
    // mutual fund" disposal — it retains the pre-existing debt-fund
    // treatment, evaluated under whichever legacy regime is in force on the
    // DISPOSAL date (ruleVersions.ts's `LegacyDebtFundRegime` — the 36-
    // month/20%-indexed regime before 23-Jul-2024, the 24-month/12.5%-
    // unindexed regime on/after).
    const legacy = rules.debtSpecified.legacyRegime;
    const holding = computeHoldingPeriod(c.acquisitionDate, c.disposalDate, legacy.ltcgHoldingPeriodMonths);
    const gainType: GainType = holding.isLongTerm ? 'ltcg' : 'stcg';

    let note: string;
    if (gainType === 'stcg') {
      note =
        `Debt/specified mutual fund unit acquired ${c.acquisitionDate}, BEFORE the 1 April 2023 ` +
        `Section 50AA cutoff — not a "specified mutual fund" disposal, retains pre-2023 debt-fund ` +
        `treatment. Held ${holding.holdingDays} days (<= ${legacy.ltcgHoldingPeriodMonths} months as ` +
        `of the disposal date's rule window) — short-term at slab rate.`;
    } else if (legacy.indexationAllowed) {
      note =
        `Debt/specified mutual fund unit acquired ${c.acquisitionDate}, BEFORE the 1 April 2023 ` +
        `Section 50AA cutoff, disposed ${c.disposalDate} (pre-23-Jul-2024 rate window) — long-term ` +
        `(held ${holding.holdingDays} days, > ${legacy.ltcgHoldingPeriodMonths} months) at ` +
        `${legacy.ltcgRatePct}% under Section 112 as it stood before Budget 2024. Cost-Inflation-` +
        `Index indexation benefit legally applies to this disposal but is NOT calculated by this ` +
        `release (no verified CII table wired in) — the cost basis and taxable gain shown use the ` +
        `UN-INDEXED acquisition cost only. Do not treat this taxable-gain figure as final; a correct ` +
        `indexed cost basis would raise the cost basis and lower the taxable gain shown here.`;
    } else {
      note =
        `Debt/specified mutual fund unit acquired ${c.acquisitionDate}, BEFORE the 1 April 2023 ` +
        `Section 50AA cutoff, disposed ${c.disposalDate} (on/after the 23 July 2024 Budget 2024 ` +
        `boundary) — long-term (held ${holding.holdingDays} days, > ${legacy.ltcgHoldingPeriodMonths} ` +
        `months) at ${legacy.ltcgRatePct}% with NO indexation (Budget 2024 removed the indexation ` +
        `benefit and shortened the LTCG holding threshold for this disposal-date window).`;
    }

    return {
      disposalEventId: c.disposalEventId,
      lotId: c.lotId,
      instrumentKey: c.instrumentKey,
      acquisitionDate: c.acquisitionDate,
      disposalDate: c.disposalDate,
      unitsConsumed: c.unitsConsumed,
      classification: classification.classification,
      gainType,
      holdingDays: holding.holdingDays,
      ruleVersion: ruleVersion.version,
      ruleVersionPlaceholder: rules.placeholder,
      saleValue,
      costBasisUsed: c.costBasis, // never indexed — see note when gainType === 'ltcg' && legacy.indexationAllowed
      costBasisPreGrandfathering: c.costBasis,
      taxableGain,
      grandfathering: null, // grandfathering (Sec 55(2)(ac)) is Section-112A/equity-linked; never applies to debt/specified funds
      note,
    };
  }

  // --- Equity-oriented or other-hybrid (post equity-test resolution): -----
  // both use the equity-oriented rate table once classifyScheme has already
  // applied the >=65% test — 'other_hybrid' at this point in the pipeline
  // means the test resolved to NOT equity-oriented, so it is taxed under
  // ordinary (non-112A) capital-gains rules: no LTCG-exemption threshold,
  // no grandfathering (Section 55(2)(ac) is Section-112A-linked), but the
  // same STCG/LTCG 12-month split and rates otherwise apply for a
  // conservative estimate absent slab-rate household data.
  const isEquityOriented = classification.classification === 'equity_oriented';
  const holding = computeHoldingPeriod(c.acquisitionDate, c.disposalDate, rules.equityOriented.stcgHoldingPeriodMonths);
  const gainType: GainType = holding.isLongTerm ? 'ltcg' : 'stcg';

  let costBasisUsed = c.costBasis;
  let grandfathering: GrandfatheringResult | null = null;

  if (gainType === 'ltcg' && isEquityOriented) {
    grandfathering = applyGrandfathering({
      acquisitionDate: c.acquisitionDate,
      actualCostPerUnit: c.costPerUnit,
      salePricePerUnit: saleValuePerUnit,
      fmvPerUnit: fmv31Jan2018PerUnit,
      isEquityOriented: true,
    });
    costBasisUsed = grandfathering.costBasisPerUnit * c.unitsConsumed;
  }

  const taxableGain = saleValue - costBasisUsed;

  return {
    disposalEventId: c.disposalEventId,
    lotId: c.lotId,
    instrumentKey: c.instrumentKey,
    acquisitionDate: c.acquisitionDate,
    disposalDate: c.disposalDate,
    unitsConsumed: c.unitsConsumed,
    classification: classification.classification,
    gainType,
    holdingDays: holding.holdingDays,
    ruleVersion: ruleVersion.version,
    ruleVersionPlaceholder: rules.placeholder,
    saleValue,
    costBasisUsed,
    costBasisPreGrandfathering: c.costBasis,
    taxableGain,
    grandfathering,
    note: isEquityOriented
      ? `Equity-oriented, ${gainType.toUpperCase()} (holding period ${holding.holdingDays} days, anniversary ${holding.anniversaryDate}).`
      : `Other/hybrid (equity-oriented test not met) — ${gainType.toUpperCase()} under general capital-gains treatment; Section 112A exemption/grandfathering not applicable.`,
  };
}
