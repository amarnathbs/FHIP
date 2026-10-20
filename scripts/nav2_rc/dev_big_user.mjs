// NAV2 release candidate, DEV, real routes: a person who holds 30 funds, of which 26 have NO stored price history.
//   B2  the report for the 4 funds with history is issued although 26 others have none (and no fetch is started for them); a choice of 20 waits ONLY for its own
//       missing history, fetches ONLY those funds (selective hydration), and the other funds keep zero stored prices;
//   B3  timing of the real route for 1, 4, 10 and 20 funds, cold and warm (this is a development machine on a home link, round trip about 170 ms: see the report
//       for what that means for production), with the typed 202 / 503 states and how many calls a cold report takes;
//   D1  the accepted-statement journey at scale (30 funds, one statement), then held-only storage counts.
//   node scripts/nav2_rc/dev_big_user.mjs prepare|b2|timing|all        (app on port 3981; fixture user "admin")
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, db, flag, logoutAll, OUT, save, setFlag, summary, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';
import { api, FUND, uploadAndAccept } from '../nav2_stage3/_flow.mjs';

const mode = process.argv[2] ?? 'all';
const email = USERS.admin;
const uid = await userIdOf(email);
const RC = path.join(OUT, '..', 'nav2_rc');
fs.mkdirSync(RC, { recursive: true });
const cand = JSON.parse(fs.readFileSync(path.join(RC, 'candidate_funds.json'), 'utf8'));
const seen = new Set();
const uniq = cand.filter((c) => (seen.has(c.instrumentId) ? false : (seen.add(c.instrumentId), true)));
const N = Number(process.env.RC_FUNDS ?? 30);
const R = uniq.slice(0, N - 4); // the funds without stored history
const heldNow = new Set(((await db.from("ii_holding_snapshots").select("instrument_id").eq("user_id", uid)).data ?? []).map((x) => x.instrument_id));
const RH = heldNow.size ? R.filter((c) => heldNow.has(c.instrumentId)) : R; // the candidates the statement really put on the account (the parser merges same-name sections, see the report)
const STANDING = [FUND.A, FUND.B, FUND.D, FUND.E];
const S4 = STANDING;
const S20 = [...STANDING, ...RH.slice(0, 16).map((c) => c.instrumentId)];
const rIds = R.map((c) => c.instrumentId);
const ledgerFile = path.join(RC, 'big_user_ledger.json');
const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : { startedAt: new Date().toISOString(), instruments: rIds, cacheKeysBefore: null };
const saveLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));
// HISTORY rows only (dated before the NAV 1 changeover, 21-09-2026): the daily job stores the newest days of EVERY fund after the changeover, whoever holds it, so the rows that show whether history was fetched for a holder are the older ones
const navCount = async (id) => (await db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('instrument_id', id).lt('price_date', '2026-09-21')).count ?? 0;
const sum = async (ids) => { let t = 0; for (const i of ids) t += await navCount(i); return t; };
const post = (body, key) => api(email, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held', ...body }, headers: key ? { 'Idempotency-Key': key } : {} });
/** like the screen: asks again with the same key; returns every call (status, ms) */
async function settle(body, { max = 40, waitMs = 6000 } = {}) {
  const key = crypto.randomUUID();
  const calls = [];
  const t0 = Date.now();
  let r;
  for (let i = 0; i < max; i++) {
    const s = Date.now();
    r = await post(body, key);
    calls.push({ status: r.status, ms: Date.now() - s, state: r.json?.data?.status ?? null, loaded: r.json?.data?.loaded ?? null, total: r.json?.data?.total ?? null });
    if (!(r.status === 202 || (r.status === 503 && r.json?.data?.status === 'timed_out'))) break;
    await new Promise((res) => setTimeout(res, waitMs));
  }
  return { r, calls, totalMs: Date.now() - t0, key };
}
const cacheKeys = async () => new Set(((await db.from('nav2_result_cache').select('cache_key')).data ?? []).map((x) => x.cache_key));

console.log(`=== big user (${N} funds: 4 with history + ${R.length} without)  mode ${mode}  ${new Date().toISOString()} ===`);
try {
  if (mode === 'prepare' || mode === 'all') {
    const have = (await db.from('ii_holding_snapshots').select('id', { count: 'exact', head: true }).eq('user_id', uid)).count;
    if (have) { console.log(`   (the user already holds ${have} snapshots: preparing is skipped; reset the user to prepare again)`); } else {
      ledger.cacheKeysBefore = [...(await cacheKeys())];
      ledger.navBefore = await sum(rIds);
      saveLedger();
      check('the funds without history have no stored HISTORY (pre-changeover prices) before the run', ledger.navBefore === 0, `${ledger.navBefore} history rows`);
      await setFlag('pc6_selective_historical_hydration', false, 'RC big user: keep fetching off while the statement is accepted');
      await setFlag('nav2_trigger_planner', false, 'RC big user');
      try { execFileSync('node', ['node_modules/tsx/dist/cli.mjs', 'scripts/nav2_rc/build_big_statement.ts', String(N)], { stdio: 'inherit', timeout: 300000 }); } catch (e) { console.log('   statement build failed', e.message.slice(0, 200)); }
      const t0 = Date.now();
      const up = await uploadAndAccept(email, `nav2rc-big-${N}`);
      console.log(`   upload+process ${Date.now() - t0} ms`, JSON.stringify(up).slice(0, 160));
      check(`D1: the ${N}-fund statement is uploaded, parsed and accepted through the real routes`, up.ok, JSON.stringify(up).slice(0, 160));
      const truth = (await db.from('ii_portfolio_truth_status').select('instrument_id, status').eq('user_id', uid)).data ?? [];
      const certified = truth.filter((t) => ['certified', 'certified_with_warnings'].includes(t.status)).length;
      check(`D1: ${N} canonical positions exist and are certified`, truth.length === N && certified === N, `${truth.length} positions, ${certified} certified`);
      const cases = (await db.from('ii_reconciliation_cases').select('id, discrepancy_type, status').eq('user_id', uid)).data ?? [];
      check('D1: no reconciliation case was opened for the 30 funds (every ISIN agrees with its AMFI code)', cases.length === 0, JSON.stringify(cases.slice(0, 3)));
      check('D1/held-only: accepting 30 funds with fetching OFF stored NO price for the 26 funds without history', (await sum(rIds)) === 0, `${await sum(rIds)} rows`);
    }
  }

  if (mode === 'b2' || mode === 'all') {
    await setFlag('pc6_selective_historical_hydration', true, 'RC big user');
    await setFlag('nav2_trigger_planner', true, 'RC big user');
    const gate = (ids, expectHold) => { try { return execFileSync('node', ['node_modules/tsx/dist/cli.mjs', 'scripts/nav2_rc/dev_gate_scope.ts', email, ids.join(','), String(expectHold)], { encoding: 'utf8', timeout: 180000 }); } catch (e) { return String(e.stdout ?? e.message); } };
    const g1 = gate(S4, true);
    console.log(g1.split('\n').filter((l) => /GATE SCOPE|"hold"|"total"/.test(l)).join(' | '));
    check('B2 (real gate, real DEV tables): held 30, 26 without history: UNSCOPED the report would be held, scoped to the 4 funds with history it is not', /GATE SCOPE: as expected/.test(g1), g1.slice(-160));
    // 1. the 4 funds with history are issued although 26 others have none
    const a = await settle({ funds: S4 });
    save('big_b2_s4.json', a.calls);
    check('B2: a report for the 4 funds with history is ISSUED (201) although the person holds 26 funds without any history', a.r.status === 201, JSON.stringify(a.calls));
    check('B2: no fetch was started for the 26 unselected funds (their stored prices are still zero)', (await sum(rIds)) === 0, `${await sum(rIds)} rows`);
    // 2. 30 held and no choice: the choice is asked for (no wait for the 26 funds)
    const noChoice = await post({}, crypto.randomUUID());
    check('B2: 30 held and NO choice: the answer is the choice (409 select_funds), not "preparing" for the 26 funds without history', noChoice.status === 409 && noChoice.json?.data?.status === 'select_funds' && noChoice.json.data.heldFundCount === (new Set(((await db.from('ii_holding_snapshots').select('instrument_id').eq('user_id', uid)).data ?? []).map((x) => x.instrument_id))).size, `${noChoice.status} ${noChoice.text.slice(0, 120)}`);
    // 3. an instrument the person does not hold
    const foreign = (await db.from('ii_instruments').select('id').not('id', 'in', `(${[...STANDING, ...rIds].join(',')})`).limit(1)).data?.[0]?.id;
    const bad = await post({ funds: [FUND.A, foreign] }, crypto.randomUUID());
    check('B2: an instrument the person does not own is rejected with the one plain message (422) and nothing is issued', bad.status === 422 && !bad.text.includes(foreign), `${bad.status} ${bad.text.slice(0, 100)}`);
    // 4. a choice of 20: waits ONLY for its own 16 missing histories, fetches ONLY those
    const before16 = await sum(RH.slice(0, 16).map((c) => c.instrumentId));
    const b = await settle({ funds: S20 }, { max: 60, waitMs: 8000 });
    save('big_b2_s20_cold.json', b.calls);
    console.log(`   S20 first issue: ${b.calls.length} calls, ${b.totalMs} ms, statuses ${b.calls.map((c) => c.status).join(',')}`);
    check('B2: the choice of 20 is issued (201) after its own missing history was fetched', b.r.status === 201, JSON.stringify(b.calls.slice(-3)));
    const after16 = await sum(RH.slice(0, 16).map((c) => c.instrumentId));
    const rest = await sum(RH.slice(16).map((c) => c.instrumentId));
    check('SELECTIVE HYDRATION: the 16 selected funds now have stored prices; before it was zero', before16 === 0 && after16 > 0, `${before16} -> ${after16} rows`);
    check('SELECTIVE HYDRATION: the 10 unselected funds still have ZERO stored prices (nothing outside the choice was fetched)', rest === 0, `${rest} rows`);
    const firstWait = b.calls.find((c) => c.state === 'preparing');
    check('the wait named only funds inside the choice (total of the waiting body is at most 20, not 30)', !firstWait || (firstWait.total ?? 0) <= 20, JSON.stringify(firstWait));
    const manifest = (await db.from('nav2_fund_analytics_reports').select('manifest_json').eq('user_id', uid).order('version_number', { ascending: false }).limit(1).single()).data.manifest_json;
    check('B2: the 20 selected instrument ids are pinned in the report manifest (sorted) with held 30 and cap 20', JSON.stringify(manifest.selection?.chosenInstrumentIds) === JSON.stringify([...S20].sort()) && manifest.selection?.heldFundCount === (new Set(((await db.from('ii_holding_snapshots').select('instrument_id').eq('user_id', uid)).data ?? []).map((x) => x.instrument_id))).size && manifest.selection?.max === 20, JSON.stringify(manifest.selection)?.slice(0, 160));
    ledger.s20Cold = { calls: b.calls, totalMs: b.totalMs };
    saveLedger();
  }

  if (mode === 'hydrate') {
    // keeps asking for the choice of 20 (as the screen does) until it is issued; logs, before every call, how many of the 16 chosen funds already reach back far enough
    await setFlag('pc6_selective_historical_hydration', true, 'RC big user');
    await setFlag('nav2_trigger_planner', true, 'RC big user');
    const R16 = RH.slice(0, 16).map((c) => c.instrumentId);
    const reach = async () => { let n = 0; for (const id of R16) { const e = (await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date', { ascending: true }).limit(1).maybeSingle()).data?.price_date; if (e && String(e).slice(0, 10) <= '2024-04-01') n++; } return n; };
    const key = crypto.randomUUID();
    const calls = [];
    let r;
    let prev = -1;
    const t0 = Date.now();
    for (let i = 0; i < Number(process.env.RC_MAX_CALLS ?? 80); i++) {
      const reachNow = await reach();
      if (prev >= 0 && reachNow < prev) console.log(`   REGRESSION: chosen funds reaching back dropped ${prev} -> ${reachNow} before call ${i + 1}`);
      prev = reachNow;
      const s = Date.now();
      r = await post({ funds: S20 }, key);
      calls.push({ status: r.status, ms: Date.now() - s, state: r.json?.data?.status ?? null, loaded: r.json?.data?.loaded ?? null, total: r.json?.data?.total ?? null, reach: reachNow });
      console.log(`   call ${i + 1}: ${r.status} ${calls[calls.length - 1].ms} ms state=${calls[calls.length - 1].state} loaded=${calls[calls.length - 1].loaded}/${calls[calls.length - 1].total} reach=${reachNow}/16`);
      if (!(r.status === 202 || (r.status === 503 && r.json?.data?.status === 'timed_out'))) break;
      await new Promise((res) => setTimeout(res, 8000));
    }
    save('big_hydrate_calls.json', calls);
    ledger.hydrate = { calls: calls.length, totalMs: Date.now() - t0, final: r?.status };
    saveLedger();
    check('B2: the choice of 20 is finally issued (201) after its own missing history was fetched', r?.status === 201, `${r?.status} after ${calls.length} calls, ${Date.now() - t0} ms`);
    check('hydrate: no call took 28 s or more (the platform ceiling)', calls.every((c) => c.ms < 28000), `longest ${Math.max(...calls.map((c) => c.ms))} ms`);
    const manifest = (await db.from('nav2_fund_analytics_reports').select('manifest_json').eq('user_id', uid).order('version_number', { ascending: false }).limit(1).single()).data.manifest_json;
    const held = (await db.from('ii_holding_snapshots').select('instrument_id').eq('user_id', uid)).data ?? [];
    const heldN = new Set(held.map((x) => x.instrument_id)).size;
    check(`B2: the 20 selected instrument ids are pinned in the report manifest (sorted) with ${heldN} distinct funds held and cap 20`, JSON.stringify(manifest.selection?.chosenInstrumentIds) === JSON.stringify([...S20].sort()) && manifest.selection?.heldFundCount === heldN && manifest.selection?.max === 20, JSON.stringify(manifest.selection)?.slice(0, 200));
    const rest = await sum(RH.slice(16).map((c) => c.instrumentId));
    check('SELECTIVE HYDRATION: the unselected funds still have ZERO stored history', rest === 0, `${rest} rows`);
  }

  if (mode === 'timing' || mode === 'all') {
    const out = { latencyNote: 'development machine on a home link; see count_post.mjs for the round trip', rows: [] };
    const wanted = (process.env.RC_SETS ?? '20,10,4,1').split(',').map(Number);
    const sets = wanted.map((k) => [String(k), S20.slice(0, k)]);
    const mine = new Set(ledger.cacheKeysBefore ?? []);
    for (const [label, ids] of sets) {
      // make the funds cold again: remove exactly the cache entries of THESE funds that were created after the run began (derived data, recomputable)
      const rows = (await db.from('nav2_result_cache').select('cache_key, instrument_id').in('instrument_id', ids)).data ?? [];
      const toDelete = rows.filter((r) => !mine.has(r.cache_key)).map((r) => r.cache_key);
      for (let i = 0; i < toDelete.length; i += 100) await db.from('nav2_result_cache').delete().in('cache_key', toDelete.slice(i, i + 100));
      const cold = await settle({ funds: ids }, { max: 20, waitMs: 3000 });
      const warm = await settle({ funds: ids }, { max: 5, waitMs: 2000 });
      const slim = (x) => ({ status: x.r.status, calls: x.calls.map((c) => `${c.status}/${c.state ?? ''}/${c.ms}ms`), totalMs: x.totalMs, worstCallMs: Math.max(...x.calls.map((c) => c.ms)) });
      out.rows.push({ funds: Number(label), coldRemovedCacheEntries: toDelete.length, cold: slim(cold), warm: slim(warm) });
      console.log(`   ${label.padStart(2)} funds | cold: ${slim(cold).calls.join(' ')} (worst call ${slim(cold).worstCallMs} ms) | warm: ${slim(warm).calls.join(' ')}`);
      check(`TIMING ${label} funds: the cold report is issued (201) in the end and no single request ended in the platform's page (every call answered in under the 28 s ceiling)`, cold.r.status === 201 && slim(cold).worstCallMs < 28000, JSON.stringify(slim(cold)));
      check(`TIMING ${label} funds: the warm report is issued in ONE call`, warm.r.status === 201 && warm.calls.length === 1, JSON.stringify(slim(warm)));
    }
    save('big_timing.json', out);
    fs.writeFileSync(path.join(RC, 'big_timing.json'), JSON.stringify(out, null, 1));
  }
} finally {
  await setFlag('pc6_selective_historical_hydration', false, 'RC big user finished');
  await setFlag('nav2_trigger_planner', false, 'RC big user finished');
  await logoutAll();
  const s = summary();
  save('big_user_results.json', s);
  console.log(`\n=== big user: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
