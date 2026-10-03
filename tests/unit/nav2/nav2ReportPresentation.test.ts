// NAV2 Stage 2 -- how results are SHOWN: the fixed wording for every typed state, the labels beside a statement value /
// stale NAV, day-first dates, no number for an unavailable result, chart rows that break at gaps, and the whole report
// rendered (server-side) from real engine output.
//
// Matrix: Stage 2 rows S2-14 (every typed state has its fixed headline), S2-15 (statement value / stale NAV are labelled), S2-16 (no
// unavailable result renders as a number), S2-17 (the chart breaks at a gap), S2-18 (no time-based-return wording, no ISO date).
//
// NAMED NEGATIVE CONTROLS
//   NC-P1  an unavailable result's text is its headline and never contains a digit-like placeholder (0, 0%, 0.00, n/a-as-number);
//   NC-P2  a benchmark MAPPING gap is worded differently from other benchmark problems;
//   NC-P3  the rendered report contains the headline for each unavailable state present, and none of those cells shows a figure;
//   NC-P4  a gap inside the chart produces a break row; with the gap removed the break disappears (the break is caused by the gap).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, type FundAnalyticsInput, type HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { chartRowsWithGaps, disclosureNote, pct, ratio, rupees, showResult, unavailableHeadline } from '@/lib/engines/nav2/presentation';
import { NAV2_UNAVAILABLE_STATES, unavailable, makeProvenance, available } from '@/lib/engines/nav2/types';
import FundAnalyticsReportView from '@/components/reports/FundAnalyticsReportView';
import { allStrings, buildSeries, ctxInr, ISO_DATE_IN_TEXT, pathFromReturns, weekdays } from './support/fixtures';

const prov = () => makeProvenance(ctxInr(), 'cagr');

describe('headlines and cells', () => {
  it('matrix 55: each typed unavailable state has its fixed headline', () => {
    expect(Object.fromEntries(NAV2_UNAVAILABLE_STATES.map((s) => [s, unavailableHeadline(s)]))).toEqual({
      insufficient_history: 'Insufficient history',
      history_hydrating: 'History is being prepared',
      benchmark_missing: 'Benchmark data unavailable',
      risk_free_missing: 'Risk-free data unavailable',
      currency_mismatch: 'Currency mismatch',
      identity_unresolved: 'Fund not identified',
      data_quality_hold: 'Data under review',
      not_applicable: 'Not applicable',
    });
  });

  it('NC-P2: a missing benchmark MAPPING is worded as such; other benchmark problems are not', () => {
    expect(unavailableHeadline('benchmark_missing', 'no_benchmark_mapping')).toBe('Benchmark mapping missing');
    expect(unavailableHeadline('benchmark_missing', 'benchmark_category_reference_not_allowed')).toBe('Benchmark mapping missing');
    expect(unavailableHeadline('benchmark_missing', 'benchmark_not_entitled')).toBe('Benchmark data unavailable');
  });

  it('NC-P1 / matrix 57: an unavailable result shows its headline and the engine sentence, never a figure; no value key exists', () => {
    for (const s of NAV2_UNAVAILABLE_STATES) {
      const c = showResult(unavailable(s, 'too_few_observations', 'The engine sentence.', prov()), (v: number) => String(v));
      expect(c.available).toBe(false);
      expect(c.text).toBe(c.headline);
      expect(c.text).not.toMatch(/\d/);
      expect(c.detail).toBe('The engine sentence.');
    }
    expect(showResult(null, (v: number) => String(v)).text).toBe('Not calculated');
  });

  it('matrix 56: statement value and stale NAV disclosures are labelled; other disclosures keep their own words', () => {
    const r = available(5, prov(), [{ code: 'statement_value', detail: 'Based on your statement of 01-09-2026.' }, { code: 'stale_nav', detail: 'The latest NAV is 9 days old.' }, { code: 'short_period', detail: 'A short period.' }]);
    const c = showResult(r, (v) => String(v));
    expect(c.notes).toEqual(['Statement value: Based on your statement of 01-09-2026.', 'Stale NAV: The latest NAV is 9 days old.', 'A short period.']);
    expect(disclosureNote({ code: 'not_a_recommendation', detail: 'Plain.' })).toBe('Plain.');
  });

  it('number formats: two-decimal percentages, whole rupees, no negative zero', () => {
    expect(pct(0.12345)).toBe('12.35%');
    expect(pct(-0.000001)).toBe('0.00%');
    expect(ratio(1.2345)).toBe('1.23');
    expect(ratio(-0.0001)).toBe('0.00');
    expect(rupees(1234567)).toMatch(/12,34,567/);
  });
});

describe('chart rows (NC-P4, matrix 58)', () => {
  const chart = (gaps: Array<{ from: string; to: string; days: number }>) => ({
    navPoints: [['2026-09-01', 100], ['2026-09-02', 101], ['2026-09-20', 102], ['2026-09-21', 103]] as Array<[string, number]>,
    sma50: [['2026-09-21', 101.5]] as Array<[string, number]>,
    sma200: [] as Array<[string, number]>,
    gaps,
    downsampled: false,
  });
  it('a material gap puts an all-null row between the two points it separates', () => {
    const rows = chartRowsWithGaps(chart([{ from: '2026-09-02', to: '2026-09-20', days: 18 }]));
    expect(rows).toHaveLength(5);
    expect(rows[2]).toEqual({ date: '2026-09-02', nav: null, sma50: null, sma200: null });
    expect(rows.filter((r) => r.nav === null)).toHaveLength(1);
    expect(rows[4].sma50).toBe(101.5);
  });
  it('without the gap there is no break row (the break is caused by the gap)', () => {
    expect(chartRowsWithGaps(chart([])).filter((r) => r.nav === null)).toHaveLength(0);
  });
  it('a gap that falls across a down-sampled stretch is still honoured', () => {
    const c = chart([{ from: '2026-09-10', to: '2026-09-15', days: 5 }]);
    expect(chartRowsWithGaps(c).filter((r) => r.nav === null)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
const AS_OF = '2026-10-02';
const DATES = weekdays('2024-10-01', 520);
const navs = (seed: number): number[] => pathFromReturns(100, Array.from({ length: DATES.length - 1 }, (_, i) => 0.0004 + 0.01 * Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2)));

function scheme(id: string, name: string, over: Partial<HeldSchemeInput> = {}): HeldSchemeInput {
  return {
    instrumentId: id,
    schemeName: name,
    planType: 'direct',
    optionType: 'growth',
    category: 'flexi_cap',
    categoryLabel: 'Flexi Cap',
    series: buildSeries(DATES, navs(id.length + name.length), { identity: { instrumentId: id, schemeName: name }, asOf: AS_OF }),
    benchmarks: [],
    investor: null,
    firstHeldDate: '2025-03-03',
    ...over,
  };
}

function report(schemes: HeldSchemeInput[]) {
  const input: FundAnalyticsInput = { asOfDate: AS_OF, displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'all_history'), periodChoice: 'all_history', riskFree: null, schemes, scope: { entityHeldSchemesExcluded: 1, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] } };
  return buildFundAnalyticsReport(input).report;
}

describe('the whole report, rendered', () => {
  const hydrating = scheme('h', 'Hydrating Fund', { series: buildSeries([], [], { identity: { instrumentId: 'h', schemeName: 'Hydrating Fund' }, asOf: AS_OF, hydrating: true }) });
  const html = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report: report([scheme('a', 'Alpha Fund'), scheme('b', 'Beta Fund'), hydrating]) }));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  it('NC-P3: shows the fixed headline for each unavailable state present, and the scope note', () => {
    expect(text).toContain('History is being prepared');
    expect(text).toContain('Risk-free data unavailable');
    expect(text).toContain('Benchmark mapping missing');
    expect(text).toMatch(/1 fund is held through a trust, HUF or company/);
    expect(text).toContain('Your held schemes');
  });

  it('shows each fund as a section with the two result families kept apart and labelled', () => {
    for (const n of ['Alpha Fund', 'Beta Fund', 'Hydrating Fund']) expect(text).toContain(n);
    expect(text).toMatch(/the fund's own growth, not your personal return/);
    expect(text).toContain('Your own money in this fund');
    expect(text).toMatch(/could not be matched to it/); // no investor input in this fixture: stated, not shown as zero
  });

  it('matrix 59: no time-based-return wording and no ISO date anywhere in the rendered text', () => {
    expect(html).not.toMatch(/twrr|time[-_ ]?weighted/i);
    expect(text).not.toMatch(ISO_DATE_IN_TEXT);
    expect(allStrings(report([scheme('a', 'Alpha Fund')])).filter((s) => s.includes(' ')).some((s) => ISO_DATE_IN_TEXT.test(s))).toBe(false);
  });

  it('real tables with captions and column scopes; the pair picker is focused (two selects), not a matrix', () => {
    expect(html).toMatch(/<caption/);
    expect(html).toMatch(/scope="col"/);
    expect(html).toMatch(/scope="row"/);
    expect((html.match(/<select/g) ?? []).length).toBe(2);
    const printHtml = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report: report([scheme('a', 'Alpha Fund'), scheme('b', 'Beta Fund')]), printMode: true }));
    expect((printHtml.match(/<select/g) ?? []).length).toBe(0); // print lists the pairs instead
  });

  it('an empty report says so plainly', () => {
    const t = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report: report([]) })).replace(/<[^>]+>/g, ' ');
    expect(t).toMatch(/none could be analysed/);
  });
});
