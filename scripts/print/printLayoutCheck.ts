// Real-browser check of the printed report PDFs (Chromium via Playwright; no dev server, login or database).
//
//   npx tsx scripts/print/printLayoutCheck.ts                      (exit 1 on any failed check)
//   npx tsx scripts/print/printLayoutCheck.ts --report monthly     (monthly | forecast | all)
//   npx tsx scripts/print/printLayoutCheck.ts --shots <dir>        (also keeps the PDFs and PNGs of chosen pages)
//   npx tsx scripts/print/printLayoutCheck.ts --dump-metrics <file>(writes trimmed page metrics, used as the negative-control fixture)
//
// Fixtures: scripts/print/fixtures/*.fixture.json, generated from a SYNTHETIC Premium household by
// `npx vitest run --config scripts/print/vitest.print.config.ts` (the REAL report builders; invented people and amounts).
//
// For each report it renders the REAL print components (same frame as the print route) to PDF and measures, from the PDF itself:
//   * page count within the expected range, and no landscape page,
//   * no page (except the last) less than 85 percent filled,
//   * every Financial Twin row's name and value on the same page and the same line (the table was split across pages),
//   * no text under 6.5 pt, no year-first date, "Page n of N" on every page,
//   * in a copy printed by the Chrome COMMAND LINE with its default header and footer: none of Chrome's own date, title, address or counter,
//   * every chart at least 280 px wide and 120 px high at the page's text width.
// Negative control: tests/unit/reportPrintLayoutRules.test.ts judges the previous layout's recorded page metrics
// (tests/fixtures/printLayout/oldMonthlyLayout.metrics.json, made by running this script with --dump-metrics on the previous main) and requires it to FAIL.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { formatMoneyWhole } from '../../lib/engines/money';
import { twinComparisonGroups, type StoredTwinMetric } from '../../lib/reports/twinComparisonRows';
import { BROWSER_HEADER_FOOTER, DEFAULT_FORBIDDEN_TEXT, evaluatePrintLayout, type PdfPageMetrics, type PrintLayoutFinding, type PrintLayoutRules, type RowPair } from '../../lib/reports/printLayoutRules';
import { analysePdf, buildAssets, launch, OUT, readFixture, renderPdf, renderWithChromeDefaults } from './printLayoutLib.mjs';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const which = opt('--report') ?? 'all';
const shots = opt('--shots');
const dump = opt('--dump-metrics');

/** The part of a fixture the checks read (the fixtures are plain JSON). */
interface MonthlyFixture {
  sections: { sectionCode: string; sectionData: { metrics?: StoredTwinMetric[] } }[];
}

interface Kind {
  key: 'monthly' | 'forecast';
  entry: string;
  fixture: string;
  pages: [number, number];
  pairs: (fixture: MonthlyFixture) => RowPair[];
}

/** Value text exactly as the report prints it (ReportPreview's formatByMetricUnit), for the units whose text is unambiguous. */
function twinPairs(fixture: MonthlyFixture): RowPair[] {
  const twin = fixture.sections.find((s) => s.sectionCode === 'financial_twin_full');
  if (!twin) return [];
  const out: RowPair[] = [];
  for (const g of twinComparisonGroups(twin.sectionData.metrics ?? [])) {
    for (const r of g.rows) {
      if (r.userValue === null || r.unit === null) continue;
      if (r.unit === 'percentage') out.push({ label: r.label, value: `${r.userValue.toFixed(1)}%` });
      else if (r.unit === 'months') out.push({ label: r.label, value: `${r.userValue.toFixed(1)} months` });
      else if (r.unit === 'currency') out.push({ label: r.label, value: formatMoneyWhole(r.userValue, 'AUD') });
    }
  }
  return out;
}

const KINDS: Kind[] = [
  {
    key: 'monthly',
    entry: 'printHarnessEntry.jsx',
    fixture: 'monthlyReport.fixture.json',
    pages: [10, 22],
    pairs: (f) => [...twinPairs(f), { label: 'Mortgage repayment', value: '$4,000' }, { label: 'Groceries', value: '$1,100' }, { label: 'School fees', value: '$900' }],
  },
  { key: 'forecast', entry: 'printHarnessEntry.forecast.jsx', fixture: 'forecastReport.fixture.json', pages: [3, 8], pairs: () => [{ label: 'Inflation', value: '3 %' }] },
];

function rulesFor(kind: Kind, fixture: MonthlyFixture, extra: Partial<PrintLayoutRules> = {}): PrintLayoutRules {
  return {
    minPages: kind.pages[0],
    maxPages: kind.pages[1],
    minFilledFrac: 0.85,
    chapterStartHeadings: [],
    minFontPt: 6.5,
    rowTolerancePt: 14,
    rowPairs: kind.pairs(fixture),
    marginBandMm: 12,
    forbiddenText: DEFAULT_FORBIDDEN_TEXT,
    forbiddenInMargins: [],
    requirePageNumbers: false,
    ...extra,
  };
}

const failures: string[] = [];
const log: string[] = [];
function report(label: string, findings: PrintLayoutFinding[]) {
  if (findings.length === 0) log.push(`PASS  ${label}`);
  else {
    for (const f of findings) log.push(`FAIL  ${label}: [${f.rule}] ${f.detail}`);
    failures.push(label);
  }
}
function check(label: string, ok: boolean, detail = '') {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
}

async function main() {
  const browser = await launch();
  if (shots) mkdirSync(shots, { recursive: true });
  for (const kind of KINDS.filter((k) => which === 'all' || which === k.key)) {
    await buildAssets(kind.entry);
    const fixture = readFixture(kind.fixture);
    const bundle = kind.entry.replace('.jsx', '.bundle.js');

    // 1. The print path: page.pdf with the page's own @page rules.
    const printed = await renderPdf(browser, { bundle, fixture, mode: 'print', snapshot: true });
    check(`${kind.key}: no script error while rendering`, printed.errors.length === 0, printed.errors.join(' | '));
    const pages: PdfPageMetrics[] = await analysePdf(browser, printed.pdf, { png: [] });
    const summary = pages.map((p) => `${p.page}:${Math.round(p.filledFrac * 100)}%`).join(' ');
    log.push(`INFO  ${kind.key} print: ${pages.length} pages, fill ${summary}`);
    report(`${kind.key} print layout`, evaluatePrintLayout(pages, rulesFor(kind, fixture, { requirePageNumbers: true })));
    const smallCharts = (printed.charts as { w: number; h: number }[]).filter((c) => c.w < 280 || c.h < 120);
    check(`${kind.key}: every chart is at least 280 x 120 px (${printed.charts.length} charts)`, smallCharts.length === 0, smallCharts.map((c) => `${c.w}x${c.h}`).join(', '));
    if (shots) writeFileSync(path.join(shots, `${kind.key}_print.pdf`), printed.pdf);
    if (dump) {
      // Trimmed for use as a unit-test fixture: only margin text, row-pair text, the smallest text and any year-first date are kept.
      const keep = new Set<string>();
      for (const r of kind.pairs(fixture)) { keep.add(r.label); keep.add(r.value); }
      const trimmed = pages.map((p) => ({ ...p, items: p.items.filter((i) => i.y < 34 || i.y > p.heightPt - 34 || i.size < 6.6 || /\d{4}-\d{2}-\d{2}/.test(i.str) || [...keep].some((k) => i.str.includes(k))) }));
      writeFileSync(dump, JSON.stringify(trimmed));
    }

    // 2. Chrome with its DEFAULT header and footer (the Print dialog's state): none of Chrome's own text may appear.
    const cli = renderWithChromeDefaults(printed.staticHtml, `${kind.key}`);
    if (cli === null) log.push(`SKIP  ${kind.key}: Chromium headless shell not found, browser header/footer check not run`);
    else {
      const cliPages: PdfPageMetrics[] = await analysePdf(browser, cli, { png: [] });
      report(`${kind.key} Chrome command-line print with default header and footer`, evaluatePrintLayout(cliPages, rulesFor(kind, fixture, { requirePageNumbers: true, forbiddenInMargins: BROWSER_HEADER_FOOTER })));
      if (shots) writeFileSync(path.join(shots, `${kind.key}_chrome_cli.pdf`), cli);
    }

    // 3. The server-side renderer's options (fixed 18/20/14 mm margins, its own footer): must still be a clean portrait document, one footer.
    const server = await renderPdf(browser, { bundle, fixture, mode: 'server' });
    const serverPages: PdfPageMetrics[] = await analysePdf(browser, server.pdf, { png: [] });
    report(`${kind.key} server renderer options`, evaluatePrintLayout(serverPages, rulesFor(kind, fixture, { minPages: kind.pages[0], maxPages: kind.pages[1] + 6, requirePageNumbers: true, marginBandMm: 16 })));
    const doubled = serverPages.filter((p) => p.items.filter((i) => /Page \d+ of \d+/.test(i.str)).length > 1);
    check(`${kind.key}: server PDF has one page-number footer per page`, doubled.length === 0, doubled.map((p) => p.page).join(','));
    if (shots) writeFileSync(path.join(shots, `${kind.key}_server.pdf`), server.pdf);
  }
  await browser.close();

  console.log(log.join('\n'));
  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}  (work files: ${OUT})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
