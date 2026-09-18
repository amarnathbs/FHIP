import { describe, it, expect } from 'vitest';
import { toMonthly, formatMoney, formatMoneyWhole, formatMoneyCode, formatMoneyExact, localeForReportingCurrency } from '@/lib/engines/money';

describe('toMonthly', () => {
  it('annualises correctly', () => {
    expect(toMonthly(1200, 'annually')).toBeCloseTo(100);
  });

  it('treats one-off as non-recurring', () => {
    expect(toMonthly(5000, 'one_off')).toBe(0);
  });

  it('converts weekly to monthly', () => {
    expect(toMonthly(500, 'weekly')).toBeCloseTo(2166.67, 1);
  });

  it('leaves monthly unchanged', () => {
    expect(toMonthly(1000, 'monthly')).toBe(1000);
  });
});

// App Review 2026-09-15, Global Standard G1 — "No decimal places on any
// monetary amount ... Every screen and every report." These assertions use
// the reviewer's own worked examples verbatim.
describe('formatMoney — G1 whole currency units', () => {
  it('formats AUD with no decimal point at all', () => {
    expect(formatMoney(1234.5, 'AUD')).toBe('$1,235');
    expect(formatMoney(1234.5, 'AUD')).not.toContain('.');
  });

  it('formats INR', () => {
    expect(formatMoney(1234, 'INR')).toContain('1,234');
    expect(formatMoney(1234, 'INR')).not.toContain('.');
  });

  it("rounds the reviewer's own examples exactly as the review requires", () => {
    // "$541.67 -> $542"
    expect(formatMoney(541.67, 'AUD')).toBe('$542');
    // "541.6666666666666 -> 542"
    expect(formatMoney(541.6666666666666, 'AUD')).toBe('$542');
    // "3690.83 -> 3,691"
    expect(formatMoney(3690.83, 'AUD')).toBe('$3,691');
    // the matching gap figure from the same sentence
    expect(formatMoney(3149.16, 'AUD')).toBe('$3,149');
  });

  it('keeps INR lakh/crore grouping (the Investment Intelligence screens are INR)', () => {
    expect(formatMoney(806724, 'INR')).toBe('₹8,06,724');
  });

  it('never emits cents for a whole amount either (minimumFractionDigits is pinned too)', () => {
    expect(formatMoney(100, 'AUD')).toBe('$100');
    expect(formatMoney(0, 'AUD')).toBe('$0');
    expect(formatMoney(-2500.4, 'AUD')).toBe('-$2,500');
  });

  it('formatMoneyWhole is now identical to formatMoney (it is an alias)', () => {
    for (const v of [0, 1, 541.67, 1234.5, 999999.99]) {
      expect(formatMoneyWhole(v, 'AUD')).toBe(formatMoney(v, 'AUD'));
      expect(formatMoneyWhole(v, 'INR')).toBe(formatMoney(v, 'INR'));
    }
  });
});

describe('formatMoneyCode — arbitrary ISO code, same G1 rule', () => {
  it('matches formatMoney for the two reporting currencies', () => {
    expect(formatMoneyCode(541.67, 'AUD')).toBe(formatMoney(541.67, 'AUD'));
    expect(formatMoneyCode(806724, 'INR')).toBe(formatMoney(806724, 'INR'));
  });

  it('handles a third real currency without decimals', () => {
    expect(formatMoneyCode(1234.56, 'USD')).not.toContain('.');
    expect(formatMoneyCode(1234.56, 'usd')).not.toContain('.');
  });

  it('falls back to a grouped number plus the code rather than throwing on an unknown code', () => {
    expect(() => formatMoneyCode(1234.56, 'XYZZY')).not.toThrow();
    expect(formatMoneyCode(1234.56, 'XYZZY')).toContain('XYZZY');
    expect(formatMoneyCode(1234.56, 'XYZZY')).not.toContain('.');
  });

  it('defaults a null/undefined code to the app default rather than throwing', () => {
    expect(formatMoneyCode(100, null)).toBe(formatMoney(100, 'AUD'));
    expect(formatMoneyCode(100, undefined)).toBe(formatMoney(100, 'AUD'));
  });
});

describe('formatMoneyExact — the single sanctioned G1 exception', () => {
  it('keeps exact cents, because it exists only for source-document transcription and payment receipts', () => {
    expect(formatMoneyExact(29.99, 'AUD')).toBe('$29.99');
    expect(formatMoneyExact(5123.4, 'AUD')).toBe('$5,123.40');
  });

  it('is deliberately NOT what formatMoney does — the two must stay distinguishable', () => {
    expect(formatMoneyExact(29.99, 'AUD')).not.toBe(formatMoney(29.99, 'AUD'));
  });
});

// G7 Contract 2 (docs/country-programme/g7-data-contracts.md) — shared
// locale-selection rule, using the exact same currency->locale mapping
// formatMoney already applies above, so report-side date formatting
// (lib/services/reportsData.ts, ReportHistoryTable, ReportPreview) stops
// hardcoding 'en-AU' independently at each call site.
describe('localeForReportingCurrency', () => {
  it('returns en-AU for AUD (unchanged from every existing hardcoded literal)', () => {
    expect(localeForReportingCurrency('AUD')).toBe('en-AU');
  });

  it('returns en-IN for INR — the correctness fix itself', () => {
    expect(localeForReportingCurrency('INR')).toBe('en-IN');
  });
});
