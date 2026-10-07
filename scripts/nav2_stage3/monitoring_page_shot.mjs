// Loads the monitoring admin page (capability granted for the run, removed after), waits for the table, prints the storage rows as shown, saves screenshots.
import path from 'node:path';
import { chromium } from 'playwright';
import { db, OUT, PORT, USERS, userIdOf, login, logoutAll } from './_lib.mjs';
import { loadSession } from '../canonical_cert/lib/session.mjs';
const id = await userIdOf(USERS.admin);
const prev = (await db.from('admin_users').select('*').eq('user_id', id).maybeSingle()).data;
const browser = await chromium.launch();
try {
  if (!prev) await db.from('admin_users').insert({ user_id: id, notes: 'NAV2 Stage 3 temporary capability for a screenshot (reverted)', can_view_reference_data_quality: true });
  else await db.from('admin_users').update({ can_view_reference_data_quality: true }).eq('user_id', id);
  await login(USERS.admin);
  const cookies = Object.entries(loadSession(USERS.admin).cookies).map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false, sameSite: 'Lax' }));
  for (const vp of [{ width: 1280, height: 1000 }, { width: 375, height: 812 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/admin/investment-intelligence/nav2-monitoring`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForSelector('table', { timeout: 120000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'ui', `monitoring-loaded-${vp.width}.png`), fullPage: true });
    const rows = await page.$$eval('table tr', (trs) => trs.map((t) => [...t.querySelectorAll('th,td')].map((c) => c.textContent.trim().replace(/\s+/g, ' ')).join(' | ')));
    console.log(`--- ${vp.width}px`); console.log(rows.filter((r) => /Price rows|Funds held|Cached|reports/i.test(r)).join('\n'));
    await ctx.close();
  }
} finally {
  await browser.close();
  if (!prev) await db.from('admin_users').delete().eq('user_id', id); else await db.from('admin_users').update({ can_view_reference_data_quality: prev.can_view_reference_data_quality }).eq('user_id', id);
  await logoutAll();
}
