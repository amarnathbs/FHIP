// NAV2 Stage 2 -- the report's period choice and the analysis spec it produces (which also decides how much history is requested).
//
// Matrix: Stage 2 row S2-31 (the period choice sets the analysis window; a short choice never forces a long history request).
//
// NAMED NEGATIVE CONTROLS
//   NC-Q1  an unknown period is not a choice (no silent default inside the engine);
//   NC-Q2  "Last 1 year" requests a strictly later history start than "Last 5 years" (hydration is bounded by the choice);
//   NC-Q3  month arithmetic clamps to the month end (29-02-2028 minus 12 months is 28-02-2027), never overflowing into March.
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { isReportPeriodChoice, REPORT_PERIOD_CHOICES, REPORT_PERIOD_LABELS, reportAnalysisSpec, standardAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { computeRequiredWindow } from '@/lib/engines/nav2/requiredWindowPlanner';

const AS_OF = '2026-10-02';

describe('period choices', () => {
  it('NC-Q1: exactly the five choices are recognised, each with a plain label', () => {
    expect([...REPORT_PERIOD_CHOICES]).toEqual(['since_first_held', '1y', '3y', '5y', 'all_history']);
    for (const c of REPORT_PERIOD_CHOICES) {
      expect(isReportPeriodChoice(c)).toBe(true);
      expect(REPORT_PERIOD_LABELS[c]).toMatch(/\w/);
    }
    for (const bad of ['forever', '', null, undefined, 5, '1Y', 'since_first_held ']) expect(isReportPeriodChoice(bad)).toBe(false);
  });

  it('the fixed windows start at the trailing date; since-first-held and all-history leave the start to the planner', () => {
    expect(reportAnalysisSpec(AS_OF, NAV2_POLICY, '1y').analysisStart).toBe('2025-10-02');
    expect(reportAnalysisSpec(AS_OF, NAV2_POLICY, '3y').analysisStart).toBe('2023-10-02');
    expect(reportAnalysisSpec(AS_OF, NAV2_POLICY, '5y').analysisStart).toBe('2021-10-02');
    expect(reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held').analysisStart).toBeNull();
    expect(reportAnalysisSpec(AS_OF, NAV2_POLICY, 'all_history').analysisStart).toBeNull();
  });

  it('the trailing point-to-point periods follow the choice', () => {
    const ids = (c: Parameters<typeof reportAnalysisSpec>[2]) => reportAnalysisSpec(AS_OF, NAV2_POLICY, c).pointToPoint.map((p) => p.id);
    expect(ids('1y')).toEqual(['1Y']);
    expect(ids('3y')).toEqual(['1Y', '3Y']);
    expect(ids('5y')).toEqual(['1Y', '3Y', '5Y']);
    expect(ids('since_first_held')).toEqual(['1Y', '3Y', '5Y']);
    expect(ids('all_history')).toEqual(['1Y', '3Y', '5Y']);
    const p = reportAnalysisSpec(AS_OF, NAV2_POLICY, '5y').pointToPoint;
    expect(p.map((x) => [x.start, x.end])).toEqual([['2025-10-02', AS_OF], ['2023-10-02', AS_OF], ['2021-10-02', AS_OF]]);
  });

  it('keeps the standard measures (rolling horizons, averages, risk, benchmark-relative) and the standard frequency', () => {
    const r = reportAnalysisSpec(AS_OF, NAV2_POLICY, '3y');
    const s = standardAnalysisSpec(AS_OF, NAV2_POLICY);
    expect({ ...r, pointToPoint: [], analysisStart: null }).toEqual({ ...s, pointToPoint: [], analysisStart: null });
  });

  it('NC-Q3: a leap-day as-of date clamps to the month end', () => {
    expect(reportAnalysisSpec('2028-02-29', NAV2_POLICY, '1y').analysisStart).toBe('2027-02-28');
    expect(reportAnalysisSpec('2028-02-29', NAV2_POLICY, '1y').pointToPoint[0].start).toBe('2027-02-28');
  });
});

describe('history requested follows the choice (NC-Q2, matrix 81)', () => {
  const required = (c: Parameters<typeof reportAnalysisSpec>[2]) => computeRequiredWindow({ instrumentId: 'i', earliestHeldDate: '2026-06-01', earliestHeldKind: 'first_transaction' as never, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, c), policy: NAV2_POLICY, today: AS_OF }).requiredFrom;
  it('Last 1 year asks for a strictly later start than Last 5 years; 3 years sits between', () => {
    const one = required('1y');
    const three = required('3y');
    const five = required('5y');
    expect(one > three).toBe(true);
    expect(three > five).toBe(true);
  });
  it('a fund held only since 01-06-2026 viewed over "since first held" still requests the trailing 5-year point (a fund\'s own growth is wanted over that period)', () => {
    expect(required('since_first_held') <= '2021-10-02').toBe(true);
  });
});
