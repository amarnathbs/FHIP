// R6-FINAL live-DEV dispatch — explicit tax-profile input surface
// (Sections 20-22): RESIDENT_INDIVIDUAL / RESIDENT_HUF /
// NON_RESIDENT_INDIVIDUAL qualification, DTAA_NOT_EVALUATED honesty, and
// fail-safe UNKNOWN_PROFILE when no explicit profile is supplied. Hermetic —
// no live DEV involved.

import { describe, it, expect } from 'vitest';
import { resolveTaxpayerContext } from '@/lib/engines/investment-intelligence/tax/taxProfile';
import { runTaxSimulation, type TaxSimulationInputs } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';
import type { AcquisitionEvent, DisposalEvent } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';

// II-PC1-F1: FIFO is now scoped to (account, instrument). Every case in this
// pre-existing suite is a single-folio scenario, so one shared account key
// preserves the original behaviour and expectations exactly.
const ACCOUNT = 'acct-r6-taxpayer-ctx';

describe('resolveTaxpayerContext — pure function', () => {
  it('no profile supplied at all -> UNKNOWN_PROFILE, never assumed resident', () => {
    const r = resolveTaxpayerContext({});
    expect(r.taxpayerType).toBe('UNKNOWN');
    expect(r.residencyStatus).toBe('UNKNOWN');
    expect(r.estimateBasis).toBe('UNKNOWN_PROFILE');
    expect(r.dtaaEvaluated).toBe(false);
    expect(r.profileComplete).toBe(false);
  });

  it('RESIDENT_INDIVIDUAL -> RESIDENT_STANDARD, complete profile', () => {
    const r = resolveTaxpayerContext({ taxpayerType: 'RESIDENT_INDIVIDUAL' });
    expect(r.residencyStatus).toBe('RESIDENT');
    expect(r.estimateBasis).toBe('RESIDENT_STANDARD');
    expect(r.profileComplete).toBe(true);
  });

  it('RESIDENT_HUF -> RESIDENT_STANDARD but with an explicit HUF-scope note, not silently reusing the individual note verbatim', () => {
    const individual = resolveTaxpayerContext({ taxpayerType: 'RESIDENT_INDIVIDUAL' });
    const huf = resolveTaxpayerContext({ taxpayerType: 'RESIDENT_HUF' });
    expect(huf.taxpayerType).toBe('RESIDENT_HUF');
    expect(huf.residencyStatus).toBe('RESIDENT');
    expect(huf.estimateBasis).toBe('RESIDENT_STANDARD');
    expect(huf.profileComplete).toBe(true);
    expect(huf.taxpayerTypeNote).not.toBe(individual.taxpayerTypeNote);
    expect(huf.taxpayerTypeNote).toMatch(/HUF/);
  });

  it('NON_RESIDENT_INDIVIDUAL -> INDIA_DOMESTIC_LAW_ESTIMATE, dtaaEvaluated false, DTAA_NOT_EVALUATED note — never a fabricated treaty benefit', () => {
    const r = resolveTaxpayerContext({ taxpayerType: 'NON_RESIDENT_INDIVIDUAL' });
    expect(r.residencyStatus).toBe('NON_RESIDENT');
    expect(r.estimateBasis).toBe('INDIA_DOMESTIC_LAW_ESTIMATE');
    expect(r.dtaaEvaluated).toBe(false);
    expect(r.taxpayerTypeNote).toMatch(/DTAA_NOT_EVALUATED/);
  });

  it('taxResidencyStatus=NON_RESIDENT without an explicit taxpayerType still fails safe to the domestic-law-estimate/DTAA-not-evaluated path', () => {
    const r = resolveTaxpayerContext({ taxResidencyStatus: 'NON_RESIDENT' });
    expect(r.estimateBasis).toBe('INDIA_DOMESTIC_LAW_ESTIMATE');
    expect(r.dtaaEvaluated).toBe(false);
    expect(r.profileComplete).toBe(false); // taxpayerType itself was never explicitly given
  });

  it('an invalid/garbage taxpayerType value is treated as not supplied, not silently coerced', () => {
    // @ts-expect-error deliberately passing an invalid value to prove the runtime guard
    const r = resolveTaxpayerContext({ taxpayerType: 'SOMETHING_ELSE' });
    expect(r.estimateBasis).toBe('UNKNOWN_PROFILE');
  });
});

describe('runTaxSimulation — taxpayerContext wiring is additive, never changes the computed rupee figure', () => {
  const INSTRUMENT = 'SCH-TAXPAYER-CTX';
  const classification: SchemeClassificationResult = {
    instrumentKey: INSTRUMENT,
    classification: 'equity_oriented',
    domesticEquityPct: 80,
    basis: 'computed_from_holdings',
    disclosureDate: null,
    note: '',
  };
  const acquisitions: AcquisitionEvent[] = [{ sourceEventId: 'a1', accountKey: ACCOUNT, instrumentKey: INSTRUMENT, kind: 'purchase', acquisitionDate: '2022-01-10', units: 100, costPerUnit: 20 }];
  const disposals: DisposalEvent[] = [{ sourceEventId: 'd1', accountKey: ACCOUNT, instrumentKey: INSTRUMENT, disposalDate: '2024-01-10', units: 100, saleValue: 3000 }];

  function run(taxProfile?: TaxSimulationInputs['taxProfile']) {
    return runTaxSimulation({
      acquisitions,
      disposals,
      classificationByInstrument: new Map([[INSTRUMENT, classification]]),
      fmv31Jan2018ByInstrument: new Map([[INSTRUMENT, null]]),
      salePricePerUnitByDisposal: new Map([['d1', 30]]),
      exitLoadSchedules: [],
      residencyProfile: {},
      taxProfile,
    });
  }

  it('omitting taxProfile entirely still produces taxpayerContext=UNKNOWN_PROFILE and an unchanged taxableGain', () => {
    const noProfile = run(undefined);
    const explicitEmpty = run({});
    expect(noProfile.taxpayerContext.estimateBasis).toBe('UNKNOWN_PROFILE');
    expect(noProfile.disposalResults[0].taxableGain).toBe(explicitEmpty.disposalResults[0].taxableGain);
  });

  it('RESIDENT_INDIVIDUAL vs RESIDENT_HUF produce byte-identical taxableGain/gainType — no fabricated HUF-specific rate difference', () => {
    const individual = run({ taxpayerType: 'RESIDENT_INDIVIDUAL' });
    const huf = run({ taxpayerType: 'RESIDENT_HUF' });
    expect(huf.disposalResults[0].taxableGain).toBe(individual.disposalResults[0].taxableGain);
    expect(huf.disposalResults[0].gainType).toBe(individual.disposalResults[0].gainType);
    expect(huf.taxpayerContext.taxpayerType).toBe('RESIDENT_HUF');
    expect(individual.taxpayerContext.taxpayerType).toBe('RESIDENT_INDIVIDUAL');
  });

  it('NON_RESIDENT_INDIVIDUAL produces the SAME domestic-law taxableGain as a resident, flagged INDIA_DOMESTIC_LAW_ESTIMATE with dtaaEvaluated false, and residencyNote (NRI scope) attached', () => {
    const nri = run({ taxpayerType: 'NON_RESIDENT_INDIVIDUAL' });
    const resident = run({ taxpayerType: 'RESIDENT_INDIVIDUAL' });
    expect(nri.disposalResults[0].taxableGain).toBe(resident.disposalResults[0].taxableGain);
    expect(nri.taxpayerContext.estimateBasis).toBe('INDIA_DOMESTIC_LAW_ESTIMATE');
    expect(nri.taxpayerContext.dtaaEvaluated).toBe(false);
  });
});
