// NAV2 Stage 3, journey 2b: the planner FETCHES, and only for the held scheme.
// The 'spare' fixture user uploads a statement for ONE fund whose stored NAV history on DEV is short (E = HDFC Flexi Cap, from 05-08-2026).
// With the planner ON, accepting it must make the system load that fund's missing history (real provider call), and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, check, db, flag, OUT, PORT, save, setFlag, summary, USERS, userIdOf, logoutAll } from './_lib.mjs';

const ROOT = path.resolve(OUT, '..', '..');
const E = '37a3d60e-47db-4fb9-af8b-4a174dfa1f2f';
const OTHERS = { A: '575b7dc3-dc60-4218-8b75-5ef68c964afe', B: '31a05b68-05f1-49d8-8d87-334e221e5740', C: '70c403e9-a81a-43be-9bcf-b03edf88ec0f', D: '2c5322cb-cb50-485c-8c9e-216b2dc6b580' };
const email = USERS.admin;
const uid = await userIdOf(email);
const exact = async (table, f) => (await f(db.from(table).select('id', { count: 'exact', head: true }))).count;
const nav = (id) => exact('ii_prices_nav', (q) => q.eq('instrument_id', id));
const plan = () => JSON.parse(execFileSync('npx', ['tsx', 'scripts/nav2_stage3/plan.ts', uid, 'since_first_held'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 180000 }).trim().split('\n').pop());
const earliest = async (id) => (await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date').limit(1)).data?.[0]?.price_date;

console.log(`=== journey 2b ${new Date().toISOString()} port ${PORT} ===`);
const plannerOriginal = await flag('nav2_trigger_planner');
const hydrOriginal = await flag('pc6_selective_historical_hydration');
const before = { E: await nav(E), earliestE: await earliest(E), global: await exact('ii_prices_nav', (q) => q), instruments: await exact('ii_instruments', (q) => q), others: {} };
for (const [k, id] of Object.entries(OTHERS)) before.others[k] = await nav(id);
const { data: ctl } = await db.from('ii_scheme_master').select('instrument_id').not('instrument_id', 'is', null).order('instrument_id').limit(300);
const CONTROL = [...new Set((ctl ?? []).map((r) => r.instrument_id))].filter((i) => i !== E && !Object.values(OTHERS).includes(i)).filter((_, i) => i % 40 === 0).slice(0, 6);
before.control = Object.fromEntries(await Promise.all(CONTROL.map(async (id) => [id.slice(0, 8), await nav(id)])));
save('j2b_before.json', before);
console.log('before', JSON.stringify(before));

try {
  await setFlag('nav2_trigger_planner', true);
  const self = await api(email, 'POST', '/api/ownership/self');
  const memberId = self.json?.data?.memberId;
  const pdf = fs.readFileSync(path.join(OUT, 'statements', 'nav2s3-spare-short.pdf'));
  const fd = new FormData();
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'nav2s3-spare-short.pdf');
  fd.append('meta', JSON.stringify({ sourceKey: 'manual', documentType: 'cas_statement', countryCode: 'IN', owner: { kind: 'member', memberId } }));
  const r = new Response(fd);
  const up = await api(email, 'POST', '/api/investment-intelligence/source-documents', { body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') });
  const docId = up.json?.data?.id;
  check('statement uploaded', up.status < 300 && !!docId, `status ${up.status}`);

  // BEFORE acceptance the user holds nothing: the plan is empty and the fund is not requested
  const p0 = plan();
  check('before acceptance (uploaded, not processed): no requirement exists for the fund', p0.windows.length === 0 && p0.fetch.toFetch.length === 0, `${p0.windows.length} windows`);
  check('before acceptance: no NAV was fetched for it', (await nav(E)) === before.E);

  const proc = await api(email, 'POST', `/api/investment-intelligence/source-documents/${docId}/process`, { json: {} });
  check('processed and accepted', proc.status === 200, `status ${proc.status}`);
  const p1 = plan();
  save('j2b_plan_after_accept.json', p1);
  check('after acceptance the planner has exactly ONE window, for the held fund E', p1.windows.length === 1 && p1.windows[0].instrumentId === E, `${p1.windows.length} windows`);
  check('the planner says the fund needs history it does not yet have (a fetch is planned for E only)', p1.fetch.toFetch.length === 1 && p1.fetch.toFetch[0].instrumentId === E, JSON.stringify(p1.fetch.toFetch));
  console.log('   planned window', p1.windows[0].requiredFrom, '->', p1.windows[0].requiredTo, ' chunks', p1.fetch.toFetch[0]?.chunkCount);

  // (i) planner ON, NAV fetch kill switch OFF (the DEV default): the report must NOT hang. Before commit 0541731 this answered 202 forever (seen on DEV).
  check('the NAV fetch kill switch is OFF at this point (DEV default)', (await flag('pc6_selective_historical_hydration')).enabled === false);
  const noFetch = await api(email, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' } });
  check('FIX 0541731: with the planner ON and fetching OFF the report is produced at once (201), not held forever (202)', noFetch.status === 201, `status ${noFetch.status} ${noFetch.text.slice(0, 120)}`);
  check('and nothing was fetched while the switch was OFF (E row count unchanged)', (await nav(E)) === before.E);
  // (ii) arm the switch (restored in finally): now the planned fetch runs, for the held fund only
  await setFlag('pc6_selective_historical_hydration', true);
  // the report holds ("preparing") while the planned history loads; generating again is how the screen re-checks
  let status = 0; let tries = 0; let bodyText = '';
  const t0 = Date.now();
  while (tries < 40) {
    tries++;
    const g = await api(email, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' } });
    status = g.status; bodyText = g.text;
    if (status === 201) break;
    if (status !== 202) break;
    if (tries === 1) save('j2b_preparing_response.json', g.json);
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log(`   report generation: final status ${status} after ${tries} call(s), ${Math.round((Date.now() - t0) / 1000)} s`);
  check('the report waited honestly (202 "being prepared") while history loaded, then produced the report (201)', status === 201, `status ${status} ${bodyText.slice(0, 160)}`);

  const after = { E: await nav(E), earliestE: await earliest(E), global: await exact('ii_prices_nav', (q) => q), instruments: await exact('ii_instruments', (q) => q), others: {} };
  for (const [k, id] of Object.entries(OTHERS)) after.others[k] = await nav(id);
  after.control = Object.fromEntries(await Promise.all(CONTROL.map(async (id) => [id.slice(0, 8), await nav(id)])));
  save('j2b_after.json', after);
  console.log('after', JSON.stringify(after));
  const p2 = plan();
  check('stored history for the held fund E grew (NAV rows loaded for it only)', after.E > before.E && after.earliestE < before.earliestE, `${before.E} -> ${after.E} rows; earliest ${before.earliestE} -> ${after.earliestE}`);
  check('the stored history now reaches the required date (or the plan is complete)', p2.fetch.toFetch.length === 0 && !p2.fetch.deferred.length, JSON.stringify(p2.fetch));
  check('the global NAV row count rose by EXACTLY the rows added to E', after.global - before.global === after.E - before.E, `global +${after.global - before.global}, E +${after.E - before.E}`);
  check('no other held-by-others fund (A, B, C, D) and none of the six control funds gained or lost a NAV row', Object.keys(OTHERS).every((k) => after.others[k] === before.others[k]) && Object.keys(before.control).every((k) => after.control[k] === before.control[k]), JSON.stringify({ others: after.others, control: after.control }));
  check('no instrument or scheme was added to the catalogue', after.instruments === before.instruments);
  const holds = (await db.from('ii_nav_retention_holds').select('id', { count: 'exact', head: true }).eq('instrument_id', E).is('released_at', null)).count;
  check('exactly one open retention hold protects fund E', holds === 1, `${holds}`);
  // repeated planner invocations / repeated generation
  const g2 = await api(email, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' } });
  const afterAgain = await nav(E);
  check('a repeated report request makes no further fetch (E row count unchanged) and no duplicate job', g2.status === 201 && afterAgain === after.E, `status ${g2.status}; ${after.E} -> ${afterAgain}`);
} catch (e) {
  console.log('FATAL', e?.stack ?? e);
  check('journey ran without an unexpected error', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await setFlag('nav2_trigger_planner', plannerOriginal.enabled, plannerOriginal.disabled_reason);
  await setFlag('pc6_selective_historical_hydration', hydrOriginal.enabled, hydrOriginal.disabled_reason);
  check('hydration switch restored', (await flag('pc6_selective_historical_hydration')).enabled === hydrOriginal.enabled);
  check('planner switch restored', (await flag('nav2_trigger_planner')).enabled === plannerOriginal.enabled);
  await logoutAll();
  const s = summary();
  save('j2b_results.json', s);
  console.log(`\n=== journey 2b: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
