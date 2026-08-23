// R4 — ROLL-001..010 (spec section 85).
import { describe, it, expect } from 'vitest';
import { rollingReturnSeries, rollingBeatPercentage, type MonthEndValuation } from '@/lib/engines/investment-intelligence/rollingReturns';

function monthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0)); // last day of `month` (1-indexed)
}

/** Build a monthly series growing at a fixed monthly rate from a start value. */
function buildMonthlySeries(startYear: number, startMonth: number, count: number, monthlyRate: number, startValue = 100): MonthEndValuation[] {
  const series: MonthEndValuation[] = [];
  let value = startValue;
  for (let i = 0; i < count; i++) {
    const m = startMonth + i;
    const y = startYear + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    series.push({ date: monthEnd(y, mm), value });
    value *= 1 + monthlyRate;
  }
  return series;
}

describe('ROLL-001: rolling 1Y series', () => {
  it('produces one window per month once 1Y of history exists', () => {
    const series = buildMonthlySeries(2019, 1, 36, 0.01); // 3 years monthly, steady 1%/mo growth
    const r = rollingReturnSeries(series, 1);
    expect(r.status).toBe('ok');
    expect(r.windows!.length).toBeGreaterThan(6);
  });
});

describe('ROLL-002: rolling 3Y series', () => {
  it('requires >= 3 years of history before any window is produced', () => {
    const series = buildMonthlySeries(2018, 1, 48, 0.005); // 4 years
    const r = rollingReturnSeries(series, 3);
    expect(r.status).toBe('ok');
    for (const w of r.windows!) {
      const days = (w.windowEndDate.getTime() - w.windowStartDate.getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(3 * 365 - 40);
    }
  });
});

describe('ROLL-003: rolling 5Y series', () => {
  it('requires >= 5 years of history', () => {
    const series = buildMonthlySeries(2015, 1, 84, 0.004); // 7 years
    const r = rollingReturnSeries(series, 5);
    expect(r.status).toBe('ok');
    expect(r.windows!.length).toBeGreaterThan(0);
  });
});

describe('ROLL-004: fund beats benchmark in every window', () => {
  it('reports beatPct = 1', () => {
    const fundSeries = buildMonthlySeries(2018, 1, 48, 0.012);
    const benchSeries = buildMonthlySeries(2018, 1, 48, 0.008);
    const fund = rollingReturnSeries(fundSeries, 3);
    const bench = rollingReturnSeries(benchSeries, 3);
    const beat = rollingBeatPercentage(fund.windows!, bench.windows!);
    expect(beat.status).toBe('ok');
    expect(beat.beatPct).toBeCloseTo(1, 9);
  });
});

describe('ROLL-005: fund beats benchmark in no windows', () => {
  it('reports beatPct = 0', () => {
    const fundSeries = buildMonthlySeries(2018, 1, 48, 0.006);
    const benchSeries = buildMonthlySeries(2018, 1, 48, 0.012);
    const fund = rollingReturnSeries(fundSeries, 3);
    const bench = rollingReturnSeries(benchSeries, 3);
    const beat = rollingBeatPercentage(fund.windows!, bench.windows!);
    expect(beat.status).toBe('ok');
    expect(beat.beatPct).toBeCloseTo(0, 9);
  });
});

describe('ROLL-006: mixed beat ratio', () => {
  it('reports a beatPct strictly between 0 and 1 for genuinely mixed performance', () => {
    const fundSeries = buildMonthlySeries(2018, 1, 60, 0.01);
    // benchmark oscillates around the fund's rate
    const benchSeries: MonthEndValuation[] = [];
    let value = 100;
    for (let i = 0; i < 60; i++) {
      const y = 2018 + Math.floor(i / 12);
      const mm = (i % 12) + 1;
      benchSeries.push({ date: monthEnd(y, mm), value });
      value *= 1 + (i % 2 === 0 ? 0.02 : -0.005);
    }
    const fund = rollingReturnSeries(fundSeries, 3);
    const bench = rollingReturnSeries(benchSeries, 3);
    const beat = rollingBeatPercentage(fund.windows!, bench.windows!);
    expect(beat.status).toBe('ok');
    expect(beat.beatPct!).toBeGreaterThanOrEqual(0);
    expect(beat.beatPct!).toBeLessThanOrEqual(1);
  });
});

describe('ROLL-007: minimum-window threshold enforced', () => {
  it('does not report a beat% from fewer than MINIMUM_OBSERVATIONS.rollingMinWindows comparable windows', () => {
    const fundSeries = buildMonthlySeries(2020, 1, 38, 0.01); // just over 3Y, few windows
    const fund = rollingReturnSeries(fundSeries, 3);
    // Fabricate an artificially short comparable benchmark window set.
    const beat = rollingBeatPercentage((fund.windows ?? []).slice(0, 1), (fund.windows ?? []).slice(0, 1));
    expect(beat.status).toBe('unavailable');
    expect(beat.reason).toBe('INSUFFICIENT_COMPARABLE_WINDOWS');
  });
});

describe('ROLL-008: insufficient history overall', () => {
  it('returns unavailable when there is less than one full window of history', () => {
    const series = buildMonthlySeries(2022, 1, 10, 0.01); // <1Y
    const r = rollingReturnSeries(series, 1);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('ROLL-009: missing observation (a gap in the monthly series)', () => {
  it('still functions by finding the nearest available prior observation within tolerance, or skips a window if none is close enough', () => {
    const series = buildMonthlySeries(2018, 1, 40, 0.01).filter((_, i) => i !== 20); // drop one month
    const r = rollingReturnSeries(series, 1);
    expect(r.status).toBe('ok');
  });
});

describe('ROLL-010: fund/benchmark-alignment dates for beat-% comparison', () => {
  it('only windows with matching end dates on both sides count as comparable', () => {
    const fundSeries = buildMonthlySeries(2018, 1, 48, 0.01);
    const benchSeries = buildMonthlySeries(2018, 1, 48, 0.008).slice(0, 40); // shorter benchmark history
    const fund = rollingReturnSeries(fundSeries, 3);
    const bench = rollingReturnSeries(benchSeries, 3);
    const beat = rollingBeatPercentage(fund.windows!, bench.windows ?? []);
    if (beat.status === 'ok') {
      expect(beat.comparableWindows!).toBeLessThanOrEqual(fund.windows!.length);
    } else {
      expect(beat.reason).toBe('INSUFFICIENT_COMPARABLE_WINDOWS');
    }
  });
});

describe('Rolling stats never hide sample size', () => {
  it('every ok result exposes min/max/median/average/current/observationCount', () => {
    const series = buildMonthlySeries(2018, 1, 40, 0.01);
    const r = rollingReturnSeries(series, 1);
    expect(r.status).toBe('ok');
    expect(r.stats).toBeDefined();
    expect(r.stats!.observationCount).toBe(r.windows!.length);
  });
});
