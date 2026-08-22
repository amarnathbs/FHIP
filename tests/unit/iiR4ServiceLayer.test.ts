// R4 — Service/orchestration layer tests (spec sections 67, 103-105).
//
// These cover the LAYER ADDED ON TOP of the already-certified pure
// engines: status classification, benchmark period construction, coverage
// suppression, risk-free suppression, currency separation, persistence
// mapping and staleness. The underlying formulas are certified elsewhere
// (50-case independent-oracle pack) and are deliberately not re-tested here.

import { describe, it, expect } from 'vitest';
import {
  fromXirr,
  fromTwrr,
  fromRiskMetric,
  missingReferenceData,
  markStale,
  isDisplayableNumber,
  toPersistedQualityStatus,
} from '@/lib/engines/investment-intelligence/calculationStatus';
import {
  monthlyRebalanceDates,
  valueOnOrBefore,
  computeBlendedBenchmark,
  computePortfolioActiveReturn,
  benchmarkWindowReturn,
} from '@/lib/engines/investment-intelligence/benchmarkService';
import { computeRiskMetrics, periodicReturnsFromLevels } from '@/lib/engines/investment-intelligence/riskMetricsService';
import { computeRollingReturns, toMonthEndSeries } from '@/lib/engines/investment-intelligence/rollingReturnService';
import { runAnalytics, toPersistableRows, applyStaleness, type AnalyticsDataset, type SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import type { BenchmarkMapping } from '@/lib/engines/investment-intelligence/benchmarkEngine';
import type { RiskFreeRatePoint } from '@/lib/config/investment-intelligence/riskFreeRate';

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

// ---------------------------------------------------------------------------
// SVC-STATUS-001..006 — status vocabulary & the no-fabrication rule
// ---------------------------------------------------------------------------

describe('SVC-STATUS-001: an unavailable engine result never becomes CALCULATED', () => {
  it('maps every XIRR failure reason to a non-CALCULATED status', () => {
    const reasons = [
      'ALL_SAME_SIGN',
      'NO_TERMINAL_VALUE',
      'INVALID_DATES',
      'INSUFFICIENT_HISTORY',
      'NOT_BRACKETED',
      'NO_CONVERGENCE',
      'MULTIPLE_ROOTS_AMBIGUOUS',
    ] as const;
    for (const reason of reasons) {
      const out = fromXirr({ status: 'unavailable', reason, detail: 'x' }, () => ({ rate: 0.1 }));
      expect(out.status).not.toBe('CALCULATED');
      // The critical property: no numeric value is ever attached.
      expect(out.value).toBeUndefined();
      expect(out.qualityFlag).toBeDefined();
    }
  });
});

describe('SVC-STATUS-002: multiple IRR roots surface as AMBIGUOUS, not a picked number', () => {
  it('classifies MULTIPLE_ROOTS_AMBIGUOUS correctly', () => {
    const out = fromXirr({ status: 'unavailable', reason: 'MULTIPLE_ROOTS_AMBIGUOUS' }, () => ({ rate: 0.1 }));
    expect(out.status).toBe('AMBIGUOUS');
    expect(out.value).toBeUndefined();
  });
});

describe('SVC-STATUS-003: missing risk-free data is MISSING_REFERENCE_DATA', () => {
  it('classifies the risk-metric reason', () => {
    const out = fromRiskMetric({ status: 'unavailable', reason: 'MISSING_RISK_FREE_DATA' });
    expect(out.status).toBe('MISSING_REFERENCE_DATA');
    expect(out.qualityFlag).toBe('RISK_FREE_DATA_MISSING');
  });
});

describe('SVC-STATUS-004: TWRR boundary gap is MISSING_REFERENCE_DATA not zero', () => {
  it('classifies MISSING_BOUNDARY_VALUATION', () => {
    const out = fromTwrr({ status: 'unavailable', reason: 'MISSING_BOUNDARY_VALUATION' }, () => ({ twrr: 0 }));
    expect(out.status).toBe('MISSING_REFERENCE_DATA');
    expect(out.value).toBeUndefined();
  });
});

describe('SVC-STATUS-005: only CALCULATED and STALE may render a number', () => {
  it('gates display correctly', () => {
    expect(isDisplayableNumber('CALCULATED')).toBe(true);
    expect(isDisplayableNumber('STALE')).toBe(true);
    for (const s of ['INSUFFICIENT_HISTORY', 'MISSING_REFERENCE_DATA', 'FAILED', 'NOT_APPLICABLE', 'AMBIGUOUS'] as const) {
      expect(isDisplayableNumber(s)).toBe(false);
    }
  });
});

describe('SVC-STATUS-006: staleness retains the value but changes the status', () => {
  it('marks stale without discarding the figure', () => {
    const ok = fromXirr({ status: 'ok' }, () => ({ rate: 0.12 }));
    expect(ok.status).toBe('CALCULATED');
    const stale = markStale(ok, 'inputs changed');
    expect(stale.status).toBe('STALE');
    expect(stale.value).toEqual({ rate: 0.12 });
    expect(toPersistedQualityStatus(stale.status)).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// SVC-BENCH-001..005 — period construction, coverage, TRI/PRI
// ---------------------------------------------------------------------------

describe('SVC-BENCH-001: monthly rebalance dates are month-ends, ascending and deduplicated', () => {
  it('produces successive month-ends between the endpoints', () => {
    const dates = monthlyRebalanceDates(d('2021-01-15'), d('2021-05-20'));
    const isoDates = dates.map((x) => x.toISOString().slice(0, 10));
    expect(isoDates[0]).toBe('2021-01-15');
    expect(isoDates[isoDates.length - 1]).toBe('2021-05-20');
    expect(isoDates).toContain('2021-01-31');
    expect(isoDates).toContain('2021-02-28');
    expect(isoDates).toContain('2021-03-31');
    expect(isoDates).toContain('2021-04-30');
    // strictly ascending, no duplicates
    for (let i = 1; i < dates.length; i++) expect(dates[i].getTime()).toBeGreaterThan(dates[i - 1].getTime());
  });

  it('handles a leap-year February', () => {
    const isoDates = monthlyRebalanceDates(d('2020-01-31'), d('2020-04-01')).map((x) => x.toISOString().slice(0, 10));
    expect(isoDates).toContain('2020-02-29');
  });
});

describe('SVC-BENCH-002: valueOnOrBefore never looks forward', () => {
  it('returns the latest point at or before the date, never a later one', () => {
    const pts = [
      { date: d('2021-01-31'), value: 100 },
      { date: d('2021-02-28'), value: 110 },
    ];
    expect(valueOnOrBefore(pts, d('2021-02-15'))?.value).toBe(100);
    expect(valueOnOrBefore(pts, d('2021-02-28'))?.value).toBe(110);
    expect(valueOnOrBefore(pts, d('2020-12-31'))).toBeUndefined();
  });
});

const mapping = (instrumentId: string, benchmarkId: string, returnType: BenchmarkMapping['returnType'] = 'TRI'): BenchmarkMapping => ({
  instrumentId,
  benchmarkId,
  benchmarkKey: benchmarkId.toUpperCase(),
  returnType,
  effectiveFrom: d('2000-01-01'),
  effectiveTo: null,
});

function levelSeries(start: string, months: number, monthlyReturn: number) {
  const out: Array<{ date: Date; value: number }> = [];
  let level = 100;
  const base = d(start);
  for (let i = 0; i <= months; i++) {
    const dt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i + 1, 0));
    out.push({ date: dt, value: level });
    level *= 1 + monthlyReturn;
  }
  return out;
}

describe('SVC-BENCH-003: an unmapped holding reduces coverage and suppresses the conclusion', () => {
  it('suppresses the blended benchmark when most value is unmapped', () => {
    const res = computeBlendedBenchmark({
      periodStart: d('2021-01-01'),
      periodEnd: d('2021-06-30'),
      instrumentSeries: [
        { instrumentId: 'mapped', points: levelSeries('2021-01-01', 6, 0.01).map((p) => ({ ...p, value: 10 })) },
        { instrumentId: 'unmapped', points: levelSeries('2021-01-01', 6, 0.01).map((p) => ({ ...p, value: 90 })) },
      ],
      mappings: [mapping('mapped', 'nifty')],
      benchmarkSeriesById: { nifty: levelSeries('2021-01-01', 6, 0.01) },
    });
    expect(res.blended.status).toBe('unavailable');
    expect(res.blended.reason).toBe('INSUFFICIENT_BENCHMARK_COVERAGE');
    expect(res.annotations.some((a) => a.flag === 'BENCHMARK_MAPPING_MISSING')).toBe(true);
  });

  it('produces a result when coverage is complete', () => {
    const res = computeBlendedBenchmark({
      periodStart: d('2021-01-01'),
      periodEnd: d('2021-06-30'),
      instrumentSeries: [{ instrumentId: 'mapped', points: levelSeries('2021-01-01', 6, 0.0).map((p) => ({ ...p, value: 100 })) }],
      mappings: [mapping('mapped', 'nifty')],
      benchmarkSeriesById: { nifty: levelSeries('2021-01-01', 6, 0.01) },
    });
    expect(res.blended.status).toBe('ok');
    expect(res.blended.coveragePct).toBeCloseTo(1, 10);
    expect(res.contributingBenchmarks[0].benchmarkKey).toBe('NIFTY');
  });
});

describe('SVC-BENCH-004: a mapped benchmark with no series values counts as uncovered, not as 0%', () => {
  it('does not treat a missing series as a zero return', () => {
    const res = computeBlendedBenchmark({
      periodStart: d('2021-01-01'),
      periodEnd: d('2021-06-30'),
      instrumentSeries: [{ instrumentId: 'a', points: levelSeries('2021-01-01', 6, 0).map((p) => ({ ...p, value: 100 })) }],
      mappings: [mapping('a', 'missing')],
      benchmarkSeriesById: {},
    });
    expect(res.blended.status).toBe('unavailable');
    expect(res.annotations.some((a) => a.flag === 'BENCHMARK_HISTORY_INCOMPLETE')).toBe(true);
  });
});

describe('SVC-BENCH-005: PRI standing in for a required TRI is flagged, never silent', () => {
  it('adds a qualification annotation', () => {
    const res = computeBlendedBenchmark({
      periodStart: d('2021-01-01'),
      periodEnd: d('2021-06-30'),
      instrumentSeries: [{ instrumentId: 'a', points: levelSeries('2021-01-01', 6, 0).map((p) => ({ ...p, value: 100 })) }],
      mappings: [mapping('a', 'nifty', 'PRI')],
      benchmarkSeriesById: { nifty: levelSeries('2021-01-01', 6, 0.01) },
      requireTotalReturn: true,
    });
    expect(res.annotations.some((a) => a.detail.includes('Price Return Index'))).toBe(true);
  });
});

describe('SVC-BENCH-006: portfolio active return is TWRR-vs-TWRR only', () => {
  it('returns unavailable when either side is missing rather than mixing families', () => {
    expect(computePortfolioActiveReturn(undefined, 0.05).status).toBe('unavailable');
    expect(computePortfolioActiveReturn(0.07, undefined).status).toBe('unavailable');
    const ok = computePortfolioActiveReturn(0.07, 0.05);
    expect(ok.status).toBe('ok');
    expect(ok.activeReturn).toBeCloseTo(0.02, 12);
  });
});

describe('SVC-BENCH-007: benchmarkWindowReturn reports both measure families', () => {
  it('gives point-to-point and CAGR over the same window', () => {
    const series = [
      { date: d('2020-01-01'), value: 100 },
      { date: d('2022-01-01'), value: 121 },
    ];
    const r = benchmarkWindowReturn(series, d('2020-01-01'), d('2022-01-01'));
    expect(r.status).toBe('ok');
    expect(r.pointToPoint).toBeCloseTo(0.21, 10);
    expect(r.cagr!).toBeGreaterThan(0.09);
    expect(r.cagr!).toBeLessThan(0.11);
  });
});

// ---------------------------------------------------------------------------
// SVC-RISK-001..003 — risk-free suppression and benchmark dependency
// ---------------------------------------------------------------------------

const RF: RiskFreeRatePoint[] = [
  { countryCode: 'IN', periodStart: d('2020-01-01'), periodEnd: d('2030-01-01'), annualisedRate: 0.06, source: 'RBI 91-day T-Bill', method: 'period_average', version: 'v1' },
];

const monthlyReturns = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? -0.01 : 0.015));
const valuations = (() => {
  const out: Array<{ date: Date; value: number }> = [];
  let v = 1000;
  for (let i = 0; i < 25; i++) {
    out.push({ date: new Date(Date.UTC(2021, i + 1, 0)), value: v });
    v *= 1 + (i % 3 === 0 ? -0.01 : 0.015);
  }
  return out;
})();

describe('SVC-RISK-001: absent risk-free data suppresses Sharpe/Sortino/alpha, never defaults a rate', () => {
  it('withholds the ratios and says why', () => {
    const res = computeRiskMetrics({
      fundReturns: monthlyReturns,
      benchmarkReturns: monthlyReturns.map((r) => r * 0.9),
      valuationSeries: valuations,
      frequency: 'monthly',
      countryCode: 'IN',
      asOfDate: d('2022-12-31'),
      riskFreeSeries: [],
    });
    expect(res.sharpeRatio.status).toBe('MISSING_REFERENCE_DATA');
    expect(res.sortinoRatio.status).toBe('MISSING_REFERENCE_DATA');
    expect(res.alpha.status).toBe('MISSING_REFERENCE_DATA');
    expect(res.sharpeRatio.value).toBeUndefined();
    expect(res.riskFree.status).toBe('unavailable');
    // Metrics that genuinely don't need a risk-free rate still compute.
    expect(res.volatility.status).toBe('CALCULATED');
    expect(res.downsideDeviation.status).toBe('CALCULATED');
    expect(res.maxDrawdown.status).toBe('CALCULATED');
  });

  it('computes them once the reference data exists', () => {
    const res = computeRiskMetrics({
      fundReturns: monthlyReturns,
      benchmarkReturns: monthlyReturns.map((r) => r * 0.9),
      valuationSeries: valuations,
      frequency: 'monthly',
      countryCode: 'IN',
      asOfDate: d('2022-12-31'),
      riskFreeSeries: RF,
    });
    expect(res.sharpeRatio.status).toBe('CALCULATED');
    expect(res.riskFree.rate).toBeCloseTo(0.06, 12);
    expect(res.riskFree.source).toBe('RBI 91-day T-Bill');
  });
});

describe('SVC-RISK-002: no benchmark suppresses benchmark-relative metrics only', () => {
  it('withholds beta/TE/IR/capture but keeps standalone risk', () => {
    const res = computeRiskMetrics({
      fundReturns: monthlyReturns,
      valuationSeries: valuations,
      frequency: 'monthly',
      countryCode: 'IN',
      asOfDate: d('2022-12-31'),
      riskFreeSeries: RF,
    });
    expect(res.beta.status).toBe('MISSING_REFERENCE_DATA');
    expect(res.trackingError.status).toBe('MISSING_REFERENCE_DATA');
    expect(res.informationRatio.status).toBe('MISSING_REFERENCE_DATA');
    expect(res.captureRatios.status).toBe('MISSING_REFERENCE_DATA');
    expect(res.volatility.status).toBe('CALCULATED');
    expect(res.sharpeRatio.status).toBe('CALCULATED');
  });
});

describe('SVC-RISK-003: periodicReturnsFromLevels ignores non-positive bases', () => {
  it('derives returns from an index level series', () => {
    const rs = periodicReturnsFromLevels([
      { date: d('2021-01-31'), value: 100 },
      { date: d('2021-02-28'), value: 110 },
      { date: d('2021-03-31'), value: 99 },
    ]);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toBeCloseTo(0.1, 12);
    expect(rs[1]).toBeCloseTo(-0.1, 12);
  });
});

// ---------------------------------------------------------------------------
// SVC-ROLL-001..002 — rolling horizons
// ---------------------------------------------------------------------------

describe('SVC-ROLL-001: too few windows yields INSUFFICIENT_HISTORY, never a beat-%', () => {
  it('suppresses short horizons', () => {
    const short = toMonthEndSeries(valuations.slice(0, 6));
    const res = computeRollingReturns(short);
    for (const h of res.horizons) {
      expect(h.series.status).not.toBe('CALCULATED');
      expect(h.beat.status).not.toBe('CALCULATED');
      expect(h.beat.value).toBeUndefined();
    }
  });
});

describe('SVC-ROLL-002: toMonthEndSeries keeps the last observation per month and never interpolates', () => {
  it('collapses intra-month points to the month-end observation', () => {
    const out = toMonthEndSeries([
      { date: d('2021-01-05'), value: 1 },
      { date: d('2021-01-28'), value: 2 },
      { date: d('2021-03-10'), value: 3 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].value).toBe(2);
    // February had no observation and is NOT fabricated.
    expect(out[1].date.toISOString().slice(0, 7)).toBe('2021-03');
  });
});

// ---------------------------------------------------------------------------
// SVC-ORCH-001..004 — orchestration, currency separation, persistence
// ---------------------------------------------------------------------------

function scheme(overrides: Partial<SchemeDataset> & { instrumentId: string; currencyCode: string }): SchemeDataset {
  const navs = levelSeries('2021-01-01', 24, 0.008);
  return {
    instrumentName: `Fund ${overrides.instrumentId}`,
    countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception',
    optionType: null,
    hasDistributionAdjustment: false,
    // Mirrors what analyticsRepository builds: investor outflows plus the
    // synthetic terminal current-value inflow on the as-of date.
    cashFlows: [
      { date: d('2021-01-31'), amount: -1000 },
      { date: d('2022-12-31'), amount: 1200 },
    ],
    currentValue: 1200,
    currentValueDate: d('2022-12-31'),
    navSeries: navs,
    valuationSeries: navs.map((p) => ({ ...p, value: p.value * 10 })),
    ...overrides,
  } as SchemeDataset;
}

function dataset(schemes: SchemeDataset[]): AnalyticsDataset {
  return {
    userId: 'user-1',
    asOfDate: d('2022-12-31'),
    periodStart: d('2021-01-01'),
    schemes,
    mappings: schemes.map((s) => mapping(s.instrumentId, 'nifty')),
    benchmarkSeriesById: { nifty: levelSeries('2021-01-01', 24, 0.007) },
    riskFreeSeries: RF,
    navDataVersion: 'nav-v1',
    benchmarkDataVersion: 'bench-v1',
    benchmarkMappingVersion: 'map-v1',
    frequency: 'monthly',
  };
}

describe('SVC-ORCH-001: currencies are reported separately, never blended at spot FX', () => {
  it('produces one portfolio block per currency and explains why they are not combined', () => {
    const rs = runAnalytics(dataset([scheme({ instrumentId: 'a', currencyCode: 'INR' }), scheme({ instrumentId: 'b', currencyCode: 'AUD' })]));
    expect(rs.portfolios).toHaveLength(2);
    expect(rs.portfolios.map((p) => p.currencyCode).sort()).toEqual(['AUD', 'INR']);
    expect(rs.crossCurrency.status).toBe('NOT_APPLICABLE');
    expect(rs.crossCurrency.detail).toMatch(/historical FX return series/i);
    // No combined figure exists anywhere in the result set.
    expect((rs as unknown as { combined?: unknown }).combined).toBeUndefined();
  });

  it('a single-currency household gets exactly one block', () => {
    const rs = runAnalytics(dataset([scheme({ instrumentId: 'a', currencyCode: 'INR' })]));
    expect(rs.portfolios).toHaveLength(1);
    expect(rs.portfolios[0].currencyCode).toBe('INR');
  });
});

describe('SVC-ORCH-002: history-completeness gate flows end to end', () => {
  it('suppresses since-inception XIRR for partial history', () => {
    const rs = runAnalytics(dataset([scheme({ instrumentId: 'a', currencyCode: 'INR', historyCompleteness: 'partial_history' })]));
    const s = rs.schemes[0];
    expect(s.investorXirr.status).not.toBe('CALCULATED');
    expect(s.investorXirr.value).toBeUndefined();
    expect(s.annotations.some((a) => a.flag === 'PARTIAL_TRANSACTION_HISTORY')).toBe(true);
  });

  it('allows it for complete_from_inception', () => {
    const rs = runAnalytics(dataset([scheme({ instrumentId: 'a', currencyCode: 'INR' })]));
    expect(rs.schemes[0].investorXirr.status).toBe('CALCULATED');
  });
});

describe('SVC-ORCH-003: persistence rows carry full versioning and record unavailability', () => {
  it('emits rows with versions, fingerprints and unavailable statuses preserved', () => {
    const ds = dataset([scheme({ instrumentId: 'a', currencyCode: 'INR', historyCompleteness: 'partial_history' })]);
    const rs = runAnalytics(ds);
    const rows = toPersistableRows('user-1', rs, ds);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.user_id).toBe('user-1');
      expect(row.engine_version).toBeTruthy();
      expect(row.input_snapshot_version).toMatch(/^[0-9a-f]{64}$/);
      expect(row.nav_data_version).toBe('nav-v1');
      expect(row.benchmark_mapping_version).toBe('map-v1');
      expect(['ok', 'unavailable', 'stale']).toContain(row.quality_status);
      // An unavailable metric is persisted as such, with a reason — not dropped,
      // and never with a fabricated numeric result.
      if (row.quality_status === 'unavailable') {
        expect(row.quality_reason).toBeTruthy();
        expect((row.result_value as { value: unknown }).value).toBeNull();
      }
    }
    const xirrRow = rows.find((r) => r.metric_key === 'investor_xirr');
    expect(xirrRow?.quality_status).toBe('unavailable');
  });

  it('scopes portfolio rows by currency', () => {
    const ds = dataset([scheme({ instrumentId: 'a', currencyCode: 'INR' }), scheme({ instrumentId: 'b', currencyCode: 'AUD' })]);
    const rows = toPersistableRows('user-1', runAnalytics(ds), ds);
    const scopes = new Set(rows.filter((r) => r.scope_type === 'portfolio').map((r) => r.scope_id));
    expect(scopes).toEqual(new Set(['currency:INR', 'currency:AUD']));
  });
});

describe('SVC-ORCH-004: determinism and staleness', () => {
  it('produces an identical fingerprint on a re-run with unchanged input', () => {
    const ds = dataset([scheme({ instrumentId: 'a', currencyCode: 'INR' })]);
    const a = runAnalytics(ds);
    const b = runAnalytics(ds);
    expect(a.portfolios[0].inputFingerprint).toBe(b.portfolios[0].inputFingerprint);
    expect(a.schemes[0].inputFingerprint).toBe(b.schemes[0].inputFingerprint);
  });

  it('changes the fingerprint when an input changes', () => {
    const base = dataset([scheme({ instrumentId: 'a', currencyCode: 'INR' })]);
    const changed = { ...base, navDataVersion: 'nav-v2' };
    expect(runAnalytics(base).portfolios[0].inputFingerprint).not.toBe(runAnalytics(changed).portfolios[0].inputFingerprint);
  });

  it('marks a persisted result stale when the fingerprint moved', () => {
    const ok = fromXirr({ status: 'ok' }, () => ({ rate: 0.12 }));
    const stale = applyStaleness(ok, { engineVersion: 'performance-engine-r4-v1', inputSnapshotVersion: 'oldhash', createdAt: '2024-01-01T00:00:00Z' }, 'newhash');
    expect(stale.status).toBe('STALE');
    expect(stale.detail).toMatch(/2024-01-01/);
    const fresh = applyStaleness(ok, { engineVersion: 'performance-engine-r4-v1', inputSnapshotVersion: 'samehash', createdAt: '2024-01-01T00:00:00Z' }, 'samehash');
    expect(fresh.status).toBe('CALCULATED');
  });
});

describe('SVC-ORCH-005: no metric is ever emitted as a misleading zero', () => {
  it('a dataset with no benchmark data yields suppressed, explained benchmark metrics', () => {
    const ds = { ...dataset([scheme({ instrumentId: 'a', currencyCode: 'INR' })]), mappings: [], benchmarkSeriesById: {} };
    const rs = runAnalytics(ds);
    const p = rs.portfolios[0];
    expect(p.blendedBenchmarkReturn.status).not.toBe('CALCULATED');
    expect(p.blendedBenchmarkReturn.value).toBeUndefined();
    expect(p.blendedBenchmarkReturn.detail).toBeTruthy();
    expect(p.activeReturn.status).not.toBe('CALCULATED');
    expect(p.activeReturn.value).toBeUndefined();
    expect(rs.schemes[0].activeReturn.status).toBe('MISSING_REFERENCE_DATA');
  });
});

describe('SVC-ORCH-007: suppressed blended benchmark suppresses EVERY benchmark-relative metric', () => {
  // Regression test for a real defect found by rendering the page in a
  // browser, which the earlier "no mappings at all" test did not reach.
  //
  // blendedBenchmarkReturn() returns raw periodReturns alongside an
  // 'unavailable' status. Consuming them regardless of status fabricated a
  // benchmark: at 0% coverage every period return is 0, so tracking error
  // came out exactly equal to portfolio volatility, and the UI reported
  // "beat the benchmark in 100% of windows" directly beneath "0.0% of this
  // portfolio has a mapped benchmark".
  function belowCoverageDataset(): AnalyticsDataset {
    const mapped = scheme({ instrumentId: 'mapped', currencyCode: 'INR' });
    const unmapped = scheme({ instrumentId: 'unmapped', currencyCode: 'INR' });
    // Make the UNMAPPED holding dominate so coverage falls under 80%.
    mapped.valuationSeries = mapped.valuationSeries.map((p) => ({ ...p, value: 10 }));
    unmapped.valuationSeries = unmapped.valuationSeries.map((p) => ({ ...p, value: 90 }));
    const ds = dataset([mapped, unmapped]);
    // Only the 'mapped' instrument has a benchmark mapping.
    ds.mappings = [mapping('mapped', 'nifty')];
    return ds;
  }

  it('suppresses the blend below the coverage threshold', () => {
    const p = runAnalytics(belowCoverageDataset()).portfolios[0];
    expect(p.blendedBenchmarkReturn.status).not.toBe('CALCULATED');
    expect(p.blendedBenchmarkReturn.detail).toMatch(/coverage|mapped benchmark/i);
  });

  it('does NOT report tracking error, information ratio, beta, alpha or capture', () => {
    const p = runAnalytics(belowCoverageDataset()).portfolios[0];
    for (const [name, outcome] of [
      ['trackingError', p.risk.trackingError],
      ['informationRatio', p.risk.informationRatio],
      ['beta', p.risk.beta],
      ['alpha', p.risk.alpha],
      ['captureRatios', p.risk.captureRatios],
    ] as const) {
      expect(outcome.status, `${name} must not be CALCULATED without a benchmark conclusion`).not.toBe('CALCULATED');
      expect(outcome.value, `${name} must not carry a value`).toBeUndefined();
    }
  });

  it('does NOT report a rolling benchmark-beat percentage', () => {
    const p = runAnalytics(belowCoverageDataset()).portfolios[0];
    for (const h of p.rolling.horizons) {
      expect(h.beat.status, `rolling ${h.windowYears}Y beat% must be suppressed`).not.toBe('CALCULATED');
      expect(h.beat.value).toBeUndefined();
    }
  });

  it('draws no benchmark line in the comparison chart', () => {
    const p = runAnalytics(belowCoverageDataset()).portfolios[0];
    expect(p.performanceVsBenchmarkSeries.every((pt) => pt.benchmark === null)).toBe(true);
  });

  it('still reports the benchmark-independent risk metrics', () => {
    const p = runAnalytics(belowCoverageDataset()).portfolios[0];
    expect(p.risk.volatility.status).toBe('CALCULATED');
    expect(p.risk.maxDrawdown.status).toBe('CALCULATED');
    expect(p.portfolioTwrr.status).toBe('CALCULATED');
  });

  it('tracking error is not silently equal to volatility (the fabrication signature)', () => {
    const p = runAnalytics(belowCoverageDataset()).portfolios[0];
    // With the bug, TE == volatility exactly, because the "benchmark" was an
    // all-zero series. With the fix, TE is not calculated at all.
    expect(p.risk.trackingError.status).not.toBe('CALCULATED');
  });
});

describe('SVC-ORCH-006: missingReferenceData constructor never carries a value', () => {
  it('is structurally incapable of showing a number', () => {
    const o = missingReferenceData('BENCHMARK_MAPPING_MISSING', 'none');
    expect(o.status).toBe('MISSING_REFERENCE_DATA');
    expect(o.value).toBeUndefined();
    expect(isDisplayableNumber(o.status)).toBe(false);
  });
});
