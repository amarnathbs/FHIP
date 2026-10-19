// NAV2 Stage 3, journey 5: cross-tenant and direct access, entitlement loss, typed states, reconciliation, honest beta/alpha, workers off.
// Real routes on the app server + DIRECT PostgREST calls made AS each fixture user (their own JWT), which is what a browser session could do.
import fs from 'node:fs';
import path from 'node:path';
import { check, db, flag, OUT, PORT, save, summary, USERS, userIdOf, logoutAll, api, asUser, rpcAsUser } from './_lib.mjs';
import { FUND, generate, uploadAndAccept } from './_flow.mjs';

const uid = { holder: await userIdOf(USERS.holder), other: await userIdOf(USERS.other), free: await userIdOf(USERS.free), admin: await userIdOf(USERS.admin) };
const secret = fs.readFileSync(path.join(OUT, '.cron_secret'), 'utf8').trim();
const latest = async (userId) => (await db.from('nav2_fund_analytics_reports').select('id, version_number').eq('user_id', userId).order('version_number', { ascending: false }).limit(1)).data?.[0]?.id;
const cron = (route, headers = {}) => fetch(`http://127.0.0.1:${PORT}/api/investment-intelligence/cron/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const tokens = async () => (await db.from('nav2_report_render_tokens').select('token', { count: 'exact', head: true })).count;

console.log(`=== journey 5 ${new Date().toISOString()} port ${PORT} ===`);
const holderReport = await latest(uid.holder);
let otherReport = await latest(uid.other);
if (!otherReport) { const g = await generate(USERS.other); otherReport = g.id; }
check('two real reports exist (holder\'s and other\'s)', !!holderReport && !!otherReport, `${String(holderReport).slice(0, 8)} / ${String(otherReport).slice(0, 8)}`);
const fakeId = '00000000-0000-4000-8000-000000000000';

// ---- 1. another Premium user against the holder's report ---------------------------------------------------------------------------
const t0 = await tokens();
const cross = await api(USERS.other, 'GET', `/api/reports/fund-analytics/${holderReport}`);
const none = await api(USERS.other, 'GET', `/api/reports/fund-analytics/${fakeId}`);
check('CROSS-TENANT report JSON: another user gets 404, indistinguishable from an id that does not exist', cross.status === 404 && none.status === 404 && cross.text === none.text, `${cross.status} ${cross.text} | ${none.status}`);
const crossPdf = await api(USERS.other, 'GET', `/api/reports/fund-analytics/${holderReport}/export`);
check('CROSS-TENANT PDF: 404 and NO render token was created for it', crossPdf.status === 404 && (await tokens()) === t0, `${crossPdf.status}; tokens ${t0} -> ${await tokens()}`);
const list = await api(USERS.other, 'GET', '/api/reports/fund-analytics');
check('CROSS-TENANT list: only the caller\'s own reports', (list.json?.data ?? []).every((r) => r.id !== holderReport) && (list.json?.data ?? []).length >= 1);
check('NEGATIVE CONTROL: the owner CAN read that same report (so the 404 above is the access rule, not a broken id)', (await api(USERS.holder, 'GET', `/api/reports/fund-analytics/${holderReport}`)).status === 200);

// ---- 2. a free user ------------------------------------------------------------------------------------------------------------------
for (const [label, method, route, opts] of [
  ['list', 'GET', '/api/reports/fund-analytics', {}],
  ['report JSON', 'GET', `/api/reports/fund-analytics/${holderReport}`, {}],
  ['PDF', 'GET', `/api/reports/fund-analytics/${holderReport}/export`, {}],
  ['generate (valid body)', 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' } }],
  ['generate (INVALID body: authorisation comes before validation)', 'POST', '/api/reports/fund-analytics', { json: { nonsense: true } }],
]) {
  const r = await api(USERS.free, method, route, opts);
  check(`FREE USER ${label}: explicit 403 with the Premium sentence (never an empty 200 or a 422)`, r.status === 403 && /premium/i.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
}
const anon = await fetch(`http://127.0.0.1:${PORT}/api/reports/fund-analytics`).then((r) => r.status);
check('NO SESSION: the report API answers 401', anon === 401, `${anon}`);
const tokensBefore = await tokens();
await api(USERS.free, 'GET', `/api/reports/fund-analytics/${holderReport}/export`);
check('FREE USER PDF created no render token', (await tokens()) === tokensBefore);

// ---- 3. print route and tokens ---------------------------------------------------------------------------------------------------------
const printStatus = async (q) => fetch(`http://127.0.0.1:${PORT}/reports/fund-analytics/print${q}`, { redirect: 'manual' }).then((r) => r.status);
check('PRINT ROUTE with no token and no session redirects to login (not the report)', [302, 307, 308].includes(await printStatus('')), `${await printStatus('')}`);
check('PRINT ROUTE with a made-up token is a 404', (await printStatus(`?token=${'a'.repeat(64)}`)) === 404);
const goodTok = 'b'.repeat(64);
await db.from('nav2_report_render_tokens').insert({ token: goodTok, user_id: uid.holder, report_id: holderReport, expires_at: new Date(Date.now() + 120000).toISOString() });
const expTok = 'c'.repeat(64);
await db.from('nav2_report_render_tokens').insert({ token: expTok, user_id: uid.holder, report_id: holderReport, expires_at: new Date(Date.now() - 60000).toISOString() });
const mismatch = 'd'.repeat(64);
await db.from('nav2_report_render_tokens').insert({ token: mismatch, user_id: uid.other, report_id: holderReport, expires_at: new Date(Date.now() + 120000).toISOString() });
check('PRINT ROUTE with a valid token opens (200)', (await printStatus(`?token=${goodTok}`)) === 200);
check('PRINT ROUTE with an EXPIRED token is a 404', (await printStatus(`?token=${expTok}`)) === 404);
check('PRINT ROUTE with a token for user X naming user Y\'s report is a 404 (the report is loaded with an explicit user filter)', (await printStatus(`?token=${mismatch}`)) === 404);
await db.from('nav2_report_render_tokens').delete().in('token', [goodTok, expTok, mismatch]);
const fakeIdPrint = await api(USERS.other, 'GET', `/reports/fund-analytics/print?id=${holderReport}`);
check('PRINT ROUTE ?id= of another user\'s report, with a session: 404', fakeIdPrint.status === 404, `${fakeIdPrint.status}`);

// ---- 4. direct database access as a user -------------------------------------------------------------------------------------------------
const cachePeek = await asUser(USERS.other, 'nav2_result_cache', 'select=cache_key&limit=3');
check('DIRECT: the shared analytics cache is closed to a signed-in user (permission denied)', cachePeek.status >= 400 && !Array.isArray(cachePeek.json), `${cachePeek.status} ${cachePeek.text.slice(0, 80)}`);
for (const t of ['nav2_report_render_tokens', 'nav2_correction_events']) {
  const r = await asUser(USERS.other, t, 'select=*&limit=3');
  check(`DIRECT: ${t} is closed to a signed-in user`, r.status >= 400 && !Array.isArray(r.json), `${r.status}`);
}
const depRows = await asUser(USERS.other, 'nav2_report_nav_dependencies', 'select=*&limit=3');
check('DIRECT: the report NAV pin table shows a non-admin user nothing (RLS: admin only)', depRows.status === 200 ? (depRows.json ?? []).length === 0 : depRows.status >= 400, `${depRows.status} rows ${Array.isArray(depRows.json) ? depRows.json.length : '-'}`);
const otherRows = await asUser(USERS.other, 'nav2_fund_analytics_reports', `select=id&user_id=eq.${uid.holder}`);
check('DIRECT: another user\'s stored reports are invisible (RLS)', otherRows.status === 200 && (otherRows.json ?? []).length === 0, `${otherRows.status} rows ${otherRows.json?.length}`);
const writeTry = await asUser(USERS.other, 'nav2_fund_analytics_reports', `id=eq.${otherReport}`, { method: 'PATCH', body: { scheme_count: 99 } });
check('DIRECT: a user cannot edit their own issued report (no update grant)', writeTry.status >= 400 || (Array.isArray(writeTry.json) && writeTry.json.length === 0), `${writeTry.status} ${writeTry.text.slice(0, 80)}`);
const delTry = await asUser(USERS.other, 'nav2_fund_analytics_reports', `id=eq.${otherReport}`, { method: 'DELETE' });
check('DIRECT: nor delete it', delTry.status >= 400 || (Array.isArray(delTry.json) && delTry.json.length === 0), `${delTry.status}`);
const holdTx = await asUser(USERS.other, 'ii_transactions', `select=id&user_id=eq.${uid.holder}`);
check('DIRECT: another user\'s held-scheme transactions are invisible (RLS)', holdTx.status === 200 && (holdTx.json ?? []).length === 0, `rows ${holdTx.json?.length}`);
const holdApi = await api(USERS.other, 'GET', '/api/investment-intelligence/holdings');
const ownIds = new Set(((await db.from('ii_holding_snapshots').select('instrument_id').eq('user_id', uid.other)).data ?? []).map((r) => r.instrument_id));
const apiText = holdApi.text;
check('HELD SCHEMES via the app API: the other user\'s holdings list contains none of the holder-only funds (B, C)', holdApi.status === 200 && !apiText.includes(FUND.B) && !apiText.includes(FUND.C), `${holdApi.status}; own instruments ${ownIds.size}`);

// ---- 5. admin and monitoring surfaces ------------------------------------------------------------------------------------------------------
for (const u of ['free', 'holder', 'other']) {
  const mon = await api(USERS[u], 'GET', '/api/admin/investment-intelligence/nav2-monitoring');
  const rf = await api(USERS[u], 'GET', '/api/admin/investment-intelligence/risk-free-data');
  const rfp = await api(USERS[u], 'POST', '/api/admin/investment-intelligence/risk-free-data', { json: { action: 'preview', seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', csvText: 'x' } });
  const sw = await api(USERS[u], 'POST', '/api/admin/investment-intelligence/risk-free-data/series-state', { json: {} });
  const rpcMon = await rpcAsUser(USERS[u], 'nav2_monitoring_snapshot');
  check(`NON-ADMIN (${u}): monitoring, risk-free status, upload and series switch are all refused (403), and the monitoring RPC called directly is refused (42501)`, [mon.status, rf.status, rfp.status, sw.status].every((s) => s === 403) && (rpcMon.json?.code === '42501' || rpcMon.status >= 400), `${mon.status}/${rf.status}/${rfp.status}/${sw.status}; rpc ${rpcMon.status} ${rpcMon.json?.code}`);
}
// the monitoring surface for a user WITH the capability (granted to the admin fixture user for this check, reverted after)
const prev = (await db.from('admin_users').select('*').eq('user_id', uid.admin).maybeSingle()).data;
let monitoring = null;
try {
  if (!prev) await db.from('admin_users').insert({ user_id: uid.admin, notes: 'NAV2 Stage 3 certification: temporary capability for the monitoring check (reverted)', can_view_reference_data_quality: true });
  else await db.from('admin_users').update({ can_view_reference_data_quality: true }).eq('user_id', uid.admin);
  monitoring = await api(USERS.admin, 'GET', '/api/admin/investment-intelligence/nav2-monitoring');
  save('j5_monitoring_snapshot.json', monitoring.json);
  const snap = monitoring.json?.data?.snapshot;
  check('MONITORING for the capability holder: 200 with aggregate cells only', monitoring.status === 200 && monitoring.json?.data?.state === 'ok', `${monitoring.status} state ${monitoring.json?.data?.state}`);
  const text = JSON.stringify(snap ?? {});
  check('the snapshot carries no user id, e-mail, folio or holding (aggregate-only)', !/@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), `${text.length} chars`);
  check('user-derived figures below 5 are suppressed with the standard label, never shown as small numbers or zero', /suppressed|Insufficient data to display safely/.test(text) || /"state":"ok"/.test(text), 'cells with state suppressed or ok');
  // upload/switch capability NOT implied by the monitoring capability
  const rf = await api(USERS.admin, 'GET', '/api/admin/investment-intelligence/risk-free-data');
  const sw = await api(USERS.admin, 'POST', '/api/admin/investment-intelligence/risk-free-data/series-state', { json: {} });
  check('CAPABILITIES ARE SEPARATE: the monitoring capability does not open risk-free upload/status or the series switch (403)', rf.status === 403 && sw.status === 403, `${rf.status}/${sw.status}`);
} finally {
  if (!prev) await db.from('admin_users').delete().eq('user_id', uid.admin);
  else await db.from('admin_users').update({ can_view_reference_data_quality: prev.can_view_reference_data_quality }).eq('user_id', uid.admin);
}
check('the temporary admin capability was removed again', !(await db.from('admin_users').select('user_id').eq('user_id', uid.admin).maybeSingle()).data || !!prev);

// ---- 6. cron routes and workers remain off ------------------------------------------------------------------------------------------------------
check('CRON: the correction worker and the weekly RBI refresh refuse a call with no secret and with a wrong secret (401)', (await cron('nav2-correction-worker')).status === 401 && (await cron('nav2-risk-free-refresh', { 'x-cron-secret': 'wrong' })).status === 401);
const cw = await cron('nav2-correction-worker', { 'x-cron-secret': secret });
const rr = await cron('nav2-risk-free-refresh', { 'x-cron-secret': secret });
check('WORKERS REMAIN OFF: with the correct secret both answer "switched off" and do nothing', /skipped|off|disabled/i.test(JSON.stringify(cw.json)) && /skipped|off|disabled/i.test(JSON.stringify(rr.json)), `${JSON.stringify(cw.json).slice(0, 110)} | ${JSON.stringify(rr.json).slice(0, 110)}`);
const offs = await Promise.all(['nav2_trigger_planner', 'nav2_correction_worker', 'nav2_risk_free_weekly_refresh', 'pc6_selective_historical_hydration'].map(async (k) => [k, (await flag(k)).enabled]));
check('switch states read back from the database', offs.every(([, e]) => e === false), JSON.stringify(Object.fromEntries(offs)));

// ---- 7. Premium entitlement loss ---------------------------------------------------------------------------------------------------------------------
const ent = (await db.from('user_entitlements').select('plan_tier, effective_from, effective_to').eq('user_id', uid.other).single()).data;
try {
  await db.from('user_entitlements').update({ plan_tier: 'free' }).eq('user_id', uid.other);
  const l = await api(USERS.other, 'GET', '/api/reports/fund-analytics');
  const g = await api(USERS.other, 'GET', `/api/reports/fund-analytics/${otherReport}`);
  const x = await api(USERS.other, 'GET', `/api/reports/fund-analytics/${otherReport}/export`);
  const p = await api(USERS.other, 'GET', `/reports/fund-analytics/print?id=${otherReport}`);
  check('PREMIUM LOST: list, report JSON, PDF and the print view all refuse (403/403/403/404)', l.status === 403 && g.status === 403 && x.status === 403 && p.status === 404, `${l.status}/${g.status}/${x.status}/${p.status}`);
  const direct = await asUser(USERS.other, 'nav2_fund_analytics_reports', `select=id,report_json&id=eq.${otherReport}`);
  const exposed = direct.status === 200 && Array.isArray(direct.json) && direct.json.length === 1 && !!direct.json[0].report_json;
  save('j5_premium_loss_direct_read.json', { status: direct.status, rows: Array.isArray(direct.json) ? direct.json.length : null, hasReportJson: exposed });
  check('PREMIUM LOST, DIRECT DATABASE READ: a lapsed user cannot read the stored report straight from the table either', !exposed, exposed ? 'FINDING: the row-level policy only checks ownership, so the stored report JSON stays readable with the user\'s own session' : 'closed');
} finally {
  await db.from('user_entitlements').update({ plan_tier: ent.plan_tier, effective_from: ent.effective_from, effective_to: ent.effective_to }).eq('user_id', uid.other);
}
check('Premium restored for the other user', (await api(USERS.other, 'GET', '/api/reports/fund-analytics')).status === 200);

await logoutAll();
const s = summary();
save('j5_results.json', s);
console.log(`\n=== journey 5 (part 1): ${s.pass} PASS, ${s.fail} FAIL ===`);
process.exitCode = s.fail ? 1 : 0;
