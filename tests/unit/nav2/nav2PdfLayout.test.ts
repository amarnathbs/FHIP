// Fund analytics PDF layout (PO feedback: huge blank areas, headings stranded from their tables, a bordered card over several pages, no fund
// name on later pages, cramped tables, the same long sentence in every cell).
//
// Four layers:
//   1. the document markup rendered to static HTML from a real report (DEV Version 5, synthetic data): two sheets per fund each naming the
//      fund, the risk-free paragraph ONCE, short labels with footnotes, the version line, day-first dates;
//   2. the print stylesheet and renderer settings as a source contract (headings keep with what follows, a whole table may split, header
//      rows repeat, no card borders, running header and footer);
//   3. the layout JUDGE (scripts/nav2_pdf_layout_check.ts judgeLayout) with a NAMED NEGATIVE CONTROL per rule: a blank page, a stranded
//      heading, a page that names no fund and a runaway line each FAIL;
//   4. the REAL render: headless Chromium prints the document through the export route's own printPageToPdf, PyMuPDF measures every page.
//      Runs when Chromium and PyMuPDF are present (skipped, with the reason, otherwise); it takes about a minute.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import { pdfFooterTemplate, pdfHeaderTemplate } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';
import { FUND_ANALYTICS_SAVED_REPORT_SENTENCE } from '@/lib/engines/nav2/reportWording';
import { judgeLayout, type LayoutAnalysis, type PageReport } from '../../../scripts/nav2_pdf_layout_check';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const report = JSON.parse(read('tests/fixtures/nav2/fund_analytics_report_v5.json'));
const version = { versionNumber: 5, createdAt: '2026-10-05T03:00:00.000Z' };
const html = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report, version }));
const count = (hay: string, needle: string | RegExp) => (typeof needle === 'string' ? hay.split(needle).length - 1 : (hay.match(needle) ?? []).length);

describe('the print document markup', () => {
  it('has a cover, TWO sheets per fund each naming the fund, and a comparison page', () => {
    expect(count(html, 'class="fa-cover"')).toBe(1);
    expect(count(html, 'fa-sheet fa-fund')).toBe(report.schemes.length);
    expect(count(html, 'fa-sheet fa-sheet-b')).toBe(report.schemes.length);
    for (const s of report.schemes) {
      expect(count(html, `<h2 class="fa-fund-name">${s.schemeName}`), s.schemeName).toBe(2); // sheet A and sheet B
    }
    expect(html).toContain('(continued)');
    expect(html).toContain('Comparing your funds');
  });

  it('page 1 carries the version line and the saved-report sentence; no card borders anywhere', () => {
    expect(html).toMatch(/Version 5, made \d{2}-\d{2}-2026, \d{1,2}:\d{2} (am|pm)/);
    expect(html).toContain(FUND_ANALYTICS_SAVED_REPORT_SENTENCE);
    expect(html).not.toContain('rounded-card');
    expect(html).not.toMatch(/class="[^"]*\bborder\b/);
  });

  it('the long risk-free paragraph is printed ONCE (report note 1); each Sharpe / Sortino row only points to it', () => {
    expect(count(html, 'converted to a daily rate')).toBe(1);
    expect(html).toContain('Note 1');
    expect(count(html, 'RBI 91-day T-bill rate, see note 1')).toBeGreaterThanOrEqual(report.schemes.length * 2 - 2);
  });

  it('an unavailable cell is a short headline with a lettered footnote; the engine sentence is NOT repeated in cells', () => {
    expect(html).toContain('class="fa-mark"');
    // the explanation sentences appear only inside the footnote blocks
    const withoutFootnotes = html.replace(/<div class="fa-footnotes">[\s\S]*?<\/div>/g, '');
    expect(withoutFootnotes).not.toContain('There is no published price on or within');
    expect(withoutFootnotes).not.toContain('CAGR is shown for periods of a year or more');
    expect(withoutFootnotes).not.toContain('Prices are not published every day');
    // and each footnote text appears at most once per sheet
    for (const block of html.match(/<div class="fa-footnotes">[\s\S]*?<\/div>/g) ?? []) {
      const texts = [...block.matchAll(/<\/sup> ([^<]+)/g)].map((m) => m[1]);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it('tables use fixed column widths (colgroup) and a repeating header row; dates are day-first, never ISO', () => {
    expect(count(html, '<colgroup>')).toBeGreaterThan(report.schemes.length * 5);
    expect(count(html, '<thead>')).toBe(count(html, '<colgroup>'));
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('print stylesheet and renderer settings (source contract)', () => {
  const css = read('app/globals.css');
  const block = css.slice(css.indexOf('.fa-doc {'));
  it('headings keep with what follows; a row never splits; a WHOLE table may split with its header row repeated', () => {
    expect(block).toMatch(/\.fa-doc h3 \{[^}]*break-after: avoid/);
    expect(block).toMatch(/\.fa-doc h2\.fa-fund-name \{[^}]*break-after: avoid/);
    expect(block).toMatch(/\.fa-doc \.fa-table \{[^}]*break-inside: auto/);
    expect(block).toMatch(/\.fa-doc \.fa-table tr \{ break-inside: avoid/);
    expect(block).toMatch(/\.fa-doc \.fa-table thead \{ display: table-header-group/);
    expect(block).toMatch(/table-layout: fixed/);
  });
  it('NC-L5: no whole multi-row table or whole sheet is forced to stay together; only small blocks (a row, a chart, a footnote) are', () => {
    const avoids = [...block.matchAll(/([^{}]+)\{[^}]*break-inside: avoid/g)].map((m) => m[1].trim());
    for (const sel of avoids) expect(sel, sel).toMatch(/tr$|\.fa-chart$|\.fa-footnotes p$/);
    expect(block).not.toMatch(/\.fa-sheet[^{]*\{[^}]*break-inside: avoid/);
  });
  it('each fund and each second sheet start a new page; no card border in the document styles', () => {
    expect(block).toMatch(/\.fa-doc \.fa-fund,[\s\S]*?break-before: page/);
    expect(block).not.toMatch(/border-radius/);
  });
  it('the renderer prints A4 with equal side margins and a running header and footer', () => {
    const src = read('lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer.ts');
    expect(src).toContain("format: 'A4'");
    expect(src).toMatch(/FUND_ANALYTICS_PDF_MARGIN = \{ top: '22mm', bottom: '20mm', left: '16mm', right: '16mm' \}/);
    const header = pdfHeaderTemplate(version);
    expect(header).toContain('FHIP - Fund analytics report');
    expect(header).toMatch(/Version 5, made \d{2}-\d{2}-2026, \d{1,2}:\d{2} (am|pm)/);
    const footer = pdfFooterTemplate();
    expect(footer).toContain('FHIP - Premium report');
    expect(footer).toContain(FUND_ANALYTICS_SAVED_REPORT_SENTENCE);
    expect(footer).toContain('pageNumber');
    expect(footer).toContain('totalPages');
    expect(header + footer).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('the layout judge (NAMED NEGATIVE CONTROLS: each rule fails on a bad layout)', () => {
  const page = (n: number, over: Partial<PageReport> = {}): PageReport => ({ page: n, blank_ratio: 0.1, lines: 30, last_line: { text: 'a footnote', size: 8, bold: false }, first_line: { text: 'Fund A', size: 15, bold: true }, funds_named: ['Fund A'], overflow_right: [], png: '', ...over });
  const doc = (pages: PageReport[]): LayoutAnalysis => ({ page_count: pages.length, pages });

  it('a good layout passes', () => {
    expect(judgeLayout(doc([page(1, { funds_named: [], first_line: { text: 'Fund analytics report', size: 24, bold: true } }), page(2), page(3, { blank_ratio: 0.8 })]))).toEqual([]);
  });
  it('NC-L1: a page more than 30% blank fails (the last page of the document may be short)', () => {
    const v = judgeLayout(doc([page(1, { blank_ratio: 0.42 }), page(2, { blank_ratio: 0.9 })]));
    expect(v.some((x) => x.includes('page 1') && x.includes('blank'))).toBe(true);
    expect(v.some((x) => x.includes('page 2'))).toBe(false);
  });
  it('NC-L2: a page that ends with a heading (stranded from its table) fails', () => {
    const v = judgeLayout(doc([page(1, { last_line: { text: 'Risk and risk-adjusted measures', size: 12, bold: true } }), page(2)]));
    expect(v.some((x) => x.includes('ends with a heading'))).toBe(true);
  });
  it('NC-L3: a fund page that names no fund fails (the page after the cover, not the cover)', () => {
    const v = judgeLayout(doc([page(1, { funds_named: [], first_line: { text: 'Fund analytics report', size: 24, bold: true } }), page(2, { funds_named: [], first_line: { text: 'Risk and risk-adjusted measures', size: 12, bold: true } }), page(3)]));
    expect(v.some((x) => x.includes('page 2') && x.includes('does not name a fund'))).toBe(true);
    expect(v.some((x) => x.includes('page 1'))).toBe(false);
  });
  it('NC-L4: text past the right margin fails', () => {
    expect(judgeLayout(doc([page(1, { overflow_right: ['a very long unbroken line'] }), page(2)])).some((x) => x.includes('past the margin'))).toBe(true);
  });
});

// ---- the real render --------------------------------------------------------------------------------------------------------------
function prerequisites(): string | null {
  if (spawnSync('python3', ['-c', 'import pymupdf'], { stdio: 'ignore' }).status !== 0) return 'PyMuPDF (python3 -c "import pymupdf") is not available';
  const pw = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const home = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (!existsSync(pw) && !existsSync(home) && !process.env.PLAYWRIGHT_BROWSERS_PATH) return 'no Playwright browser is installed';
  return null;
}
const skip = prerequisites();

describe('the real PDF: rendered by Chromium through the export route\'s printPageToPdf and measured with PyMuPDF', () => {
  it.skipIf(skip !== null)(
    'every page except the last is at most 30% blank, no page ends with a stranded heading, every fund page names its fund',
    () => {
      let out = '';
      try {
        out = execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/nav2_pdf_layout_check.ts'], { cwd: ROOT, encoding: 'utf8', timeout: 280_000, maxBuffer: 20_000_000 });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        throw new Error(`layout check failed:\n${err.stdout ?? ''}\n${err.stderr ?? ''}`);
      }
      expect(out).toContain('Layout check passed.');
      const analysis = JSON.parse(readFileSync(path.join(ROOT, 'test-artifacts', 'nav2_pdf_layout_check', 'analysis.json'), 'utf8')) as LayoutAnalysis;
      // two sheets per fund plus a cover and a comparison page: the redesign aims at two pages per fund
      expect(analysis.page_count).toBe(report.schemes.length * 2 + 2);
      // every fund's sheets are on their own pages, so each fund name appears on at least two pages
      for (const s of report.schemes) expect(analysis.pages.filter((p) => p.funds_named.includes(s.schemeName)).length, s.schemeName).toBeGreaterThanOrEqual(2);
    },
    300_000
  );
  it('records why the real render was skipped, if it was', () => {
    if (skip) console.warn(`PDF layout render skipped: ${skip}`);
    expect(true).toBe(true);
  });
});
