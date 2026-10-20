// Print layout of the report print views (PO 18-10-2026: "so much blank space and formatting is also not correct").
// The REAL measurements come from scripts/print/printLayoutCheck.ts (Chromium). These tests pin the rules that judge them, the pure helpers
// behind the fixes, and the CSS / markup contract, and carry the negative control: the previous layout's real page metrics must FAIL.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BROWSER_HEADER_FOOTER, DEFAULT_FORBIDDEN_TEXT, evaluatePrintLayout, firstContentLine, type PdfPageMetrics, type PrintLayoutRules } from '@/lib/reports/printLayoutRules';
import { chartMonthLabel } from '@/lib/reports/chartMonthLabel';
import { humaniseMetricCode, twinComparisonGroups } from '@/lib/reports/twinComparisonRows';
import { METRIC_CATALOGUE } from '@/lib/engines/twin/metricCatalogue';
import { ReportPrintFrame, reportPrintIdentity } from '@/components/reports/ReportPrintFrame';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fixture = (name: string): PdfPageMetrics[] => JSON.parse(read(`tests/fixtures/printLayout/${name}`));

const baseRules: PrintLayoutRules = {
  minPages: 10,
  maxPages: 22,
  minFilledFrac: 0.85,
  chapterStartHeadings: [],
  minFontPt: 6.5,
  rowTolerancePt: 14,
  rowPairs: [
    { label: 'Savings rate', value: '9.9%' },
    { label: 'Debt-service ratio', value: '68.3%' },
  ],
  marginBandMm: 12,
  forbiddenText: DEFAULT_FORBIDDEN_TEXT,
  forbiddenInMargins: BROWSER_HEADER_FOOTER,
  requirePageNumbers: true,
};

const page = (n: number, over: Partial<PdfPageMetrics> = {}): PdfPageMetrics => ({
  page: n,
  widthPt: 595,
  heightPt: 842,
  landscape: false,
  filledFrac: 0.97,
  items: [{ str: `Page ${n} of 3`, x: 500, y: 830, size: 7.5 }],
  ...over,
});
const footer = (n: number, total: number) => ({ str: `Page ${n} of ${total}`, x: 500, y: 830, size: 7.5 });
const rules = (over: Partial<PrintLayoutRules> = {}): PrintLayoutRules => ({ ...baseRules, minPages: 1, maxPages: 5, rowPairs: [], ...over });
const names = (f: { rule: string }[]) => [...new Set(f.map((x) => x.rule))].sort();

describe('print layout rules (pure)', () => {
  it('a clean three-page document passes', () => {
    expect(evaluatePrintLayout([page(1), page(2), page(3, { filledFrac: 0.4 })], rules())).toEqual([]);
  });

  it('page count outside the range is a finding', () => {
    expect(names(evaluatePrintLayout([page(1)], rules({ minPages: 3 })))).toContain('page-count');
    expect(names(evaluatePrintLayout([1, 2, 3, 4, 5, 6].map((n) => page(n)), rules({ maxPages: 5 })))).toContain('page-count');
  });

  it('a landscape page is a finding', () => {
    const f = evaluatePrintLayout([page(1), page(2, { landscape: true, widthPt: 842, heightPt: 595 }), page(3)], rules());
    expect(f.filter((x) => x.rule === 'landscape').map((x) => x.page)).toEqual([2]);
  });

  it('a half-empty page is a finding unless the next page starts a listed chapter; the last page may be short', () => {
    const pages = [page(1), page(2, { filledFrac: 0.5 }), page(3, { items: [{ str: 'Appendices', x: 40, y: 60, size: 12 }, footer(3, 3)] })];
    expect(names(evaluatePrintLayout(pages, rules()))).toContain('blank-space');
    expect(evaluatePrintLayout(pages, rules({ chapterStartHeadings: ['Appendices'] }))).toEqual([]);
    expect(firstContentLine(pages[2], 12)).toBe('Appendices');
  });

  it('a row whose value is on another page (or never printed) is a finding; label and value on one line pass', () => {
    const pairs = [{ label: 'Savings rate', value: '9.9%' }];
    const together = page(1, { items: [{ str: 'Savings rate', x: 40, y: 100, size: 8 }, { str: '9.9%', x: 500, y: 100, size: 8 }, footer(1, 2)] });
    expect(evaluatePrintLayout([together, page(2, { items: [footer(2, 2)] })], rules({ rowPairs: pairs }))).toEqual([]);
    const split = [
      page(1, { items: [{ str: 'Savings rate', x: 40, y: 700, size: 8 }, footer(1, 2)] }),
      page(2, { items: [{ str: '9.9%', x: 500, y: 60, size: 8 }, footer(2, 2)] }),
    ];
    expect(names(evaluatePrintLayout(split, rules({ rowPairs: pairs })))).toEqual(['row-split']);
    expect(names(evaluatePrintLayout([page(1, { items: [footer(1, 2)] }), page(2, { items: [footer(2, 2)] })], rules({ rowPairs: pairs })))).toEqual(['row-split']);
  });

  it('text under the minimum size is a finding; a two-character superscript marker is not', () => {
    const small = page(1, { items: [{ str: 'tiny caption', x: 40, y: 300, size: 5.2 }, footer(1, 1)] });
    expect(names(evaluatePrintLayout([small], rules()))).toEqual(['font-size']);
    const marker = page(1, { items: [{ str: 'x', x: 40, y: 300, size: 5.2 }, footer(1, 1)] });
    expect(evaluatePrintLayout([marker], rules())).toEqual([]);
  });

  it('a year-first date anywhere is a finding (PO rule: day-first only)', () => {
    const iso = page(1, { items: [{ str: '2026-08-01', x: 40, y: 300, size: 8 }, footer(1, 1)] });
    expect(names(evaluatePrintLayout([iso], rules()))).toEqual(['forbidden-text']);
  });

  it("Chrome's own header and footer in the margins are findings; the report's own running header is not", () => {
    const chrome = page(1, {
      items: [
        { str: '18/10/2026, 20:51', x: 20, y: 20, size: 8 },
        { str: 'FHIP | Financial Health', x: 250, y: 20, size: 8 },
        { str: 'https://app.example.test/reports/1/print', x: 20, y: 830, size: 8 },
        { str: '1/3', x: 560, y: 830, size: 8 },
        footer(1, 1),
      ],
    });
    const found = evaluatePrintLayout([chrome], rules()).filter((x) => x.rule === 'browser-header-footer');
    expect(found.map((x) => x.detail.split(' printed')[0]).sort()).toEqual(['address', 'date and time', 'page counter n/N', 'page title']);
    const own = page(1, { items: [{ str: 'Household Financial Health Report - October 2026', x: 34, y: 24, size: 7.5 }, { str: 'Confidential', x: 520, y: 24, size: 7.5 }, footer(1, 1)] });
    expect(evaluatePrintLayout([own], rules())).toEqual([]);
  });

  it('a page without "Page n of N" in its margins is a finding', () => {
    expect(names(evaluatePrintLayout([page(1, { items: [] })], rules()))).toEqual(['page-numbers']);
  });
});

describe('NEGATIVE CONTROL: the layout before the fix (real page metrics of the previous main, measured in Chromium) fails the same rules', () => {
  const old = fixture('oldMonthlyLayout.metrics.json');
  // every Financial Twin row name of the catalogue: the old layout never printed one of them
  const twinRows = METRIC_CATALOGUE.map((m) => ({ label: m.label, value: '1' }));
  const findings = evaluatePrintLayout(old, { ...baseRules, rowPairs: twinRows });
  it('was 44 pages for a household the new layout prints in 22', () => {
    expect(old).toHaveLength(44);
    expect(findings.some((f) => f.rule === 'page-count')).toBe(true);
  });
  it('had landscape pages', () => expect(findings.filter((f) => f.rule === 'landscape').length).toBeGreaterThanOrEqual(3));
  it('had half-empty pages (some under 20 percent full)', () => {
    expect(findings.filter((f) => f.rule === 'blank-space').length).toBeGreaterThan(20);
    expect(old.some((p, i) => i < old.length - 1 && p.filledFrac < 0.2)).toBe(true);
  });
  it('printed the Financial Twin table without its row names', () => {
    const rowSplits = findings.filter((f) => f.rule === 'row-split');
    expect(rowSplits.length).toBeGreaterThan(20);
  });
  it('had a year-first date, text under the minimum size and no running footer', () => {
    expect(findings.some((f) => f.rule === 'forbidden-text')).toBe(true);
    expect(findings.some((f) => f.rule === 'font-size')).toBe(true);
    expect(findings.filter((f) => f.rule === 'page-numbers')).toHaveLength(44);
  });
});

describe('the new layout (real page metrics measured in Chromium) passes every rule', () => {
  it('portrait pages within range, none under 85 percent full except the last, twin rows on one line, margins carry only the report header and "Page n of N"', () => {
    const now = fixture('newMonthlyLayout.metrics.json');
    expect(now.length).toBeGreaterThanOrEqual(10);
    expect(now.length).toBeLessThanOrEqual(22);
    expect(now.some((p) => p.items.some((i) => i.str.includes('Savings rate')))).toBe(true);
    const pairs = [
      { label: 'Savings rate', value: '9.9%' },
      { label: 'Debt-service ratio', value: '68.3%' },
      { label: 'Emergency fund', value: '9.0 months' },
    ];
    expect(evaluatePrintLayout(now, { ...baseRules, rowPairs: pairs })).toEqual([]);
  });
});

describe('the Financial Twin comparison names every row', () => {
  it('the report stores a code, not a name: the catalogue gives the label, the unit and the category', () => {
    const groups = twinComparisonGroups([
      { metricCode: 'savings_rate', userValue: 9.9, peerValue: 12, healthyMin: 10, healthyMax: 40, comparisonStatus: 'behind' },
      { metricCode: 'gross_household_income', userValue: 200000, peerValue: null, healthyMin: null, healthyMax: null, comparisonStatus: null },
    ]);
    expect(groups.map((g) => g.categoryLabel)).toEqual(['Income and Cash Flow', 'Expenses and Savings']);
    expect(groups[0].rows[0]).toMatchObject({ label: 'Gross household income', unit: 'currency' });
    expect(groups[1].rows[0]).toMatchObject({ label: 'Savings rate', unit: 'percentage' });
  });
  it('every metric of the catalogue resolves to a non-empty label and a unit (no blank row on paper)', () => {
    const groups = twinComparisonGroups(METRIC_CATALOGUE.map((m) => ({ metricCode: m.code, userValue: 1, peerValue: 1, healthyMin: null, healthyMax: null, comparisonStatus: null })));
    const rows = groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(METRIC_CATALOGUE.length);
    expect(rows.every((r) => r.label.trim().length > 0 && r.unit !== null)).toBe(true);
  });
  it('a retired code is named from the code itself and shown as a plain number, never blank', () => {
    const [g] = twinComparisonGroups([{ metricCode: 'old_metric_code', userValue: 3, peerValue: null, healthyMin: null, healthyMax: null, comparisonStatus: null }]);
    expect(g.categoryLabel).toBe('Other metrics');
    expect(g.rows[0]).toMatchObject({ label: 'Old metric code', unit: null });
    expect(humaniseMetricCode('')).toBe('Metric');
  });
  it('NEGATIVE CONTROL: the legacy mapping (label read from the stored row) yields a blank name', () => {
    const stored = { metricCode: 'savings_rate', userValue: 9.9 } as { metricCode: string; userValue: number; label?: string };
    expect(stored.label ?? '').toBe('');
    expect(twinComparisonGroups([{ ...stored, peerValue: null, healthyMin: null, healthyMax: null, comparisonStatus: null }])[0].rows[0].label).toBe('Savings rate');
  });
  it('ReportPreview builds the rows through the catalogue helper', () => {
    expect(read('components/reports/ReportPreview.tsx')).toContain('twinComparisonGroups(');
  });
});

describe('chart month labels are never year-first', () => {
  it.each([
    ['2026-08-01', 'Aug 2026'],
    ['2026-10', 'Oct 2026'],
    ['2027-01-15', 'Jan 2027'],
    ['not a month', 'not a month'],
    ['2026-13-01', '2026-13-01'],
  ])('%s -> %s', (input, expected) => {
    expect(chartMonthLabel(input)).toBe(expected);
  });
  it('the report and forecast charts use it', () => {
    expect(read('components/forecast/ForecastReportCharts.tsx')).toContain('chartMonthLabel(');
    expect((read('components/reports/ReportPreview.tsx').match(/chartMonthLabel\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the print frame', () => {
  it('fills the page on paper (no 768 px column, no padding) and carries the running-header text', () => {
    const html = renderToStaticMarkup(React.createElement(ReportPrintFrame, { identity: 'Household Financial Health Report - October 2026' }, React.createElement('p', null, 'x')));
    expect(html).toContain('print:max-w-none');
    expect(html).toContain('print:p-0');
    expect(html).toContain('--report-print-identity:&quot;Household Financial Health Report - October 2026&quot;');
    expect(html).not.toContain('@page');
  });
  it('the headless renderer path switches the page margin boxes off (it draws its own footer)', () => {
    const html = renderToStaticMarkup(React.createElement(ReportPrintFrame, { identity: 'x', serverRender: true }));
    expect(html).toContain('@page report{@top-left{content:none}');
  });
  it('the identity cannot break out of its CSS string', () => {
    expect(reportPrintIdentity('a"}</style><script>x{y};')).not.toMatch(/[<>"{};\\]/);
    expect(reportPrintIdentity('  Monthly   report ')).toBe('Monthly report');
  });
  it('both print routes use the frame, and pass serverRender for the token (headless) path', () => {
    const monthly = read('app/(print)/reports/[id]/print/page.tsx');
    const forecast = read('app/(print)/forecast/report/print/page.tsx');
    expect(monthly).toContain('<ReportPrintFrame');
    expect(monthly).toContain('serverRender={Boolean(token)}');
    expect(forecast).toMatch(/<ReportPrintFrame identity="Consolidated Forecasting Report" serverRender>/);
    expect(monthly).not.toContain('mx-auto max-w-3xl p-6');
  });
});

describe('print stylesheet contract (app/globals.css)', () => {
  const css = read('app/globals.css');
  it('defines the named page `report` with a header box AND a footer box (that is what makes Chrome leave its own header and footer out)', () => {
    const start = css.indexOf('@page report');
    const block = css.slice(start, css.indexOf('.report-print-root {', start));
    expect(block).toMatch(/size:\s*A4 portrait/);
    expect(block).toMatch(/margin:\s*13mm 12mm 12mm 12mm/);
    expect(block).toMatch(/@top-left/);
    expect(block).toMatch(/@bottom-right[\s\S]*counter\(page\)[\s\S]*counter\(pages\)/);
    expect(block).toContain('var(--report-print-identity');
  });
  it('the report root uses that page, prints backgrounds, and is portrait only', () => {
    expect(css).toMatch(/\.report-print-root\s*\{[^}]*page:\s*report/);
    expect(css).toMatch(/\.report-print-root \*\s*\{[^}]*print-color-adjust:\s*exact/);
    expect(css).not.toMatch(/A4 landscape/);
  });
  it('no card is kept whole by default, no chapter forces a page break, tables fit the page and repeat their header', () => {
    expect(css).toMatch(/\.report-print-root \.report-section\s*\{\s*break-inside:\s*auto/);
    expect(css).not.toMatch(/\.report-page-break\s*\{/);
    expect(css).not.toMatch(/\.report-chapter-break\s*\{/);
    expect(css).toMatch(/\.report-print-root table\s*\{[^}]*min-width:\s*0 !important/);
    expect(css).toMatch(/\.report-print-root thead\s*\{\s*display:\s*table-header-group/);
    expect(css).toMatch(/\.report-print-root tr\s*\{[^}]*break-inside:\s*avoid/);
  });
  it('leaves the Net Worth Statement rules alone', () => {
    expect(css).toMatch(/@page nws\s*\{\s*size:\s*A4;\s*margin:\s*10mm 12mm;/);
    expect(css).toMatch(/\.nws-root\s*\{\s*page:\s*nws;/);
  });
  it('no component still forces a page break per chapter, and the report type scale never goes under 7 pt', () => {
    for (const f of ['components/reports/ReportPreview.tsx', 'components/forecast/ForecastReportContent.tsx']) {
      expect(read(f)).not.toMatch(/className="[^"]*report-page-break/);
      expect(read(f)).not.toMatch(/report-chapter-break/);
    }
    const start = css.indexOf('Type scale for paper');
    const sizes = [...css.slice(start, css.indexOf('Flat sections', start)).matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(3);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(7);
  });
  it('the forecast report shows its dates day-first', () => {
    const src = read('components/forecast/ForecastReportContent.tsx');
    expect(src).toContain('formatDateShort(data.comparisonDate, currency)');
    expect(src).not.toContain('Comparison date: ${data.comparisonDate}');
  });
});
