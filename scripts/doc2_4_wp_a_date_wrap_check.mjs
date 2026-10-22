// Document2 (4) WP-A F1 layout check in a REAL browser (headless Chromium via Playwright). It lays out the "Fund return over trailing periods" table
// (same four columns, same cell classes and the shared .fhip-table rules) at the review widths and counts the lines each "Dates used" cell takes.
//   OLD markup  : the plain text cell the page had  -> the date range breaks at hyphens
//   NEW markup  : DatesUsed (two non-breaking dates) -> exactly 2 lines at every width, and no date is ever split
// Usage: node scripts/doc2_4_wp_a_date_wrap_check.mjs   (exit code 1 when the NEW markup fails or the OLD markup does not show the defect)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WIDTHS = [320, 360, 375, 390, 414, 768, 1280];
const css = `
  body{font-family:Arial,sans-serif;font-size:14px;margin:0;padding:0 16px}
  .fhip-table-wrap{max-width:100%;overflow-x:auto}
  .fhip-table{width:100%;font-size:0.8125rem;line-height:1.25rem;border-collapse:collapse}
  .block{display:block}.whitespace-nowrap{white-space:nowrap}
  td,th{padding:4px 12px 4px 0;vertical-align:top}.num{text-align:right;white-space:nowrap}
`;
const rows = [['1 year', '-6.63%', '-6.63%', ['17-10-2025', '16-10-2026']], ['3 year', '7.49%', '7.49%', ['19-10-2023', '16-10-2026']], ['5 year', '8.62%', '8.62%', ['19-10-2021', '16-10-2026']]];
const table = (variant) => `<div class="fhip-table-wrap"><table class="fhip-table"><thead><tr><th>Period</th><th class="num">Total return</th><th class="num">CAGR (a year)</th><th>Dates used</th></tr></thead><tbody>${rows
  .map(
    ([p, a, b, [f, t]]) =>
      `<tr><th scope="row">${p}</th><td class="num">${a}</td><td class="num">${b}</td><td class="dates">${variant === 'new' ? `<span class="block whitespace-nowrap">${f}</span><span class="block whitespace-nowrap">to ${t}</span>` : `${f} to ${t}`}</td></tr>`,
  )
  .join('')}</tbody></table></div>`;

const browser = await chromium.launch();
let failed = false;
for (const variant of ['old', 'new']) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(`<style>${css}</style>${table(variant)}`);
    const res = await page.evaluate(() => {
      const lineCount = (td) => {
        const tops = new Set();
        const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const rect of r.getClientRects()) tops.add(Math.round(rect.top));
        }
        return { lines: tops.size, text: td.textContent };
      };
      const out = [];
      for (const td of document.querySelectorAll('td.dates')) {
        out.push(lineCount(td));
      }
      const wrap = document.querySelector('.fhip-table-wrap');
      return { cells: out, pageOverflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    const maxLines = Math.max(...res.cells.map((c) => c.lines));
    console.log(`${variant.padEnd(3)} width ${String(width).padStart(4)}  lines per date cell: ${res.cells.map((c) => c.lines).join(',')}  page scrolls sideways: ${res.pageOverflow}`);
    if (variant === 'new' && (maxLines !== 2 || res.pageOverflow)) failed = true;
    await page.close();
  }
}
// the old markup must show the defect at some width, or this check proves nothing
const oldDefect = await (async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  await page.setContent(`<style>${css}</style>${table('old')}`);
  const n = await page.evaluate(() => {
    const td = document.querySelector('td.dates');
    const tops = new Set();
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const r = document.createRange();
      r.selectNodeContents(node);
      for (const rect of r.getClientRects()) tops.add(Math.round(rect.top));
    }
    return tops.size;
  });
  await page.close();
  return n;
})();
console.log(`negative control: old markup at 320 px takes ${oldDefect} lines for one date range`);
if (oldDefect <= 2) failed = true;
await browser.close();
process.exit(failed ? 1 : 0);
