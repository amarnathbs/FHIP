// PO review of Version 9 (07-10-2026): the report an ORDINARY reader gets is plain.
//   - no "Price history used" table (count / from / to / gaps per fund): one line "Prices are published by AMFI and run to DD-MM-YYYY.";
//     the audit figures stay in the stored report block and in the pinned manifest;
//   - Note 1 is ONE sentence naming the risk-free rate, Note 2 is short; the full formula and the dates of the rates used are kept in
//     `calculationNotes` (report and manifest), shown collapsed on the page and on the last page of the PDF;
//   - when no benchmark index is linked, ONE line replaces the two amber "Benchmark mapping missing" rows; the typed state stays in the data
//     and nothing is ever shown as zero.
//
// NAMED NEGATIVE CONTROLS
//   NC-W5  the old long note and the price table are gone from both renderings (a revert would put them back and fail);
//   NC-W6  with a benchmark linked the beta and alpha ROWS are still shown (the line is only for the missing case, never hiding a figure);
//   NC-W7  a report stored before this change (long Note 1, no calculationNotes) still renders, and its note pointer still resolves.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import FundAnalyticsReportView from '@/components/reports/FundAnalyticsReportView';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, type FundAnalyticsInput, type HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { BETA_ALPHA_NO_BENCHMARK_LINE, betaAlphaNoBenchmark, figuresAsAtNote, pricesRunToLine, riskFreeShortNote } from '@/lib/engines/nav2/reportWording';
import { fixtureB, weeklyDataset } from './support/riskFreeFixtures';

const B = fixtureB();
const version = { versionNumber: 9, createdAt: '2026-10-07T03:00:00.000Z' };
const scheme = (over: Partial<HeldSchemeInput> = {}): HeldSchemeInput => ({
  instrumentId: 'a', schemeName: 'Alpha Fund', planType: 'direct', optionType: 'growth', category: 'flexi_cap', categoryLabel: 'Flexi Cap',
  series: B.scheme, benchmarks: [],
  investor: { instrumentId: 'a', flows: [{ date: new Date('2025-01-06T00:00:00Z'), amount: -1000 }], valuation: { basis: 'market_nav', units: 10, marketValue: 1200, valuationDate: '2025-03-31', stale: false, nav: 120, navDate: '2025-03-31' }, asOfDate: '2025-03-31' },
  firstHeldDate: '2025-01-06', ...over,
});
const input = (schemes: HeldSchemeInput[]): FundAnalyticsInput => ({
  asOfDate: '2025-03-31', displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec('2025-03-31', NAV2_POLICY, 'all_history'), periodChoice: 'all_history',
  riskFree: weeklyDataset(6.5, { datasetVersion: 'tb-v9' }), schemes, scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
  calculatedAt: '2026-10-07T10:15:30.000Z',
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the wording helpers', () => {
  it('one plain sentence per series; the as-at note; the prices line', () => {
    expect(riskFreeShortNote({ seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD' })).toBe('Sharpe and Sortino compare each fund with the RBI 91-day Treasury bill rate (source: Reserve Bank of India).');
    expect(riskFreeShortNote({ seriesId: 'RBI_POLICY_REPO_RATE' })).toMatch(/RBI policy repo rate/);
    expect(figuresAsAtNote('01-10-2026')).toBe('Figures are as at 01-10-2026. Prices are published by AMFI. This is information, not a recommendation to buy, sell or switch.');
    expect(pricesRunToLine('01-10-2026')).toBe('Prices are published by AMFI and run to 01-10-2026.');
  });
  it('the beta/alpha line applies only when BOTH are "no benchmark mapped"; any other reason keeps its own row', () => {
    expect(betaAlphaNoBenchmark({ beta: { state: 'benchmark_missing', reason: 'no_benchmark_mapping' }, alpha: { state: 'benchmark_missing', reason: 'no_benchmark_mapping' } })).toBe(true);
    expect(betaAlphaNoBenchmark({ beta: { state: 'benchmark_missing', reason: 'no_benchmark_mapping' }, alpha: { state: 'insufficient_history' } })).toBe(false);
    expect(betaAlphaNoBenchmark({ beta: { state: 'benchmark_missing', reason: 'benchmark_not_entitled' }, alpha: { state: 'benchmark_missing', reason: 'benchmark_not_entitled' } })).toBe(false);
    expect(betaAlphaNoBenchmark({ beta: { state: 'available' }, alpha: { state: 'available' } })).toBe(false);
  });
});

describe('a new report, no benchmark linked', () => {
  const { report, manifest } = buildFundAnalyticsReport(input([scheme()]));
  const page = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report }));
  const doc = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report, version }));

  it('NC-W5: the notes are short, the price table and the long formula are gone from the body of both renderings', () => {
    expect(report.notes).toContain('Sharpe and Sortino compare each fund with the RBI 91-day Treasury bill rate (source: Reserve Bank of India).');
    expect(report.notes[report.notes.length - 1]).toBe('Figures are as at 31-03-2025. Prices are published by AMFI. This is information, not a recommendation to buy, sell or switch.');
    for (const html of [page, doc]) {
      expect(text(html)).not.toContain('Price history used');
      expect(text(html)).not.toContain('Gaps are never filled in');
      expect(text(html)).toContain('Prices are published by AMFI and run to 31-03-2025.');
    }
  });

  it('the full formula and dates are kept: in the report, in the pinned manifest, collapsed on the page and on the last page of the PDF', () => {
    expect(report.calculationNotes?.[0]).toMatch(/never interpolated/);
    expect(manifest.calculationNotes).toEqual(report.calculationNotes);
    expect(page).toContain('data-testid="how-calculated"');
    expect(page).toContain('<details');
    expect(text(page)).toContain('How this was calculated');
    const lastPage = doc.slice(doc.indexOf('fa-comparison'));
    expect(text(lastPage)).toContain('How this was calculated');
    expect(text(lastPage)).toMatch(/never interpolated/);
    expect(text(doc.slice(0, doc.indexOf('fa-fund'))).includes('never interpolated')).toBe(false); // not on the cover
  });

  it('the price-history audit figures stay in the stored report block and in the manifest (count, first and last date, gaps, checksum)', () => {
    expect(report.schemes[0].navSeriesSummary).toMatchObject({ count: B.scheme.count, firstDate: B.scheme.firstDate, lastDate: B.scheme.lastDate });
    expect(manifest.schemes[0].navSeries).toMatchObject({ count: B.scheme.count, firstDate: B.scheme.firstDate, lastDate: B.scheme.lastDate, checksum: B.scheme.checksum, materialGapCount: B.scheme.gaps.length });
  });

  it('beta and alpha: ONE plain line, no amber rows, the typed state kept in the data, never a zero', () => {
    for (const html of [page, doc]) {
      expect(text(html)).toContain(BETA_ALPHA_NO_BENCHMARK_LINE);
      expect(text(html)).not.toContain('Benchmark mapping missing');
      expect(text(html)).not.toContain('Benchmark data unavailable: no benchmark is mapped'); // no orphan footnote for rows that are not printed
      expect(text(html)).not.toMatch(/Beta[^.]{0,40}\b0(\.0+)?\b/);
    }
    const s = report.schemes[0].analytics.scheme as unknown as { beta: { state: string }; alpha: { state: string } };
    expect(s.beta.state).toBe('benchmark_missing');
    expect(s.alpha.state).toBe('benchmark_missing');
    expect('value' in s.beta).toBe(false);
  });

  it('the Sharpe and Sortino rows still point to the note and name the series in words', () => {
    expect(doc).toContain('RBI 91-day T-bill, see note 1');
  });
});

describe('NC-W6: with a benchmark linked the beta and alpha rows are still shown', () => {
  const { report } = buildFundAnalyticsReport(input([scheme({ benchmarks: B.benchmarks })]));
  it('rows present, no "not available yet" line', () => {
    const page = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report }));
    const doc = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report, version }));
    for (const html of [page, doc]) {
      expect(text(html)).toMatch(/Beta/);
      expect(text(html)).not.toContain(BETA_ALPHA_NO_BENCHMARK_LINE);
    }
  });
});

describe('NC-W7: a report stored before this change still renders', () => {
  const old = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'fixtures', 'nav2', 'fund_analytics_report_v5.json'), 'utf8'));
  it('keeps its own long note, the pointer to it, and shows no price table', () => {
    const doc = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: old, version }));
    expect(text(doc)).toContain('Note 1 Risk-free rate:');
    expect(doc).toContain('see note 1');
    expect(text(doc)).not.toContain('Price history used');
    expect(text(doc)).toContain('Prices are published by AMFI and run to 01-10-2026.');
  });
});
