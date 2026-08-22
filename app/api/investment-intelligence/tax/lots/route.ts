import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { loadTaxDataset } from '@/lib/services/investment-intelligence/taxRepository';
import { runTaxSimulation } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';

// Investment Intelligence R6-FINAL — open/consumed tax-lot listing (FIFO
// state) for the authenticated user (spec Section 23).
//
// Recomputes lots from the same certified `runTaxSimulation` pipeline the
// summary route uses (no separate/parallel lot-matching logic to drift out
// of sync) — `ii_tax_lots` itself is not read/written here; lots are always
// derived fresh from `ii_transactions`, exactly as the summary route does.
// SIMULATION ONLY — carries the same `disclaimer`.

export async function GET(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(request.url);
  const asOfRaw = url.searchParams.get('asOf');
  if (asOfRaw && !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
    return bad('Invalid date parameter: expected YYYY-MM-DD.');
  }

  try {
    const supabase = await createClient();
    const { dataset, warnings, empty } = await loadTaxDataset(supabase, user.id, { asOfDate: asOfRaw ?? undefined });
    if (empty || !dataset) {
      return ok({ empty: true, warnings, lots: [] });
    }

    const acquisitions = [...dataset.acquisitionsByInstrument.values()].flat();
    const disposals = [...dataset.disposalsByInstrument.values()].flat();

    const result = runTaxSimulation({
      acquisitions,
      disposals,
      classificationByInstrument: dataset.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal: dataset.salePricePerUnitByDisposal,
      exitLoadSchedules: dataset.exitLoadSchedules,
      residencyProfile: {},
    });

    return ok({
      empty: false,
      disclaimer: result.disclaimer,
      asOfDate: dataset.asOfDate,
      warnings,
      lots: result.lots.map((l) => ({
        lotId: l.lotId,
        instrumentId: l.instrumentKey,
        instrumentName: dataset.instrumentNames.get(l.instrumentKey) ?? l.instrumentKey,
        kind: l.kind,
        acquisitionDate: l.acquisitionDate,
        unitsAcquired: l.unitsAcquired,
        unitsRemaining: l.unitsRemaining,
        status: l.unitsRemaining <= 1e-6 ? 'fully_consumed' : l.unitsRemaining < l.unitsAcquired ? 'partially_consumed' : 'open',
        costPerUnit: l.costPerUnit,
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Tax lots could not be listed: ${message}`, 500);
  }
}
