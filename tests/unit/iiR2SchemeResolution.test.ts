import { describe, it, expect } from 'vitest';
import { resolveScheme, type ExistingInstrumentForResolution, type AliasMapRow, type SchemeResolutionQuery } from '@/lib/services/investment-intelligence/schemeResolution';

function baseQuery(overrides: Partial<SchemeResolutionQuery> = {}): SchemeResolutionQuery {
  return {
    isin: null,
    amfiSchemeCode: null,
    internalProvisionalCode: null,
    normalisedSchemeName: 'hdfc flexi cap fund - growth (direct plan)',
    amcName: 'HDFC Mutual Fund',
    planType: 'direct',
    optionType: 'growth',
    countryCode: 'IN',
    ...overrides,
  };
}

const existingOne: ExistingInstrumentForResolution[] = [
  {
    instrumentId: 'inst-1',
    isin: 'INF179K01YW8',
    amfiSchemeCode: '118834',
    internalProvisionalCode: null,
    normalisedSchemeName: 'hdfc flexi cap fund - growth (direct plan)',
    amcName: 'HDFC Mutual Fund',
    planType: 'direct',
    optionType: 'growth',
    countryCode: 'IN',
  },
];

describe('resolveScheme (spec section 17 — priority-ordered deterministic resolver)', () => {
  it('priority 1: resolves via ISIN when present, regardless of other fields', () => {
    const outcome = resolveScheme(baseQuery({ isin: 'INF179K01YW8', normalisedSchemeName: 'totally different text' }), existingOne, []);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.instrumentId).toBe('inst-1');
      expect(outcome.matchedVia).toBe('isin');
      expect(outcome.confidence).toBe(1);
    }
  });

  it('priority 2: resolves via AMFI scheme code (country-scoped) when ISIN is absent', () => {
    const outcome = resolveScheme(baseQuery({ amfiSchemeCode: '118834', normalisedSchemeName: 'different text' }), existingOne, []);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') expect(outcome.matchedVia).toBe('amfi_scheme_code');
  });

  it('priority 2: does NOT match an AMFI code from a different country', () => {
    const outcome = resolveScheme(baseQuery({ amfiSchemeCode: '118834', countryCode: 'AU', normalisedSchemeName: 'different text' }), existingOne, []);
    expect(outcome.kind).toBe('unresolved');
  });

  it('priority 3: resolves via exact internal_provisional source identifier', () => {
    const existing: ExistingInstrumentForResolution[] = [{ ...existingOne[0], isin: null, amfiSchemeCode: null, internalProvisionalCode: 'RTA-CODE-001' }];
    const outcome = resolveScheme(baseQuery({ internalProvisionalCode: 'RTA-CODE-001', normalisedSchemeName: 'different text' }), existing, []);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') expect(outcome.matchedVia).toBe('exact_source_identifier');
  });

  it('priority 4: resolves via normalised scheme name + plan/option + AMC + country when no identifier is present', () => {
    const outcome = resolveScheme(baseQuery(), existingOne, []);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.matchedVia).toBe('normalised_name');
      expect(outcome.confidence).toBeLessThan(1); // heuristic, lower confidence than an identifier match
    }
  });

  it('priority 4 requires an EXACT normalised-name+plan+option match, not a fuzzy one — a different plan does not match', () => {
    const outcome = resolveScheme(baseQuery({ planType: 'regular' }), existingOne, []);
    expect(outcome.kind).toBe('unresolved');
  });

  it('priority 5: resolves via the controlled alias map when nothing else matches', () => {
    const aliasRows: AliasMapRow[] = [
      { rawSchemeNameNormalised: 'hdfc flexicap growth direct (renamed)', amcName: 'HDFC Mutual Fund', planType: 'direct', optionType: 'growth', countryCode: 'IN', resolvedInstrumentId: 'inst-1' },
    ];
    const outcome = resolveScheme(baseQuery({ normalisedSchemeName: 'hdfc flexicap growth direct (renamed)' }), [], aliasRows);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') expect(outcome.matchedVia).toBe('alias_map');
  });

  it('priority 6: returns unresolved (never guesses) when nothing matches at any priority', () => {
    const outcome = resolveScheme(baseQuery({ normalisedSchemeName: 'a scheme nobody has ever seen' }), existingOne, []);
    expect(outcome.kind).toBe('unresolved');
  });

  it('an ISIN shared by two distinct existing instruments returns AMBIGUOUS, never silently picks one (spec: "ambiguous mappings must create a reconciliation case")', () => {
    const twoInstruments: ExistingInstrumentForResolution[] = [
      { ...existingOne[0], instrumentId: 'inst-1' },
      { ...existingOne[0], instrumentId: 'inst-2' },
    ];
    const outcome = resolveScheme(baseQuery({ isin: 'INF179K01YW8' }), twoInstruments, []);
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.candidateInstrumentIds.sort()).toEqual(['inst-1', 'inst-2']);
    }
  });

  it('does NOT fuzzy-match a merely-similar scheme name (e.g. missing "(Direct Plan)" suffix) — proves priority 4 is exact, not approximate', () => {
    const outcome = resolveScheme(baseQuery({ normalisedSchemeName: 'hdfc flexi cap fund - growth' }), existingOne, []);
    expect(outcome.kind).toBe('unresolved');
  });
});
