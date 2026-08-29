/**
 * FDH-11 — Australia SECURITY matching (spec sections 39-42, 90, 104).
 *
 * PURE matching logic only — this module never queries a database and never
 * imports Investment Intelligence (mechanically enforced by
 * `tests/unit/fdh11Isolation.test.ts`, mirroring `fdh1Isolation.test.ts`).
 * The actual candidate-identifier lookup against `ii_instrument_identifiers`
 * happens in `lib/investment-import-bridge/auSecurityResolution.ts`, which
 * calls this function with candidates already fetched.
 *
 * Preferred matching order (spec section 39): canonical security ID (not
 * applicable pre-match) -> ISIN -> exchange+ticker -> controlled name
 * matching is explicitly NOT implemented here (spec: "Never
 * fuzzy-name-first where stable identifiers exist" — this module has no
 * fuzzy-name tier at all; an unresolved security always routes to
 * REVIEW_REQUIRED / unresolved, never a best-guess name match).
 */

export type AuSecurityIdentifierScheme = 'isin' | 'asx_ticker';

export interface AuSecurityCandidateIdentifier {
  instrumentId: string;
  scheme: AuSecurityIdentifierScheme;
  value: string;
}

export interface AuSecurityMatchQuery {
  isin?: string;
  tickerRaw?: string;
  exchange?: string; // e.g. 'ASX'
}

export type AuSecurityMatchOutcome = 'matched' | 'ambiguous' | 'unresolved';

export interface AuSecurityMatchResult {
  outcome: AuSecurityMatchOutcome;
  matchedInstrumentId: string | null;
  candidateInstrumentIds: string[];
  matchedVia: AuSecurityIdentifierScheme | null;
}

function normaliseTicker(raw: string, exchange?: string): string {
  // ASX tickers are commonly quoted with an exchange prefix/suffix
  // ("ASX:BHP", "BHP.AX") by different statement formats — normalise to the
  // bare code so the SAME instrument resolves regardless of which
  // convention a given broker's export uses.
  return raw
    .trim()
    .toUpperCase()
    .replace(/^ASX:/, '')
    .replace(/\.AX$/, '')
    .replace(new RegExp(`^${(exchange ?? '').toUpperCase()}:`), '');
}

/**
 * Resolve one statement security line against the candidate identifiers
 * already known to Investment Intelligence for this instrument universe.
 *
 * TIER 1 — ISIN (global, spec section 40). TIER 2 — ASX ticker (country-
 * scoped exactly like `nse_symbol`/`bse_code` already are for India — see
 * `ii_instrument_identifiers`'s two-partial-unique-index design).
 *
 * More than one instrument matching the SAME identifier value is
 * structurally impossible given the DB's own unique indexes, but this
 * function still reports `ambiguous` rather than silently picking the first
 * array element if it is ever called with data that violates that
 * invariant (defensive, spec section 41's "no arbitrary first match").
 */
export function matchAuSecurity(
  query: AuSecurityMatchQuery,
  candidates: readonly AuSecurityCandidateIdentifier[],
): AuSecurityMatchResult {
  if (query.isin) {
    const isinMatches = candidates.filter((c) => c.scheme === 'isin' && c.value === query.isin);
    const distinctIds = [...new Set(isinMatches.map((c) => c.instrumentId))];
    if (distinctIds.length === 1) {
      return { outcome: 'matched', matchedInstrumentId: distinctIds[0], candidateInstrumentIds: distinctIds, matchedVia: 'isin' };
    }
    if (distinctIds.length > 1) {
      return { outcome: 'ambiguous', matchedInstrumentId: null, candidateInstrumentIds: distinctIds, matchedVia: 'isin' };
    }
  }

  if (query.tickerRaw) {
    const normalised = normaliseTicker(query.tickerRaw, query.exchange);
    const tickerMatches = candidates.filter((c) => c.scheme === 'asx_ticker' && c.value === normalised);
    const distinctIds = [...new Set(tickerMatches.map((c) => c.instrumentId))];
    if (distinctIds.length === 1) {
      return { outcome: 'matched', matchedInstrumentId: distinctIds[0], candidateInstrumentIds: distinctIds, matchedVia: 'asx_ticker' };
    }
    if (distinctIds.length > 1) {
      return { outcome: 'ambiguous', matchedInstrumentId: null, candidateInstrumentIds: distinctIds, matchedVia: 'asx_ticker' };
    }
  }

  return { outcome: 'unresolved', matchedInstrumentId: null, candidateInstrumentIds: [], matchedVia: null };
}

export { normaliseTicker as normaliseAsxTicker };
