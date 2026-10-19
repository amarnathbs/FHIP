// PO review D: the Fund Analytics report and the Performance tab each say, in plain words, why their annualised figures can differ.
// The Performance tab's maths is NOT changed (asserted: the certified convention and method version are the same).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV_RETURN_METHOD_VERSION, YEARS_CONVENTION, pointToPointReturn } from '@/lib/engines/investment-intelligence/navReturn';
import { FUND_ANALYTICS_CAGR_CONVENTION_NOTE, PERFORMANCE_TAB_CAGR_CONVENTION_NOTE } from '@/lib/engines/nav2/reportWording';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', '..', '..', rel), 'utf8');

describe('both screens state their convention', () => {
  it('the wording names both conventions and says neither is wrong', () => {
    for (const n of [FUND_ANALYTICS_CAGR_CONVENTION_NOTE, PERFORMANCE_TAB_CAGR_CONVENTION_NOTE]) {
      expect(n).toContain('365.2425');
      expect(n).toMatch(/365 days/);
      expect(n).toMatch(/slightly different/);
      expect(n).toMatch(/correct for the convention/);
      expect(n).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    }
  });

  it('the Fund analytics page, its PDF document and the Performance tab render the note', () => {
    expect(read('components/reports/FundAnalyticsReportView.tsx')).toContain('FUND_ANALYTICS_CAGR_CONVENTION_NOTE');
    expect(read('components/reports/FundAnalyticsPrintDocument.tsx')).toContain('FUND_ANALYTICS_CAGR_CONVENTION_NOTE');
    expect(read('components/investment-intelligence/PerformanceClient.tsx')).toContain('PERFORMANCE_TAB_CAGR_CONVENTION_NOTE');
  });

  it('NC-D1: the Performance tab maths is unchanged: actual/365, annualised only above 365 days (a 365-day period stays absolute)', () => {
    expect(YEARS_CONVENTION).toBe('actual_days_over_365');
    expect(NAV_RETURN_METHOD_VERSION).toBe('nav-return-actual365-v1');
    const exact = pointToPointReturn(100, new Date('2025-01-01T00:00:00Z'), 110, new Date('2026-01-01T00:00:00Z')); // 365 days
    expect(exact).toMatchObject({ status: 'ok', actualDays: 365 });
    expect((exact as { cagr?: number }).cagr).toBeUndefined();
    const longer = pointToPointReturn(100, new Date('2025-01-01T00:00:00Z'), 110, new Date('2026-01-02T00:00:00Z')); // 366 days
    expect((longer as { cagr?: number }).cagr).toBeCloseTo(Math.pow(1.1, 365 / 366) - 1, 12);
  });
});
