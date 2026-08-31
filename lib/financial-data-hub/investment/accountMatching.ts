/**
 * FDH-11 — Australia INVESTMENT ACCOUNT matching (spec sections 43-46).
 *
 * NEVER MATCH BY CURRENT MARKET VALUE ALONE (spec section 43). Signals are
 * institution, jurisdiction, masked account identifier, account type and
 * currency — mirrors `lib/financial-data-hub/liability/facilityMatching.ts`'s
 * "never balance alone" discipline exactly, applied to investment accounts.
 */

export interface ExistingAuInvestmentAccountCandidate {
  accountId: string;
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  accountType: string; // II's `ii_accounts.account_type`, e.g. 'broker'
  currencyCode: string;
  countryCode: string;
}

export interface AccountMatchQuery {
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  accountType: string;
  currencyCode: string;
  countryCode: string;
}

export type AccountMatchOutcome = 'single_match' | 'no_match' | 'ambiguous';

export interface AccountMatchResult {
  outcome: AccountMatchOutcome;
  matchedAccountId: string | null;
  candidateIds: string[];
}

function foldName(s: string | null | undefined): string | null {
  if (!s) return null;
  const folded = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return folded || null;
}

/**
 * TIER 1 — masked account identifier match (strongest). Jurisdiction,
 * account type and currency must also agree.
 *
 * TIER 2 — institution + account type + currency + jurisdiction, when no
 * masked identifier is available on either side. More than one candidate
 * clearing this tier is AMBIGUOUS (spec section 46), never auto-picked —
 * this is exactly the "two brokerage accounts at the same broker" case.
 */
export function matchAuInvestmentAccount(
  query: AccountMatchQuery,
  existing: readonly ExistingAuInvestmentAccountCandidate[],
): AccountMatchResult {
  const sameTypeCurrencyCountry = existing.filter(
    (a) => a.accountType === query.accountType && a.currencyCode === query.currencyCode && a.countryCode === query.countryCode,
  );

  let institutionFallbackPool = sameTypeCurrencyCountry;

  if (query.maskedAccountIdentifier) {
    const byMasked = sameTypeCurrencyCountry.filter((a) => a.maskedAccountIdentifier === query.maskedAccountIdentifier);
    if (byMasked.length === 1) {
      return { outcome: 'single_match', matchedAccountId: byMasked[0].accountId, candidateIds: [byMasked[0].accountId] };
    }
    if (byMasked.length > 1) {
      return { outcome: 'ambiguous', matchedAccountId: null, candidateIds: byMasked.map((a) => a.accountId) };
    }
    // Supplied but matched nothing — a pre-existing account may predate
    // masked-identifier capture. Restrict the institution fallback to
    // accounts that ALSO have no masked identifier on file (an account that
    // already has a DIFFERENT one recorded is proof it is a distinct
    // physical account — same fix rationale as FDH-10's facilityMatching.ts).
    institutionFallbackPool = sameTypeCurrencyCountry.filter((a) => a.maskedAccountIdentifier == null);
  }

  const institution = foldName(query.institutionName);
  if (institution) {
    const byInstitution = institutionFallbackPool.filter((a) => foldName(a.institutionName) === institution);
    if (byInstitution.length === 1) {
      return { outcome: 'single_match', matchedAccountId: byInstitution[0].accountId, candidateIds: [byInstitution[0].accountId] };
    }
    if (byInstitution.length > 1) {
      return { outcome: 'ambiguous', matchedAccountId: null, candidateIds: byInstitution.map((a) => a.accountId) };
    }
  }

  return { outcome: 'no_match', matchedAccountId: null, candidateIds: [] };
}
