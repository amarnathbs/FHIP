// R4 — AnalyticsOrchestrator (spec sections 55-59, 67, 103-105).
//
// The single entry point that turns a fully-loaded, already-authorised
// analytics dataset into the investor-facing result set, with:
//   * every number produced by the certified engines (no formula lives here);
//   * every number carrying a CalculationStatus + data-quality flag;
//   * full versioning + input-snapshot fingerprint per metric, so a shown
//     figure is always reproducible and staleness is detectable;
//   * strict local-currency treatment (spec section 59).
//
// READ-ONLY GUARANTEE: this module and everything it calls are pure over
// their inputs. It performs no I/O at all. Its only persistence-adjacent
// output is `toPersistableRows()`, which RETURNS rows for the caller to
// write to ii_analytics_results — the derived analytics table. Nothing
// here ever touches investments / assets / retirement_accounts / income /
// expenses / liabilities or any R3 publication row.

import { computeSchemePerformance, computePortfolioPerformance } from './PerformanceEngine';
import { computeBlendedBenchmark, computePortfolioActiveReturn, benchmarkWindowReturn, valueOnOrBefore, type SeriesPoint, type InstrumentValuationSeries } from './benchmarkService';
import { computeRiskMetrics, periodicReturnsFromLevels, type RiskMetricsResult, type ReturnFrequency } from './riskMetricsService';
import { computeRollingReturns, toMonthEndSeries, type RollingReturnServiceResult } from './rollingReturnService';
import { fromXirr, fromTwrr, insufficientHistory, toPersistedQualityStatus, markStale, type CalculationOutcome, type CalculationStatus } from './calculationStatus';
import { fingerprintInputs, isStale, PERFORMANCE_ENGINE_VERSION, ENGINE_SUB_VERSIONS } from './analyticsVersioning';
import type { DataQualityAnnotation } from './dataQuality';
import type { CashFlow } from './xirr';
import type { ValuationPoint, ExternalFlow } from './twrr';
import type { BenchmarkMapping } from './benchmarkEngine';
import type { RiskFreeRatePoint } from '@/lib/config/investment-intelligence/riskFreeRate';

export interface SchemeDataset {
  instrumentId: string;
  instrumentName: string;
  /** The instrument's own currency. Never pre-converted (spec section 59). */
  currencyCode: string;
  countryOfDomicile: string;
  historyCompleteness: string | null;
  optionType: string | null;
  hasDistributionAdjustment: boolean;
  cashFlows: CashFlow[];
  currentValue: number;
  currentValueDate: Date;
  navSeries: SeriesPoint[];
  /** Dated market value of the position, used for weights and drawdown. */
  valuationSeries: SeriesPoint[];
}

export interface AnalyticsDataset {
  userId: string;
  asOfDate: Date;
  periodStart: Date;
  schemes: SchemeDataset[];
  mappings: BenchmarkMapping[];
  benchmarkSeriesById: Record<string, SeriesPoint[]>;
  riskFreeSeries: RiskFreeRatePoint[];
  /** Reference-data provenance versions, for the persisted result rows. */
  navDataVersion: string | null;
  benchmarkDataVersion: string | null;
  benchmarkMappingVersion: string | null;
  /** Frequency of the periodic-return series used for risk metrics. */
  frequency?: ReturnFrequency;
}

export interface SchemeAnalytics {
  instrumentId: string;
  instrumentName: string;
  currencyCode: string;
  investorXirr: CalculationOutcome<{ rate: number }>;
  navReturns: Record<string, CalculationOutcome<{ pointToPoint?: number; cagr?: number }>>;
  activeReturn: CalculationOutcome<{ activeReturn: number; family: string; benchmarkKey: string }>;
  annotations: DataQualityAnnotation[];
  inputFingerprint: string;
}

export interface PortfolioCurrencyAnalytics {
  currencyCode: string;
  schemeCount: number;
  totalValue: number;
  portfolioTwrr: CalculationOutcome<{ twrr: number }>;
  portfolioXirr: CalculationOutcome<{ rate: number }>;
  blendedBenchmarkReturn: CalculationOutcome<{ blendedReturn: number; coveragePct: number }>;
  activeReturn: CalculationOutcome<{ activeReturn: number }>;
  risk: RiskMetricsResult;
  rolling: RollingReturnServiceResult;
  drawdownSeries: Array<{ date: string; value: number; drawdown: number }>;
  performanceVsBenchmarkSeries: Array<{ date: string; portfolio: number; benchmark: number | null }>;
  contributingBenchmarks: Array<{ benchmarkId: string; benchmarkKey: string; returnType: string }>;
  annotations: DataQualityAnnotation[];
  inputFingerprint: string;
}

export interface AnalyticsResultSet {
  asOfDate: string;
  periodStart: string;
  engineVersion: string;
  subVersions: typeof ENGINE_SUB_VERSIONS;
  /** One block per currency — never a single cross-currency blended return. */
  portfolios: PortfolioCurrencyAnalytics[];
  schemes: SchemeAnalytics[];
  /** Explains why no single combined figure is shown when >1 currency exists. */
  crossCurrency: CalculationOutcome<never>;
  annotations: DataQualityAnnotation[];
}

const CROSS_CURRENCY_DETAIL =
  'This household holds investments in more than one currency. A single combined performance figure is not shown because converting beginning and ending values at today\'s exchange rate would misattribute currency movement as investment performance. A genuine cross-currency return requires a historical FX return series, which is not part of this release. Each currency is reported separately below, in its own local currency.';

/**
 * Main orchestration entry point. Pure: no I/O, no writes, fully
 * deterministic for a given dataset.
 */
export function runAnalytics(ds: AnalyticsDataset): AnalyticsResultSet {
  const frequency: ReturnFrequency = ds.frequency ?? 'monthly';
  const annotations: DataQualityAnnotation[] = [];

  const schemes = ds.schemes.map((s) => analyseScheme(s, ds));

  // ---- Currency treatment (spec section 59) --------------------------
  const byCurrency = new Map<string, SchemeDataset[]>();
  for (const s of ds.schemes) {
    const list = byCurrency.get(s.currencyCode) ?? [];
    list.push(s);
    byCurrency.set(s.currencyCode, list);
  }

  const portfolios = [...byCurrency.entries()].map(([currencyCode, group]) =>
    analysePortfolioCurrency(currencyCode, group, ds, frequency)
  );

  const crossCurrency: CalculationOutcome<never> =
    byCurrency.size > 1
      ? { status: 'NOT_APPLICABLE', qualityFlag: 'COMPLETE', detail: CROSS_CURRENCY_DETAIL }
      : { status: 'NOT_APPLICABLE', qualityFlag: 'COMPLETE', detail: 'Single-currency portfolio: performance is reported in its own local currency.' };

  if (byCurrency.size > 1) {
    annotations.push({ flag: 'COMPLETE', detail: CROSS_CURRENCY_DETAIL });
  }

  return {
    asOfDate: iso(ds.asOfDate),
    periodStart: iso(ds.periodStart),
    engineVersion: PERFORMANCE_ENGINE_VERSION,
    subVersions: ENGINE_SUB_VERSIONS,
    portfolios,
    schemes,
    crossCurrency,
    annotations,
  };
}

function analyseScheme(s: SchemeDataset, ds: AnalyticsDataset): SchemeAnalytics {
  const perf = computeSchemePerformance({
    instrumentId: s.instrumentId,
    historyCompleteness: s.historyCompleteness,
    optionType: s.optionType,
    hasDistributionAdjustment: s.hasDistributionAdjustment,
    cashFlows: s.cashFlows,
    currentValue: s.currentValue,
    currentValueDate: s.currentValueDate,
    navSeries: s.navSeries,
  });

  const investorXirr = fromXirr(perf.investorXirr, () => ({ rate: perf.investorXirr.rate! }));

  const navReturns: SchemeAnalytics['navReturns'] = {};
  for (const [horizon, r] of Object.entries(perf.navPointToPoint)) {
    navReturns[horizon] =
      r.status === 'ok'
        ? { status: 'CALCULATED', value: { pointToPoint: r.pointToPointReturn, cagr: r.cagr } }
        : { status: 'FAILED', qualityFlag: 'NAV_HISTORY_INCOMPLETE', engineReason: r.reason, detail: r.detail };
  }

  // Scheme active return: compare like with like (spec section 32). We use
  // the SINCE_INCEPTION CAGR on both sides when available.
  const activeReturn = computeSchemeActive(s, ds, perf.navPointToPoint['SINCE_INCEPTION']);

  return {
    instrumentId: s.instrumentId,
    instrumentName: s.instrumentName,
    currencyCode: s.currencyCode,
    investorXirr,
    navReturns,
    activeReturn,
    annotations: perf.dataQualityAnnotations,
    inputFingerprint: perf.inputFingerprint,
  };
}

function computeSchemeActive(
  s: SchemeDataset,
  ds: AnalyticsDataset,
  schemeSinceInception: { status: 'ok' | 'unavailable'; cagr?: number } | undefined
): CalculationOutcome<{ activeReturn: number; family: string; benchmarkKey: string }> {
  const sorted = [...s.navSeries].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (sorted.length < 2 || !schemeSinceInception || schemeSinceInception.status !== 'ok' || schemeSinceInception.cagr === undefined) {
    return insufficientHistory('NAV_HISTORY_INCOMPLETE', 'An annualised scheme return could not be computed for this period, so an active return against the benchmark is not shown.');
  }
  const start = sorted[0].date;
  const end = sorted[sorted.length - 1].date;
  const mapping = ds.mappings.find(
    (m) => m.instrumentId === s.instrumentId && m.effectiveFrom.getTime() <= end.getTime() && (m.effectiveTo === null || m.effectiveTo.getTime() >= end.getTime())
  );
  if (!mapping) {
    return {
      status: 'MISSING_REFERENCE_DATA',
      qualityFlag: 'BENCHMARK_MAPPING_MISSING',
      detail: 'This scheme has no benchmark mapping effective for the selected period, so an active return cannot be calculated.',
    };
  }
  const series = ds.benchmarkSeriesById[mapping.benchmarkId] ?? [];
  const bench = benchmarkWindowReturn(series, start, end);
  if (bench.status !== 'ok' || bench.cagr === undefined) {
    return {
      status: 'MISSING_REFERENCE_DATA',
      qualityFlag: 'BENCHMARK_HISTORY_INCOMPLETE',
      detail: 'The mapped benchmark has no index values at the period boundaries, so an active return cannot be calculated.',
    };
  }
  // Both sides are CAGR over the identical window — a compatible pair.
  return {
    status: 'CALCULATED',
    value: {
      activeReturn: schemeSinceInception.cagr - bench.cagr,
      family: 'CAGR',
      benchmarkKey: mapping.benchmarkKey,
    },
  };
}

function analysePortfolioCurrency(
  currencyCode: string,
  group: SchemeDataset[],
  ds: AnalyticsDataset,
  frequency: ReturnFrequency
): PortfolioCurrencyAnalytics {
  const annotations: DataQualityAnnotation[] = [];

  // Aggregate the portfolio valuation series across this currency's schemes.
  const allDates = new Set<number>();
  for (const s of group) for (const p of s.valuationSeries) allDates.add(p.date.getTime());
  const dates = [...allDates].sort((a, b) => a - b).map((t) => new Date(t));

  const valuations: ValuationPoint[] = dates.map((d) => ({
    date: d,
    value: group.reduce((sum, s) => sum + (valueOnOrBefore(s.valuationSeries, d)?.value ?? 0), 0),
  }));

  // External flows = investor cash flows, sign-flipped to the portfolio's
  // perspective (investor outflow to buy = money INTO the portfolio).
  const flowMap = new Map<number, number>();
  const investorCashFlows: CashFlow[] = [];
  for (const s of group) {
    for (const cf of s.cashFlows) {
      investorCashFlows.push(cf);
      flowMap.set(cf.date.getTime(), (flowMap.get(cf.date.getTime()) ?? 0) + -cf.amount);
    }
  }
  // The terminal current-value flow is a valuation, not an external flow.
  const terminal = dates.length ? dates[dates.length - 1].getTime() : 0;
  flowMap.delete(terminal);
  const externalFlows: ExternalFlow[] = [...flowMap.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([t, amount]) => ({ date: new Date(t), amount }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const perf = computePortfolioPerformance({ valuations, externalFlows, investorCashFlows });
  const portfolioTwrr = fromTwrr(perf.portfolioTwrr, () => ({ twrr: perf.portfolioTwrr.twrr! }));
  const portfolioXirr = fromXirr(perf.portfolioXirr, () => ({ rate: perf.portfolioXirr.rate! }));

  // ---- Blended benchmark ---------------------------------------------
  const instrumentSeries: InstrumentValuationSeries[] = group.map((s) => ({
    instrumentId: s.instrumentId,
    points: s.valuationSeries,
  }));
  const blend = computeBlendedBenchmark({
    periodStart: ds.periodStart,
    periodEnd: ds.asOfDate,
    instrumentSeries,
    mappings: ds.mappings,
    benchmarkSeriesById: ds.benchmarkSeriesById,
    requireTotalReturn: true,
  });
  annotations.push(...blend.annotations);

  const blendedOutcome: CalculationOutcome<{ blendedReturn: number; coveragePct: number }> =
    blend.blended.status === 'ok'
      ? { status: 'CALCULATED', value: { blendedReturn: blend.blended.blendedReturn!, coveragePct: blend.blended.coveragePct! } }
      : {
          status: blend.blended.reason === 'INSUFFICIENT_BENCHMARK_COVERAGE' ? 'MISSING_REFERENCE_DATA' : 'INSUFFICIENT_HISTORY',
          qualityFlag: blend.blended.reason === 'INSUFFICIENT_BENCHMARK_COVERAGE' ? 'BENCHMARK_MAPPING_MISSING' : 'NAV_HISTORY_INCOMPLETE',
          engineReason: blend.blended.reason,
          detail:
            blend.blended.reason === 'INSUFFICIENT_BENCHMARK_COVERAGE'
              ? `Only ${((blend.blended.coveragePct ?? 0) * 100).toFixed(1)}% of this portfolio's value has a mapped benchmark with usable history, below the ${(blend.minCoverageThreshold * 100).toFixed(0)}% minimum required to draw a benchmark conclusion. The comparison is withheld rather than presented as if coverage were complete.`
              : 'There is not enough valuation history to construct a blended benchmark for this period.',
        };

  // ---- Portfolio active return (TWRR vs blended TWRR only) ------------
  const activeRaw = computePortfolioActiveReturn(
    portfolioTwrr.status === 'CALCULATED' ? portfolioTwrr.value!.twrr : undefined,
    blendedOutcome.status === 'CALCULATED' ? blendedOutcome.value!.blendedReturn : undefined
  );
  const activeReturn: CalculationOutcome<{ activeReturn: number }> =
    activeRaw.status === 'ok'
      ? { status: 'CALCULATED', value: { activeReturn: activeRaw.activeReturn! } }
      : {
          status: 'MISSING_REFERENCE_DATA',
          qualityFlag: activeRaw.reason === 'BENCHMARK_UNAVAILABLE' ? 'BENCHMARK_MAPPING_MISSING' : 'NAV_HISTORY_INCOMPLETE',
          engineReason: activeRaw.reason,
          detail:
            activeRaw.reason === 'BENCHMARK_UNAVAILABLE'
              ? 'A blended benchmark return is not available for this period, so active return cannot be shown.'
              : 'The portfolio time-weighted return is not available for this period, so active return cannot be shown.',
        };

  // ---- Risk metrics ---------------------------------------------------
  const monthEnd = toMonthEndSeries(valuations);
  const fundReturns = periodicReturnsFromLevels(monthEnd);
  const benchmarkLevels = buildBlendedBenchmarkLevels(blend.rebalanceDates, blend.blended.periodReturns);
  const benchmarkReturns = benchmarkLevels.length > 1 ? periodicReturnsFromLevels(toMonthEndSeries(benchmarkLevels)) : [];
  const aligned = alignSeries(fundReturns, benchmarkReturns);

  const risk = computeRiskMetrics({
    fundReturns: aligned.fund,
    benchmarkReturns: aligned.benchmark.length ? aligned.benchmark : undefined,
    valuationSeries: valuations,
    frequency,
    countryCode: group[0]?.countryOfDomicile ?? 'IN',
    asOfDate: ds.asOfDate,
    riskFreeSeries: ds.riskFreeSeries,
  });
  if (risk.riskFree.status !== 'ok') {
    annotations.push({
      flag: 'RISK_FREE_DATA_MISSING',
      detail: 'No risk-free rate is available in reference data for this country and period, so Sharpe, Sortino and alpha are withheld rather than computed against an assumed rate.',
    });
  }

  // ---- Rolling returns ------------------------------------------------
  const rolling = computeRollingReturns(monthEnd, benchmarkLevels.length ? toMonthEndSeries(benchmarkLevels) : undefined);

  // ---- Chart series ---------------------------------------------------
  const drawdownSeries = buildDrawdownSeries(valuations);
  const performanceVsBenchmarkSeries = buildComparisonSeries(valuations, benchmarkLevels);

  const inputFingerprint = fingerprintInputs([
    currencyCode,
    valuations.map((v) => ({ d: v.date.toISOString(), v: v.value })),
    externalFlows.map((f) => ({ d: f.date.toISOString(), a: f.amount })),
    ds.mappings.map((m) => ({ i: m.instrumentId, b: m.benchmarkId, f: m.effectiveFrom.toISOString(), t: m.effectiveTo?.toISOString() ?? null })),
    ds.navDataVersion,
    ds.benchmarkDataVersion,
    ds.benchmarkMappingVersion,
    PERFORMANCE_ENGINE_VERSION,
  ]);

  return {
    currencyCode,
    schemeCount: group.length,
    totalValue: valuations.length ? valuations[valuations.length - 1].value : 0,
    portfolioTwrr,
    portfolioXirr,
    blendedBenchmarkReturn: blendedOutcome,
    activeReturn,
    risk,
    rolling,
    drawdownSeries,
    performanceVsBenchmarkSeries,
    contributingBenchmarks: blend.contributingBenchmarks,
    annotations,
    inputFingerprint,
  };
}

/** Rebuild an index-level series from the blended benchmark's period returns. */
function buildBlendedBenchmarkLevels(rebalanceDates: Date[], periodReturns: number[] | undefined): SeriesPoint[] {
  if (!periodReturns || periodReturns.length === 0 || rebalanceDates.length < 2) return [];
  const out: SeriesPoint[] = [{ date: rebalanceDates[0], value: 100 }];
  let level = 100;
  for (let i = 0; i < periodReturns.length && i + 1 < rebalanceDates.length; i++) {
    level *= 1 + periodReturns[i];
    out.push({ date: rebalanceDates[i + 1], value: level });
  }
  return out;
}

/** Trim two periodic-return series to a common trailing length. */
function alignSeries(fund: number[], benchmark: number[]): { fund: number[]; benchmark: number[] } {
  if (benchmark.length === 0) return { fund, benchmark: [] };
  const n = Math.min(fund.length, benchmark.length);
  return { fund: fund.slice(fund.length - n), benchmark: benchmark.slice(benchmark.length - n) };
}

function buildDrawdownSeries(valuations: ValuationPoint[]): Array<{ date: string; value: number; drawdown: number }> {
  let peak = -Infinity;
  return valuations.map((v) => {
    peak = Math.max(peak, v.value);
    return { date: iso(v.date), value: v.value, drawdown: peak > 0 ? v.value / peak - 1 : 0 };
  });
}

/** Both sides rebased to 100 at the first common date, for a like-for-like chart. */
function buildComparisonSeries(
  valuations: ValuationPoint[],
  benchmarkLevels: SeriesPoint[]
): Array<{ date: string; portfolio: number; benchmark: number | null }> {
  if (valuations.length === 0) return [];
  const base = valuations[0].value;
  const benchBase = benchmarkLevels.length ? benchmarkLevels[0].value : null;
  return valuations.map((v) => {
    const b = benchmarkLevels.length ? valueOnOrBefore(benchmarkLevels, v.date) : undefined;
    return {
      date: iso(v.date),
      portfolio: base > 0 ? (v.value / base) * 100 : 0,
      benchmark: b && benchBase ? (b.value / benchBase) * 100 : null,
    };
  });
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Persistence mapping (spec sections 55-57). Returns rows; writes nothing.
// ---------------------------------------------------------------------------

export interface PersistableAnalyticsRow {
  user_id: string;
  scope_type: 'scheme' | 'portfolio';
  scope_id: string;
  metric_key: string;
  metric_version: string;
  engine_version: string;
  data_as_of_date: string;
  input_snapshot_version: string;
  benchmark_mapping_version: string | null;
  nav_data_version: string | null;
  benchmark_data_version: string | null;
  risk_free_version: string | null;
  quality_status: 'ok' | 'unavailable' | 'stale';
  quality_reason: string | null;
  result_value: Record<string, unknown>;
}

/**
 * Flatten a result set into ii_analytics_results rows. Unavailable metrics
 * ARE persisted (with quality_status 'unavailable' and their reason), so
 * the absence of a number is itself an auditable, reproducible fact rather
 * than a silent gap.
 */
export function toPersistableRows(userId: string, rs: AnalyticsResultSet, ds: AnalyticsDataset): PersistableAnalyticsRow[] {
  const rows: PersistableAnalyticsRow[] = [];
  const base = {
    user_id: userId,
    engine_version: rs.engineVersion,
    data_as_of_date: rs.asOfDate,
    benchmark_mapping_version: ds.benchmarkMappingVersion,
    nav_data_version: ds.navDataVersion,
    benchmark_data_version: ds.benchmarkDataVersion,
  };

  const push = (
    scope_type: 'scheme' | 'portfolio',
    scope_id: string,
    metric_key: string,
    metric_version: string,
    outcome: CalculationOutcome<unknown>,
    input_snapshot_version: string,
    risk_free_version: string | null
  ) => {
    rows.push({
      ...base,
      scope_type,
      scope_id,
      metric_key,
      metric_version,
      input_snapshot_version,
      risk_free_version,
      quality_status: toPersistedQualityStatus(outcome.status),
      quality_reason: outcome.status === 'CALCULATED' ? null : (outcome.qualityFlag ?? null),
      result_value: {
        status: outcome.status,
        value: outcome.value ?? null,
        detail: outcome.detail ?? null,
        engineReason: outcome.engineReason ?? null,
      },
    });
  };

  for (const s of rs.schemes) {
    push('scheme', s.instrumentId, 'investor_xirr', ENGINE_SUB_VERSIONS.xirr, s.investorXirr, s.inputFingerprint, null);
    push('scheme', s.instrumentId, 'scheme_active_return', ENGINE_SUB_VERSIONS.blendedBenchmark, s.activeReturn, s.inputFingerprint, null);
    for (const [horizon, outcome] of Object.entries(s.navReturns)) {
      push('scheme', s.instrumentId, `scheme_nav_return_${horizon.toLowerCase()}`, ENGINE_SUB_VERSIONS.navReturn, outcome, s.inputFingerprint, null);
    }
  }

  for (const p of rs.portfolios) {
    const rfv = p.risk.riskFree.status === 'ok' ? (p.risk.riskFree.version ?? null) : null;
    const scope = `currency:${p.currencyCode}`;
    push('portfolio', scope, 'portfolio_twrr', ENGINE_SUB_VERSIONS.twrr, p.portfolioTwrr, p.inputFingerprint, rfv);
    push('portfolio', scope, 'portfolio_xirr', ENGINE_SUB_VERSIONS.xirr, p.portfolioXirr, p.inputFingerprint, rfv);
    push('portfolio', scope, 'blended_benchmark_return', ENGINE_SUB_VERSIONS.blendedBenchmark, p.blendedBenchmarkReturn, p.inputFingerprint, rfv);
    push('portfolio', scope, 'portfolio_active_return', ENGINE_SUB_VERSIONS.blendedBenchmark, p.activeReturn, p.inputFingerprint, rfv);
    const riskMetrics: Array<[string, CalculationOutcome<unknown>]> = [
      ['volatility', p.risk.volatility],
      ['downside_deviation', p.risk.downsideDeviation],
      ['max_drawdown', p.risk.maxDrawdown],
      ['sharpe_ratio', p.risk.sharpeRatio],
      ['sortino_ratio', p.risk.sortinoRatio],
      ['beta', p.risk.beta],
      ['alpha', p.risk.alpha],
      ['tracking_error', p.risk.trackingError],
      ['information_ratio', p.risk.informationRatio],
      ['capture_ratios', p.risk.captureRatios],
      ['calmar_ratio', p.risk.calmarRatio],
    ];
    for (const [key, outcome] of riskMetrics) {
      push('portfolio', scope, key, ENGINE_SUB_VERSIONS.riskMetrics, outcome, p.inputFingerprint, rfv);
    }
    for (const h of p.rolling.horizons) {
      push('portfolio', scope, `rolling_${h.windowYears}y`, ENGINE_SUB_VERSIONS.rollingReturn, h.series, p.inputFingerprint, rfv);
      push('portfolio', scope, `rolling_${h.windowYears}y_beat_pct`, ENGINE_SUB_VERSIONS.rollingReturn, h.beat, p.inputFingerprint, rfv);
    }
  }

  return rows;
}

/**
 * Staleness check for a previously-persisted row (spec section 57). The
 * value is retained but the status becomes STALE, so the UI can disclose
 * "as previously calculated" instead of silently presenting it as current.
 */
export function applyStaleness<T>(
  outcome: CalculationOutcome<T>,
  persisted: { engineVersion: string; inputSnapshotVersion: string; createdAt: string },
  currentInputFingerprint: string
): CalculationOutcome<T> {
  if (!isStale(persisted, PERFORMANCE_ENGINE_VERSION, currentInputFingerprint)) return outcome;
  return markStale(
    outcome,
    `The underlying data or calculation method has changed since this figure was calculated on ${persisted.createdAt.slice(0, 10)}. It is shown as previously calculated and needs recalculation to be current.`
  );
}

export type { CalculationStatus };
