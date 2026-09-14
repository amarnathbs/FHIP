/**
 * AIE-1.2 — instrument matching (execution sequence step 7). Thin wrapper
 * around Investment Intelligence's OWN pure, DB-free resolver
 * (`resolveScheme`, lib/services/investment-intelligence/schemeResolution.ts)
 * — no matching logic is reimplemented here. The caller supplies a
 * read-only snapshot of existing instruments/aliases (fetched the same way
 * `documentProcessing.ts` already does, via `fetchAllRows` against
 * `ii_instruments`/`ii_instrument_identifiers`/`ii_scheme_alias_map`); this
 * file never creates a provisional instrument itself — that write is
 * deferred to the gated canonical write step (`write.ts`), which delegates
 * to the real `processSourceDocument` for it.
 *
 * "Unresolved" here does NOT automatically become a blocking unresolved
 * item — a genuinely first-seen scheme is expected (documentProcessing.ts's
 * own comment: "not a blocker"). Only `ambiguous` (multiple existing
 * instruments equally match) is unknown/conflicting evidence in the sense
 * the spec means, and only that becomes a typed unresolved item
 * (`unresolvedItems.ts`).
 */

import { resolveScheme, type AliasMapRow, type ExistingInstrumentForResolution, type SchemeResolutionOutcome } from '@/lib/services/investment-intelligence/schemeResolution';
import type { ParsedInstrumentRecord } from '@/lib/services/investment-intelligence/parsers/types';

export function schemeKey(s: ParsedInstrumentRecord): string {
  return `${s.normalisedSchemeName}|${s.planType}|${s.optionType}|${s.amcName}`;
}

export function matchInstrumentsReadOnly(
  schemes: readonly ParsedInstrumentRecord[],
  countryCode: string,
  existing: readonly ExistingInstrumentForResolution[],
  aliasRows: readonly AliasMapRow[],
): Map<string, SchemeResolutionOutcome> {
  const byKey = new Map<string, ParsedInstrumentRecord>();
  for (const s of schemes) byKey.set(schemeKey(s), s);

  const outcomes = new Map<string, SchemeResolutionOutcome>();
  for (const [key, scheme] of byKey) {
    outcomes.set(
      key,
      resolveScheme(
        {
          isin: scheme.isin,
          amfiSchemeCode: scheme.amfiSchemeCode,
          internalProvisionalCode: null,
          normalisedSchemeName: scheme.normalisedSchemeName,
          amcName: scheme.amcName,
          planType: scheme.planType,
          optionType: scheme.optionType,
          countryCode,
        },
        existing as ExistingInstrumentForResolution[],
        aliasRows as AliasMapRow[],
      ),
    );
  }
  return outcomes;
}
