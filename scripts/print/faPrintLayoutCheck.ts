// Real-browser check of the printed Fund analytics report (Chromium via Playwright; no dev server, login, database or secret).
//
//   npx tsx scripts/print/faPrintLayoutCheck.ts                         (exit 1 on any failed check)
//   npx tsx scripts/print/faPrintLayoutCheck.ts --fixtures funds-1,funds-4,funds-10+long
//   npx tsx scripts/print/faPrintLayoutCheck.ts --shots <dir>           (keeps the PDFs and a PNG of every page)
//
// Fixtures: SYNTHETIC reports made by the real report engine (scripts/nav2_print_fixtures.ts). For each fixture it renders the REAL
// FundAnalyticsPrintDocument the way the person's own print tab prints it (A4, the page's own @page rules decide size and margins, background
// graphics off) and measures the PDF itself: page count, how full every page is, landscape pages, row splits, small text, ISO dates, and (a
// copy printed by the Chrome COMMAND LINE with its default header and footer) none of Chrome's own date, title, address or counter.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BROWSER_HEADER_FOOTER, DEFAULT_FORBIDDEN_TEXT, evaluatePrintLayout, type PdfPageMetrics, type PrintLayoutFinding, type PrintLayoutRules } from '../../lib/reports/printLayoutRules';
import { buildPrintFixture, parseFixtureName } from '../nav2_print_fixtures';
import { analysePdf, buildAssets, launch, OUT, renderPdf, renderWithChromeDefaults } from './printLayoutLib.mjs';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fixtures = (opt('--fixtures') ?? 'funds-1,funds-4,funds-10').split(',');
const shots = opt('--shots');
const jsonOut = opt('--json');
const MIN_FILLED_NON_LAST = Number(opt('--min-filled') ?? 0.5);

const rules = (extra: Partial<PrintLayoutRules> = {}): PrintLayoutRules => ({
  minPages: 1,
  maxPages: 60,
  minFilledFrac: MIN_FILLED_NON_LAST,
  chapterStartHeadings: [],
  minFontPt: 7.4,
  rowTolerancePt: 14,
  rowPairs: [],
  marginBandMm: 21,
  forbiddenText: DEFAULT_FORBIDDEN_TEXT,
  forbiddenInMargins: [],
  requirePageNumbers: false,
  ...extra,
});

async function main() {
  const failures: string[] = [];
  const log: string[] = [];
  const summary: Record<string, unknown>[] = [];
  const browser = await launch();
  if (shots) mkdirSync(shots, { recursive: true });
  await buildAssets('printHarnessEntry.fa.jsx');
  for (const name of fixtures) {
    const { report } = buildPrintFixture(parseFixtureName(name));
    const fixture = { report, version: { versionNumber: 2, createdAt: '2026-10-19T00:38:00.000Z' }, plan: 1 };
    const printed = await renderPdf(browser, { bundle: 'printHarnessEntry.fa.bundle.js', fixture, mode: 'print', snapshot: true });
    if (printed.errors.length) failures.push(`${name}: script error ${printed.errors.join(' | ')}`);
    const pages: PdfPageMetrics[] = await analysePdf(browser, printed.pdf, { png: (shots ? Array.from({ length: 40 }, (_, i) => i + 1) : []) as unknown as never[], excludeBandMm: 21 });
    const fills = pages.map((p) => Math.round(p.filledFrac * 100));
    log.push(`INFO  ${name}: ${pages.length} pages, fill % ${fills.join(' ')}`);
    summary.push({ fixture: name, pages: pages.length, fill: fills });
    const findings: PrintLayoutFinding[] = evaluatePrintLayout(pages, rules({ requirePageNumbers: true }));
    for (const f of findings) {
      log.push(`FAIL  ${name}: [${f.rule}] ${f.detail}`);
      failures.push(`${name}: ${f.rule}`);
    }
    if (findings.length === 0) log.push(`PASS  ${name} print layout`);
    if (shots) {
      writeFileSync(path.join(shots, `${name.replace(/[^a-z0-9]+/gi, '_')}.pdf`), printed.pdf);
      pages.forEach((p) => {
        const png = (p as unknown as { png?: string }).png;
        if (png) writeFileSync(path.join(shots, `${name.replace(/[^a-z0-9]+/gi, '_')}_p${p.page}.png`), Buffer.from(png.split(',')[1], 'base64'));
      });
    }
    const cli = renderWithChromeDefaults(printed.staticHtml, `fa_${name.replace(/[^a-z0-9]+/gi, '_')}`);
    if (cli === null) log.push(`SKIP  ${name}: Chromium headless shell not found, browser header/footer check not run`);
    else {
      const cliPages: PdfPageMetrics[] = await analysePdf(browser, cli, { png: [], excludeBandMm: 21 });
      // the report's own running header carries the version line ("Version 2, made 19-10-2026, 11:08 am UTC"): it is not Chrome's date and time
      for (const cp of cliPages) cp.items = cp.items.filter((i) => !/^Version \d+, made /.test(i.str));
      const f2 = evaluatePrintLayout(cliPages, rules({ requirePageNumbers: true, forbiddenInMargins: BROWSER_HEADER_FOOTER }));
      for (const f of f2) {
        log.push(`FAIL  ${name} (Chrome command line, default header/footer): [${f.rule}] ${f.detail}`);
        failures.push(`${name} cli: ${f.rule}`);
      }
      if (f2.length === 0) log.push(`PASS  ${name} Chrome command-line print: no browser header/footer`);
    }
  }
  await browser.close();
  console.log(log.join('\n'));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 1));
  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}  (work files: ${OUT})`);
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
