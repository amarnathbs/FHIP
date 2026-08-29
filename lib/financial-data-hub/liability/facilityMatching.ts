/**
 * FDH-10 — Credit Cards & Loans Intelligence: LIABILITY FACILITY MATCHING
 * (spec sections 50-52, 59-60, 125-138).
 *
 * NEVER BALANCE ALONE (spec section 51). Matching signals are institution,
 * facility/debt type, masked identifier and nickname/currency — a statement
 * whose closing balance happens to equal an existing Liability's balance is
 * not, by itself, evidence they are the same facility (two personal loans
 * from the same bank can coincidentally show the same balance on the day a
 * statement is imported).
 *
 * PRESERVES PROPERTY<->LIABILITY LINKING (spec section 59). This module never
 * writes to `property_liability_links` and never reasons about property
 * identity — a mortgage already linked to a property is matched by FACILITY
 * identity exactly like any other liability; the existing link is untouched
 * by construction because nothing here can see or touch that table.
 */

export interface ExistingLiabilityCandidate {
  liabilityId: string;
  debtType: string;
  currencyCode: string;
  maskedIdentifier: string | null;
  lender: string | null;
  liabilityName: string;
}

export interface FacilityMatchQuery {
  facilityDebtType: string;
  currencyCode: string;
  institutionName: string | null;
  maskedIdentifier: string | null;
}

export type FacilityMatchOutcome = 'single_match' | 'no_match' | 'ambiguous';

export interface FacilityMatchResult {
  outcome: FacilityMatchOutcome;
  matchedLiabilityId: string | null;
  candidateIds: string[];
}

function foldName(s: string | null | undefined): string | null {
  if (!s) return null;
  const folded = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return folded || null;
}

/**
 * Match a parsed statement's facility identity against the user's existing
 * Liabilities.
 *
 * TIER 1 — masked identifier match (strongest: an exact account/card
 * fingerprint). Currency and debt type must ALSO agree — a masked identifier
 * collision across a completely different facility type is not trusted
 * blindly.
 *
 * TIER 2 — institution (lender) + debt type + currency, when no masked
 * identifier is available on either side. Two facilities from the same
 * lender of the SAME type is exactly the "multiple cards with the same bank"
 * case (spec section 72) — this tier deliberately returns `ambiguous` rather
 * than picking one when more than one candidate clears it, so a supplementary
 * or second card is never silently merged into the wrong existing row.
 */
export function matchLiabilityFacility(
  query: FacilityMatchQuery,
  existing: readonly ExistingLiabilityCandidate[],
): FacilityMatchResult {
  const sameTypeCurrency = existing.filter(
    (l) => l.debtType === query.facilityDebtType && l.currencyCode === query.currencyCode,
  );

  // FIX (live-DEV final certification round): genuinely reproduced live
  // against real hosted Postgres. A generic loan CSV adapter (e.g.
  // au_loan_generic_v1) always declares ONE fixed facilityType/debtType
  // ('home_loan' -> 'mortgage') regardless of what the statement is actually
  // for — there is no per-statement signal distinguishing a mortgage from a
  // personal/vehicle/investment-property loan in a generic transaction-history
  // CSV. When the statement also carries a masked_identifier that matches
  // NOTHING in the (mis-derived) debt-type bucket, the institution-only
  // fallback below used to search every same-bucket liability regardless of
  // whether IT ALSO already has its own (different) masked_identifier on
  // file — so an unrelated, already-identified mortgage sharing the same
  // lender name silently absorbed a statement that was never about it,
  // overwriting its balance. The fallback's own comment already says why it
  // exists: "the existing Liability may predate FDH-10 and simply have no
  // masked_identifier recorded yet" — so it must only ever consider
  // candidates matching that description (maskedIdentifier is null), never a
  // liability that already has a DIFFERENT masked identifier recorded, which
  // is itself proof it is a distinct physical facility.
  let institutionFallbackPool = sameTypeCurrency;

  if (query.maskedIdentifier) {
    const byMasked = sameTypeCurrency.filter((l) => l.maskedIdentifier === query.maskedIdentifier);
    if (byMasked.length === 1) {
      return { outcome: 'single_match', matchedLiabilityId: byMasked[0].liabilityId, candidateIds: [byMasked[0].liabilityId] };
    }
    if (byMasked.length > 1) {
      return { outcome: 'ambiguous', matchedLiabilityId: null, candidateIds: byMasked.map((l) => l.liabilityId) };
    }
    // A masked identifier was supplied but matched nothing — fall through to
    // institution-based matching rather than immediately declaring no_match,
    // since the existing Liability may predate FDH-10 and simply have no
    // masked_identifier recorded yet. Restrict the fallback pool accordingly
    // (see fix note above): a liability that already has its OWN, different
    // masked identifier is never a candidate here.
    institutionFallbackPool = sameTypeCurrency.filter((l) => l.maskedIdentifier == null);
  }

  const institution = foldName(query.institutionName);
  if (institution) {
    const byInstitution = institutionFallbackPool.filter((l) => foldName(l.lender) === institution || foldName(l.liabilityName)?.includes(institution));
    if (byInstitution.length === 1) {
      return { outcome: 'single_match', matchedLiabilityId: byInstitution[0].liabilityId, candidateIds: [byInstitution[0].liabilityId] };
    }
    if (byInstitution.length > 1) {
      return { outcome: 'ambiguous', matchedLiabilityId: null, candidateIds: byInstitution.map((l) => l.liabilityId) };
    }
  }

  return { outcome: 'no_match', matchedLiabilityId: null, candidateIds: [] };
}
