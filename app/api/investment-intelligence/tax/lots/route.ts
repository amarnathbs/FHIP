import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { ownerClassField, resolveOwnerClassScope } from '@/lib/services/investment-intelligence/ownerClassScope';
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
    const rootClient = await createClient();
    const scope = await resolveOwnerClassScope(request, rootClient, user.id);
    if (!scope.ok) return scope.response;
    const supabase = scope.client;
    const { dataset, warnings, empty } = await loadTaxDataset(supabase, user.id, { asOfDate: asOfRaw ?? undefined });
    if (empty || !dataset) {
      return ok({ empty: true, ownerClass: ownerClassField(scope), warnings, lots: [] });
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
        instrumentName: dataset.instrumentNames.get(l.instrumentKey) ?? 'Unnamed fund',
        // II-PC1-F1: FIFO is scoped to (account, instrument), so a lot list
        // that showed only the instrument would imply the wrong thing to a
        // user holding one scheme in two folios — two separate FIFO queues
        // would look like one pooled queue. The folio is now explicit.
        accountId: l.accountKey,
        accountLabel: dataset.accountLabels.get(l.accountKey) ?? 'Folio without a recorded number',
        kind: l.kind,
        acquisitionDate: l.acquisitionDate,
        unitsAcquired: l.unitsAcquired,
        unitsRemaining: l.unitsRemaining,
        status: l.unitsRemaining <= 1e-6 ? 'fully_consumed' : l.unitsRemaining < l.unitsAcquired ? 'partially_consumed' : 'open',
        costPerUnit: l.costPerUnit,
      })),
    });
  } catch (e) {
    // Document2 closure finding #16: do not interpolate the engine's raw
    // error message (may embed an internal lot/event id, see
    // tax/summary/route.ts's catch block for the full rationale) into the
    // user-facing body. Preserved server-side for debugging only.
    const rawMessage = e instanceof Error ? e.message : 'Unknown error';
    console.error('[investment-intelligence/tax/lots] tax lots could not be listed', { error: rawMessage });
    return bad('Tax lots could not be listed because your transaction or lot history is inconsistent. Please review your Investment Intelligence statements for missing or conflicting data.', 500);
  }
}
