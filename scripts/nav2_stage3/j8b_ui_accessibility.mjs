// NAV2 Stage 3, journey 8b: phone-width, keyboard and semantic / accessibility inspection of the report page and the two admin pages,
// in a real Chromium (Playwright) against the app on port 3981, signed in as fixture users (session cookies from the harness; no password).
// axe-core (the standard rules engine) is loaded from cdnjs into the page for the run.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { check, db, OUT, PORT, save, summary, USERS, userIdOf, logoutAll, login } from './_lib.mjs';
import { loadSession } from '../canonical_cert/lib/session.mjs';

const shots = path.join(OUT, 'ui');
fs.mkdirSync(shots, { recursive: true });
const AXE = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.0/axe.min.js';
const adminId = await userIdOf(USERS.admin);
const prev = (await db.from('admin_users').select('*').eq('user_id', adminId).maybeSingle()).data;
const caps = { can_view_reference_data_quality: true, can_upload_risk_free_data: true, can_switch_risk_free_series: true };
const results = {};

async function cookiesFor(email) {
  await login(email);
  const s = loadSession(email);
  return Object.entries(s.cookies).map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false, sameSite: 'Lax' }));
}

async function inspect(browser, email, urlPath, label, viewport) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  await ctx.addCookies(await cookiesFor(email));
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}${urlPath}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => !/Working|Loading|Compiling/i.test(document.body.innerText.replace(/Compiling/g, '')), undefined, { timeout: 90000 }).catch(() => {});
  if (urlPath.startsWith('/reports/')) await page.waitForSelector('table', { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const tag = `${label}-${viewport.width}`;
  await page.screenshot({ path: path.join(shots, `${tag}.png`), fullPage: true });
  const info = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis).map((h) => ({ level: Number(h.tagName[1]), text: name(h).slice(0, 60) }));
    const skips = headings.filter((h, i) => i > 0 && h.level > headings[i - 1].level + 1).map((h) => h.text);
    const buttons = [...document.querySelectorAll('button, [role=button], a[href]')].filter(vis);
    const unnamed = buttons.filter((b) => !name(b)).map((b) => b.outerHTML.slice(0, 100));
    const inputs = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis);
    const unlabelled = inputs.filter((i) => !(i.labels && i.labels.length) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby')).map((i) => i.outerHTML.slice(0, 100));
    const tables = [...document.querySelectorAll('table')].filter(vis);
    const tablesNoHeaders = tables.filter((t) => !t.querySelector('th')).length;
    const imgs = [...document.querySelectorAll('img')].filter(vis);
    const imgsNoAlt = imgs.filter((i) => !i.hasAttribute('alt')).length;
    const smallTargets = buttons.filter((b) => { const r = b.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).length;
    return {
      title: document.title, lang: document.documentElement.lang,
      h1: headings.filter((h) => h.level === 1).length, headings: headings.slice(0, 40), headingSkips: skips,
      landmarks: { main: document.querySelectorAll('main,[role=main]').length, nav: document.querySelectorAll('nav,[role=navigation]').length },
      interactive: buttons.length, unnamedInteractive: unnamed.slice(0, 5), unlabelledInputs: unlabelled.slice(0, 5),
      tables: tables.length, tablesNoHeaders, images: imgs.length, imgsNoAlt, smallTargets,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      liveRegions: document.querySelectorAll('[aria-live],[role=status],[role=alert]').length,
      text: document.body.innerText.slice(0, 600),
    };
  });
  // keyboard: Tab through up to 40 stops, record each and whether a focus indicator is visible
  const stops = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const el = document.activeElement; if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const outlined = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
      return { tag: el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40), outlined: !!outlined, id: el.id || null };
    });
    if (!s) break;
    if (s.tag === 'nextjs-portal') continue; // the Next.js development overlay, not part of the app
    stops.push(s);
  }
  const noIndicator = stops.filter((s) => !s.outlined).length;
  let axeResult = null;
  try {
    await page.addScriptTag({ url: AXE });
    axeResult = await page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'] }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} :: ${n.html.slice(0, 140)} :: ${(n.any[0] || n.all[0] || n.none[0] || {}).message || ''}`.slice(0, 380)) })); });
  } catch (e) { axeResult = { error: String(e).slice(0, 120) }; }
  await ctx.close();
  results[tag] = { info: { ...info, text: undefined }, stops: stops.length, noIndicator, firstStops: stops.slice(0, 8), axe: axeResult };
  return { info, stops, noIndicator, axeResult, tag };
}

console.log(`=== journey 8b ${new Date().toISOString()} ===`);
const browser = await chromium.launch();
try {
  if (!prev) await db.from('admin_users').insert({ user_id: adminId, notes: 'NAV2 Stage 3 certification: temporary capabilities for the admin page inspection (reverted)', ...caps });
  else await db.from('admin_users').update(caps).eq('user_id', adminId);

  const pages = [
    ['report', USERS.holder, '/reports/fund-analytics'],
    ['admin-monitoring', USERS.admin, '/admin/investment-intelligence/nav2-monitoring'],
    ['admin-risk-free', USERS.admin, '/admin/investment-intelligence/risk-free-data'],
  ];
  for (const [label, email, url] of pages) {
    for (const vp of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
      const r = await inspect(browser, email, url, label, vp);
      const tag = r.tag;
      console.log(`   ${tag}: h1 ${r.info.h1}, headings ${r.info.headings.length}, interactive ${r.info.interactive}, tab stops ${r.stops.length}, axe ${Array.isArray(r.axeResult) ? r.axeResult.length + ' violation kinds' : JSON.stringify(r.axeResult)}`);
      check(`${tag}: the page loaded as the intended page (title, no error page)`, !/404|This page could not be found|Application error/i.test(r.info.text) && r.info.interactive > 0, `title "${r.info.title}"; starts "${r.info.text.slice(0, 70).replace(/\s+/g, ' ')}"`);
      check(`${tag}: ${vp.width < 500 ? 'PHONE WIDTH: no horizontal page scroll' : 'no horizontal page scroll'}`, !r.info.overflowX, `scrollWidth ${r.info.scrollWidth} vs ${r.info.clientWidth}`);
      check(`${tag}: exactly one h1 and no skipped heading level`, r.info.h1 === 1 && r.info.headingSkips.length === 0, `h1 ${r.info.h1}; skips: ${r.info.headingSkips.join(' | ')}`);
      check(`${tag}: a main landmark exists; every button/link has an accessible name; every input has a label`, r.info.landmarks.main >= 1 && r.info.unnamedInteractive.length === 0 && r.info.unlabelledInputs.length === 0, `main ${r.info.landmarks.main}; unnamed ${r.info.unnamedInteractive.length}; unlabelled ${r.info.unlabelledInputs.length}`);
      check(`${tag}: every data table has header cells; every image has alt text`, r.info.tablesNoHeaders === 0 && r.info.imgsNoAlt === 0, `tables ${r.info.tables} without headers ${r.info.tablesNoHeaders}; images ${r.info.images} without alt ${r.info.imgsNoAlt}`);
      check(`${tag}: KEYBOARD: Tab reaches the interactive controls in order and every stop shows a visible focus indicator`, r.stops.length >= 1 && r.noIndicator === 0, `${r.stops.length} stops; without indicator ${r.noIndicator}; first: ${r.stops.slice(0, 5).map((s) => s.name || s.tag).join(' > ')}`);
      const serious = Array.isArray(r.axeResult) ? r.axeResult.filter((v) => ['serious', 'critical'].includes(v.impact)) : null;
      check(`${tag}: axe-core finds no serious or critical violation`, serious !== null && serious.length === 0, serious === null ? `axe did not run: ${JSON.stringify(r.axeResult)}` : serious.map((v) => `${v.id}(${v.nodes})`).join(', ') || `${r.axeResult.length} lower-impact kinds: ${r.axeResult.map((v) => v.id).join(',')}`);
    }
  }
} finally {
  await browser.close();
  if (!prev) await db.from('admin_users').delete().eq('user_id', adminId);
  else await db.from('admin_users').update({ can_view_reference_data_quality: prev.can_view_reference_data_quality, can_upload_risk_free_data: prev.can_upload_risk_free_data, can_switch_risk_free_series: prev.can_switch_risk_free_series }).eq('user_id', adminId);
  check('the temporary admin capabilities were removed again', !prev ? !(await db.from('admin_users').select('user_id').eq('user_id', adminId).maybeSingle()).data : true);
  save('j8b_ui_results.json', results);
  await logoutAll();
  const s = summary();
  save('j8b_results.json', s);
  console.log(`\n=== journey 8b: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
