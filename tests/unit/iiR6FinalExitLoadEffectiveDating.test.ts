// R6-FINAL closure — effective-dated exit-load schedule selection.
//
// FINDING (2026-08-22, discovered while building Section 33's NC-5 negative
// control): taxOrchestrator.ts's exit-load schedule selection used a bare
// `.find((s) => s.instrumentKey === disposal.instrumentKey)` with NO check
// against the disposal's own date. A scheme can have more than one exit-
// load schedule version over time (migration 0058's
// unique(instrument_id, effective_from) explicitly anticipates this), so
// this would silently apply whichever schedule row happened to be first in
// array order — potentially a CURRENT schedule — to a HISTORICAL disposal,
// or vice versa. This is exactly the R6-FINAL spec's Section 33 NC-5 defect
// shape ("apply a current exit-load schedule to a historical lot"). Fixed
// in this same pass (see taxOrchestrator.ts) to select the schedule version
// actually in force on the disposal date, mirroring resolveRuleVersion's
// own effective-dated pattern. This test certifies the fix and doubles as
// the historical-lot regression target for NC-5.

import { describe, it, expect } from 'vitest';
import { runTaxSimulation, type TaxSimulationInputs } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';
import type { AcquisitionEvent, DisposalEvent } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import type { ExitLoadSchedule } from '@/lib/engines/investment-intelligence/tax/exitLoad';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';

const INSTRUMENT = 'SCH-EXITLOAD-HIST';

function baseInputs(overrides: Partial<TaxSimulationInputs>): TaxSimulationInputs {
  const classification: SchemeClassificationResult = {
    instrumentKey: INSTRUMENT,
    classification: 'equity_oriented',
    domesticEquityPct: 80,
    basis: 'computed_from_holdings',
    disclosureDate: null,
    note: '',
  };
  return {
    acquisitions: [],
    disposals: [],
    classificationByInstrument: new Map([[INSTRUMENT, classification]]),
    fmv31Jan2018ByInstrument: new Map([[INSTRUMENT, null]]),
    salePricePerUnitByDisposal: new Map(),
    exitLoadSchedules: [],
    residencyProfile: { residencyStatus: 'resident' },
    ...overrides,
  };
}

describe('R6-FINAL: exit-load schedule is selected by the DISPOSAL date, not "whichever schedule is found first"', () => {
  // Both schedule windows and both disposal dates deliberately sit within
  // the tax rule versions' covered range (2023-04-01 onward) so this test
  // exercises ONLY the exit-load-schedule-selection fix, not an unrelated
  // "no rule version covers this date" failure from resolveRuleVersion.
  const HISTORICAL_SCHEDULE: ExitLoadSchedule = {
    instrumentKey: INSTRUMENT,
    tiers: [{ uptoDays: 90, loadPct: 3 }], // old, stricter schedule
    effectiveFrom: '2023-04-01',
    effectiveTo: '2024-12-31',
  };
  const CURRENT_SCHEDULE: ExitLoadSchedule = {
    instrumentKey: INSTRUMENT,
    tiers: [{ uptoDays: 90, loadPct: 1 }], // newer, looser schedule
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
  };

  it('a HISTORICAL disposal (within the old schedule\'s window, held < 90 days) gets the OLD 3% tier, not the current 1% one', () => {
    // Acquired 2024-11-15, disposed 2024-12-01 -> 16 days holding, inside
    // the historical schedule's effectiveTo (2024-12-31) and inside its own
    // 90-day tier.
    const acquisitions: AcquisitionEvent[] = [
      { sourceEventId: 'acq-h', instrumentKey: INSTRUMENT, kind: 'purchase', acquisitionDate: '2024-11-15', units: 100, costPerUnit: 20 },
    ];
    const disposals: DisposalEvent[] = [{ sourceEventId: 'disp-h', instrumentKey: INSTRUMENT, disposalDate: '2024-12-01', units: 50, saleValue: 1500 }];
    const inputs = baseInputs({
      acquisitions,
      disposals,
      salePricePerUnitByDisposal: new Map([['disp-h', 30]]),
      exitLoadSchedules: [HISTORICAL_SCHEDULE, CURRENT_SCHEDULE],
    });
    const result = runTaxSimulation(inputs);
    expect(result.exitLoadResults).toHaveLength(1);
    expect(result.exitLoadResults[0].applicableLoadPct).toBe(3); // the HISTORICAL rate
  });

  it('a CURRENT disposal (after the new schedule takes effect, held < 90 days) gets the NEW 1% tier', () => {
    const acquisitions: AcquisitionEvent[] = [
      { sourceEventId: 'acq-c', instrumentKey: INSTRUMENT, kind: 'purchase', acquisitionDate: '2026-05-01', units: 100, costPerUnit: 20 },
    ];
    const disposals: DisposalEvent[] = [{ sourceEventId: 'disp-c', instrumentKey: INSTRUMENT, disposalDate: '2026-06-01', units: 50, saleValue: 1500 }];
    const inputs = baseInputs({
      acquisitions,
      disposals,
      salePricePerUnitByDisposal: new Map([['disp-c', 30]]),
      exitLoadSchedules: [HISTORICAL_SCHEDULE, CURRENT_SCHEDULE],
    });
    const result = runTaxSimulation(inputs);
    expect(result.exitLoadResults).toHaveLength(1);
    expect(result.exitLoadResults[0].applicableLoadPct).toBe(1); // the CURRENT rate
  });

  it('the two disposals above, run TOGETHER in one simulation, still resolve to their OWN correct era\'s schedule (no cross-contamination)', () => {
    const acquisitions: AcquisitionEvent[] = [
      { sourceEventId: 'acq-h2', instrumentKey: INSTRUMENT, kind: 'purchase', acquisitionDate: '2024-11-15', units: 100, costPerUnit: 20 },
      { sourceEventId: 'acq-c2', instrumentKey: INSTRUMENT, kind: 'purchase', acquisitionDate: '2026-05-01', units: 100, costPerUnit: 20 },
    ];
    const disposals: DisposalEvent[] = [
      // disp-h2 fully drains acq-h2's lot (FIFO would otherwise let disp-c2
      // spill into the older lot and pick up ITS acquisition date, which
      // would test FIFO ordering rather than schedule-era selection).
      { sourceEventId: 'disp-h2', instrumentKey: INSTRUMENT, disposalDate: '2024-12-01', units: 100, saleValue: 3000 },
      { sourceEventId: 'disp-c2', instrumentKey: INSTRUMENT, disposalDate: '2026-06-01', units: 50, saleValue: 1500 },
    ];
    const inputs = baseInputs({
      acquisitions,
      disposals,
      salePricePerUnitByDisposal: new Map([
        ['disp-h2', 30],
        ['disp-c2', 30],
      ]),
      exitLoadSchedules: [HISTORICAL_SCHEDULE, CURRENT_SCHEDULE],
    });
    const result = runTaxSimulation(inputs);
    expect(result.exitLoadResults).toHaveLength(2);
    const hist = result.exitLoadResults.find((r) => r.disposalEventId === 'disp-h2')!;
    const curr = result.exitLoadResults.find((r) => r.disposalEventId === 'disp-c2')!;
    expect(hist.applicableLoadPct).toBe(3);
    expect(curr.applicableLoadPct).toBe(1);
  });
});
