// axe-core scan of the SHARED sidebar (components/ui/AppShell.tsx), user and Admin, desktop and phone width.
//
//   node scripts/a11y/sidebarAxe.mjs            # exit 1 when any WCAG 2.x A/AA violation is found
//
// How it works: esbuild bundles the real AppShell with the Next router/Link and the Supabase browser client stubbed
// (scripts/a11y/stub*.js*), Tailwind compiles the real stylesheet from the repository config, and Playwright's Chromium
// renders it with @axe-core/playwright. No dev server, no login, no database, no network: it can run anywhere and touches nothing.
// It is the reproduction and the proof for the "shared sidebar menu ARIA and colour contrast" findings of the NAV2 Stage 3
// certification (aria-required-children, aria-required-parent, listitem, color-contrast).
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
const OUT = path.join(os.tmpdir(), 'fhip-a11y-sidebar');
mkdirSync(OUT, { recursive: true });

const stub = (name) => path.join(HERE, name);
await build({
  entryPoints: [stub('sidebarHarnessEntry.jsx')],
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

const page_html = (cfg) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sidebar harness</title><link rel="stylesheet" href="out.css"></head><body><div id="root"></div><script>window.__HARNESS__=${JSON.stringify(cfg)}</script><script src="bundle.js"></script></body></html>`;

const browser = await chromium.launch();
const results = [];

async function scan(name, { width, admin, path: harnessPath = '/profile', steps }) {
  writeFileSync(path.join(OUT, 'index.html'), page_html({ admin, path: harnessPath }));
  const context = await browser.newContext({ viewport: { width, height: 3200 } });
  const page = await context.newPage();
  await page.goto('file:///' + path.join(OUT, 'index.html').replace(/\\/g, '/'));
  await page.waitForSelector('nav[aria-label="Main"]', { state: 'attached' });
  await page.waitForTimeout(300); // the two capability fetches resolve and the nav re-renders
  await steps(page);
  const scope = width < 1024 ? '#mobile-nav-panel' : 'aside';
  const axe = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.html.slice(0, 120), detail: v.nodes[0]?.any?.[0]?.message ?? v.nodes[0]?.failureSummary?.slice(0, 160) }));
  results.push({ name, width, violations, incomplete: axe.incomplete.map((v) => v.id), incompleteNodes: axe.incomplete.flatMap((v) => v.nodes.map((n) => ({ id: v.id, html: n.html.slice(0, 110), msg: n.any?.[0]?.message?.slice(0, 140) }))) });
  await context.close();
}

// The sidebar keeps ONE dropdown open at a time (Forecasting, Reports or Admin), so each is scanned in its own state.
// Idempotent: on an /admin/* path the Admin dropdown starts open, and a second click would close it.
const open = (label) => async (page) => {
  const button = page.locator('nav[aria-label="Main"]').getByRole('button', { name: label, exact: true });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
};
const drawerThen = (label) => async (page) => {
  await page.getByTestId('mobile-menu-trigger').click();
  await open(label)(page);
};

for (const [label, admin] of [['Forecasting', false], ['Reports', false], ['Admin', true]]) {
  const p = admin ? '/admin/entitlements' : '/profile';
  for (const width of [390, 768, 1024, 1440]) {
    const drawer = width < 1024; // below lg the sidebar is the hamburger drawer
    await scan(`${admin ? 'admin' : 'user'} sidebar, ${drawer ? 'drawer' : 'desktop'} ${width}, ${label} open`, { width, admin, path: p, steps: drawer ? drawerThen(label) : open(label) });
  }
}

// Structure and keyboard facts the unit tests also pin (findings F9 and F10), read from the rendered page in a real browser.
const facts = [];
for (const width of [390, 768, 1024, 1440]) {
  writeFileSync(path.join(OUT, 'index.html'), page_html({ admin: true, path: '/admin/entitlements' }));
  const context = await browser.newContext({ viewport: { width, height: 1400 } });
  const page = await context.newPage();
  await page.goto('file:///' + path.join(OUT, 'index.html').replace(/\\/g, '/'));
  await page.waitForSelector('nav[aria-label="Main"]', { state: 'attached' });
  await page.waitForTimeout(300);
  if (width < 1024) await page.getByTestId('mobile-menu-trigger').click();
  const scope = page.locator(width < 1024 ? '#mobile-nav-panel' : 'aside');
  const firstLink = (await scope.locator('nav[aria-label="Main"] a').first().innerText()).trim();
  const firstHeading = (await scope.locator('nav[aria-label="Main"] p').first().innerText()).trim();
  const adminHeadings = (await scope.locator('[aria-label="Admin"] p[role="presentation"]').allInnerTexts()).map((t) => t.trim());
  const groupItems = await scope.locator('ul[aria-label="Premium and Promo Codes"] a').allInnerTexts();
  // keyboard: the first Tab stop inside the sidebar must show a visible focus indicator
  await page.keyboard.press('Tab');
  for (let i = 0; i < 6 && !(await page.evaluate(() => Boolean(document.activeElement?.closest('nav[aria-label="Main"]')))); i += 1) await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = el ? getComputedStyle(el) : null;
    return cs ? { focused: document.activeElement.textContent.trim().slice(0, 30), outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow !== 'none' } : null;
  });
  facts.push({ width, firstHeading, firstLink, adminHeadings, groupItems: groupItems.map((t) => t.trim()), outline });
  if (width === 1440 && process.env.SIDEBAR_SHOT) await page.screenshot({ path: process.env.SIDEBAR_SHOT });
  await context.close();
}
await browser.close();

let failed = 0;
for (const f of facts) console.log('FACTS', JSON.stringify(f));
for (const r of results) {
  console.log(`\n${r.name} (${r.width}px): ${r.violations.length === 0 ? 'no violations' : r.violations.length + ' violation rule(s)'}${r.incomplete.length ? ` [axe needs review: ${r.incomplete.join(', ')}]` : ''}`);
  for (const v of r.violations) {
    failed += 1;
    console.log(`  - ${v.id} (${v.impact}) x${v.nodes}: ${v.detail}\n      e.g. ${v.sample}`);
  }
}
if (process.env.AXE_SHOW_INCOMPLETE) for (const r of results) for (const n of r.incompleteNodes) console.log('INCOMPLETE', r.name, JSON.stringify(n));
console.log(`\nTOTAL violation rules across all states: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
