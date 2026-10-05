// Layout check of the Fund analytics PDF. NOT shipped to users (a development / CI check).
//
//   npx tsx scripts/nav2_pdf_layout_check.ts [--report <report.json>] [--out <dir>] [--version <n>] [--made <iso>]
//
// It renders the print document (components/reports/FundAnalyticsPrintDocument.tsx) with the app stylesheet in headless Chromium and prints it
// through printPageToPdf(), the SAME function the export route uses (same page size, margins, running header and footer), rasterises every
// page to a PNG with PyMuPDF and judges the layout:
//   * no page except the last is more than MAX_BLANK (30%) empty below its last content;
//   * no page ends with a heading (a heading stranded from the table that follows it);
//   * every page names a fund, except the cover and the comparison page which carry their own title;
//   * nothing runs past the right margin.
// Exit code 0 = all pass, 1 = a layout failure, 2 = the check could not run (no Chromium, no PyMuPDF).
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { printPageToPdf } from '../lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';

const ROOT = path.resolve(__dirname, '..');
export const MAX_BLANK = 0.3;

export interface PageReport {
  page: number;
  blank_ratio: number;
  lines: number;
  last_line: { text: string; size: number; bold: boolean } | null;
  first_line: { text: string; size: number; bold: boolean } | null;
  funds_named: string[];
  overflow_right: string[];
  png: string;
}
export interface LayoutAnalysis {
  page_count: number;
  pages: PageReport[];
}

/** Pure: the verdict on an analysis. Exported so the unit test can prove each rule fails on a bad layout. */
export function judgeLayout(a: LayoutAnalysis, opts: { maxBlank?: number } = {}): string[] {
  const maxBlank = opts.maxBlank ?? MAX_BLANK;
  const out: string[] = [];
  a.pages.forEach((p, i) => {
    const isLast = i === a.pages.length - 1;
    if (!isLast && p.blank_ratio > maxBlank) out.push(`page ${p.page}: ${(p.blank_ratio * 100).toFixed(0)}% blank below its last content (limit ${(maxBlank * 100).toFixed(0)}%)`);
    const l = p.last_line;
    if (!isLast && l && l.bold && l.size >= 10.5) out.push(`page ${p.page}: ends with a heading ("${l.text}") stranded from what follows it`);
    const cover = i === 0;
    const titled = p.first_line && /^(Comparing your funds|Fund analytics report)/.test(p.first_line.text);
    if (!cover && !titled && p.funds_named.length === 0) out.push(`page ${p.page}: does not name a fund`);
    if (p.overflow_right.length > 0) out.push(`page ${p.page}: text runs past the margin ("${p.overflow_right[0]}")`);
  });
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const reportPath = path.resolve(ROOT, arg('--report', 'tests/fixtures/nav2/fund_analytics_report_v5.json'));
  const out = path.resolve(ROOT, arg('--out', 'test-artifacts/nav2_pdf_layout_check'));
  const version = { versionNumber: Number(arg('--version', '5')), createdAt: arg('--made', '2026-10-05T09:30:00.000Z') };
  mkdirSync(out, { recursive: true });

  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { schemes: Array<{ schemeName: string }> };
  const names = report.schemes.map((s) => s.schemeName);
  writeFileSync(path.join(out, 'fund-names.json'), JSON.stringify(names));

  // 1. the browser bundle of the print document
  await build({
    entryPoints: [path.join(ROOT, 'scripts/nav2_pdf_harness/entry.tsx')],
    bundle: true,
    outfile: path.join(out, 'bundle.js'),
    format: 'iife',
    jsx: 'automatic',
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  });
  // 2. the app stylesheet (Tailwind + app/globals.css, including the .fa-doc print rules)
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/tailwindcss/lib/cli.js'), '-i', path.join(ROOT, 'app/globals.css'), '-o', path.join(out, 'app.css'), '--minify'], { cwd: ROOT, stdio: 'pipe' });
  // 3. the page
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fund analytics report</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script>window.__REPORT__=${JSON.stringify(report).replace(/</g, '\\u003c')};window.__VERSION__=${JSON.stringify(version)};</script><script src="bundle.js"></script></body></html>`;
  writeFileSync(path.join(out, 'index.html'), html);

  // 4. the PDF, through the export route's own print function
  let pdf: Buffer;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file:///${path.join(out, 'index.html').replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
    pdf = await printPageToPdf(page, version);
  } finally {
    await browser.close();
  }
  const pdfPath = path.join(out, 'fund-analytics-report.pdf');
  writeFileSync(pdfPath, pdf);

  // 5. rasterise and measure
  let raw: string;
  try {
    raw = execFileSync('python3', [path.join(ROOT, 'scripts/nav2_pdf_layout_analyse.py'), pdfPath, path.join(out, 'png'), path.join(out, 'fund-names.json')], { encoding: 'utf8', maxBuffer: 50_000_000 });
  } catch (e) {
    console.error('PyMuPDF is not available: ', e instanceof Error ? e.message : e);
    process.exit(2);
  }
  const analysis = JSON.parse(raw) as LayoutAnalysis;
  writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(analysis, null, 1));
  console.log(`PDF: ${pdfPath} (${analysis.page_count} pages)`);
  for (const p of analysis.pages) console.log(`  page ${String(p.page).padStart(2)}: blank ${String(Math.round(p.blank_ratio * 100)).padStart(3)}%  funds: ${p.funds_named.length}  first: ${p.first_line?.text.slice(0, 40) ?? ''}  | last: ${p.last_line?.text.slice(0, 40) ?? ''}`);
  const failures = judgeLayout(analysis);
  if (failures.length > 0) {
    console.log('\nLAYOUT FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nLayout check passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) void main();
