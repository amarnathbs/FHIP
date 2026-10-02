import { describe, it, expect } from 'vitest';
import { instrumentSignaturesMatch, type InstrumentResolutionSignature } from '@/lib/services/investment-intelligence/ambiguousInstrumentResolution';

// Document2 final non-benchmark closure #3 (2026-09-30) — the signature
// matcher that lets a resolved ambiguous_instrument case's explicit user
// choice be found again on a later reprocess/Re-evaluate of the SAME scheme,
// deterministic and non-fuzzy (mirrors resolveScheme's own priority order:
// ISIN, then AMFI+country, then name+plan+option+AMC+country).

function sig(overrides: Partial<InstrumentResolutionSignature> = {}): InstrumentResolutionSignature {
  return {
    isin: null,
    amfiSchemeCode: null,
    normalisedSchemeName: 'hdfc flexi cap fund - growth (direct plan)',
    amcName: 'HDFC Mutual Fund',
    planType: 'direct',
    optionType: 'growth',
    countryCode: 'IN',
    ...overrides,
  };
}

describe('instrumentSignaturesMatch', () => {
  it('matches on ISIN alone, regardless of every other field disagreeing', () => {
    const a = sig({ isin: 'INF179K01YW8', normalisedSchemeName: 'a', amcName: 'X' });
    const b = sig({ isin: 'inf179k01yw8', normalisedSchemeName: 'totally different', amcName: 'Y', countryCode: 'AU' });
    expect(instrumentSignaturesMatch(a, b)).toBe(true);
  });

  it('does not match two different ISINs even if every other field agrees', () => {
    const a = sig({ isin: 'INF179K01YW8' });
    const b = sig({ isin: 'INF179K01YW9' });
    expect(instrumentSignaturesMatch(a, b)).toBe(false);
  });

  it('falls back to AMFI code + country when neither has an ISIN', () => {
    const a = sig({ amfiSchemeCode: '118834', normalisedSchemeName: 'a' });
    const b = sig({ amfiSchemeCode: '118834', normalisedSchemeName: 'b' });
    expect(instrumentSignaturesMatch(a, b)).toBe(true);
  });

  it('does not match the same AMFI code across two different countries', () => {
    const a = sig({ amfiSchemeCode: '118834', countryCode: 'IN' });
    const b = sig({ amfiSchemeCode: '118834', countryCode: 'AU' });
    expect(instrumentSignaturesMatch(a, b)).toBe(false);
  });

  it('falls back to exact name+plan+option+amc+country when no identifier is present on either side', () => {
    expect(instrumentSignaturesMatch(sig(), sig())).toBe(true);
  });

  it('does not match a different AMC even with an identical scheme name/plan/option — never fuzzy, never cross-AMC', () => {
    const a = sig({ amcName: 'HDFC Mutual Fund' });
    const b = sig({ amcName: 'SBI Mutual Fund' });
    expect(instrumentSignaturesMatch(a, b)).toBe(false);
  });

  it('does not match a different plan (direct vs regular)', () => {
    const a = sig({ planType: 'direct' });
    const b = sig({ planType: 'regular' });
    expect(instrumentSignaturesMatch(a, b)).toBe(false);
  });

  it('does not match a merely-similar (not identical) normalised scheme name', () => {
    const a = sig({ normalisedSchemeName: 'hdfc flexi cap fund - growth (direct plan)' });
    const b = sig({ normalisedSchemeName: 'hdfc flexi cap fund - growth' });
    expect(instrumentSignaturesMatch(a, b)).toBe(false);
  });
});
