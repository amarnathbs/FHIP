// Investment Intelligence R5 — canonical underlying-security resolution.
//
// THE RULE (spec sections 55-57, and critical-FAIL items 10-11):
// A DISPLAY NAME IS NEVER AN IDENTITY. "RELIANCE INDUSTRIES LTD.",
// "Reliance Industries Limited" and "RELIANCE INDUSTRIES LIMITED" must
// resolve to the same canonical security — but they must do so via a
// deterministic IDENTIFIER, never via fuzzy string similarity. R5 contains
// no edit-distance matching, no token-overlap scoring, and no "close enough"
// threshold anywhere in this file. Ambiguity resolves to UNRESOLVED, which is
// an honest, visible outcome, not a silent guess.
//
// RESOLUTION PRIORITY (strict, first match wins):
//   1. ISIN                      — globally unique, the strongest identity
//   2. Exchange/security id      — NSE symbol, BSE code (country-scoped)
//   3. Approved provider id      — e.g. an AMFI scheme code
//   4. Controlled alias          — an explicitly curated, admin-maintained
//                                  name->canonical mapping. This is the ONLY
//                                  place a name participates in identity, and
//                                  only because a human approved that exact
//                                  string. It is exact-match, case- and
//                                  whitespace-normalised, never fuzzy.
//   5. Exact deterministic map   — a source-specific exact identifier map
//   6. UNRESOLVED                — surfaced for reconciliation
//
// Normalisation applied before an ALIAS lookup is deliberately minimal and
// lossless-in-intent: uppercase, collapse internal whitespace, trim, and drop
// a trailing period. It never strips corporate suffixes ("LTD" vs "LIMITED"
// are NOT unified by code) — that unification is exactly what the curated
// alias table is for, so a human decides it, not a heuristic.

export const SECURITY_RESOLUTION_METHOD_VERSION = 'security-resolution-identifier-first-r5-v1';

export type ResolutionMethod = 'ISIN' | 'EXCHANGE_ID' | 'PROVIDER_ID' | 'CONTROLLED_ALIAS' | 'EXACT_MAP' | 'UNRESOLVED';

/** A raw holding line exactly as disclosed by the source. Never mutated. */
export interface RawHoldingRecord {
  /** Free-text name as printed by the source. NOT an identity. */
  holdingName: string;
  isin?: string | null;
  exchangeSymbol?: string | null;
  exchangeCode?: string | null;
  providerSecurityId?: string | null;
  countryCode?: string | null;
}

/**
 * Country-neutral canonical security. India-specific facts live in
 * `sourceMetadata`, never as first-class columns, so an Australian holding
 * (ASX code, AUD, GICS sector) fits this model without a schema change
 * (spec section 58).
 */
export interface CanonicalSecurity {
  canonicalId: string;
  name: string;
  countryCode: string | null;
  exchangeCode: string | null;
  securityType: string | null;
  currencyCode: string | null;
  issuerId: string | null;
  isin: string | null;
  /** Versioned classification payload; see classification.ts consumers. */
  sectorCode?: string | null;
  industryCode?: string | null;
  marketCapClass?: string | null;
  classificationVersion?: string | null;
  sourceMetadata?: Record<string, unknown>;
}

export interface ResolutionIndex {
  byIsin: Map<string, string>;
  /** key: `${countryCode}:${symbolOrCode}` */
  byExchangeId: Map<string, string>;
  byProviderId: Map<string, string>;
  /** key: normalised alias string; value: canonicalId. Curated, admin-only. */
  byControlledAlias: Map<string, string>;
  byExactMap: Map<string, string>;
  securities: Map<string, CanonicalSecurity>;
}

export interface ResolutionResult {
  status: 'resolved' | 'unresolved';
  canonicalId?: string;
  security?: CanonicalSecurity;
  method: ResolutionMethod;
  methodVersion: typeof SECURITY_RESOLUTION_METHOD_VERSION;
  /** Populated when unresolved, for the reconciliation queue. */
  detail?: string;
}

/** Minimal, documented normalisation for CONTROLLED ALIAS lookup only. */
export function normaliseAliasKey(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\.$/, '');
}

export function normaliseIsin(isin: string): string {
  return isin.trim().toUpperCase().replace(/\s+/g, '');
}

export function buildResolutionIndex(
  securities: CanonicalSecurity[],
  aliases: Array<{ alias: string; canonicalId: string }> = [],
  exactMaps: Array<{ sourceKey: string; canonicalId: string }> = []
): ResolutionIndex {
  const index: ResolutionIndex = {
    byIsin: new Map(),
    byExchangeId: new Map(),
    byProviderId: new Map(),
    byControlledAlias: new Map(),
    byExactMap: new Map(),
    securities: new Map(),
  };
  for (const s of securities) {
    index.securities.set(s.canonicalId, s);
    if (s.isin) index.byIsin.set(normaliseIsin(s.isin), s.canonicalId);
    if (s.exchangeCode) index.byExchangeId.set(`${s.countryCode ?? ''}:${s.exchangeCode.trim().toUpperCase()}`, s.canonicalId);
  }
  for (const a of aliases) index.byControlledAlias.set(normaliseAliasKey(a.alias), a.canonicalId);
  for (const m of exactMaps) index.byExactMap.set(m.sourceKey, m.canonicalId);
  return index;
}

/**
 * Resolve one raw disclosed holding to a canonical security.
 *
 * Returns UNRESOLVED rather than guessing. An unresolved holding is never
 * treated as matched for overlap purposes and is retained as an explicit
 * remainder in look-through weight — it is never quietly dropped, and never
 * quietly merged into a similarly-named security.
 */
export function resolveUnderlyingSecurity(raw: RawHoldingRecord, index: ResolutionIndex): ResolutionResult {
  const v = SECURITY_RESOLUTION_METHOD_VERSION;

  if (raw.isin) {
    const hit = index.byIsin.get(normaliseIsin(raw.isin));
    if (hit) return { status: 'resolved', canonicalId: hit, security: index.securities.get(hit), method: 'ISIN', methodVersion: v };
  }
  const exchangeKey = raw.exchangeSymbol ?? raw.exchangeCode;
  if (exchangeKey) {
    const hit = index.byExchangeId.get(`${raw.countryCode ?? ''}:${exchangeKey.trim().toUpperCase()}`);
    if (hit) return { status: 'resolved', canonicalId: hit, security: index.securities.get(hit), method: 'EXCHANGE_ID', methodVersion: v };
  }
  if (raw.providerSecurityId) {
    const hit = index.byProviderId.get(raw.providerSecurityId.trim());
    if (hit) return { status: 'resolved', canonicalId: hit, security: index.securities.get(hit), method: 'PROVIDER_ID', methodVersion: v };
  }
  if (raw.holdingName) {
    const hit = index.byControlledAlias.get(normaliseAliasKey(raw.holdingName));
    if (hit) return { status: 'resolved', canonicalId: hit, security: index.securities.get(hit), method: 'CONTROLLED_ALIAS', methodVersion: v };
  }
  if (raw.providerSecurityId) {
    const hit = index.byExactMap.get(raw.providerSecurityId);
    if (hit) return { status: 'resolved', canonicalId: hit, security: index.securities.get(hit), method: 'EXACT_MAP', methodVersion: v };
  }

  return {
    status: 'unresolved',
    method: 'UNRESOLVED',
    methodVersion: v,
    detail: `"${raw.holdingName}" could not be matched to a known security by ISIN, exchange identifier, provider identifier, or an approved alias. It is retained as unresolved exposure rather than being matched by name similarity.`,
  };
}
