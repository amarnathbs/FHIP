// Investment Intelligence R2 — deterministic, priority-ordered scheme /
// instrument resolver (spec section 17):
//   1. ISIN
//   2. AMFI scheme code
//   3. exact approved source identifier (internal_provisional scheme)
//   4. normalised scheme name + plan/option (+ AMC + country)
//   5. controlled alias mapping (ii_scheme_alias_map)
//   6. manual reconciliation (caller's responsibility once this returns
//      'unresolved'/'ambiguous' — this module NEVER silently guesses)
//
// Pure logic only — no I/O. The DB-backed wrapper that fetches candidate
// rows lives in documentProcessing.ts, mirroring the existing
// identifiers.ts split between resolveInstrumentIdFromIdentifiers (pure)
// and resolveOrCreateInstrument (DB-backed) that R1 already established.

import type { IiOptionType, IiPlanType } from './types';

export interface SchemeResolutionQuery {
  isin: string | null;
  amfiSchemeCode: string | null;
  internalProvisionalCode: string | null;
  normalisedSchemeName: string;
  amcName: string;
  planType: IiPlanType;
  optionType: IiOptionType;
  countryCode: string;
}

export interface ExistingInstrumentForResolution {
  instrumentId: string;
  isin: string | null;
  amfiSchemeCode: string | null;
  internalProvisionalCode: string | null;
  normalisedSchemeName: string;
  amcName: string | null;
  planType: IiPlanType | null;
  optionType: IiOptionType | null;
  countryCode: string;
}

export interface AliasMapRow {
  rawSchemeNameNormalised: string;
  amcName: string | null;
  planType: IiPlanType | null;
  optionType: IiOptionType | null;
  countryCode: string | null;
  resolvedInstrumentId: string;
}

export type SchemeMatchedVia = 'isin' | 'amfi_scheme_code' | 'exact_source_identifier' | 'normalised_name' | 'alias_map';

export type SchemeResolutionOutcome =
  | { kind: 'resolved'; instrumentId: string; matchedVia: SchemeMatchedVia; confidence: number }
  | { kind: 'ambiguous'; candidateInstrumentIds: string[]; matchedVia: SchemeMatchedVia; reason: string }
  | { kind: 'unresolved'; reason: string };

function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function resolveScheme(
  query: SchemeResolutionQuery,
  existing: ExistingInstrumentForResolution[],
  aliasRows: AliasMapRow[]
): SchemeResolutionOutcome {
  // 1. ISIN — globally unique, highest trust.
  if (query.isin) {
    const matches = uniq(existing.filter((e) => e.isin && e.isin.toUpperCase() === query.isin!.toUpperCase()).map((e) => e.instrumentId));
    if (matches.length === 1) return { kind: 'resolved', instrumentId: matches[0], matchedVia: 'isin', confidence: 1 };
    if (matches.length > 1) return { kind: 'ambiguous', candidateInstrumentIds: matches, matchedVia: 'isin', reason: `Multiple instruments share ISIN ${query.isin}.` };
  }

  // 2. AMFI scheme code — country-scoped.
  if (query.amfiSchemeCode) {
    const matches = uniq(
      existing
        .filter((e) => e.amfiSchemeCode === query.amfiSchemeCode && e.countryCode === query.countryCode)
        .map((e) => e.instrumentId)
    );
    if (matches.length === 1) return { kind: 'resolved', instrumentId: matches[0], matchedVia: 'amfi_scheme_code', confidence: 1 };
    if (matches.length > 1)
      return { kind: 'ambiguous', candidateInstrumentIds: matches, matchedVia: 'amfi_scheme_code', reason: `Multiple instruments share AMFI scheme code ${query.amfiSchemeCode}.` };
  }

  // 3. Exact approved source identifier (internal_provisional scheme) —
  // country-scoped, for RTA-native codes that are neither ISIN nor AMFI.
  if (query.internalProvisionalCode) {
    const matches = uniq(
      existing
        .filter((e) => e.internalProvisionalCode === query.internalProvisionalCode && e.countryCode === query.countryCode)
        .map((e) => e.instrumentId)
    );
    if (matches.length === 1) return { kind: 'resolved', instrumentId: matches[0], matchedVia: 'exact_source_identifier', confidence: 1 };
    if (matches.length > 1)
      return {
        kind: 'ambiguous',
        candidateInstrumentIds: matches,
        matchedVia: 'exact_source_identifier',
        reason: `Multiple instruments share source identifier ${query.internalProvisionalCode}.`,
      };
  }

  // 4. Normalised scheme name + plan/option + AMC + country — heuristic,
  // lower confidence than an exact identifier match, but still a
  // DETERMINISTIC exact-string match on the normalised name (not fuzzy).
  {
    const matches = uniq(
      existing
        .filter(
          (e) =>
            e.normalisedSchemeName === query.normalisedSchemeName &&
            e.planType === query.planType &&
            e.optionType === query.optionType &&
            e.countryCode === query.countryCode
        )
        .map((e) => e.instrumentId)
    );
    if (matches.length === 1) return { kind: 'resolved', instrumentId: matches[0], matchedVia: 'normalised_name', confidence: 0.85 };
    if (matches.length > 1)
      return {
        kind: 'ambiguous',
        candidateInstrumentIds: matches,
        matchedVia: 'normalised_name',
        reason: `Multiple instruments match the normalised scheme name "${query.normalisedSchemeName}" with the same plan/option — cannot resolve without a stronger identifier.`,
      };
  }

  // 5. Controlled alias mapping — curated, reviewed rows only (never
  // populated by silent fuzzy-match auto-acceptance).
  {
    const matches = uniq(
      aliasRows
        .filter(
          (a) =>
            a.rawSchemeNameNormalised === query.normalisedSchemeName &&
            (a.planType === null || a.planType === query.planType) &&
            (a.optionType === null || a.optionType === query.optionType) &&
            (a.countryCode === null || a.countryCode === query.countryCode)
        )
        .map((a) => a.resolvedInstrumentId)
    );
    if (matches.length === 1) return { kind: 'resolved', instrumentId: matches[0], matchedVia: 'alias_map', confidence: 0.9 };
    if (matches.length > 1)
      return { kind: 'ambiguous', candidateInstrumentIds: matches, matchedVia: 'alias_map', reason: `Multiple alias-map rows resolve "${query.normalisedSchemeName}" to different instruments.` };
  }

  // 6. Manual reconciliation — this module never guesses further.
  return { kind: 'unresolved', reason: `No ISIN, AMFI code, source identifier, normalised-name, or alias-map match found for "${query.normalisedSchemeName}" (${query.amcName}, ${query.planType}/${query.optionType}).` };
}
