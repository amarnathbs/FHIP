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

    const schedule = exitLoadSchedules.find((s) => s.instrumentKey === disposal.instrumentKey);
    if (schedule) {
      exitLoadResults.push(...computeExitLoadForConsumptions(consumptions, schedule));
    }
  }

  const taxYearAggregation = aggregateTaxYear(disposalResults, ruleVersions);
  const residency = checkResidency(residencyProfile);

  const result: TaxSimulationResult = {
    classification: 'SIMULATION',
    engineVersion: TAX_ENGINE_VERSION,
    lots,
    disposalResults,
    taxYearAggregation,
    exitLoadResults,
    residency,
  };

  const placeholderUsed = disposalResults.some((d) => d.ruleVersionPlaceholder);
  return withTaxDisclaimer(result, { nriFlagged: residency.nriRulesMayApply, placeholderRuleUsed: placeholderUsed });
}
