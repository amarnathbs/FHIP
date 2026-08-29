import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadTaxDataset } from '@/lib/services/investment-intelligence/taxRepository';
import { runTaxSimulation } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';
import type { DisposalEvent } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';

// Investment Intelligence R6-FINAL — hypothetical redemption/switch-out
// preview (spec Section 27's "Redemption Simulator").
//
// NEVER PERSISTED: the hypothetical disposal is layered on top of the
// user's REAL open lots (so FIFO consumption order and grandfathering are
// realistic) but the result is a preview only — this route never calls
// persistCapitalGainsComputations, and the hypothetical disposal never
// touches ii_transactions. Closing this loop is what distinguishes it from
// tax/summary, which persists results for REAL, already-recorded disposals.
//
// SIMULATION ONLY — carries the same `disclaimer`; never "Final Tax
// Payable"/"You Owe" language (Section 24).

export async function POST(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  let body: { instrumentId?: string; units?: number; pricePerUnit?: number; disposalDate?: string; disposalType?: 'redemption' | 'switch_out' };
  try {
    body = await request.json();
  } catch {
    return bad('Invalid JSON body.');
  }

  const { instrumentId, units, pricePerUnit, disposalDate } = body;
  if (!instrumentId || typeof instrumentId !== 'string') return bad('instrumentId is required.');
  if (typeof units !== 'number' || !(units > 0)) return bad('units must be a positive number.');
  if (typeof pricePerUnit !== 'number' || !(pricePerUnit > 0)) return bad('pricePerUnit must be a positive number.');
  if (!disposalDate || !/^\d{4}-\d{2}-\d{2}$/.test(disposalDate)) return bad('disposalDate is required, format YYYY-MM-DD.');

  try {
    const supabase = await createClient();
    const { dataset, empty } = await loadTaxDataset(supabase, user.id, { asOfDate: disposalDate });
    if (empty || !dataset) {
      return bad('No investment transactions are available yet — nothing to simulate a redemption against.', 422);
    }
    if (!dataset.acquisitionsByInstrument.has(instrumentId)) {
      return bad('No holdings on record for this instrument — cannot simulate a redemption you do not hold.', 422);
    }

    const acquisitions = [...dataset.acquisitionsByInstrument.values()].flat();
    const realDisposals = [...dataset.disposalsByInstrument.values()].flat();

    const hypotheticalId = `hypothetical-${crypto.randomUUID()}`;
    const hypotheticalDisposal: DisposalEvent = {
      sourceEventId: hypotheticalId,
      instrumentKey: instrumentId,
      disposalDate,
      units,
      saleValue: units * pricePerUnit,
    };

    const salePricePerUnitByDisposal = new Map(dataset.salePricePerUnitByDisposal);
    salePricePerUnitByDisposal.set(hypotheticalId, pricePerUnit);

    const result = runTaxSimulation({
      acquisitions,
      disposals: [...realDisposals, hypotheticalDisposal],
      classificationByInstrument: dataset.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal,
      exitLoadSchedules: dataset.exitLoadSchedules,
      residencyProfile: {},
    });

    const hypotheticalResults = result.disposalResults.filter((d) => d.disposalEventId === hypotheticalId);
    const hypotheticalExitLoad = result.exitLoadResults.filter((e) => e.disposalEventId === hypotheticalId);

    if (hypotheticalResults.length === 0) {
      return bad('Simulated redemption could not be matched against any open lot — check units/instrument.', 422);
    }

    return ok({
      hypothetical: true,
      persisted: false,
      disclaimer: result.disclaimer,
      instrumentName: dataset.instrumentNames.get(instrumentId) ?? instrumentId,
      totalTaxableGain: hypotheticalResults.reduce((s, d) => s + (d.taxableGain ?? 0), 0),
      totalExitLoadAmount: hypotheticalExitLoad.reduce((s, e) => s + e.exitLoadAmount, 0),
      lotBreakdown: hypotheticalResults.map((d) => ({
        lotId: d.lotId,
        acquisitionDate: d.acquisitionDate,
        unitsConsumed: d.unitsConsumed,
        classification: d.classification,
        gainType: d.gainType,
        holdingDays: d.holdingDays,
        costBasisUsed: d.costBasisUsed,
        taxableGain: d.taxableGain,
        grandfathering: d.grandfathering,
        note: d.note,
      })),
      exitLoadBreakdown: hypotheticalExitLoad,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Redemption simulation could not be calculated: ${message}`, 500);
  }
}
