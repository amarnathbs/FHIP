/**
 * Canonical-upload certification: a headless Chromium session, signed in as ONE fixture user, driven
 * step by step over a localhost-only control port. Used for the UI journeys (screenshots as evidence).
 *
 *   npx tsx scripts/canonical_cert/ui_driver.ts --email <signed-in email> --port 3103 --control 3199 [--shots <dir>]
 *   curl -s 127.0.0.1:3199/act -d '{"a":"goto","url":"/expenses"}'
 *
 * The session cookies come from the harness session file (signin.mjs / residue.mjs prepare, `mint`
 * method); they are added to the browser context for the 127.0.0.1 app origin only and never printed.
 * The app runs on localhost; the browser talks to the localhost app exactly as a user's would.
 *
 * Actions (JSON body of POST /act):
 *   {a:"goto", url}                       navigate (relative to the app origin); returns final URL + status
 *   {a:"click", role?, name?, text?, sel?, nth?, exact?}
 *   {a:"fill", label?|sel, value}         {a:"select", label?|sel, value}      {a:"check", label?|sel}
 *   {a:"file", sel?, path}                set a file input (default input[type=file])
 *   {a:"wait", text?|sel?, ms?}           wait for text/selector (or just ms)
 *   {a:"shot", name, full?, sel?}         screenshot -> <shots>/<name>.png
 *   {a:"text", sel?, max?}                visible text of the page (or a region)
 *   {a:"controls"}                        buttons/links/inputs with accessible names (for scripting)
 *   {a:"eval", js}                        evaluate an expression in the page (inspection only)
 *   {a:"viewport", width, height}         {a:"close"}
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page, type Locator } from '@playwright/test';
import { loadSession } from './lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const appPort = Number(arg('--port'));
const control = Number(arg('--control') ?? 3199);
const shots = path.resolve(arg('--shots') ?? path.join('test-artifacts', 'canonical_cert'));
if (!email || !appPort) throw new Error('usage: ui_driver.ts --email <e> --port <app port> [--control 3199] [--shots dir]');
const origin = `http://127.0.0.1:${appPort}`;

type Act = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function locate(page: Page, act: Act): Locator {
  let loc: Locator;
  if (act.sel) loc = page.locator(act.sel);
  else if (act.role) loc = page.getByRole(act.role, act.name !== undefined ? { name: act.name, exact: Boolean(act.exact) } : undefined);
  else if (act.label) loc = page.getByLabel(act.label, { exact: Boolean(act.exact) });
  else if (act.text) loc = page.getByText(act.text, { exact: Boolean(act.exact) });
  else throw new Error('need sel, role, label or text');
  return act.nth !== undefined ? loc.nth(act.nth) : loc.first();
}

async function main() {
  const session = loadSession(email!);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(Object.entries(session.cookies as Record<string, string>).map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/', sameSite: 'Lax' as const })));
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  fs.mkdirSync(shots, { recursive: true });

  async function run(act: Act): Promise<unknown> {
    const timeout = act.timeout ?? 60_000;
    switch (act.a) {
      case 'goto': {
        const t = Date.now();
        const res = await page.goto(origin + act.url, { waitUntil: act.until ?? 'networkidle', timeout: act.timeout ?? 180_000 });
        return { url: page.url().replace(origin, ''), status: res?.status() ?? null, ms: Date.now() - t };
      }
      case 'click': await locate(page, act).click({ timeout }); await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => {}); return { url: page.url().replace(origin, '') };
      case 'fill': await locate(page, act).fill(String(act.value), { timeout }); return 'ok';
      case 'select': await locate(page, act).selectOption(String(act.value), { timeout }); return 'ok';
      case 'check': await locate(page, act).check({ timeout }); return 'ok';
      case 'file': await page.locator(act.sel ?? 'input[type="file"]').first().setInputFiles(path.resolve(act.path), { timeout }); return 'ok';
      case 'wait':
        if (act.text) await page.getByText(act.text, { exact: Boolean(act.exact) }).first().waitFor({ timeout: act.ms ?? 120_000 });
        else if (act.sel) await page.locator(act.sel).first().waitFor({ timeout: act.ms ?? 120_000 });
        else await page.waitForTimeout(act.ms ?? 1000);
        return 'ok';
      case 'shot': {
        const file = path.join(shots, `${act.name}.png`);
        if (act.sel) await page.locator(act.sel).first().screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage: act.full !== false });
        return file;
      }
      case 'text': {
        const txt = act.sel ? await page.locator(act.sel).first().innerText({ timeout }) : await page.locator('main').first().innerText({ timeout }).catch(() => page.locator('body').innerText());
        return txt.slice(0, act.max ?? 12000);
      }
      case 'controls':
        return page.evaluate(() => Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], summary'))
          .filter((el) => (el as HTMLElement).offsetParent !== null || el.tagName === 'INPUT')
          .map((el) => {
            const e = el as HTMLInputElement;
            const name = (e.getAttribute('aria-label') ?? e.innerText ?? e.value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
            const lab = e.labels?.[0]?.innerText?.trim().replace(/\s+/g, ' ').slice(0, 60);
            return `${e.tagName.toLowerCase()}${e.type ? '[' + e.type + ']' : ''}${e.disabled ? '(disabled)' : ''} ${name}${lab ? ' <label:' + lab + '>' : ''}${e.getAttribute('href') ? ' -> ' + e.getAttribute('href') : ''}`;
          }));
      case 'eval': return page.evaluate(act.js);
      // {a:"key", key:"Tab"|"Enter"|"Space"|"Shift+Tab"|..., repeat?}: real keyboard input (focus / keyboard-operation checks)
      case 'key': for (let i = 0; i < (act.repeat ?? 1); i++) await page.keyboard.press(act.key); return 'ok';
      // {a:"focused"}: what has keyboard focus now (tag, accessible name, whether it shows a focus ring)
      case 'focused': return page.evaluate(() => { const e = document.activeElement as HTMLElement | null; if (!e) return null; const cs = getComputedStyle(e); return { tag: e.tagName.toLowerCase(), name: (e.getAttribute('aria-label') ?? e.innerText ?? (e as HTMLInputElement).value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80), label: (e as HTMLInputElement).labels?.[0]?.innerText?.trim().slice(0, 60) ?? null, outline: cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px', boxShadow: cs.boxShadow !== 'none' }; });
      case 'viewport': await page.setViewportSize({ width: act.width, height: act.height }); return 'ok';
      case 'errors': return consoleErrors.splice(0);
      case 'close': setTimeout(async () => { await browser.close(); process.exit(0); }, 100); return 'closing';
      default: throw new Error(`unknown action ${act.a}`);
    }
  }

  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const acts: Act[] = [].concat(JSON.parse(body || '{}'));
        const out: unknown[] = [];
        for (const act of acts) out.push(await run(act));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, out }, null, 1));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message.slice(0, 1500) : String(e), url: page.url().replace(origin, '') }));
      }
    });
  }).listen(control, '127.0.0.1', () => console.log(`ui driver for ${email} on 127.0.0.1:${control} -> ${origin}; shots ${shots}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
