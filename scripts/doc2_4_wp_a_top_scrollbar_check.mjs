// Document2 (4) WP-A F2 check in a REAL browser (headless Chromium via Playwright): the shared table region gets a mirrored sideways scrollbar ABOVE
// the table when the table is wider than its box, the two bars follow each other, and a table that fits gets no extra bar.
// The real components are bundled with esbuild (components/ui/DataTable.tsx + ScrollRegion.tsx) and mounted; the two CSS rules come from app/globals.css.
// Usage: node scripts/doc2_4_wp_a_top_scrollbar_check.mjs   (exit code 1 on any failed check)
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const dir = mkdtempSync(path.join(tmpdir(), 'wpa-scroll-'));
const entry = path.join(dir, 'entry.tsx');
await import('node:fs').then((fs) =>
  fs.writeFileSync(
    entry,
    `import React from 'react';
import { createRoot } from 'react-dom/client';
import { DataTable } from ${JSON.stringify(path.join(root, 'components/ui/DataTable.tsx').split(path.sep).join('/'))};
const wide = (id: string, cols: number, rows: number) => (
  <DataTable label={id} wrapperClassName="max-h-[300px]" wrapperProps={{ 'data-testid': id }}>
    <thead><tr>{Array.from({ length: cols }, (_, c) => <th key={c} style={{ minWidth: 160 }}>Col {c}</th>)}</tr></thead>
    <tbody>{Array.from({ length: rows }, (_, r) => <tr key={r}>{Array.from({ length: cols }, (_, c) => <td key={c}>{r}-{c}</td>)}</tr>)}</tbody>
  </DataTable>
);
createRoot(document.getElementById('root')!).render(<div style={{ maxWidth: 800 }}>{wide('wide', 15, 30)}{wide('narrow', 2, 3)}</div>);
`,
  ),
);
const out = path.join(dir, 'bundle.js');
await esbuild.build({ entryPoints: [entry], bundle: true, outfile: out, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, nodePaths: [path.join(root, 'node_modules')], alias: { '@': root }, logLevel: 'error' });

const globals = readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const rule = (sel) => {
  const i = globals.indexOf(sel + ' {');
  return globals.slice(i, globals.indexOf('}', i) + 1);
};
const css = [rule('.fhip-table-wrap'), rule('.fhip-table-topscroll'), '.fhip-table{width:100%}'].join('\n');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.setContent(`<style>${css}</style><div id="root"></div>`);
await page.addScriptTag({ path: out });
let failed = false;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failed = true;
};
await page.waitForSelector('[data-testid="table-top-scrollbar"]', { timeout: 5000 }).catch(() => {});
const bars = await page.$$('[data-testid="table-top-scrollbar"]');
check('exactly one top bar (the wide table only; the narrow table that fits gets none)', bars.length === 1, `(found ${bars.length})`);
const pos = await page.evaluate(() => {
  const bar = document.querySelector('[data-testid="table-top-scrollbar"]');
  const region = document.querySelector('[data-testid="wide"]');
  return { barBottom: bar.getBoundingClientRect().bottom, regionTop: region.getBoundingClientRect().top, barH: bar.getBoundingClientRect().height, regionClient: region.clientWidth, regionScroll: region.scrollWidth, barInner: bar.firstElementChild.getBoundingClientRect().width };
});
check('the bar sits directly above the table region', pos.barBottom <= pos.regionTop + 4 && pos.barH > 0, JSON.stringify(pos));
check('the bar content is as wide as the table (same scroll range)', Math.abs(pos.barInner - pos.regionScroll) < 2);
await page.evaluate(() => { document.querySelector('[data-testid="table-top-scrollbar"]').scrollLeft = 400; });
await page.waitForTimeout(150);
const a = await page.evaluate(() => document.querySelector('[data-testid="wide"]').scrollLeft);
check('moving the top bar moves the table', Math.abs(a - 400) < 2, `(table at ${a})`);
await page.evaluate(() => { document.querySelector('[data-testid="wide"]').scrollLeft = 700; });
await page.waitForTimeout(150);
const b = await page.evaluate(() => document.querySelector('[data-testid="table-top-scrollbar"]').scrollLeft);
check('moving the table moves the top bar', Math.abs(b - 700) < 2, `(top bar at ${b})`);
await page.setViewportSize({ width: 3000, height: 700 });
await page.evaluate(() => { document.getElementById('root').firstElementChild.style.maxWidth = '3000px'; });
await page.waitForTimeout(300);
const gone = await page.$$('[data-testid="table-top-scrollbar"]');
check('widening the box until the table fits removes the bar', gone.length === 0, `(found ${gone.length})`);
await browser.close();
process.exit(failed ? 1 : 0);
