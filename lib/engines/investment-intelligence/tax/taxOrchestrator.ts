// Investment Intelligence R6-P1 — top-level orchestrator tying together
// FIFO lot matching, classification, holding period, grandfathering,
// effective-dated rule resolution, tax-year aggregation, exit load, and the
// mandatory disclaimer. Mirrors the `sipOrchestrator.ts` /
// `analyticsOrchestrator.ts` shape from R4/R5: pure functions in, one
// labelled result out, no I/O.

import { buildTaxLots, consumeLotsFifo, type AcquisitionEvent, type DisposalEvent, type TaxLot } from './taxLotEngine';
import { computeDisposalTax, type DisposalTaxResult } from './capitalGainsEngine';
import { aggregateTaxYear, type TaxYearAggregationResult } from './taxYearAggregation';
import { computeExitLoadForConsumptions, type ExitLoadSchedule, type LotExitLoadResult } from './exitLoad';
import type { SchemeClassificationResult } from './schemeClassification';
import { checkResidency, type ResidencyCheckResult, type ResidencyProfileInput } from './residency';
import { resolveTaxpayerContext, type TaxProfileInput, type TaxpayerContextResult } from './taxProfile';
import { withTaxDisclaimer, type Disclaimed } from './disclaimer';
import { TAX_ENGINE_VERSION } from './taxVersioning';
import type { TaxRuleVersion } from './ruleVersions';

export interface TaxSimulationInputs {
  acquisitions: readonly AcquisitionEvent[];
  disposals: readonly DisposalEvent[];
  /** Classification per instrumentKey — resolved once by the caller
   * (typically per disposal date's rule version domestic-equity threshold),
   * looked up per-consumption below. */
  classificationByInstrument: ReadonlyMap<string, SchemeClassificationResult>;
  /** 31-Jan-2018 FMV per unit, by instrumentKey, where known. */
  fmv31Jan2018ByInstrument: ReadonlyMap<string, number | null>;
  /** Sale price per unit, by disposal sourceEventId (a disposal has one
   * sale price applied uniformly across whichever lots it consumes). */
  salePricePerUnitByDisposal: ReadonlyMap<string, number>;
  exitLoadSchedules: readonly ExitLoadSchedule[];
  residencyProfile: ResidencyProfileInput;
  /** R6-FINAL (Sections 20-22): explicit taxpayer-type/residency profile,
   * supplied ONLY when a caller has an actual deliberate user input to pass
   * — never inferred. Optional and additive: omitting it preserves every
   * pre-existing caller's exact behaviour (falls back to the UNKNOWN_PROFILE
   * branch, same as before this field existed). Does not change any
   * computed rupee figure — see taxProfile.ts's header for why. */
  taxProfile?: TaxProfileInput;
  ruleVersions?: readonly TaxRuleVersion[];
}

export interface TaxSimulationResult {
  classification: 'SIMULATION';
  engineVersion: typeof TAX_ENGINE_VERSION;
  lots: TaxLot[];
  disposalResults: DisposalTaxResult[];
  taxYearAggregation: TaxYearAggregationResult;
  exitLoadResults: LotExitLoadResult[];
  residency: ResidencyCheckResult;
  taxpayerContext: TaxpayerContextResult;
}

export type TaxSimulationOutput = TaxSimulationResult & Disclaimed & { residencyNote?: string; ruleVersionNote?: string };

export function runTaxSimulation(inputs: TaxSimulationInputs): TaxSimulationOutput {
  const {
    acquisitions,
    disposals,
    classificationByInstrument,
    fmv31Jan2018ByInstrument,
    salePricePerUnitByDisposal,
    exitLoadSchedules,
    residencyProfile,
    taxProfile,
    ruleVersions,
  } = inputs;

  const lots = buildTaxLots(acquisitions);

  const disposalResults: DisposalTaxResult[] = [];
  const exitLoadResults: LotExitLoadResult[] = [];

  for (const disposal of disposals) {
    const consumptions = consumeLotsFifo(lots, disposal);
    const classification = classificationByInstrument.get(disposal.instrumentKey);
    if (!classification) {
      throw new Error(`runTaxSimulation: no classification supplied for instrument ${disposal.instrumentKey}`);
    }
    const saleValuePerUnit = salePricePerUnitByDisposal.get(disposal.sourceEventId);
    if (saleValuePerUnit === undefined) {
      throw new Error(`runTaxSimulation: no sale price supplied for disposal ${disposal.sourceEventId}`);
    }
    const fmv = fmv31Jan2018ByInstrument.get(disposal.instrumentKey) ?? null;

    for (const consumption of consumptions) {
      disposalResults.push(
        computeDisposalTax({
          consumption,
          saleValuePerUnit,
          classification,
          fmv31Jan2018PerUnit: fmv,
          ruleVersions,
        })
      );
    }

    // R6-FINAL closure (2026-08-22) fix: a scheme can have MORE THAN ONE
    // exit-load schedule version over time (migration 0058's
    // unique(instrument_id, effective_from) explicitly anticipates this —
    // AMCs do revise exit-load tiers). The original `.find()` picked
    // whichever schedule row happened to be FIRST for the instrument in
    // whatever order the repository read them, with NO check against the
    // DISPOSAL's own date — i.e. exactly the Section 33 NC-5 defect shape
    // ("apply a current exit-load schedule to a historical lot"). Fixed to
    // select the schedule version actually in force on the disposal date,
    // mirroring resolveRuleVersion's own effective-dated pattern.
    const applicableSchedules = exitLoadSchedules.filter(
      (s) =>
        s.instrumentKey === disposal.instrumentKey &&
        disposal.disposalDate >= s.effectiveFrom &&
        (s.effectiveTo === null || disposal.disposalDate <= s.effectiveTo)
    );
    // Non-overlapping schedule periods are expected; if more than one still
    // matches, the most recently-effective one wins (never silently picks
    // an arbitrary one).
    const schedule = applicableSchedules.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
    if (schedule) {
      exitLoadResults.push(...computeExitLoadForConsumptions(consumptions, schedule));
    }
  }

  const taxYearAggregation = aggregateTaxYear(disposalResults, ruleVersions);
  const residency = checkResidency(residencyProfile);
  const taxpayerContext = resolveTaxpayerContext(taxProfile ?? {});

  const result: TaxSimulationResult = {
    classification: 'SIMULATION',
    engineVersion: TAX_ENGINE_VERSION,
    lots,
    disposalResults,
    taxYearAggregation,
    exitLoadResults,
    residency,
    taxpayerContext,
  };

  const placeholderUsed = disposalResults.some((d) => d.ruleVersionPlaceholder);
  return withTaxDisclaimer(result, { nriFlagged: residency.nriRulesMayApply, placeholderRuleUsed: placeholderUsed });
}
