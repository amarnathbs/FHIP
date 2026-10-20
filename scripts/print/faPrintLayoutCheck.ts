// Real-browser check of the printed Fund analytics report (Chromium via Playwright; no dev server, login, database or secret).
//
//   npx tsx scripts/print/faPrintLayoutCheck.ts                         (exit 1 on any failed check)
//   npx tsx scripts/print/faPrintLayoutCheck.ts --fixtures funds-1,funds-4,funds-10+long
//   npx tsx scripts/print/faPrintLayoutCheck.ts --shots <dir>           (keeps the PDFs and a PNG of every page)
//   npx tsx scripts/print/faPrintLayoutCheck.ts --combined funds-10,funds-7   (ONE document of several reports, as /reports/fund-analytics/print?ids=a,b prints it:
//                                                                              checks the page numbers run 1..N across the reports, each page's own report version
//                                                                              in the header, the explanation line once, and where each report starts)
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
const combined = opt('--combined');
const prodNotes = args.includes('--prod-notes');
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

/** A fixture report made a DIFFERENT set of funds (ids and names), as a second batch is: the fixture generator names funds the same way every time. */
function asOtherBatch(report: ReturnType<typeof buildPrintFixture>['report'], tag: string) {
  const json = report.schemes.reduce((j, s) => j.split(s.instrumentId).join(`${tag}-${s.instrumentId}`), JSON.stringify(report));
  return JSON.parse(json.split('"schemeName":"').join(`"schemeName":"${tag} `)) as typeof report;
}

/** The combined document: several fixtures rendered as ONE print job, then measured as one PDF. */
async function checkCombined(spec: string, browser: Awaited<ReturnType<typeof launch>>, failures: string[], log: string[], summary: Record<string, unknown>[]) {
  const names = spec.split(',');
  const parts = names.map((n, i) => {
    const { report } = buildPrintFixture(parseFixtureName(n));
    const r = i === 0 ? report : asOtherBatch(report, `B${i + 1}`);
    // --prod-notes: the notes a production report of a household that holds 17 funds carries (statement lines waiting, "covers X of your Y funds"), so the front section is measured with a realistic notes block
    const held = names.reduce((t, n) => t + parseFixtureName(n).funds, 0);
    if (prodNotes) r.notes = ['3 statement lines are waiting for a review decision and are not shown here yet.', ...r.notes.slice(0, -1), `This report covers ${r.schemes.length} of your ${held} Indian mutual funds, as you chose. The others can go in a second report.`, r.notes[r.notes.length - 1]];
    return { report: r, version: { versionNumber: 4 + i, createdAt: `2026-10-19T00:${38 + i}:00.000Z` } };
  });
  const label = `combined(${names.join(' + ')})`;
  const printed = await renderPdf(browser, { bundle: 'printHarnessEntry.fa.bundle.js', fixture: { parts, plan: 1 }, mode: 'print' });
  if (printed.errors.length) failures.push(`${label}: script error ${printed.errors.join(' | ')}`);
  const pages: PdfPageMetrics[] = await analysePdf(browser, printed.pdf, { png: (shots ? Array.from({ length: 80 }, (_, i) => i + 1) : []) as unknown as never[], excludeBandMm: 21 });
  const fills = pages.map((p) => Math.round(p.filledFrac * 100));
  log.push(`INFO  ${label}: ${pages.length} pages, fill % ${fills.join(' ')}`);
  // the page's running header names its section: the front section "Versions 4 and 5", then each report's own "Version n, made ..."
  const topBand = (p: PdfPageMetrics) => p.items.filter((i) => i.y < 21 * 2.835).map((i) => i.str).join(' ');
  const sectionOf = (p: PdfPageMetrics): number => {
    const t = topBand(p);
    if (/Versions \d/.test(t)) return 0;
    const m = /Version (\d+),/.exec(t);
    return m ? Number(m[1]) - 3 : -1; // report number, 1-based
  };
  const sections = pages.map(sectionOf);
  const starts = names.map((_, i) => sections.indexOf(i + 1) + 1); // first page of each report's fund pages
  const frontPages = sections.filter((x) => x === 0).length;
  log.push(`INFO  ${label}: front section = pages 1-${frontPages}; reports' fund pages start on pages ${starts.join(', ')}`);
  // the last page of the FRONT section may be short: a front section longer than one page (more funds, long fund names, many notes) ends on a partial page before the
  // reports' fund pages start on a fresh page. It is reported as INFO with its fill, not hidden, and not counted as a failure.
  const allFindings = evaluatePrintLayout(pages, rules({ requirePageNumbers: true }));
  const findings = allFindings.filter((f) => !(f.rule === 'blank-space' && f.page === frontPages && frontPages > 1));
  if (findings.length !== allFindings.length) log.push(`INFO  ${label}: the front section is ${frontPages} pages; its last page is ${Math.round(pages[frontPages - 1].filledFrac * 100)}% full (a front longer than one page ends on a partial page)`);
  for (const f of findings) {
    log.push(`FAIL  ${label}: [${f.rule}] ${f.detail}`);
    failures.push(`${label}: ${f.rule}`);
  }
  if (findings.length === 0) log.push(`PASS  ${label} print layout (page numbers "Page n of ${pages.length}" run 1 to ${pages.length} across all sections)`);
  const monotone = sections.every((x, i) => i === 0 || x >= sections[i - 1]) && sections[0] === 0 && starts.every((x) => x > 0);
  if (monotone) log.push(`PASS  ${label} every page header names its own section's version (front, then report 1, 2, ...), in order`);
  else {
    log.push(`FAIL  ${label}: page headers by section are ${sections.join(',')}`);
    failures.push(`${label}: headers`);
  }
  const textOf = (p: PdfPageMetrics) => p.items.map((i) => i.str).join(' ');
  const countPages = (needle: string) => pages.filter((p) => textOf(p).includes(needle)).map((p) => p.page);
  const introPages = countPages('This document combines');
  if (introPages.length === 1 && introPages[0] === 1) log.push(`PASS  ${label} the explanation line is on page 1 only`);
  else {
    log.push(`FAIL  ${label}: explanation line on pages ${introPages.join(', ') || 'none'}`);
    failures.push(`${label}: intro`);
  }
  const glance = countPages('All your funds at a glance');
  const oldGlance = pages.filter((p) => /(^|[^l] )Your funds at a glance/.test(textOf(p)) || textOf(p).includes('Your funds at a glance') && !textOf(p).includes('All your funds at a glance')).map((p) => p.page);
  if (glance.length === 1 && glance[0] === 1 && oldGlance.length === 0) log.push(`PASS  ${label} ONE "All your funds at a glance" table on page 1, no per-report "Your funds at a glance"`);
  else {
    log.push(`FAIL  ${label}: "All your funds at a glance" on pages ${glance.join(', ')}; old per-report block on pages ${oldGlance.join(', ')}`);
    failures.push(`${label}: summary`);
  }
  const howTo = countPages('How to read this report');
  const notesH = countPages('Notes');
  log.push(`INFO  ${label}: "How to read this report" on pages ${howTo.join(', ')}; "How this was calculated" on pages ${countPages('How this was calculated').join(', ') || 'none'}`);
  if (howTo.length !== 1) {
    log.push(`FAIL  ${label}: "How to read this report" printed ${howTo.length} times`);
    failures.push(`${label}: how-to`);
  }
  void notesH;
  // each report's fund pages begin on a fresh page; the last page of the section before may end early, that is the price of a fresh start
  for (const s of starts) log.push(`INFO  ${label}: page ${s - 1} (last page before the section starting on page ${s}) is ${Math.round(pages[s - 2].filledFrac * 100)}% full`);
  summary.push({ combined: names, pages: pages.length, fill: fills, starts });
  if (shots) {
    const base = `combined_${names.join('_').replace(/[^a-z0-9]+/gi, '_')}`;
    writeFileSync(path.join(shots, `${base}.pdf`), printed.pdf);
    pages.forEach((p) => {
      const png = (p as unknown as { png?: string }).png;
      if (png) writeFileSync(path.join(shots, `${base}_p${p.page}.png`), Buffer.from(png.split(',')[1], 'base64'));
    });
  }
}

async function main() {
  const failures: string[] = [];
  const log: string[] = [];
  const summary: Record<string, unknown>[] = [];
  const browser = await launch();
  if (shots) mkdirSync(shots, { recursive: true });
  await buildAssets('printHarnessEntry.fa.jsx');
  if (combined) {
    await checkCombined(combined, browser, failures, log, summary);
    await browser.close();
    console.log(log.join('\n'));
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 1));
    console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}  (work files: ${OUT})`);
    process.exit(failures.length === 0 ? 0 : 1);
  }
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
