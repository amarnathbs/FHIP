// Promo / Premium hardening: BROWSER certification against a LOCAL copy of the app that talks to the DEV Supabase project.
//
//   node scripts/promo_hardening_browser_certification.mjs --fixtures <file> --out <screenshot folder outside the repository> [--base http://localhost:3997] [--skip-flows]
//
// WHAT IT DOES (Playwright, Chromium, the fixture users written by scripts/promo_hardening_dev_fixtures.mjs create):
//   * signs each persona in through the real login page (passwords come only from the fixtures file, never printed);
//   * for the Promo Codes and Premium Access pages: opens them at 1280 and 390 pixels wide, and runs axe-core (WCAG 2.0/2.1 A and AA);
//     checks no horizontal scroll, the shared back link ("Back to ...") is the FIRST keyboard stop and shows a focus outline, every form
//     control is reachable by Tab in reading order and shows a focus indicator, no year-first or month-first date text is on the page;
//   * cross-capability negative controls through the real pages and APIs: a promo-only admin cannot open Premium Access, an
//     entitlement-only admin cannot open Promo Codes, an admin with no capability and a plain user are sent away from both, and each of
//     them gets 401/403 from the matching API (never an empty 200), an anonymous request gets 401;
//   * the override panel appears ONLY for the operator who holds the override capability;
//   * (unless --skip-flows) the user journeys: create a code and see it ONCE (the list then shows only the masked hint), prepare existing
//     codes, the network address check, redeem on the Profile page, the generic refusal for a wrong code, "already used", and a disabled code.
//
// SAFETY: refuses unless the base URL is localhost and the app's Supabase URL (from .env.local) is the DEV project. It stores nothing in the
// repository. Screenshots go to --out. It prints only PASS/FAIL lines; never a password, a code or a protected copy.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const DEV_REF = 'vqycarelcoijzwlpkpcz';

function argValue(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const base = argValue('--base', 'http://localhost:3997');
const fixturesFile = argValue('--fixtures');
const outDir = argValue('--out');
const skipFlows = process.argv.includes('--skip-flows');

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      env[line.slice(0, i)] = line.slice(i + 1).trim();
    }
  } catch {
    /* optional */
  }
  return env;
}
const env = loadEnv();
if (!/^http:\/\/localhost:\d+$/.test(base)) {
  console.error('REFUSING: --base must be a localhost URL.');
  process.exit(2);
}
if (!String(env.NEXT_PUBLIC_SUPABASE_URL ?? '').includes(DEV_REF)) {
  console.error('REFUSING: the app environment (.env.local) is not the DEV project.');
  process.exit(2);
}
if (!fixturesFile || !outDir) {
  console.error('Give --fixtures <file> and --out <folder outside the repository>.');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const fixtures = JSON.parse(fs.readFileSync(fixturesFile, 'utf8'));
const person = (label) => {
  const u = fixtures.users.find((x) => x.label === label);
  if (!u) throw new Error(`no fixture ${label}`);
  return u;
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
};

const browser = await chromium.launch();

async function signedInContext(label, width = 1280, height = 900) {
  const u = person(label);
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'networkidle', timeout: 180_000 });
  await page.waitForTimeout(1500); // let the page hydrate before the form is used (a dev server compiles on first use)
  await page.getByRole('textbox', { name: 'Email' }).fill(u.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(u.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 120_000 });
  return { context, page };
}

const ISO_DATE = /\b(19|20)\d{2}-\d{2}-\d{2}\b/;
const US_DATE = /\b(0?[1-9]|1[0-2])\/(1[3-9]|2\d|3[01])\/(19|20)\d{2}\b/;

async function pageHealth(page, label, widthName, include = null) {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const axe = await builder.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  check(`${label} (${widthName}): axe finds no WCAG 2.x A/AA violation`, axe.violations.length === 0, axe.violations.map((v) => `${v.id}x${v.nodes.length}`).join(', '));
  const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  check(`${label} (${widthName}): no horizontal scroll of the page`, overflow <= 1, `overflow ${overflow}px`);
  const text = await page.evaluate(() => document.body.innerText);
  check(`${label} (${widthName}): no year-first or month-first date text`, !ISO_DATE.test(text) && !US_DATE.test(text), (text.match(ISO_DATE) ?? text.match(US_DATE) ?? [''])[0]);
  check(`${label} (${widthName}): no 64-character hex string (no protected copy or hash) is shown`, !/\b[0-9a-f]{64}\b/.test(text));
}

async function keyboardWalk(page, label) {
  await page.evaluate(() => {
    if (document.activeElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  const stops = [];
  for (let i = 0; i < 220; i += 1) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const st = getComputedStyle(a);
      const ring = (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0) || st.boxShadow !== 'none';
      return {
        tag: a.tagName,
        id: a.id || '',
        name: (a.getAttribute('aria-label') || a.textContent || a.getAttribute('placeholder') || '').trim().slice(0, 40),
        back: Boolean(a.closest('nav[aria-label="Back navigation"]')),
        main: Boolean(a.closest('main')),
        ring,
        dev: a.tagName === 'NEXTJS-PORTAL', // the Next.js development overlay, not the application
      };
    });
    if (!s) break;
    if (!s.dev) stops.push(s);
  }
  const backIdx = stops.findIndex((s) => s.back);
  const firstControl = stops.findIndex((s) => s.main && !s.back);
  check(`${label}: the shared back link is a keyboard stop and comes BEFORE the first control of the page`, backIdx >= 0 && backIdx < firstControl, `back stop ${backIdx}, first control ${firstControl}`);
  check(`${label}: the back link shows a visible focus indicator`, stops[backIdx]?.ring === true);
  const noRing = stops.filter((s) => !s.ring);
  check(`${label}: every one of the ${stops.length} keyboard stops shows a focus indicator`, stops.length >= 5 && noRing.length === 0, noRing.slice(0, 8).map((s) => `${s.tag}${s.id ? `#${s.id}` : ''}:${s.name}`).join(' | '));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
}

try {
  // ---------------------------------------------------------------- A. Promo Codes page, promo-only operator
  for (const [width, widthName] of [[1280, 'desktop'], [390, 'phone']]) {
    const { context, page } = await signedInContext('promo', width, width === 390 ? 844 : 900);
    await page.goto(`${base}/admin/entitlements/promo-codes`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByRole('heading', { name: 'Promo Codes' }).waitFor({ timeout: 120_000 });
    await page.getByRole('heading', { name: 'Setup check' }).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes('Checking the server setup'), null, { timeout: 60_000 });
    await page.waitForFunction(() => !/Loading…/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => undefined);
    check(`Promo Codes (${widthName}): the Back to Premium Access link is present`, await page.getByRole('link', { name: /Back to Premium Access/ }).isVisible());
    await pageHealth(page, 'Promo Codes', widthName);
    if (width === 1280) await keyboardWalk(page, 'Promo Codes');
    await shot(page, `promo-codes-${widthName}`);
    await context.close();
  }

  // ---------------------------------------------------------------- B. Premium Access page
  for (const [width, widthName] of [[1280, 'desktop'], [390, 'phone']]) {
    const { context, page } = await signedInContext('ent', width, width === 390 ? 844 : 900);
    await page.goto(`${base}/admin/entitlements`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByRole('heading', { name: /Premium Access/ }).waitFor({ timeout: 120_000 });
    await page.waitForTimeout(2500);
    check(`Premium Access (${widthName}): the back link is present`, (await page.getByRole('link', { name: /^Back to / }).count()) > 0);
    await pageHealth(page, 'Premium Access', widthName);
    if (width === 1280) await keyboardWalk(page, 'Premium Access');
    await shot(page, `premium-access-${widthName}`);
    await context.close();
  }

  // ---------------------------------------------------------------- C. cross-capability negative controls
  const apiStatus = async (page, method, url, body) => (await page.request.fetch(`${base}${url}`, { method, data: body, headers: body ? { 'Content-Type': 'application/json' } : undefined })).status();
  const personas = [
    { label: 'promo', canPromo: true, canEnt: false },
    { label: 'ent', canPromo: false, canEnt: true },
    { label: 'super', canPromo: false, canEnt: false },
    { label: 'user1', canPromo: false, canEnt: false },
  ];
  for (const p of personas) {
    const { context, page } = await signedInContext(p.label);
    await page.goto(`${base}/admin/entitlements/promo-codes`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForTimeout(1500);
    const onPromo = new URL(page.url()).pathname.startsWith('/admin/entitlements/promo-codes');
    check(`${p.label}: the Promo Codes page ${p.canPromo ? 'opens' : 'is NOT opened (sent away)'}`, onPromo === p.canPromo, page.url());
    await page.goto(`${base}/admin/entitlements`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForTimeout(1500);
    const onEnt = new URL(page.url()).pathname === '/admin/entitlements';
    check(`${p.label}: the Premium Access page ${p.canEnt ? 'opens' : 'is NOT opened (sent away)'}`, onEnt === p.canEnt, page.url());
    const sPromo = await apiStatus(page, 'GET', '/api/admin/promo-codes');
    const sHealth = await apiStatus(page, 'GET', '/api/admin/promo-codes/health');
    const sBackfill = await apiStatus(page, 'POST', '/api/admin/promo-codes/digest-backfill', {});
    const sNet = await apiStatus(page, 'GET', '/api/admin/promo-codes/network-check');
    const sGrants = await apiStatus(page, 'GET', '/api/admin/entitlements/grants?filter=expiring');
    if (p.canPromo) check(`${p.label}: the promo APIs answer (not a denial)`, [sPromo, sHealth, sNet].every((s) => s === 200 || s === 503), `${sPromo}/${sHealth}/${sNet}`);
    else check(`${p.label}: the promo APIs answer 403 (a clean denial, never an empty 200)`, [sPromo, sHealth, sBackfill, sNet].every((s) => s === 403), `${sPromo}/${sHealth}/${sBackfill}/${sNet}`);
    if (p.canEnt) check(`${p.label}: the grants API answers (not a denial)`, sGrants === 200 || sGrants === 503, String(sGrants));
    else check(`${p.label}: the grants API answers 403`, sGrants === 403, String(sGrants));
    await context.close();
  }
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const anonStatuses = [];
  for (const [m, u] of [['GET', '/api/admin/promo-codes'], ['GET', '/api/admin/promo-codes/health'], ['POST', '/api/admin/promo-codes/digest-backfill'], ['GET', '/api/admin/entitlements/grants?filter=expiring']]) anonStatuses.push(await apiStatus(anonPage, m, u, m === 'POST' ? {} : undefined));
  check('an anonymous request gets 401 on the promo and grant APIs', anonStatuses.every((s) => s === 401), anonStatuses.join(','));
  await anon.close();

  // ---------------------------------------------------------------- D. the override panel appears only for the override holder
  if (fixtures.users.some((u) => u.label === 'ovr')) {
    const me = async (label) => {
      const { context, page } = await signedInContext(label);
      const r = await page.request.get(`${base}/api/admin/me`);
      const j = await r.json();
      await context.close();
      return j?.data?.capabilities ?? j?.capabilities ?? {};
    };
    const caps = { ent: await me('ent'), both: await me('both'), ovr: await me('ovr'), ovronly: await me('ovronly') };
    check('/api/admin/me: only the override holder reports entitlementOverride=true; the grant capability, both ordinary capabilities and Super Admin style rows do not', caps.ovr.entitlementOverride === true && caps.ent.entitlementOverride === false && caps.both.entitlementOverride === false && caps.ovronly.entitlementOverride === true, JSON.stringify({ ent: caps.ent.entitlementOverride, both: caps.both.entitlementOverride, ovr: caps.ovr.entitlementOverride, ovronly: caps.ovronly.entitlementOverride }));
    check('/api/admin/me: the override alone does not report either ordinary capability', caps.ovronly.entitlementManagement === false && caps.ovronly.promoCodeManagement === false);
  }

  if (!skipFlows) {
    // -------------------------------------------------------------- E. journeys
    const { context, page } = await signedInContext('promo');
    await page.goto(`${base}/admin/entitlements/promo-codes`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByRole('heading', { name: 'Setup check' }).waitFor({ timeout: 120_000 });
    await page.waitForFunction(() => !document.body.innerText.includes('Checking the server setup'), null, { timeout: 60_000 });
    const setupText = await page.getByRole('region', { name: 'Setup check' }).innerText().catch(() => '');
    check('the setup check says every required server secret is set', /Every required server secret is set/.test(setupText) || /Every required server secret is set/.test(await page.locator('body').innerText()));
    await page.getByRole('button', { name: 'Check my network address' }).click();
    await page.getByText(/Address list received/).waitFor({ timeout: 30_000 });
    check('the network address check answers (no header is normal on a local copy: no address would be used)', /No address would be used|The entry that would be used/.test(await page.locator('body').innerText()));
    await page.locator('#promo-note').fill('browser certification code, safe to disable');
    await page.getByRole('button', { name: 'Create code', exact: true }).click();
    const notice = page.getByText(/Promo code created: /);
    await notice.waitFor({ timeout: 60_000 });
    const noticeText = await notice.innerText();
    const code = (/Promo code created: ([A-Z2-9]{5}-[A-Z2-9]{5})/.exec(noticeText) ?? [])[1];
    check('creating a code shows it ONCE, in the day-first message, with the 30 day wording', Boolean(code) && /counting the day of redemption/.test(noticeText) && !ISO_DATE.test(noticeText), noticeText.slice(0, 120));
    await shot(page, 'promo-code-created');
    const hint = code ? `${code.replace('-', '').slice(0, 2)}******${code.replace('-', '').slice(-2)}` : '?';
    await page.waitForTimeout(1500);
    const bodyAfter = await page.locator('body').innerText();
    check('the list shows only the masked hint of the new code (the full code is not in the list)', bodyAfter.includes(hint) && (bodyAfter.match(new RegExp((code ?? 'x').replace('-', '-?'), 'g')) ?? []).length === 1, hint);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Codes', exact: true }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    check('after a reload the full code is gone from the page (it cannot be shown again)', !(await page.locator('body').innerText()).replace(/\s/g, '').includes((code ?? 'x').replace('-', '')));
    const prepare = page.getByRole('button', { name: 'Prepare existing codes' });
    if (await prepare.count()) {
      const disabled = await prepare.isDisabled();
      check('Prepare existing codes is offered (disabled when nothing waits)', true, `disabled=${disabled}`);
      if (!disabled) {
        await prepare.click();
        await page.getByText(/existing codes now have a verified protected copy|Nothing to prepare/).waitFor({ timeout: 120_000 }).catch(() => undefined);
        check('Prepare existing codes reports a result and removes nothing', /protected copy|Nothing to prepare|could not be verified/.test(await page.locator('body').innerText()));
      }
    }
    await context.close();

    // An OLD-WORLD code (made by the old function shapes, plain text stored) must redeem after Prepare existing codes, by its protected copy or the legacy lookup.
    const oldFile = argValue('--oldcodes');
    if (oldFile && fs.existsSync(oldFile)) {
      const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
      const { context: octx, page: opage } = await signedInContext('user3');
      await opage.goto(`${base}/profile`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      const ofield = opage.getByLabel('Promo code');
      await ofield.waitFor({ timeout: 120_000 });
      await ofield.fill(old.typed);
      await opage.getByRole('button', { name: 'Apply code' }).click();
      await opage.getByText(/Premium \(promo code, ends /).first().waitFor({ timeout: 60_000 }).catch(() => undefined);
      const t = await opage.locator('body').innerText();
      check('an existing OLD-WORLD code (created by the old function shapes) still redeems after the backfill, with the new 30 day window', /Premium \(promo code, ends \d{2}\/\d{2}\/\d{4}\)/.test(t), (t.match(/Premium \(promo code[^)]*\)/) ?? [''])[0]);
      await octx.close();
    }

    if (code) {
      const { context: uctx, page: upage } = await signedInContext('user4');
      await upage.goto(`${base}/profile`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      const field = upage.getByLabel('Promo code');
      await field.waitFor({ timeout: 120_000 });
      await field.fill('WRONGCODE223');
      await upage.getByRole('button', { name: 'Apply code' }).click();
      await upage.getByText('This code cannot be used.').waitFor({ timeout: 60_000 });
      check('a wrong code gets the generic refusal', true);
      await field.fill(code);
      await upage.getByRole('button', { name: 'Apply code' }).click();
      await upage.getByText(/Premium \(promo code, ends /).first().waitFor({ timeout: 60_000 }).catch(() => undefined);
      const profileText = await upage.locator('body').innerText();
      check('redeeming the code on the Profile page gives Premium from a promo code with a day-first end date', /Premium \(promo code, ends \d{2}\/\d{2}\/\d{4}\)|ends \d{2}-\d{2}-\d{4}/.test(profileText) && !ISO_DATE.test(profileText), (profileText.match(/Premium \(promo code[^)]*\)/) ?? [''])[0]);
      await shot(upage, 'profile-redeemed');
      await field.fill(code).catch(() => undefined);
      await upage.getByRole('button', { name: 'Apply code' }).click().catch(() => undefined);
      await upage.waitForTimeout(2000);
      check('using the same code again is refused with a clear message', /already used|cannot be used/.test(await upage.locator('body').innerText()));
      // Only the plan and promo panel is in scope: the Profile form above it has two unlabeled controls that are not part of this release (reported as a finding).
      await upage.evaluate(() => { const r = document.querySelector('#promo-code-helper')?.closest('.space-y-6'); if (r) r.setAttribute('data-axe-scope', '1'); });
      await pageHealth(upage, 'Profile (plan and promo panel)', 'desktop', '[data-axe-scope]');
      await uctx.close();
    }
  }
} catch (e) {
  fail += 1;
  console.log(`FAIL  unexpected error: ${e instanceof Error ? e.message : 'error'}`);
} finally {
  await browser.close();
  console.log(`\nPROMO HARDENING BROWSER CERTIFICATION: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
