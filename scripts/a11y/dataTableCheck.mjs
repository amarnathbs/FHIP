// Real-browser check (Chromium; widths 1280, 1024, 768 and 390) of the shared table mechanism on the REAL components named in the
// Product Owner's 08-10-2026 table complaint. No dev server, login or database: fetch is answered from fixtures, so it can run
// anywhere and touches nothing.
//
//   node scripts/a11y/dataTableCheck.mjs                 (exit 1 on any failed check)
//   DT_SHOT=<dir> node scripts/a11y/dataTableCheck.mjs   (also writes a screenshot per page and width)
//
// Per page and width it measures:
//   * the PAGE never scrolls sideways (document.scrollWidth == viewport width),
//   * at 1024 and 1280 every table fits (its scroll region does not scroll sideways) unless the page is on the expected list
//     of tables that cannot fit (FITS_AT_1024 below says which),
//   * no cell shows more than two lines of text, and a date is never broken across lines,
//   * the scroll region is labelled and keyboard focusable, and axe-core (WCAG 2.0/2.1/2.2 A and AA) finds nothing.
// It also drives the "Show more" control by keyboard (Tab, Enter, Space) and checks that the full text was in the DOM all along.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(os.tmpdir(), 'fhip-a11y-data-table');
mkdirSync(OUT, { recursive: true });
const stub = (name) => path.join(HERE, name);

await build({
  entryPoints: [path.join(HERE, 'dataTableHarnessEntry.jsx')],
  bundle: true,
  outfile: path.join(OUT, 'bundle.js'),
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  logLevel: 'error',
  plugins: [
    {
      name: 'harness-stubs',
      setup(b) {
        b.onResolve({ filter: /^next\/link$/ }, () => ({ path: stub('stubLink.jsx') }));
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: stub('stubNavigation.js') }));
        b.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: stub('stubSupabase.js') }));
      },
    },
  ],
});
execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(ROOT, 'tailwind.config.ts'), '-i', path.join(ROOT, 'app', 'globals.css'), '-o', path.join(OUT, 'out.css')], { cwd: ROOT, stdio: 'ignore' });

const inventory = JSON.parse(readFileSync(path.join(ROOT, 'docs/investment-intelligence/bench1_phase2/inventory/inventory_prod.json'), 'utf8')).rows;
const pageHtml = (fixture) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Table harness</title><link rel="stylesheet" href="out.css"></head><body><div id="root"></div><script>window.__FIXTURE__=${JSON.stringify(fixture)}</script><script src="bundle.js"></script></body></html>`;
const fileUrl = 'file:///' + path.join(OUT, 'index.html').replace(/\\/g, '/');

// page key -> [title, region name to wait for, may the table need an inside-the-table scroll at 1024 (and why)]
const PAGES = [
  ['jobs', 'Market Index Data: Recent import jobs', 'Recent import jobs', null],
  ['entitlements', 'Market Index Data: Entitlements', 'Entitlements for NIFTY 50 TRI', null],
  // The Mappings tab (held schemes, Factsheet sources) is being reworked on branch fix/market-index-data-layout-20261008: it is rendered here
  // from THIS branch's source to show what the shared mechanism does for it on its own, and is reported, not counted.
  ['mappings', 'Market Index Data: Mappings', 'Held schemes', 'OTHER_BRANCH'],
  ['promo', 'Promo codes', 'Codes', null],
  ['reports', 'Reports', 'Generated reports', null],
  // 14 columns that the Product Owner fixed column-for-column to his own workbook: cannot fit 1024 or 1280, scrolls inside its region.
  ['holdings', 'Investment Intelligence: Holdings', 'Holdings', 'EXPECTED_SCROLL'],
];

const browser = await chromium.launch();
const failures = [];
const log = [];
let soft = false; // a page whose tables belong to another in-flight branch: reported, never fails this check
const check = (name, ok, detail = '') => {
  log.push(`${ok ? 'PASS' : soft ? 'INFO(not counted: tables owned by another branch)' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok && !soft) failures.push(name);
};

for (const [key, title, regionHint, expected] of PAGES) {
  for (const width of [1280, 1024, 768, 390]) {
    const tag = `${key} @${width}`;
    soft = expected === 'OTHER_BRANCH';
    writeFileSync(path.join(OUT, 'index.html'), pageHtml({ page: key, title, inventory }));
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(fileUrl);
    await page.getByRole('region', { name: new RegExp(regionHint) }).first().waitFor({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(250);

    check(`${tag}: no script error`, errors.length === 0, errors.join(' | '));
    const sw = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, vw: window.innerWidth }));
    check(`${tag}: the PAGE has no sideways scroll`, sw.scroll <= sw.vw, `${sw.scroll} vs ${sw.vw}`);

    const tables = await page.evaluate(() => {
      const lineCount = (el, skipButtons = false) => {
        const tops = new Set();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (!n.textContent.trim()) continue;
          if (n.parentElement.closest('.fhip-clamp-toggle')) continue; // the Show more control is not cell text
          if (skipButtons && n.parentElement.closest('button')) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          const clip = n.parentElement.closest('.fhip-clamp');
          const clipBottom = clip ? clip.getBoundingClientRect().bottom : Infinity;
          // Text that the two-line clamp hides is not a visible line.
          for (const rect of r.getClientRects()) if (rect.width > 0 && rect.height > 0 && rect.top < clipBottom - 1) tops.add(Math.round((rect.top + rect.height / 2) / 10));
        }
        return tops.size;
      };
      const brokenDates = [];
      const dateRe = /\b\d{2}-\d{2}-\d{4}\b/g;
      for (const td of document.querySelectorAll('.fhip-table td, .fhip-table th')) {
        const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          let m;
          dateRe.lastIndex = 0;
          while ((m = dateRe.exec(n.textContent))) {
            const r = document.createRange();
            r.setStart(n, m.index);
            r.setEnd(n, m.index + m[0].length);
            const tops = new Set([...r.getClientRects()].map((q) => Math.round(q.top / 4)));
            if (tops.size > 1) brokenDates.push(m[0]);
          }
        }
      }
      return {
        brokenDates,
        regions: [...document.querySelectorAll('.fhip-table-wrap')].map((w) => {
          const t = w.querySelector('table');
          const cap = w.getAttribute('aria-label');
          // Stacked action buttons are separate controls: the text of a cell is counted without them, and each button on its own.
          const cellLines = (c) => Math.max(lineCount(c, true), ...[...c.querySelectorAll('button')].map((b) => lineCount(b)), 0);
          const cells = [...t.querySelectorAll('td, th')].map((c) => ({ lines: cellLines(c), text: c.textContent.trim().slice(0, 40), kind: c.getAttribute('data-cell-kind') }));
          const worst = cells.reduce((a, c) => (c.lines > a.lines ? c : a), { lines: 0, text: '' });
          return {
            cap,
            label: w.getAttribute('aria-label'),
            focusable: w.tabIndex === 0,
            role: w.getAttribute('role'),
            fits: w.scrollWidth <= w.clientWidth + 1,
            scrollWidth: w.scrollWidth,
            clientWidth: w.clientWidth,
            worstLines: worst.lines,
            worstText: worst.text,
            cols: t.querySelectorAll('thead th').length,
            vertical: getComputedStyle(w).overflowY,
            colWidths: [...t.querySelectorAll('thead th')].map((th) => `${th.textContent.trim().slice(0, 14)}:${Math.round(th.getBoundingClientRect().width)}`).join(' '),
          };
        }),
      };
    });
    check(`${tag}: found ${tables.regions.length} table region(s)`, tables.regions.length > 0);
    check(`${tag}: no date is broken across lines`, tables.brokenDates.length === 0, tables.brokenDates.join(', '));
    for (const r of tables.regions) {
      check(`${tag}: "${r.cap}" is a labelled, keyboard-focusable region`, r.role === 'region' && !!r.label && r.focusable);
      const mustFit = width >= 1024 && expected !== 'EXPECTED_SCROLL';
      if (width >= 1024) {
        const ok = r.fits;
        if (mustFit) check(`${tag}: "${r.cap}" fits without sideways scrolling`, ok, `${r.scrollWidth} <= ${r.clientWidth}, ${r.cols} columns${ok ? '' : ' ' + r.colWidths}`);
        else log.push(`INFO  ${tag}: "${r.cap}" ${ok ? "fits" : `scrolls INSIDE its region (${r.scrollWidth} > ${r.clientWidth})`}, ${r.cols} columns`);
        if (process.env.DT_DEBUG) log.push(`      ${r.colWidths}`);
      }
      if (width >= 1024) check(`${tag}: "${r.cap}" has no cell over two lines`, r.worstLines <= 2, `worst ${r.worstLines} lines: "${r.worstText}"`);
    }

    // Keyboard: Tab onto a "Show more" control, Enter expands, Space collapses. The text is in the DOM either way.
    const toggles = await page.locator('.fhip-clamp-toggle').count();
    if (width === 1024 && toggles > 0) {
      const first = page.locator('.fhip-clamp-toggle').first();
      const controlled = await first.getAttribute('aria-controls');
      const full = await page.evaluate((id) => document.getElementById(id)?.textContent ?? '', controlled);
      check(`${tag}: the clamped text is complete in the DOM (${full.length} characters) before it is expanded`, full.length > 20);
      await first.focus();
      check(`${tag}: "Show more" is collapsed (aria-expanded=false)`, (await first.getAttribute('aria-expanded')) === 'false');
      await page.keyboard.press('Enter');
      check(`${tag}: Enter expands it (aria-expanded=true, label "Show less")`, (await first.getAttribute('aria-expanded')) === 'true' && (await first.innerText()) === 'Show less');
      const expandedLines = await page.evaluate((id) => document.getElementById(id)?.getAttribute('data-clamp-state'), controlled);
      check(`${tag}: expanded state is exposed`, expandedLines === 'expanded');
      await page.keyboard.press('Space');
      check(`${tag}: Space collapses it again`, (await first.getAttribute('aria-expanded')) === 'false');
    }
    if (width === 390) {
      const sticky = await page.evaluate(() => {
        const t = document.querySelector('.fhip-table');
        const td = t.querySelector('tbody td:first-child');
        return td ? getComputedStyle(td).position : 'none';
      });
      check(`${tag}: the first column is sticky inside the scroll region`, sticky === 'sticky', sticky);
    }

    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    check(`${tag}: axe-core finds no WCAG 2.x A/AA violation`, axe.violations.length === 0, axe.violations.map((v) => `${v.id}x${v.nodes.length}`).join(','));
    for (const v of axe.violations) log.push(`      ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);

    if (process.env.DT_SHOT) {
      mkdirSync(process.env.DT_SHOT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.DT_SHOT, `${key}-${width}.png`), fullPage: false });
    }
    await context.close();
  }
}
await browser.close();
console.log(log.join('\n'));
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
