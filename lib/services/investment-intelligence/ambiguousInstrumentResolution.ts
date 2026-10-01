// Investment Intelligence — Document2 final non-benchmark closure, mission
// item #3 (ambiguous_instrument must have a genuine resolution path).
//
// PREFERRED ARCHITECTURE (per the Product Owner's mission spec): Review
// issue -> show candidate instruments -> user selects the correct canonical
// instrument -> save an explicit resolution -> preserve original source
// evidence -> Re-evaluate -> affected transactions/holdings resolve -> issue
// disappears -> Publish can proceed where no other blocker remains.
//
// STORAGE: reuses `ii_reconciliation_cases` itself as the resolution store —
// no new table, no new migration. A RESOLVED `ambiguous_instrument` case
// with `discrepancy_details.resolvedInstrumentId` set IS the explicit
// resolution; `discrepancy_details.signature` is the scheme identity it
// applies to. `resolveScheme()`'s own five-step priority chain (ISIN -> AMFI
// -> source identifier -> normalised name+plan+option+AMC -> controlled
// alias map) always resolves ISIN/AMFI/name-level ambiguity in the SAME
// deterministic way on every call — it can never fall through to a lower
// step once an earlier one reports >1 candidates, so the pre-existing
// `ii_scheme_alias_map` (its own step 5) can never actually be reached to
// fix a step-1/2/4 ambiguity. This module is therefore consulted BEFORE
// resolveScheme() is called at all: an explicit, human resolution for this
// exact scheme signature always wins over the automatic heuristic that
// already proved it cannot disambiguate this case on its own.
//
// SAFETY: signature matching is exact, never fuzzy (mirrors resolveScheme's
// own priority order: ISIN, then AMFI+country, then
// name+plan+option+AMC+country) — this module never guesses an
// economically different instrument, and a case only ever resolves the
// specific scheme identity it was raised for.

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitAuditEvent } from './audit';

export interface InstrumentResolutionSignature {
  isin: string | null;
  amfiSchemeCode: string | null;
  normalisedSchemeName: string;
  amcName: string | null;
  planType: string | null;
  optionType: string | null;
  countryCode: string;
}

export interface AmbiguousInstrumentCandidate {
  instrumentId: string;
  displayName: string;
  amcName: string | null;
  isin: string | null;
  planType: string | null;
  optionType: string | null;
}

/** Deterministic, non-fuzzy signature equality — mirrors resolveScheme's own priority order. */
export function instrumentSignaturesMatch(a: InstrumentResolutionSignature, b: InstrumentResolutionSignature): boolean {
  if (a.isin && b.isin) return a.isin.toUpperCase() === b.isin.toUpperCase();
  if (a.amfiSchemeCode && b.amfiSchemeCode) return a.amfiSchemeCode === b.amfiSchemeCode && a.countryCode === b.countryCode;
  return (
    a.normalisedSchemeName === b.normalisedSchemeName &&
    (a.amcName ?? null) === (b.amcName ?? null) &&
    (a.planType ?? null) === (b.planType ?? null) &&
    (a.optionType ?? null) === (b.optionType ?? null) &&
    a.countryCode === b.countryCode
  );
}

/**
 * Look up a previously RESOLVED ambiguous_instrument case for this user
 * whose recorded signature matches the scheme currently being resolved, and
 * return the instrument id the user explicitly chose. Never returns an
 * unresolved/dismissed/superseded case's value — only a genuinely resolved,
 * still-current (not-yet-superseded-by-amendment) decision.
 */
export async function findResolvedAmbiguousInstrumentOverride(
  admin: SupabaseClient,
  userId: string,
  signature: InstrumentResolutionSignature
): Promise<string | null> {
  // `ii_reconciliation_cases` has no `superseded_by_id` column (that exists
  // only on ii_prices_nav/ii_benchmark_series/ii_review_items) — this
  // table's own amend flow (resolutions/[caseId]/amend) instead inserts a
  // brand-new resolved row carrying `discrepancy_details.amendsCaseId` back
  // to the one it supersedes, exactly like the GET .../resolutions route's
  // own `supersededCaseIds` computation. Mirrored here so an amended
  // decision is never consulted — only its current successor is.
  const { data, error } = await admin
    .from('ii_reconciliation_cases')
    .select('id, discrepancy_details, resolved_at')
    .eq('user_id', userId)
    .eq('discrepancy_type', 'ambiguous_instrument')
    .eq('status', 'resolved')
    .order('resolved_at', { ascending: false });
  if (error || !data) return null;

  const supersededCaseIds = new Set<string>();
  for (const row of data) {
    const amendsCaseId = (row.discrepancy_details as Record<string, unknown> | null)?.amendsCaseId;
    if (typeof amendsCaseId === 'string') supersededCaseIds.add(amendsCaseId);
  }

  for (const row of data) {
    if (supersededCaseIds.has(row.id as string)) continue;
    const details = (row.discrepancy_details ?? null) as Record<string, unknown> | null;
    const resolvedInstrumentId = details?.resolvedInstrumentId as string | undefined;
    const rowSignature = details?.signature as InstrumentResolutionSignature | undefined;
    if (!resolvedInstrumentId || !rowSignature) continue;
    if (instrumentSignaturesMatch(rowSignature, signature)) return resolvedInstrumentId;
  }
  return null;
}

/**
 * Records that the automatic resolver reused this user's earlier explicit
 * choice for a repeat occurrence of the same scheme (a second statement
 * from the same source, or a Re-evaluate run) — visible in the audit trail
 * as its own distinct `matchedVia`, never silently indistinguishable from a
 * fresh automatic match.
 */
export async function auditUserResolvedAmbiguousInstrument(userId: string, instrumentId: string, parseRunId: string | null, scheme: string): Promise<void> {
  await emitAuditEvent({
    userId,
    eventType: 'instrument_resolved',
    subjectType: 'ii_instruments',
    subjectId: instrumentId,
    actorType: 'system',
    metadata: { matchedVia: 'user_resolved_ambiguous_instrument', scheme, parseRunId },
  });
}
