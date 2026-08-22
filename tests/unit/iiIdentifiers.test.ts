import { describe, it, expect } from 'vitest';
import { resolveInstrumentIdFromIdentifiers, type CandidateIdentifier, type ExistingIdentifierRow } from '@/lib/services/investment-intelligence/identifiers';

describe('resolveInstrumentIdFromIdentifiers (ADR-002 alias resolution)', () => {
  it('resolves to the same instrument via a globally-unique scheme (ISIN) regardless of country', () => {
    const candidates: CandidateIdentifier[] = [{ scheme: 'isin', value: 'INF179K01UT9', countryCode: 'IN' }];
    const existing: ExistingIdentifierRow[] = [{ instrumentId: 'inst-1', scheme: 'isin', value: 'INF179K01UT9', countryCode: null }];
    expect(resolveInstrumentIdFromIdentifiers(candidates, existing)).toBe('inst-1');
  });

  it('resolves via a country-scoped scheme (AMFI) only when the country matches', () => {
    const candidates: CandidateIdentifier[] = [{ scheme: 'amfi_scheme_code', value: '119551', countryCode: 'IN' }];
    const existingSameCountry: ExistingIdentifierRow[] = [{ instrumentId: 'inst-2', scheme: 'amfi_scheme_code', value: '119551', countryCode: 'IN' }];
    expect(resolveInstrumentIdFromIdentifiers(candidates, existingSameCountry)).toBe('inst-2');

    const existingDifferentCountry: ExistingIdentifierRow[] = [{ instrumentId: 'inst-3', scheme: 'amfi_scheme_code', value: '119551', countryCode: 'AU' }];
    expect(resolveInstrumentIdFromIdentifiers(candidates, existingDifferentCountry)).toBeNull();
  });

  it('resolves the SAME instrument when first seen via one scheme and later confirmed via a second scheme (ADR-002 testing requirement)', () => {
    // Instrument first seen only via an internal provisional tag...
    const firstSeen: CandidateIdentifier[] = [{ scheme: 'internal_provisional', value: 'PROV-001', countryCode: 'IN' }];
    const existingAfterFirstSeen: ExistingIdentifierRow[] = [{ instrumentId: 'inst-4', scheme: 'internal_provisional', value: 'PROV-001', countryCode: 'IN' }];
    expect(resolveInstrumentIdFromIdentifiers(firstSeen, existingAfterFirstSeen)).toBe('inst-4');

    // ...later confirmed via BOTH the provisional tag and a real AMFI code
    // once enrichment resolves it — both aliases now point at the same row.
    const laterConfirmed: CandidateIdentifier[] = [
      { scheme: 'amfi_scheme_code', value: '119551', countryCode: 'IN' },
      { scheme: 'internal_provisional', value: 'PROV-001', countryCode: 'IN' },
    ];
    const existingAfterEnrichment: ExistingIdentifierRow[] = [
      { instrumentId: 'inst-4', scheme: 'internal_provisional', value: 'PROV-001', countryCode: 'IN' },
      { instrumentId: 'inst-4', scheme: 'amfi_scheme_code', value: '119551', countryCode: 'IN' },
    ];
    expect(resolveInstrumentIdFromIdentifiers(laterConfirmed, existingAfterEnrichment)).toBe('inst-4');
  });

  it('returns null when no candidate matches any existing alias (a genuinely new instrument)', () => {
    const candidates: CandidateIdentifier[] = [{ scheme: 'isin', value: 'BRAND-NEW', countryCode: 'IN' }];
    const existing: ExistingIdentifierRow[] = [{ instrumentId: 'inst-5', scheme: 'isin', value: 'SOMETHING-ELSE', countryCode: 'IN' }];
    expect(resolveInstrumentIdFromIdentifiers(candidates, existing)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(resolveInstrumentIdFromIdentifiers([], [])).toBeNull();
  });
});
