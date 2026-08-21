import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { loadTaxDataset, persistCapitalGainsComputations } from '@/lib/services/investment-intelligence/taxRepository';
import { runTaxSimulation } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';

// Investment Intelligence R6-P1 — India Tax & Cost Intelligence summary for
// the authenticated user.
//
// SIMULATION ONLY — NOT TAX ADVICE. Every response carries `disclaimer`
// (and, when relevant, `residencyNote` / `ruleVersionNote`) from
// lib/engines/investment-intelligence/tax/disclaimer.ts. This is
// structurally enforced here: the disclaimer comes from the engine's own
// return value, not appended ad hoc by this route, so it cannot be dropped
// by a future edit to this file without also editing the engine.
//
// PARAMETER-SPOOFING DEFENCE: the only identity used is `user.id` from the
// authenticated session, matching the R5 SIP/X-ray routes. There is no
// account/instrument/classification parameter for a client to spoof — every
// authoritative input (transactions, classification, FMV, exit-load
// schedule, rule version) is resolved server-side in taxRepository.
//
// This route is READ-derived: it never writes to any FHIP financial
// register. Its only writes are to ii_capital_gains_computations, which is
// a derived/observational record, not part of net worth.

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
      return ok({
        empty: true,
        warnings,
        message: 'No investment transactions are available yet, so no tax simulation can be produced.',
      });
    }

    const acquisitions = [...dataset.acquisitionsByInstrument.values()].flat();
    const disposals = [...dataset.disposalsByInstrument.values()].flat();

    if (disposals.length === 0) {
      return ok({
        empty: true,
        warnings: [...warnings, { scope: 'disposals', detail: 'No redemptions/switch-outs are on record — there is nothing to compute capital gains on yet.' }],
        message: 'No disposals found. Capital-gains tax only applies once units are redeemed or switched out.',
      });
    }

    // Residency: this session found no confirmed household-profile
    // residency field to read from — see taxRepository.ts / residency.ts
    // header comments and the R6-P1 completion report's "known limitations"
    // section. Passing an empty profile means checkResidency() fails safe:
    // status 'unknown', nriRulesMayApply true, NRI_SCOPE_DISCLAIMER shown.
    const result = runTaxSimulation({
      acquisitions,
      disposals,
      classificationByInstrument: dataset.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal: dataset.salePricePerUnitByDisposal,
      exitLoadSchedules: dataset.exitLoadSchedules,
      residencyProfile: {},
    });

    const persistence = await persistCapitalGainsComputations(user.id, result.disposalResults, result.exitLoadResults);

    return ok({
      empty: false,
      classification: result.classification,
      disclaimer: result.disclaimer,
      residencyNote: result.residencyNote ?? null,
      ruleVersionNote: result.ruleVersionNote ?? null,
      engineVersion: result.engineVersion,
      asOfDate: dataset.asOfDate,
      warnings: persistence.error ? [...warnings, { scope: 'persistence', detail: `Results could not be stored (${persistence.error}); the figures shown were recomputed from certified inputs.` }] : warnings,
      taxYearAggregation: result.taxYearAggregation,
      disposalResults: result.disposalResults.map((d) => ({
        instrumentId: d.instrumentKey,
        instrumentName: dataset.instrumentNames.get(d.instrumentKey) ?? d.instrumentKey,
        acquisitionDate: d.acquisitionDate,
        disposalDate: d.disposalDate,
        unitsConsumed: d.unitsConsumed,
        classification: d.classification,
        gainType: d.gainType,
        holdingDays: d.holdingDays,
        ruleVersion: d.ruleVersion,
        ruleVersionPlaceholder: d.ruleVersionPlaceholder,
        saleValue: d.saleValue,
        costBasisUsed: d.costBasisUsed,
        taxableGain: d.taxableGain,
        grandfathering: d.grandfathering,
        note: d.note,
      })),
      exitLoadResults: result.exitLoadResults,
    });
  } catch (e) {
    // Clean error handling: a failure surfaces as an explicit error, never
    // as a zero-valued result a caller could mistake for a real calculation.
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Tax simulation could not be calculated: ${message}`, 500);
  }
}
