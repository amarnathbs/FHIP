// Real-browser check (Chromium, widths 390/768/1024/1440) of the two shared pieces behind findings F6 and F13, rendered from the REAL
// components with no dev server, login or database:
//   - PageBackLink: visible, reachable by the Tab key as the first stop, visible focus outline, "Back to <parent>", no horizontal scroll,
//     44 px high; axe-core WCAG 2.x A/AA clean.
//   - DateTextField / DateInput (the Money Update "Event Date" field the PO screenshot showed with a YYYY-MM-DD placeholder):
//     placeholder DD-MM-YYYY, typing 20-08-2026 stores 2026-08-20, a month-first or year-first text is rejected (aria-invalid, state '').
//   node scripts/a11y/componentsCheck.mjs   (exit 1 on any failed check)
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
const OUT = path.join(os.tmpdir(), 'fhip-a11y-components');
mkdirSync(OUT, { recursive: true });
const stub = (n) => path.join(HERE, n);

await build({
  entryPoints: [stub('componentsHarnessEntry.jsx')],
  bundle: true,
  outfile: path.join(OUT, 'bundle.js'),
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  logLevel: 'error',
  plugins: [{ name: 'stubs', setup(b) { b.onResolve({ filter: /^next\/link$/ }, () => ({ path: stub('stubLink.jsx') })); } }],
});
execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(ROOT, 'tailwind.config.ts'), '-i', path.join(ROOT, 'app', 'globals.css'), '-o', path.join(OUT, 'out.css')], { cwd: ROOT, stdio: 'ignore' });
writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Components harness</title><link rel="stylesheet" href="out.css"></head><body><div id="root"></div><script src="bundle.js"></script></body></html>');

const browser = await chromium.launch();
const failures = [];
const log = [];
const check = (name, ok, detail = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures.push(name); };

for (const width of [390, 768, 1024, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto('file:///' + path.join(OUT, 'index.html').replace(/\\/g, '/'));
  await page.waitForSelector('[data-testid="page-back-link"]');
  const tag = `${width}px`;

  const link = page.getByTestId('page-back-link');
  check(`${tag} back link visible with text "Back to Money Updates"`, (await link.isVisible()) && (await link.innerText()).trim() === 'Back to Money Updates');
  check(`${tag} back link points at the parent`, (await link.getAttribute('href')) === '/admin/resources/money-updates');
  const box = await link.boundingBox();
  check(`${tag} back link is at least 44 px high`, box !== null && box.height >= 44, `${box?.height}`);
  await page.keyboard.press('Tab');
  check(`${tag} first Tab stop is the back link`, await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'page-back-link'));
  const outline = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }; });
  check(`${tag} back link shows a focus outline`, outline.style !== 'none' && outline.width >= 1, JSON.stringify(outline));
  check(`${tag} no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  const date = page.getByLabel('Event Date', { exact: false });
  check(`${tag} Event Date placeholder is DD-MM-YYYY (not YYYY-MM-DD)`, (await date.getAttribute('placeholder')) === 'DD-MM-YYYY');
  await date.fill('20-08-2026');
  check(`${tag} typing 20-08-2026 stores ISO 2026-08-20 in state`, (await page.getByTestId('iso-state').innerText()) === 'state:2026-08-20');
  check(`${tag} the box keeps showing 20-08-2026`, (await date.inputValue()) === '20-08-2026');
  await date.fill('08/20/2026');
  check(`${tag} month-first 08/20/2026 is rejected (state cleared, field marked invalid)`, (await page.getByTestId('iso-state').innerText()) === 'state:' && (await date.getAttribute('aria-invalid')) === 'true');
  await date.fill('2026-08-20');
  check(`${tag} year-first 2026-08-20 typed by hand is rejected too`, (await page.getByTestId('iso-state').innerText()) === 'state:' && (await date.getAttribute('aria-invalid')) === 'true');
  await date.fill('');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  check(`${tag} axe-core: no WCAG 2.x A/AA violation`, axe.violations.length === 0, axe.violations.map((v) => v.id).join(','));
  if (width === 1440 && process.env.COMPONENTS_SHOT) { await date.fill('20-08-2026'); await page.screenshot({ path: process.env.COMPONENTS_SHOT }); }
  await context.close();
}
await browser.close();
console.log(log.join('\n'));
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
