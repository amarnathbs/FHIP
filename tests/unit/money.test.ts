import { describe, it, expect } from 'vitest';
import { toMonthly, formatMoney, localeForReportingCurrency } from '@/lib/engines/money';

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

describe('formatMoney', () => {
  it('formats AUD', () => {
    expect(formatMoney(1234.5, 'AUD')).toContain('1,234.50');
  });

  it('formats INR', () => {
    expect(formatMoney(1234, 'INR')).toContain('1,234');
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
