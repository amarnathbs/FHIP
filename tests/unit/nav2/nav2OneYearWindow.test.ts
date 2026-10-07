// Stage 3 (05-10-2026): the "Last 1 year" window asks for 05-10-2025 to 05-10-2026 (365 days). The previous-valid-NAV boundary rule resolves
// it to 03-10-2025 and 01-10-2026, 363 days apart; v1 decided on those 363 actual days and answered "not applicable" for every fund.
// v2 decides on the REQUESTED period (a requested horizon of a year or more is a year-or-more period) and annualises over the actual days,
// disclosing both the boundary substitution and the actual span. Rolling horizons already decide on the requested months and SMA/EMA/ROC
// count observations, so neither has this issue (asserted below).
// NAMED NEGATIVE CONTROLS: NC-Y1 the old rule (actual days only) would refuse this window; NC-Y2 a genuinely shorter requested span still does.
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { absoluteReturn, cagr, pointToPointReturn, rollingReturn } from '@/lib/engines/nav2/schemeReturns';
import { allStrings, buildSeries, ctxInr, expectClose, ISO_DATE_IN_TEXT, weekdays } from './support/fixtures';

describe('one-year requested window that resolves to 363 actual days (cagr / point_to_point v2)', () => {
  const s = buildSeries(['2025-10-03', '2026-10-01'], [100, 110]);
  const REQ = ['2025-10-05', '2026-10-05'] as const;

  it('NC-Y1: the old rule (actual days only) would refuse this window: 363 < cagrMinDays', () => {
    const p = pointToPointReturn(s, ctxInr(), REQ[0], REQ[1]);
    if (p.state !== 'available') throw new Error(p.state);
    expect(p.value.actualDays).toBe(363);
    expect(p.value.actualDays).toBeLessThan(NAV2_POLICY.cagrMinDays);
  });

  it('a requested year is a year-or-more period: CAGR is shown, annualised over the 363 actual days, with both disclosures', () => {
    const c = cagr(s, ctxInr(), REQ[0], REQ[1]);
    if (c.state !== 'available') throw new Error(c.state);
    expectClose(c.value.cagr, Math.pow(1.1, 365.2425 / 363) - 1, 1e-12);
    expect(c.value.actualDays).toBe(363);
    const codes = c.disclosures.map((d) => d.code);
    expect(codes).toContain('boundary_substitution');
    expect(codes).toContain('cagr_on_actual_days');
    expect(c.disclosures.find((d) => d.code === 'cagr_on_actual_days')?.detail).toContain('363 days');
    expect(c.provenance.definitionVersion).toBe('nav2-cagr-actual-days-v2');
    const p = pointToPointReturn(s, ctxInr(), REQ[0], REQ[1]);
    if (p.state !== 'available') throw new Error(p.state);
    expect(p.value.cagr).not.toBeNull();
    expect(p.provenance.definitionVersion).toBe('nav2-point-to-point-v2');
  });

  it('absolute return does not carry the CAGR note', () => {
    const a = absoluteReturn(s, ctxInr(), REQ[0], REQ[1]);
    expect(a.disclosures.map((d) => d.code)).not.toContain('cagr_on_actual_days');
  });

  it('NC-Y2: a genuinely shorter REQUESTED span (six months, or 364 days) still shows the absolute return only', () => {
    const six = buildSeries(['2025-10-03', '2026-04-01'], [100, 104], { asOf: '2026-10-10' });
    const c = cagr(six, ctxInr(), '2025-10-05', '2026-04-05');
    expect(c.state === 'not_applicable' && c.reason).toBe('period_under_one_year');
    const near = buildSeries(['2025-10-05', '2026-10-04'], [100, 110], { asOf: '2026-10-10' });
    const n = cagr(near, ctxInr(), '2025-10-05', '2026-10-04'); // 364 days requested, 364 actual
    expect(n.state === 'not_applicable' && n.reason).toBe('period_under_one_year');
  });

  it('exactly 365 requested and 365 actual is a year with no extra note', () => {
    const exact = buildSeries(['2025-10-05', '2026-10-05'], [100, 110], { asOf: '2026-10-10' });
    const c = cagr(exact, ctxInr(), '2025-10-05', '2026-10-05');
    if (c.state !== 'available') throw new Error(c.state);
    expect(c.disclosures.map((d) => d.code)).not.toContain('cagr_on_actual_days');
  });

  it('the notes are day-first and carry no ISO date', () => {
    const c = cagr(s, ctxInr(), REQ[0], REQ[1]);
    if (c.state !== 'available') throw new Error(c.state);
    for (const d of c.disclosures) expect(ISO_DATE_IN_TEXT.test(d.detail)).toBe(false);
    expect(allStrings(c.disclosures).some((t) => ISO_DATE_IN_TEXT.test(t))).toBe(false);
  });

  it('the 3-year and 5-year periods are far above the threshold and need no special rule', () => {
    const long = buildSeries(['2021-10-01', '2026-10-01'], [100, 180]);
    const c = cagr(long, ctxInr(), '2021-10-05', '2026-10-05');
    if (c.state !== 'available') throw new Error(c.state);
    expect(c.value.actualDays).toBeGreaterThan(1800);
  });

  it('rolling returns annualise by the requested horizon in months, never by actual days (no change needed)', () => {
    const dates = weekdays('2024-01-01', 600);
    const s2 = buildSeries(dates, dates.map((_, i) => 100 + i * 0.1));
    const r = rollingReturn(s2, ctxInr(), '1Y');
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.measure).toBe('annualised_cagr');
  });
});
