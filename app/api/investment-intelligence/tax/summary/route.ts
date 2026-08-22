import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations, loadTaxProfile, toTaxProfileInput } from '@/lib/services/investment-intelligence/taxRepository';
import { runTaxSimulation } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';
import type { TaxpayerType } from '@/lib/engines/investment-intelligence/tax/taxProfile';

const VALID_TAXPAYER_TYPES = new Set(['RESIDENT_INDIVIDUAL', 'RESIDENT_HUF', 'NON_RESIDENT_INDIVIDUAL']);

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

  // R6-FINAL (Sections 20-23): explicit, EXPLICIT-ONLY tax-profile
  // resolution. Precedence: an explicit per-request query override (used by
  // the LIVE-R6-011/012 certification scenarios, and by any caller while
  // migration 0060's persistence is pending) wins over a persisted profile,
  // which wins over "no profile" (UNKNOWN_PROFILE, never assumed resident).
  // Never inferred from any other field — see taxProfile.ts's header.
  const overrideTaxpayerType = url.searchParams.get('taxpayerType');
  if (overrideTaxpayerType && !VALID_TAXPAYER_TYPES.has(overrideTaxpayerType)) {
    return bad('Invalid taxpayerType override: must be one of RESIDENT_INDIVIDUAL, RESIDENT_HUF, NON_RESIDENT_INDIVIDUAL.');
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

    // R6-FINAL: resolve the explicit tax profile — override param first,
    // else a persisted ii_tax_profiles row (once migration 0060 is applied;
    // gracefully absent until then), else "no profile" (UNKNOWN_PROFILE).
    const { profile: persistedProfile } = await loadTaxProfile(supabase, user.id);
    const taxProfile = overrideTaxpayerType
      ? { taxpayerType: overrideTaxpayerType as TaxpayerType, taxYear: url.searchParams.get('taxYear') }
      : toTaxProfileInput(persistedProfile);

    // Residency: derived from the SAME explicit taxProfile (never any other
    // field) — a NON_RESIDENT_INDIVIDUAL/NON_RESIDENT profile flows straight
    // into checkResidency() so NRI_SCOPE_DISCLAIMER attaches consistently
    // with taxpayerContext.estimateBasis === 'INDIA_DOMESTIC_LAW_ESTIMATE'.
    // No profile at all still fails safe exactly as before this dispatch:
    // status 'unknown', nriRulesMayApply true, NRI_SCOPE_DISCLAIMER shown.
    const residencyProfile =
      taxProfile.taxpayerType === 'NON_RESIDENT_INDIVIDUAL'
        ? { residencyStatus: 'nri' as const }
        : taxProfile.taxpayerType === 'RESIDENT_INDIVIDUAL' || taxProfile.taxpayerType === 'RESIDENT_HUF'
          ? { residencyStatus: 'resident' as const }
          : {};

    const result = runTaxSimulation({
      acquisitions,
      disposals,
      classificationByInstrument: dataset.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal: dataset.salePricePerUnitByDisposal,
      exitLoadSchedules: dataset.exitLoadSchedules,
      residencyProfile,
      taxProfile,
    });

    // Lots must be persisted first — ii_capital_gains_computations.lot_id
    // is a not-null FK into ii_tax_lots (see persistTaxLots's header for the
    // defect this fixes).
    const lotsPersistence = await persistTaxLots(user.id, result.lots, dataset.accountIdByTransactionId);
    const consumptionsPersistence = await persistTaxLotConsumptions(user.id, result.disposalResults);
    const persistence = await persistCapitalGainsComputations(user.id, result.disposalResults, result.exitLoadResults);

    return ok({
      empty: false,
      classification: result.classification,
      disclaimer: result.disclaimer,
      residencyNote: result.residencyNote ?? null,
      ruleVersionNote: result.ruleVersionNote ?? null,
      taxpayerContext: result.taxpayerContext,
      taxProfileSource: overrideTaxpayerType ? 'request_override' : persistedProfile ? 'persisted_profile' : 'none',
      engineVersion: result.engineVersion,
      asOfDate: dataset.asOfDate,
      warnings: [
        ...warnings,
        ...(lotsPersistence.error ? [{ scope: 'lots_persistence', detail: `Tax lots could not be stored (${lotsPersistence.error}); the figures shown were recomputed from certified inputs.` }] : []),
        ...(consumptionsPersistence.error ? [{ scope: 'consumptions_persistence', detail: `Lot consumptions could not be stored (${consumptionsPersistence.error}); the figures shown were recomputed from certified inputs.` }] : []),
        ...(persistence.error ? [{ scope: 'persistence', detail: `Results could not be stored (${persistence.error}); the figures shown were recomputed from certified inputs.` }] : []),
      ],
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
