// NAV2 Stage 2 -- the pure Fund analytics REPORT assembler.
//
// Matrix: Stage 2 rows S2-01 (the report is a pinned, manifest-bearing output) and S2-02 (rankings only among held schemes; compact
// stored output; the chart carries the SMAs and keeps the true last NAV; the output is deterministic).
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  the stored trend results carry no per-date points (the compact form), but keep their latest value;
//   NC-R2  the chart is bounded and never loses the last observation, and a down-sampled line still ends on the true last NAV;
//   NC-R3  a scheme with no usable history is a typed unavailable block in the report, not dropped and not zero;
//   NC-R4  the manifest checksum changes when ANY pinned input changes (series checksum, as-of date) and not otherwise;
//   NC-R5  the report text never carries a time-based return word and never an ISO date;
//   NC-R6  correlations are among held pairs only, and past the cap are skipped with a plain sentence, not computed.
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, CHART_MAX_POINTS, countStates, manifestChecksum, MAX_SCHEMES_FOR_PAIRS, type FundAnalyticsInput, type HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { allStrings, buildSeries, ISO_DATE_IN_TEXT, pathFromReturns, weekdays } from './support/fixtures';

const AS_OF = '2026-10-02';
const DATES = weekdays('2024-10-01', 520);

function navs(seed: number, n = DATES.length): number[] {
  const r: number[] = [];
  for (let i = 0; i < n - 1; i++) r.push(0.0004 + 0.01 * Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2));
  return pathFromReturns(100, r);
}

function scheme(id: string, name: string, seed: number, over: Partial<HeldSchemeInput> = {}): HeldSchemeInput {
  const dates = DATES;
  return {
    instrumentId: id,
    schemeName: name,
    planType: 'direct',
    optionType: 'growth',
    category: 'flexi_cap',
    categoryLabel: 'Flexi Cap',
    series: buildSeries(dates, navs(seed), { identity: { instrumentId: id, schemeName: name }, asOf: AS_OF }),
    benchmarks: [],
    investor: null,
    firstHeldDate: '2025-03-03',
    ...over,
  };
}

function input(schemes: HeldSchemeInput[], over: Partial<FundAnalyticsInput> = {}): FundAnalyticsInput {
  return {
    asOfDate: AS_OF,
    displayCurrency: 'INR',
    policy: NAV2_POLICY,
    spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'all_history'),
    periodChoice: 'all_history',
    riskFree: null,
    schemes,
    scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
    ...over,
  };
}

describe('buildFundAnalyticsReport', () => {
  const two = [scheme('b', 'Beta Fund', 2), scheme('a', 'Alpha Fund', 1)];
  const { report, manifest } = buildFundAnalyticsReport(input(two));

  it('orders schemes by name, one block each, with a manifest entry per scheme', () => {
    expect(report.schemes.map((s) => s.schemeName)).toEqual(['Alpha Fund', 'Beta Fund']);
    expect(manifest.schemes.map((s) => s.instrumentId)).toEqual(['a', 'b']);
    expect(manifest.schemes[0].navSeries.checksum).toBe(two[1].series.checksum);
    expect(manifest.schemes[0].navRange).toEqual({ from: two[1].series.firstDate, to: two[1].series.lastDate });
  });

  it('NC-R1: stored trend results are compact (no per-date points) but keep the latest value', () => {
    const sma50 = report.schemes[0].analytics.scheme.movingAverages.find((m) => m.result.state === 'available');
    expect(sma50).toBeDefined();
    if (sma50 && sma50.result.state === 'available') {
      expect(sma50.result.value.points).toEqual([]);
      expect(Number.isFinite(sma50.result.value.latest.value)).toBe(true);
    }
  });

  it('NC-R2: the chart is bounded, keeps the true last NAV and carries SMA 50 / 200 on the same dates', () => {
    const longDates = weekdays('2020-10-01', 1500);
    const long = scheme('l', 'Long Fund', 4, { series: buildSeries(longDates, navs(4, 1500), { identity: { instrumentId: 'l', schemeName: 'Long Fund' }, asOf: AS_OF }) });
    const b = buildFundAnalyticsReport(input([long])).report.schemes[0];
    expect(long.series.count).toBeGreaterThan(CHART_MAX_POINTS);
    expect(b.chart.navPoints.length).toBeLessThanOrEqual(CHART_MAX_POINTS);
    expect(b.chart.downsampled).toBe(true);
    const last = long.series.observations[long.series.observations.length - 1];
    expect(b.chart.navPoints[b.chart.navPoints.length - 1]).toEqual([last.date, last.value]);
    const dates = new Set(b.chart.navPoints.map((p) => p[0]));
    expect(b.chart.sma50.length).toBeGreaterThan(0);
    expect(b.chart.sma200.length).toBeGreaterThan(0);
    for (const p of [...b.chart.sma50, ...b.chart.sma200]) expect(dates.has(p[0])).toBe(true);
    expect(b.chart.sma200.length).toBeLessThanOrEqual(b.chart.sma50.length);
  });

  it('rankings are among the household schemes only and labelled so; correlations cover held pairs', () => {
    expect(report.comparison.label).toBe('Your held schemes');
    expect(report.comparison.rankings.map((r) => r.horizonId)).toEqual(['1Y', '3Y', '5Y']);
    expect(report.comparison.correlations).toHaveLength(1);
    expect(report.comparison.correlations[0]).toMatchObject({ aInstrumentId: 'a', bInstrumentId: 'b' });
  });

  it('NC-R5: no time-based-return wording and no ISO date in any report text', () => {
    const text = allStrings(report).filter((s) => !/^[0-9a-f]{64}$/.test(s));
    const visible = text.filter((s) => s.includes(' '));
    expect(JSON.stringify(report)).not.toMatch(/twrr|time[-_ ]?weighted/i);
    for (const s of visible) expect(s, s).not.toMatch(ISO_DATE_IN_TEXT);
  });

  it('is deterministic: the same input gives byte-identical output and the same checksum (matrix 45)', () => {
    const again = buildFundAnalyticsReport(input([scheme('b', 'Beta Fund', 2), scheme('a', 'Alpha Fund', 1)]));
    expect(JSON.stringify(again.report)).toBe(JSON.stringify(report));
    expect(manifestChecksum(again.manifest)).toBe(manifestChecksum(manifest));
  });

  it('state counts are the count of typed results in the report', () => {
    expect(report.stateCounts).toEqual(countStates(report));
    expect(Object.values(report.stateCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
  });
});

describe('manifest checksum (NC-R4)', () => {
  it('changes with the series checksum and the as-of date and with nothing else', () => {
    const base = buildFundAnalyticsReport(input([scheme('a', 'Alpha Fund', 1)])).manifest;
    const same = buildFundAnalyticsReport(input([scheme('a', 'Alpha Fund', 1)])).manifest;
    expect(manifestChecksum(same)).toBe(manifestChecksum(base));
    const changedSeries = buildFundAnalyticsReport(input([scheme('a', 'Alpha Fund', 3)])).manifest;
    expect(manifestChecksum(changedSeries)).not.toBe(manifestChecksum(base));
    expect(manifestChecksum({ ...base, asOfDate: '2026-10-01' })).not.toBe(manifestChecksum(base));
    expect(manifestChecksum(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('thin and missing history (NC-R3)', () => {
  it('a scheme with a few observations is a block of typed unavailable results, never dropped, never zero', () => {
    const thin = scheme('t', 'Thin Fund', 5, { series: buildSeries(DATES.slice(-5), navs(5, 5), { identity: { instrumentId: 't', schemeName: 'Thin Fund' }, asOf: AS_OF }) });
    const { report } = buildFundAnalyticsReport(input([thin, scheme('a', 'Alpha Fund', 1)]));
    const block = report.schemes.find((s) => s.instrumentId === 't')!;
    expect(block).toBeDefined();
    expect(block.analytics.scheme.sharpe?.state).not.toBe('available');
    expect(block.analytics.scheme.sharpe && 'value' in block.analytics.scheme.sharpe).toBeFalsy();
    expect(block.navSeriesSummary.count).toBe(5);
    const rank = report.comparison.rankings.find((r) => r.horizonId === '5Y')!;
    expect(rank.result.state).not.toBe('available');
  });

  it('an empty household is a valid, empty report', () => {
    const { report, manifest } = buildFundAnalyticsReport(input([]));
    expect(report.schemes).toEqual([]);
    expect(report.comparison.correlations).toEqual([]);
    expect(manifest.schemes).toEqual([]);
  });
});

describe('scope notes and caps', () => {
  it('names entity-held funds that are excluded, and price histories that could not be loaded', () => {
    const { report } = buildFundAnalyticsReport(input([scheme('a', 'Alpha Fund', 1)], { scope: { entityHeldSchemesExcluded: 2, otherInstrumentsExcluded: 1, statementLinesAwaitingReview: 1, priceHistoryUnavailable: [{ schemeName: 'Gamma Fund', reason: 'no published prices found' }] } }));
    const joined = report.notes.join(' | ');
    expect(joined).toMatch(/2 funds are held through a trust, HUF or company/);
    expect(joined).toMatch(/1 holding is not Indian mutual funds|1 holding is not/);
    expect(joined).toMatch(/1 statement line is waiting/);
    expect(joined).toMatch(/Gamma Fund could not be loaded|Price history for Gamma Fund/);
    expect(joined).toMatch(/02\/10\/2026|02-10-2026/);
  });

  it('NC-R6: more than the cap is skipped with a sentence and no pair is computed', () => {
    const many = Array.from({ length: MAX_SCHEMES_FOR_PAIRS + 1 }, (_, i) => scheme(`s${i}`, `Fund ${String(i).padStart(2, '0')}`, i + 1));
    const { report } = buildFundAnalyticsReport(input(many));
    expect(report.comparison.correlations).toEqual([]);
    expect(report.comparison.correlationsSkippedReason).toMatch(/pick fewer funds/);
  });
});
