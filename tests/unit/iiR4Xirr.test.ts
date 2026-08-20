// R4 — XIRR-001..020 (spec section 81). Unit-level correctness and
// edge-case behaviour of lib/engines/investment-intelligence/xirr.ts.
// This is the UNIT test pack; independent cross-implementation
// certification against a from-scratch Python oracle lives separately in
// scripts/ii_r4_independent_reconciliation.py and
// docs/investment-intelligence/R4_50_CASE_CALCULATION_CERTIFICATION.md.
import { describe, it, expect } from 'vitest';
import { xirr } from '@/lib/engines/investment-intelligence/xirr';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

describe('XIRR-001: single purchase, exact-double over exactly 365 days -> 100%', () => {
  it('resolves to r = 1.0 within tolerance', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1000 }, { date: d('2022-01-01'), amount: 2000 }]);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeCloseTo(1.0, 6);
  });
});

describe('XIRR-002: multiple purchases then terminal value', () => {
  it('converges to a plausible positive rate', () => {
    const r = xirr([
      { date: d('2021-01-01'), amount: -1000 },
      { date: d('2021-07-01'), amount: -1000 },
      { date: d('2022-01-01'), amount: 2300 },
    ]);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeGreaterThan(0);
    expect(r.rate).toBeLessThan(1);
  });
});

describe('XIRR-003: SIP-like irregular monthly dates', () => {
  it('converges', () => {
    const flows = [];
    for (let m = 0; m < 12; m++) {
      flows.push({ date: new Date(Date.UTC(2021, m, 5)), amount: -1000 });
    }
    flows.push({ date: d('2022-06-01'), amount: 13500 });
    const r = xirr(flows);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeGreaterThan(-1);
  });
});

describe('XIRR-004: purchase + partial redemption + ending value', () => {
  it('handles a redemption event mid-stream', () => {
    const r = xirr([
      { date: d('2020-01-01'), amount: -5000 },
      { date: d('2021-01-01'), amount: 1500 },
      { date: d('2022-01-01'), amount: 4200 },
    ]);
    expect(r.status).toBe('ok');
  });
});

describe('XIRR-005: cash distribution received (IDCW payout) as a positive interim flow', () => {
  it('includes the distribution as its own cash flow', () => {
    const r = xirr([
      { date: d('2020-01-01'), amount: -10000 },
      { date: d('2020-07-01'), amount: 200 },
      { date: d('2021-01-01'), amount: 300 },
      { date: d('2021-06-01'), amount: 10800 },
    ]);
    expect(r.status).toBe('ok');
  });
});

describe('XIRR-006: same-day flows', () => {
  it('sums same-day flows correctly (net -500 on day 0)', () => {
    const r = xirr([
      { date: d('2021-01-01'), amount: -1000 },
      { date: d('2021-01-01'), amount: 500 },
      { date: d('2022-01-01'), amount: 700 },
    ]);
    expect(r.status).toBe('ok');
    // Equivalent to a single -500 -> 700 over 365 days: r = 0.4 exactly.
    expect(r.rate).toBeCloseTo(0.4, 5);
  });
});

describe('XIRR-007: negative return', () => {
  it('resolves to a negative rate when ending value < invested', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1000 }, { date: d('2022-01-01'), amount: 800 }]);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeCloseTo(-0.2, 6);
  });
});

describe('XIRR-008: near-zero return', () => {
  it('resolves close to 0%', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1000 }, { date: d('2022-01-01'), amount: 1001 }]);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeCloseTo(0.001, 4);
  });
});

describe('XIRR-009: very high return', () => {
  it('resolves a 900% annual return', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1000 }, { date: d('2022-01-01'), amount: 10000 }]);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeCloseTo(9.0, 5);
  });
});

describe('XIRR-010: 10-year history, single purchase', () => {
  it('annualises a decade-long holding correctly', () => {
    // 3x over 10 years: r = 3^(1/10) - 1
    const r = xirr([{ date: d('2012-01-01'), amount: -1000 }, { date: d('2022-01-01'), amount: 3000 }]);
    expect(r.status).toBe('ok');
    const expected = Math.pow(3, 1 / 10) - 1;
    expect(r.rate).toBeCloseTo(expected, 3); // wider tolerance: actual/365 vs exact leap-adjusted 10y span
  });
});

describe('XIRR-011: incomplete history (only 1 flow)', () => {
  it('is unavailable, never fabricated', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1000 }]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('XIRR-012: no positive flow', () => {
  it('is unavailable with ALL_SAME_SIGN', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1000 }, { date: d('2021-06-01'), amount: -500 }]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('ALL_SAME_SIGN');
  });
});

describe('XIRR-013: no negative flow', () => {
  it('is unavailable with ALL_SAME_SIGN', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: 1000 }, { date: d('2021-06-01'), amount: 500 }]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('ALL_SAME_SIGN');
  });
});

describe('XIRR-014: invalid dates', () => {
  it('rejects a NaN date', () => {
    const r = xirr([{ date: new Date('not-a-date'), amount: -1000 }, { date: d('2021-06-01'), amount: 1200 }]);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INVALID_DATES');
  });
});

describe('XIRR-015: multiple-root / pathological cash-flow pattern', () => {
  it('either resolves a single well-bracketed root or reports ambiguity, never silently one of several', () => {
    // Alternating-sign pattern classically associated with multiple IRRs.
    const r = xirr([
      { date: d('2020-01-01'), amount: -1000 },
      { date: d('2021-01-01'), amount: 2500 },
      { date: d('2022-01-01'), amount: -2000 },
      { date: d('2023-01-01'), amount: 1000 },
    ]);
    expect(['ok', 'unavailable']).toContain(r.status);
    if (r.status === 'unavailable') {
      expect(['MULTIPLE_ROOTS_AMBIGUOUS', 'NOT_BRACKETED', 'NO_CONVERGENCE']).toContain(r.reason);
    }
  });
});

describe('XIRR-016: convergence boundary (very small residual)', () => {
  it('still converges for a value extremely close to break-even', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1_000_000 }, { date: d('2022-01-01'), amount: 1_000_000.01 }]);
    expect(r.status).toBe('ok');
    expect(Math.abs(r.rate!)).toBeLessThan(0.001);
  });
});

describe('XIRR-017: large values', () => {
  it('handles crore-scale amounts', () => {
    const r = xirr([{ date: d('2018-01-01'), amount: -50_000_000 }, { date: d('2023-01-01'), amount: 95_000_000 }]);
    expect(r.status).toBe('ok');
    expect(r.rate).toBeGreaterThan(0);
  });
});

describe('XIRR-018: fractional flows (unit-based partial redemptions)', () => {
  it('handles non-integer rupee amounts', () => {
    const r = xirr([
      { date: d('2021-03-14'), amount: -12345.67 },
      { date: d('2021-09-22'), amount: -876.54 },
      { date: d('2022-11-30'), amount: 15234.19 },
    ]);
    expect(r.status).toBe('ok');
  });
});

describe('XIRR-019: scheme-level XIRR (single instrument)', () => {
  it('matches a simple two-flow computation', () => {
    const r = xirr([{ date: d('2019-06-01'), amount: -25000 }, { date: d('2021-06-01'), amount: 32000 }]);
    expect(r.status).toBe('ok');
    // (32000/25000)^(1/2)-1 approx using actual/365 (731 days incl 1 leap day -> slightly >2y)
    const approxYears = (d('2021-06-01').getTime() - d('2019-06-01').getTime()) / 86_400_000 / 365;
    const expected = Math.pow(32000 / 25000, 1 / approxYears) - 1;
    expect(r.rate).toBeCloseTo(expected, 5);
  });
});

describe('XIRR-020: portfolio-level XIRR (aggregated multi-scheme cash flows)', () => {
  it('aggregates flows from multiple schemes into one series', () => {
    const r = xirr([
      { date: d('2020-01-01'), amount: -10000 }, // scheme A purchase
      { date: d('2020-01-01'), amount: -5000 }, // scheme B purchase
      { date: d('2021-01-01'), amount: -3000 }, // scheme A top-up
      { date: d('2022-01-01'), amount: 21000 }, // combined ending value
    ]);
    expect(r.status).toBe('ok');
  });
});

describe('XIRR precision and domain guards', () => {
  it('never returns NaN or Infinity as a valid rate', () => {
    const r = xirr([{ date: d('2021-01-01'), amount: -1000 }, { date: d('2022-01-01'), amount: 2000 }]);
    if (r.status === 'ok') {
      expect(Number.isFinite(r.rate)).toBe(true);
    }
  });
  it('rejects fewer than 2 cash flows', () => {
    expect(xirr([]).status).toBe('unavailable');
  });
});
