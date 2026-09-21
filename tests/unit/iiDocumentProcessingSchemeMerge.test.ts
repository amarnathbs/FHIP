// R2/NAV1 — unit test for a REAL, previously-undetected defect found live
// this session: schemeKey()-keyed scheme records from parsed.transactions
// and parsed.holdings were silently overwritten (losing isin/amfiSchemeCode)
// instead of merged, when the same scheme appears in both sections with the
// identifier present in only one of them -- exactly the real shape of a CAMS
// Individual Folio Statement (ISIN only in the FINANCIAL TRANSACTIONS
// section header, never in SUMMARY OF HOLDINGS). Confirmed live: uploading a
// real folio statement for a real, PC6-known scheme (HDFC Flexi Cap Fund,
// ISIN INF179K01UT0) minted a duplicate provisional instrument instead of
// matching the existing one, until this fix landed.
import { describe, it, expect } from 'vitest';
import { mergeSchemeRecords } from '@/lib/services/investment-intelligence/documentProcessing';
import type { ParsedInstrumentRecord } from '@/lib/services/investment-intelligence/parsers/types';

function scheme(overrides: Partial<ParsedInstrumentRecord> = {}): ParsedInstrumentRecord {
  return {
    rawSchemeName: 'HDFC Flexi Cap Fund - Growth',
    normalisedSchemeName: 'hdfc flexi cap fund - growth',
    amcName: '',
    planType: 'not_applicable',
    optionType: 'growth',
    isin: null,
    amfiSchemeCode: null,
    ...overrides,
  };
}

describe('mergeSchemeRecords', () => {
  it('reproduces the real bug scenario: a transaction-section record (with ISIN) merged with a holdings-section record (without) keeps the ISIN', () => {
    const fromTransaction = scheme({ isin: 'INF179K01UT0' });
    const fromHolding = scheme({ isin: null });
    // This is the EXACT order the real code applies (transactions first,
    // holdings second) -- the holdings record is passed as `b`.
    const merged = mergeSchemeRecords(fromTransaction, fromHolding);
    expect(merged.isin).toBe('INF179K01UT0');
  });

  it('the reverse order (holdings processed first, transaction second) still keeps the ISIN', () => {
    const fromHolding = scheme({ isin: null });
    const fromTransaction = scheme({ isin: 'INF179K01UT0' });
    const merged = mergeSchemeRecords(fromHolding, fromTransaction);
    expect(merged.isin).toBe('INF179K01UT0');
  });

  it('merges amfiSchemeCode the same way as isin', () => {
    const withCode = scheme({ amfiSchemeCode: '118955' });
    const withoutCode = scheme({ amfiSchemeCode: null });
    expect(mergeSchemeRecords(withCode, withoutCode).amfiSchemeCode).toBe('118955');
    expect(mergeSchemeRecords(withoutCode, withCode).amfiSchemeCode).toBe('118955');
  });

  it('when BOTH sides have an identifier, the first (a) wins -- never silently swapped', () => {
    const merged = mergeSchemeRecords(scheme({ isin: 'INF179K01UT0' }), scheme({ isin: 'INF999ZZZZZZ' }));
    expect(merged.isin).toBe('INF179K01UT0');
  });

  it('when NEITHER side has an identifier, the result correctly has none (not fabricated)', () => {
    const merged = mergeSchemeRecords(scheme({ isin: null, amfiSchemeCode: null }), scheme({ isin: null, amfiSchemeCode: null }));
    expect(merged.isin).toBeNull();
    expect(merged.amfiSchemeCode).toBeNull();
  });
});
