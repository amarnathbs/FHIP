// Real-browser check (Chromium; widths 1280, 1024, 768 and 390) of the Income page grid: the REAL FinancialDataGrid with incomeGridConfig,
// fetch answered from an in-memory fixture (scripts/a11y/incomeGridHarnessEntry.jsx). No dev server, login or database: it touches nothing.
//
//   node scripts/a11y/incomeGridCheck.mjs                 (exit 1 on any failed check)
//   IG_SHOT=<dir> node scripts/a11y/incomeGridCheck.mjs   (also writes a screenshot per width)
//
// 1. EDIT FLOW (PO report 17-10-2026, "there is no way to edit the net salary"): on a row imported from a payslip the Edit form shows
//    Net Amount and Tax, enabled; saving a new take-home sends it; emptying the field sends null (not 0); the form is brought into view.
// 2. TAKE-HOME COLUMN: the figures, their basis labels, the amber assumed-gross highlight, the Add take-home control, the plausibility
//    hint, the footer total; and that the Expenses grid has no such column.
// 3. LAYOUT: per width the page never scrolls sideways, no cell shows more than two lines of text, the scroll region is labelled and
//    keyboard focusable, and axe-core (WCAG 2.0/2.1/2.2 A and AA) finds nothing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const OUT = path.join(os.tmpdir(), 'fhip-a11y-income-grid');
mkdirSync(OUT, { recursive: true });
const stub = (name) => path.join(HERE, name);

await build({
  entryPoints: [path.join(HERE, 'incomeGridHarnessEntry.jsx')],
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

const pageHtml = (fixture) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Income grid harness</title><link rel="stylesheet" href="out.css"></head><body><div id="root"></div><script>window.__FIXTURE__=${JSON.stringify(fixture)}</script><script src="bundle.js"></script></body></html>`;
const fileUrl = 'file:///' + path.join(OUT, 'index.html').replace(/\\/g, '/');

const browser = await chromium.launch();
const failures = [];
const log = [];
const check = (name, ok, detail = '') => {
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`${name}: section ran to the end`, false, String(e).split(/\r?\n/)[0].slice(0, 200));
  }
}

async function open(width, fixture = {}, height = 900) {
  writeFileSync(path.join(OUT, 'index.html'), pageHtml(fixture));
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(fileUrl);
  await page.getByRole('heading', { name: fixture.grid === 'expenses' ? 'Expenses' : 'Income', exact: true }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(250);
  return { page, context, errors };
}

// The input that belongs to a form field, found through its visible label (works whether or not the label is linked with htmlFor).
const fieldInput = (page, labelText) => page.locator('label', { hasText: labelText }).first().locator('xpath=following-sibling::input | following-sibling::select').first();
const rowOf = (page, name) => page.locator('.fhip-table tbody tr', { hasText: name }).first();
const calls = (page) => page.evaluate(() => window.__CALLS__);

// ---------------------------------------------------------------------------------------------------------------------------
// 1. EDIT FLOW (desktop)
// ---------------------------------------------------------------------------------------------------------------------------
await section('edit flow', async () => {
  const { page, context, errors } = await open(1280);
  await rowOf(page, 'Employment Salary').getByRole('button', { name: /^Edit/ }).click();
  const heading = page.getByRole('heading', { name: /Edit Employment Salary/ });
  await heading.waitFor({ timeout: 5000 });
  const net = fieldInput(page, 'Net Amount');
  const tax = fieldInput(page, 'Tax per period');
  check('edit/imported: the Edit form shows Net Amount on a row imported from a payslip', (await net.count()) === 1 && (await net.isVisible()));
  check('edit/imported: the Tax per period field is shown too', (await tax.count()) === 1 && (await tax.isVisible()));
  check('edit/imported: Net Amount is enabled and not read-only', (await net.isEnabled()) && !(await net.evaluate((e) => e.readOnly)));
  check('edit/imported: Net Amount starts at the imported take-home 138386.48', (await net.inputValue()) === '138386.48', await net.inputValue());
  check('edit/imported: the imported-row notice says it can still be edited', (await page.getByText(/You can still edit it here/).count()) === 1);

  await net.fill('140000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(400);
  const c1 = await calls(page);
  const save1 = c1.find((c) => c.method === 'POST' || c.method === 'PATCH');
  check('edit/imported: saving a new Net Amount sends it (140000) with the gross and frequency', !!save1 && save1.body.net_amount === 140000 && save1.body.amount === 196994.48 && save1.body.frequency === 'annually', JSON.stringify(save1?.body));
  check('edit/imported: the save does not send source_type, so the row stays "Imported from payslip"', !!save1 && !('source_type' in save1.body));
  check('edit/imported: the form closes after the save', (await heading.count()) === 0);
  check('edit/imported: the badge is still on the row after the save', (await rowOf(page, 'Employment Salary').getByText('Imported from payslip').count()) === 1);

  // Emptying the field must clear the take-home (null), never save 0 as an "entered" take-home.
  await rowOf(page, 'Employment Salary').getByRole('button', { name: /^Edit/ }).click();
  await heading.waitFor({ timeout: 5000 });
  await fieldInput(page, 'Net Amount').fill('');
  const shown = await fieldInput(page, 'Net Amount').inputValue();
  check('edit/clear: after emptying Net Amount the field stays empty (not "0")', shown === '', JSON.stringify(shown));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(400);
  const c2 = await calls(page);
  const save2 = c2.filter((c) => c.method === 'POST' || c.method === 'PATCH')[1];
  check('edit/clear: emptying Net Amount sends net_amount null (clears it), not 0', !!save2 && save2.body.net_amount === null, JSON.stringify(save2?.body?.net_amount));
  check('edit/no script error', errors.length === 0, errors.join(' | '));
  await context.close();
});

// The form must be brought into view when Edit is pressed far down the page (it renders above the table).
await section('edit visible', async () => {
for (const width of [1280, 390]) {
  const { page, context } = await open(width, { spacer: 0 }, 700);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(150);
  const edit = width >= 768 ? rowOf(page, 'Rental Income').getByRole('button', { name: /^Edit/ }) : page.locator('div.md\\:hidden >> div.rounded-card', { hasText: 'Rental Income' }).getByRole('button', { name: /^Edit/ }).first();
  await edit.scrollIntoViewIfNeeded();
  await edit.click();
  await page.getByRole('heading', { name: /Edit Rental Income/ }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(700);
  const vis = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((e) => /^Edit /.test(e.textContent ?? ''));
    const r = h.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
  });
  check(`edit/visible @${width}: after pressing Edit on a row far down the page the form heading is on screen`, vis.top >= 0 && vis.bottom <= vis.vh, JSON.stringify(vis));
  await context.close();
}
});

// ---------------------------------------------------------------------------------------------------------------------------
// 2. TAKE-HOME COLUMN (desktop table + mobile cards + footer + the other register)
// ---------------------------------------------------------------------------------------------------------------------------
await section('take-home column', async () => {
  const { page, context } = await open(1280);
  const headers = await page.locator('.fhip-table thead th').allInnerTexts();
  check('column: the Income table has a Take-home column next to Amount', headers.map((h) => h.trim().toLowerCase()).join('|').includes('amount|take-home'), headers.join('|'));
  const sal = rowOf(page, 'Employment Salary');
  check('column: Employment Salary shows the entered take-home 138,386 (138,386.48) with basis "entered"', (await sal.innerText()).includes('$138,386') && /\bentered\b/.test(await sal.innerText()));
  const bon = rowOf(page, 'Bonus');
  const bonText = await bon.innerText();
  check('column: Bonus (no take-home, no tax) shows 20,000 with "assumed = gross (no tax deducted)"', bonText.includes('assumed = gross (no tax deducted)'), bonText.replace(/\s+/g, ' '));
  const amber = (await bon.locator('[data-take-home-basis="assumed_gross"]').count()) ? await bon.locator('[data-take-home-basis="assumed_gross"]').first().evaluate((e) => getComputedStyle(e).backgroundColor) : 'none';
  check('column: the assumed-gross label is highlighted in the amber style', amber !== 'rgba(0, 0, 0, 0)' && /^rgb\((25[0-5]|2[0-4]\d), (2[0-4]\d|25[0-5]), (\d+)\)$/.test(amber) && amber.startsWith('rgb(255, 251, 235)'), amber);
  check('column: Bonus offers an "Add take-home" control', (await bon.getByRole('button', { name: /Add take-home/ }).count()) === 1);
  const oth = rowOf(page, 'Consulting side job');
  const othText = (await oth.innerText()).replace(/\s+/g, ' ');
  check('column: tax 6,000 on 20,000 shows 14,000 "from tax"', othText.includes('$14,000') && othText.includes('from tax'), othText);
  const fort = rowOf(page, 'Casual shifts');
  const fortText = (await fort.innerText()).replace(/\s+/g, ' ');
  check('column: an implausible take-home (400 on a 3,000 fortnightly gross) carries a text hint', /Check take-home: only 13% of gross/.test(fortText), fortText);
  check('column: the fortnightly row shows its own-frequency figure and the annual equivalent in text', fortText.includes('$400') && /a year|annual/i.test(fortText), fortText);
  const footer = await page.locator('text=Total take-home (annual)').count();
  check('footer: "Total take-home (annual)" is shown', footer === 1);
  const totals = (await page.locator('div.bg-gray-50').innerText()).replace(/\s+/g, ' ');
  check('footer: the existing summary items are all still there', ['Active items', 'Total annual value', 'Missing fields', 'Warnings', 'Completion'].every((t) => totals.includes(t)), totals);
  // Expected total take-home (annual): 138,386.48 + 20,000 + 14,000 + 400*26 (=10,400) + 1,800*12 (=21,600) = 204,386.48
  check('footer: total take-home is 204,386 (hand oracle 204,386.48)', totals.includes('$204,386'), totals);

  // Add take-home opens the edit form focused on Net Amount.
  await bon.getByRole('button', { name: /Add take-home/ }).click();
  await page.getByRole('heading', { name: /Edit Bonus/ }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => { const a = document.activeElement; return a ? (a.closest('div')?.querySelector('label')?.textContent ?? '') : ''; });
  check('column: "Add take-home" opens the Edit form with focus in Net Amount', /Net Amount/.test(focused), focused);
  // Live result while typing.
  const netIn = fieldInput(page, 'Net Amount');
  await netIn.fill('15000');
  const live = (await page.locator('[data-testid="income-take-home-live"]').innerText()).replace(/\s+/g, ' ');
  check('form: the live line says "Take-home = $15,000 per year (entered)" while typing', live.includes('Take-home = $15,000 per year') && live.includes('entered'), live);
  await netIn.fill('');
  await fieldInput(page, 'Tax per period').fill('6000');
  const live2 = (await page.locator('[data-testid="income-take-home-live"]').innerText()).replace(/\s+/g, ' ');
  check('form: with only tax 6,000 the live line says $14,000 per year (from tax)', live2.includes('$14,000 per year') && live2.includes('from tax'), live2);
  await fieldInput(page, 'Tax per period').fill('');
  const live3 = (await page.locator('[data-testid="income-take-home-live"]').innerText()).replace(/\s+/g, ' ');
  check('form: with neither the live line says assumed gross', live3.includes('$20,000 per year') && /assumed/i.test(live3), live3);
  check('form: the helper text is under Net Amount', (await page.getByText('Take-home pay for the same period as the gross. Leave blank to use gross minus tax; with neither, gross is treated as take-home').count()) === 1);
  await context.close();
});
await section('other register', async () => {
  const { page, context } = await open(1280, { grid: 'expenses' });
  const headers = (await page.locator('.fhip-table thead th').allInnerTexts()).map((h) => h.trim());
  check('other register: the Expenses table has no Take-home column', !headers.some((h) => /take-home/i.test(h)), headers.join('|'));
  check('other register: the Expenses footer has no take-home total', (await page.getByText('Total take-home').count()) === 0);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------
// 3. LAYOUT AND ACCESSIBILITY
// ---------------------------------------------------------------------------------------------------------------------------
await section('layout', async () => {
for (const width of [1280, 1024, 768, 390]) {
  const tag = `layout @${width}`;
  const { page, context, errors } = await open(width);
  check(`${tag}: no script error`, errors.length === 0, errors.join(' | '));
  const sw = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, vw: window.innerWidth }));
  check(`${tag}: the PAGE has no sideways scroll`, sw.scroll <= sw.vw, `${sw.scroll} vs ${sw.vw}`);
  if (width >= 768) {
    const t = await page.evaluate(() => {
      const w = document.querySelector('.fhip-table-wrap');
      const lineCount = (el) => {
        const tops = new Set();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (!n.textContent.trim() || n.parentElement.closest('button, a')) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const rect of r.getClientRects()) if (rect.width > 1 && rect.height > 1) tops.add(Math.round(rect.top + rect.height / 2));
        }
        const c = [...tops].sort((a, b) => a - b);
        return c.reduce((k, v, i) => (i === 0 || v - c[i - 1] > 8 ? k + 1 : k), 0);
      };
      const cells = [...w.querySelectorAll('tbody td')].map((c) => ({ lines: lineCount(c), text: c.textContent.trim().slice(0, 50), takeHome: !!c.querySelector('[data-testid="income-take-home"]') }));
      const spare = window.innerWidth >= 1280 ? 1 : 2;
      const over = (c) => c.lines - (c.takeHome ? spare : 0); // the Take-home cell (figure, basis label, annual equivalent, hint) may use extra lines where the table is squeezed
      const worst = cells.reduce((a, c) => (over(c) > a.lines ? { ...c, lines: over(c) } : a), { lines: 0, text: '' });
      return { label: w.getAttribute('aria-label'), focusable: w.tabIndex === 0, role: w.getAttribute('role'), fits: w.scrollWidth <= w.clientWidth + 1, sw: w.scrollWidth, cw: w.clientWidth, worst, cols: [...w.querySelectorAll('thead th')].map((th) => `${th.textContent.trim().slice(0, 12)}:${Math.round(th.getBoundingClientRect().width)}`).join(' ') };
    });
    check(`${tag}: the table region is labelled and keyboard focusable`, t.role === 'region' && !!t.label && t.focusable);
    if (width >= 1024) check(`${tag}: the table fits without sideways scrolling`, t.fits, `${t.sw} <= ${t.cw}; ${t.cols}`);
    else log.push(`INFO  ${tag}: table ${t.fits ? 'fits' : `scrolls INSIDE its region (${t.sw} > ${t.cw})`}; ${t.cols}`);
    check(`${tag}: no body cell shows more than two lines of text`, t.worst.lines <= 2, `worst ${t.worst.lines}: "${t.worst.text}"`);
  } else {
    const cards = await page.locator('div.md\\:hidden >> div.rounded-card').count();
    const cardText = (await page.locator('div.md\\:hidden >> div.rounded-card', { hasText: 'Bonus' }).first().innerText()).replace(/\s+/g, ' ');
    check(`${tag}: the mobile cards show a Take-home line with its basis (${cards} cards)`, /Take-home/.test(cardText) && cardText.includes('assumed = gross (no tax deducted)'), cardText);
    const btn = await page.locator('div.md\\:hidden >> div.rounded-card', { hasText: 'Bonus' }).first().getByRole('button', { name: /Add take-home/ }).count();
    check(`${tag}: the mobile Bonus card offers Add take-home`, btn === 1);
  }
  // The edit form open (axe covers the labelled fields too).
  const edit = width >= 768 ? rowOf(page, 'Employment Salary').getByRole('button', { name: /^Edit/ }) : page.locator('div.md\\:hidden >> div.rounded-card', { hasText: 'Employment Salary' }).first().getByRole('button', { name: /^Edit/ });
  await edit.click();
  await page.getByRole('heading', { name: /Edit Employment Salary/ }).waitFor();
  await page.waitForTimeout(300);
  const unlabelled = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), select')].filter((i) => !(i.labels && i.labels.length) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby')).map((i) => i.outerHTML.slice(0, 60)));
  check(`${tag}: every form field has an accessible name`, unlabelled.length === 0, unlabelled.slice(0, 3).join(' | '));
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  check(`${tag}: axe-core finds no WCAG 2.x A/AA violation`, axe.violations.length === 0, axe.violations.map((v) => `${v.id}x${v.nodes.length}`).join(','));
  for (const v of axe.violations) log.push(`      ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  if (process.env.IG_SHOT) {
    mkdirSync(process.env.IG_SHOT, { recursive: true });
    await page.screenshot({ path: path.join(process.env.IG_SHOT, `income-grid-form-${width}.png`), fullPage: false });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.screenshot({ path: path.join(process.env.IG_SHOT, `income-grid-${width}.png`), fullPage: false });
  }
  await context.close();
}
});

await browser.close();
console.log(log.join('\n'));
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
