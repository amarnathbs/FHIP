// Layout check of the Fund analytics PDF from a stored report JSON or a synthetic print fixture (offline, fast). NOT shipped to users.
//
//   npx tsx scripts/nav2_pdf_layout_check.ts [--report <report.json> | --fixture funds-12+unavailable] [--out <dir>] [--version <n>] [--made <iso>]
//
// The print document (components/reports/FundAnalyticsPrintDocument.tsx) is rendered to STATIC HTML on the server side exactly as the print
// route does (no client-side script at all), styled with the app stylesheet, printed in headless Chromium through printPageToPdf(), the SAME
// function the export route uses (same page size, margins, running header and footer, same ready wait), rasterised page by page with
// PyMuPDF, and judged against the PAGE PLAN (lib/config/nav2/printLayout.ts):
//   * the summary (cover) takes at most 2 pages, then EVERY FUND starts at the top of a fresh page and uses exactly the planned number of
//     pages (never a spill onto an extra page), then the comparison is exactly ONE page and the last page;
//   * no table row is split across pages, no page ends with a heading, nothing runs past the right margin;
//   * no text under 7.5 pt (body, footnotes, chart labels) and no running header / footer text under 7 pt; no two text spans overlap;
//   * the body text is printed at its designed size: a page that shrank to fit, or grew, FAILS.
// scripts/nav2_stage3/route_pdf_check.mjs runs the same judgement through the real print route and export code. Exit code 0 = pass, 1 = layout
// failure, 2 = the check could not run (no Chromium, no PyMuPDF).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FundAnalyticsPrintDocument from '../components/reports/FundAnalyticsPrintDocument';
import { FUND_ANALYTICS_MAX_COVER_PAGES, FUND_ANALYTICS_DEFAULT_PAGES_PER_FUND, type FundPagePlan } from '../lib/config/nav2/printLayout';
import { oneFundPerPageFits, printPageToPdf } from '../lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';
import { buildPrintFixture, parseFixtureName } from './nav2_print_fixtures';

const ROOT = path.resolve(__dirname, '..');
/** A page that is not the last page of the summary may not leave more than this share empty (a summary that stops short for no reason). */
export const MAX_BLANK = 0.3;
/** The designed body size on a normal page is 9 pt (8 pt on the compact fund page); anything outside this band means the page was scaled. */
export const BODY_PT_MIN = 7.5;
export const BODY_PT_MAX = 10.5;
/** No text on a page, footnotes and chart labels included, may be set smaller than this. */
export const MIN_TEXT_PT = 7.5;
/** The running header and footer (Chromium templates) may be a little smaller, but never under this. */
export const MIN_FURNITURE_PT = 7;

export interface PageReport {
  page: number;
  blank_ratio: number;
  lines: number;
  last_line: { text: string; size: number; bold: boolean } | null;
  first_line: { text: string; size: number; bold: boolean } | null;
  funds_named: string[];
  overflow_right: string[];
  png: string;
  /** Most common font size of the page's text (pt). */
  body_size?: number | null;
  /** Pairs of text spans whose boxes overlap (a header or cell that runs into its neighbour). */
  overlaps?: string[];
  /** Smallest font size of body text (pt). */
  min_size?: number | null;
  /** Smallest font size of ANY text on the page, the running header and footer included (pt). */
  min_size_all?: number | null;
  /** The page carries the "(continued)" mark of a second fund page. */
  continued?: boolean;
  /** Table rows whose wrapped text continues at the top of this page (a row split across a page break). */
  split_rows?: string[];
}
export interface LayoutAnalysis {
  /** Table cells whose text is wider than the cell (measured in the browser at the print text width). */
  cell_overflow?: string[];
  page_count: number;
  pages: PageReport[];
  /** The fund names in report order. When present the judge also enforces the PAGE PLAN (cover, one fund per fresh page(s), one comparison page). */
  fund_names?: string[];
  /** Pages every fund must use (default: the plan in printLayout.ts). */
  pages_per_fund?: number;
}

const COMPARISON_TITLE = 'Comparing your funds';
const firstText = (p: PageReport): string => (p.first_line?.text ?? '').trim();
function startsFund(p: PageReport, name: string): boolean {
  const f = firstText(p);
  return f.length >= 8 && (name.startsWith(f) || f.startsWith(name));
}

/** The page-plan rules (see the header). Pure. */
export function judgePagePlan(a: LayoutAnalysis, maxCover = FUND_ANALYTICS_MAX_COVER_PAGES): string[] {
  const out: string[] = [];
  const names = a.fund_names ?? [];
  const perFund = a.pages_per_fund ?? FUND_ANALYTICS_DEFAULT_PAGES_PER_FUND;
  const pages = a.pages;
  const isComparison = (p: PageReport) => firstText(p).startsWith(COMPARISON_TITLE);
  let c = 0;
  while (c < pages.length && !(names.length > 0 && startsFund(pages[c], names[0])) && !isComparison(pages[c])) c += 1;
  if (c === 0) out.push('page 1 is not the summary');
  if (c > maxCover) out.push(`the summary runs over ${c} pages (at most ${maxCover})`);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (c >= pages.length || !startsFund(pages[c], name) || pages[c].continued) {
      out.push(`fund "${name}" does not start at the top of a fresh page${c < pages.length ? ` (page ${pages[c].page} begins "${firstText(pages[c]).slice(0, 40)}")` : ' (the document ended)'}`);
      let k = c;
      while (k < pages.length && !(startsFund(pages[k], name) && !pages[k].continued)) k += 1;
      if (k >= pages.length) break;
      c = k;
    }
    c += 1;
    for (let k = 1; k < perFund; k++) {
      if (c < pages.length && startsFund(pages[c], name) && pages[c].continued) c += 1;
      else out.push(`fund "${name}" uses ${k} page(s), the plan is exactly ${perFund}`);
    }
    // anything that still belongs to this fund (a spill onto an extra page) or is not the next fund / the comparison
    const next = c < pages.length ? pages[c] : null;
    if (next && !isComparison(next) && !(i + 1 < names.length && startsFund(next, names[i + 1]) && !next.continued)) {
      out.push(`fund "${name}" spills onto an extra page (page ${next.page}); it may use only ${perFund} page(s)`);
      while (c < pages.length && !isComparison(pages[c]) && !(i + 1 < names.length && startsFund(pages[c], names[i + 1]) && !pages[c].continued)) c += 1;
    }
  }
  if (names.length > 0) {
    if (c < pages.length && isComparison(pages[c])) {
      if (c + 1 < pages.length) out.push(`the comparison runs over ${pages.length - c} pages (it must be exactly one)`);
    } else out.push('the comparison page is missing or does not follow the last fund');
  }
  return out;
}

/** Pure: the verdict on an analysis. Exported so the unit test can prove each rule fails on a bad layout. */
export function judgeLayout(a: LayoutAnalysis, opts: { maxBlank?: number } = {}): string[] {
  const maxBlank = opts.maxBlank ?? MAX_BLANK;
  const out: string[] = [];
  const planned = a.fund_names !== undefined;
  if (planned) out.push(...judgePagePlan(a));
  for (const c of a.cell_overflow ?? []) out.push(`a table cell is narrower than its text and runs into its neighbour ("${c}")`);
  // the pages of the summary: every one but its last may not stop short
  const coverPages = planned ? a.pages.findIndex((p, i) => i > 0 && (startsFundAny(p, a.fund_names!) || firstText(p).startsWith(COMPARISON_TITLE))) : a.pages.length;
  const coverEnd = coverPages < 0 ? a.pages.length : coverPages;
  a.pages.forEach((p, i) => {
    const isLast = i === a.pages.length - 1;
    const blankApplies = planned ? i < coverEnd - 1 : !isLast;
    if (blankApplies && p.blank_ratio > maxBlank) out.push(`page ${p.page}: ${(p.blank_ratio * 100).toFixed(0)}% blank below its last content (limit ${(maxBlank * 100).toFixed(0)}%)`);
    const l = p.last_line;
    if (!isLast && l && l.bold && l.size >= 10) out.push(`page ${p.page}: ends with a heading ("${l.text}") stranded from what follows it`);
    const cover = i === 0;
    const titled = p.first_line && /^(Comparing your funds|Fund analytics report)/.test(p.first_line.text);
    if (!planned && !cover && !titled && p.funds_named.length === 0) out.push(`page ${p.page}: does not name a fund`);
    if (p.min_size_all !== undefined && p.min_size_all !== null && p.min_size_all < MIN_FURNITURE_PT) out.push(`page ${p.page}: running header or footer text is ${p.min_size_all} pt, below ${MIN_FURNITURE_PT} pt`);
    if (p.min_size !== undefined && p.min_size !== null && p.min_size < MIN_TEXT_PT) out.push(`page ${p.page}: the smallest text is ${p.min_size} pt, below ${MIN_TEXT_PT} pt`);
    if ((p.overlaps ?? []).length > 0) out.push(`page ${p.page}: text collides ("${p.overlaps![0]}")`);
    if ((p.split_rows ?? []).length > 0) out.push(`page ${p.page}: a table row is split across the page break ("${p.split_rows![0]}")`);
    if (p.overflow_right.length > 0) out.push(`page ${p.page}: text runs past the margin ("${p.overflow_right[0]}")`);
    if (p.lines >= 12 && p.body_size !== undefined && p.body_size !== null && (p.body_size < BODY_PT_MIN || p.body_size > BODY_PT_MAX)) out.push(`page ${p.page}: body text is ${p.body_size} pt, designed ${BODY_PT_MIN}-${BODY_PT_MAX} pt (the page was scaled)`);
  });
  return out;
}
function startsFundAny(p: PageReport, names: string[]): boolean {
  return names.some((n) => startsFund(p, n));
}

/** The browser-side measure: every th and td whose content is wider than the cell, with the page laid out at the A4 text width (178 mm), plus the body-cell texts. */
export async function measureCellOverflow(page: import('playwright').Page): Promise<string[]> {
  await page.setViewportSize({ width: 673, height: 1000 });
  await page.emulateMedia({ media: 'print' });
  return page.evaluate(() => [...document.querySelectorAll('.fa-doc th, .fa-doc td')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => (c.textContent ?? '').trim().slice(0, 40)));
}
export async function measureBodyCells(page: import('playwright').Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('.fa-doc tbody th, .fa-doc tbody td')].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 3));
}

/** Rasterises every page to PNG and measures it (PyMuPDF). Shared with the live-path check. */
export function analysePdf(pdfPath: string, pngDir: string, fundNamesJson: string): LayoutAnalysis {
  const raw = execFileSync('python3', [path.join(ROOT, 'scripts/nav2_pdf_layout_analyse.py'), pdfPath, pngDir, fundNamesJson], { encoding: 'utf8', maxBuffer: 50_000_000 });
  return JSON.parse(raw) as LayoutAnalysis;
}

export function printAnalysis(pdfPath: string, analysis: LayoutAnalysis): void {
  console.log(`PDF: ${pdfPath} (${analysis.page_count} pages)`);
  for (const p of analysis.pages) console.log(`  page ${String(p.page).padStart(2)}: blank ${String(Math.round(p.blank_ratio * 100)).padStart(3)}%  body ${p.body_size ?? '?'}pt  min ${p.min_size ?? '?'}/${p.min_size_all ?? '?'}pt  first: ${p.first_line?.text.slice(0, 36) ?? ''}  | last: ${p.last_line?.text.slice(0, 36) ?? ''}`);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const fixtureName = args.includes('--fixture') ? arg('--fixture', 'funds-4') : null;
  const reportPath = path.resolve(ROOT, arg('--report', 'tests/fixtures/nav2/fund_analytics_report_v10.json'));
  const out = path.resolve(ROOT, arg('--out', fixtureName ? `test-artifacts/nav2_pdf_layout_check_${fixtureName.replace(/[^a-z0-9]+/gi, '_')}` : 'test-artifacts/nav2_pdf_layout_check'));
  const version = { versionNumber: Number(arg('--version', '5')), createdAt: arg('--made', '2026-10-05T09:30:00.000Z') };
  mkdirSync(out, { recursive: true });

  const report = (fixtureName ? buildPrintFixture(parseFixtureName(fixtureName)).report : JSON.parse(readFileSync(reportPath, 'utf8'))) as { schemes: Array<{ schemeName: string }> };
  const names = report.schemes.map((s) => s.schemeName);

  // 1. the app stylesheet (Tailwind + app/globals.css, including the .fa-doc print rules)
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/tailwindcss/lib/cli.js'), '-i', path.join(ROOT, 'app/globals.css'), '-o', path.join(out, 'app.css'), '--minify'], { cwd: ROOT, stdio: 'pipe' });
  // 2. the page: the document rendered to static HTML, no script
  const htmlFor = (plan: FundPagePlan) => {
    const body = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: report as never, version, pagesPerFund: plan }));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fund analytics report</title><link rel="stylesheet" href="app.css"></head><body class="font-sans text-gray-900 antialiased">${body}</body></html>`;
  };
  const forced = args.includes('--plan') ? (Number(arg('--plan', '1')) as FundPagePlan) : null;
  writeFileSync(path.join(out, 'index.html'), htmlFor(forced ?? 1));
  let plan: FundPagePlan = forced ?? 1;

  // 3. the PDF, through the export route's own print function
  let pdf: Buffer;
  let cellOverflow: string[] = [];
  let cells: string[] = [];
  const t0 = Date.now();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = `file:///${path.join(out, 'index.html').replace(/\\/g, '/')}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    // the same decision the export makes: every one-page fund sheet must fit, otherwise the WHOLE report uses two pages per fund
    if (!forced && !(await oneFundPerPageFits(page))) {
      plan = 2;
      writeFileSync(path.join(out, 'index.html'), htmlFor(2));
      await page.goto(url, { waitUntil: 'networkidle' });
    }
    cellOverflow = await measureCellOverflow(page);
    cells = await measureBodyCells(page);
    pdf = await printPageToPdf(page, version);
  } finally {
    await browser.close();
  }
  const renderMs = Date.now() - t0;
  const pdfPath = path.join(out, 'fund-analytics-report.pdf');
  writeFileSync(pdfPath, pdf);
  writeFileSync(path.join(out, 'fund-names.json'), JSON.stringify({ names, cells }));

  // 4. rasterise and measure
  let analysis: LayoutAnalysis;
  try {
    analysis = analysePdf(pdfPath, path.join(out, 'png'), path.join(out, 'fund-names.json'));
  } catch (e) {
    console.error('PyMuPDF is not available: ', e instanceof Error ? e.message : e);
    process.exit(2);
  }
  analysis.cell_overflow = cellOverflow;
  analysis.fund_names = names;
  analysis.pages_per_fund = plan;
  writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(analysis, null, 1));
  printAnalysis(pdfPath, analysis);
  console.log(`plan: ${plan} page(s) per fund; render ${renderMs} ms, PDF ${Math.round(pdf.length / 1024)} KB`);
  const failures = judgeLayout(analysis);
  if (failures.length > 0) {
    console.log('\nLAYOUT FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nLayout check passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) void main();
