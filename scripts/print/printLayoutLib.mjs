// Build + render + analyse helpers shared by scripts/print/printLayoutCheck.ts. Real Chromium (Playwright), no dev server, no login,
// no database: the report components are bundled with esbuild (next/link, next/navigation and the Supabase client are stubbed, the
// same way as scripts/a11y/*Check.mjs) and fed from a fixture.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const A11Y = path.join(ROOT, 'scripts', 'a11y');
export const OUT = process.env.PRINT_CHECK_OUT || path.join(os.tmpdir(), 'fhip-print-layout');
mkdirSync(OUT, { recursive: true });

const A4_MM = { w: 210, h: 297 };
export { A4_MM };

/** Bundles a harness entry + the compiled stylesheet + the pdf.js analyser into OUT. Returns the file URL of the page template. */
export async function buildAssets(entry) {
  const stub = (name) => path.join(A11Y, name);
  await build({
    entryPoints: [path.join(HERE, entry)],
    bundle: true,
    outfile: path.join(OUT, `${path.basename(entry, path.extname(entry))}.bundle.js`),
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
          b.onResolve({ filter: /^@\/lib\/supabase\/(client|server)$/ }, () => ({ path: stub('stubSupabase.js') }));
          b.onResolve({ filter: /^next\/image$/ }, () => ({ path: stub('stubLink.jsx') }));
        },
      },
    ],
  });
  await build({
    entryPoints: [path.join(HERE, 'pdfAnalyzeEntry.js')],
    bundle: true,
    outfile: path.join(OUT, 'pdfAnalyze.bundle.js'),
    format: 'iife',
    platform: 'browser',
    logLevel: 'error',
    loader: { '.mjs': 'js' },
  });
  execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(ROOT, 'tailwind.config.ts'), '-i', path.join(ROOT, 'app', 'globals.css'), '-o', path.join(OUT, 'out.css')], { cwd: ROOT, stdio: 'ignore' });
}

const pageHtml = (bundle, fixture) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FHIP | Financial Health</title><link rel="stylesheet" href="out.css"></head><body><div id="root"></div><script>window.__FIXTURE__=${JSON.stringify(fixture).split('<').join('\\u003c')}</script><script src="${bundle}"></script></body></html>`;

/** The Chromium headless shell that ships with Playwright (it has the same print code as the Print dialog, including its header and footer). */
export function findHeadlessShell() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell'))) {
      const base = path.join(root, dir);
      for (const sub of readdirSync(base)) {
        for (const exe of ['chrome-headless-shell.exe', 'chrome-headless-shell']) {
          const f = path.join(base, sub, exe);
          if (existsSync(f)) return f;
        }
      }
    }
  }
  return null;
}

/**
 * Prints a static copy of the page with the Chrome COMMAND LINE (--print-to-pdf), which draws Chrome's own date, title, address and "n/N" in the
 * margins unless the page tells it not to: the same state as the Print dialog with "Headers and footers" ticked. Playwright's page.pdf() cannot show
 * this (it has its own header template switch), so the "no browser header or footer" check uses this path.
 */
export function renderWithChromeDefaults(staticHtml, name) {
  const exe = findHeadlessShell();
  if (!exe) return null;
  const html = path.join(OUT, `${name}.static.html`);
  const pdf = path.join(OUT, `${name}.cli.pdf`);
  writeFileSync(html, staticHtml);
  execFileSync(exe, ['--disable-gpu', '--no-sandbox', `--print-to-pdf=${pdf}`, pathToFileURL(html).href], { stdio: 'ignore', timeout: 120000 });
  return readFileSync(pdf);
}


/**
 * Renders the fixture's print view to PDF. mode:
 *   'print'   = what the print path produces: A4, the page's own @page rules decide size and margins, no browser header or footer
 *   'server'  = the server-side renderer's options (lib/services/reportPdfRenderer.ts): fixed 18/20/14 mm margins, its own page-number footer
 */
export async function renderPdf(browser, { bundle, fixture, mode, widthPx = 703, snapshot = false }) {
  writeFileSync(path.join(OUT, 'index.html'), pageHtml(bundle, fixture));
  const context = await browser.newContext({ viewport: { width: mode === 'server' ? 688 : widthPx, height: 900 } });
  if (mode === 'server') await context.addInitScript(() => { window.__SERVER__ = true; }); // the print route sets serverRender for ?token=
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(OUT, 'index.html')).href);
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 30000 });
  // The app serves /images/* from public/; in the harness they are read from disk.
  await page.evaluate(async (base) => {
    const imgs = [...document.images].filter((i) => (i.getAttribute('src') || '').startsWith('/'));
    imgs.forEach((i) => { i.src = base + i.getAttribute('src'); });
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
  }, pathToFileURL(path.join(ROOT, 'public')).href);
  await page.waitForTimeout(1200); // charts (recharts) measure and paint after mount
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(900); // charts re-measure at the print width
  // Size of every chart as laid out for paper (viewport = the text width of the page, 186 mm).
  const charts = await page.evaluate(() => [...document.querySelectorAll('.recharts-responsive-container')].map((c) => ({ w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })));
  const pdf =
    mode === 'server'
      ? await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '18mm', bottom: '20mm', left: '14mm', right: '14mm' },
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate: '<div style="width:100%;font-size:9px;color:#9CA3AF;text-align:center;font-family:Arial,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
        })
      : await page.pdf({ preferCSSPageSize: true, format: 'A4', printBackground: false }); // the dialog's "Background graphics" box is OFF by default
  // Charts measured at the page's text width, for a printed copy made by the Chrome command line (see renderWithChromeDefaults).
  let staticHtml = null;
  if (snapshot) {
    await page.setViewportSize({ width: 703, height: 900 });
    await page.waitForTimeout(1200);
    staticHtml = await page.evaluate(() => {
      document.querySelectorAll('script').forEach((n) => n.remove());
      return '<!doctype html>' + document.documentElement.outerHTML;
    });
  }
  await context.close();
  return { pdf, errors, staticHtml, charts };
}

/** Reads a PDF with pdf.js inside Chromium: page sizes, text with positions and sizes, ink coverage. */
export async function analysePdf(browser, pdf, { png = [], scale = 0.6, excludeBandMm = 12 } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: path.join(OUT, 'pdfAnalyze.bundle.js') });
  await page.waitForFunction(() => window.__PDF_READY__ === true, null, { timeout: 30000 });
  const pages = await page.evaluate(([b64, o]) => window.analyzePdf(b64, o), [pdf.toString('base64'), { png, scale, excludeBandMm }]);
  await context.close();
  return pages;
}

export async function launch() {
  return chromium.launch();
}

export function readFixture(name) {
  return JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
}
export { mkdirSync, writeFileSync };
