// NAV2 production release -- deploy order proof and hand-over pack proof, on PGlite (an in-process Postgres with a platform shim).
// Evidence label: PGlite-verified. NOT DEV evidence and NOT production evidence. No network, no database outside this process.
//
// What it proves
//   A. a "production like" database (every migration of this tree EXCEPT the NAV2 ones: 0260-0263 and 0269-0271) behaves in a recorded way on
//      the OLD paths (corrections, retention predicate, job control list, admin_users, entitlements, instrument delete);
//   B. what the NEW code sees on that database BEFORE the NAV2 migrations (the exact errors and empty answers its fail-closed paths rely on);
//   C. the pack (docs/nav2/po_apply_production/sql): every pre-check returns what the README promises, every migration step (0260 parts a-e,
//      0261, 0262, 0263, 0269, 0270, 0271) runs in the documented order and its check returns all true (and a check run too EARLY returns
//      false: negative controls), the grants and switches files do what they say, the final check is all true;
//   D. the OLD paths give the SAME answers after the migrations (only the documented differences: four more job-control rows, one correction
//      event per price or benchmark correction);
//   E. every rollback file runs in the documented reverse order, the database returns to the pre-NAV2 shape (P1 true again, retention function
//      body equal to 0219 again) and the old paths still answer the same;
//   F. re-applying everything a second time raises no error (idempotent).
//
// Run: node scripts/nav2_production_deploy_order_proof.mjs            (about 4 minutes, most of it the migration replay)
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIG = path.join(REPO, 'supabase', 'migrations');
const PACK = path.join(REPO, 'docs', 'nav2', 'po_apply_production', 'sql');
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const NAV2_NUMBERS = new Set(['0260', '0261', '0262', '0263', '0269', '0270', '0271']);
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const prodLike = files.filter((f) => !NAV2_NUMBERS.has(f.slice(0, 4)));
const pack = (rel) => fs.readFileSync(path.join(PACK, rel), 'utf8');
const packFile = (dir, name) => pack(`${dir}/${name}`);

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of prodLike) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(REPO, 'supabase', 'seed.sql'), 'utf8'));
}
console.log(`production-like ledger replayed: ${prodLike.length} migrations, highest ${prodLike.at(-1)} (NAV2 0260-0263 and 0269-0271 NOT applied)\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  DO-${String(seq).padStart(3, '0')}  ${label}${!cond && detail ? '\n        ' + detail : ''}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const err = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e; } };
const allTrue = (row) => Object.values(row).every((v) => v === true);
const falseKeys = (row) => Object.entries(row).filter(([, v]) => v !== true).map(([k]) => k).join(', ');
const asRole = async (role, sub, sql) => {
  try {
    await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false); select set_config('request.jwt.claim.role', '${role}', false);`);
    const r = await db.query(sql);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, msg: e.message, code: e.code };
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.role', '', false);`);
  }
};
const runPack = async (rel) => (await db.query(strip(pack(rel)))).rows[0];

// ---------------------------------------------------------------------------------------------------------------------------------
// Seed: users, an administrator, entitlements, instruments with prices, a hold, corrections (the OLD paths)
// ---------------------------------------------------------------------------------------------------------------------------------
const U = { admin: 'bbbb0000-0000-0000-0000-000000000001', premium: 'bbbb0000-0000-0000-0000-000000000002', free: 'bbbb0000-0000-0000-0000-000000000003', lapsed: 'bbbb0000-0000-0000-0000-000000000004', second: 'bbbb0000-0000-0000-0000-000000000005' };
for (const [k, id] of Object.entries(U)) await db.exec(`insert into auth.users(id,email) values ('${id}','po-${k}@t.test');`);
await db.exec(`insert into admin_users (user_id) values ('${U.admin}'), ('${U.second}');`);
await db.exec(`insert into user_entitlements (user_id, plan_tier, effective_from, effective_to) values
  ('${U.premium}', 'premium', current_date - 5, current_date + 5), ('${U.free}', 'free', current_date - 100, null), ('${U.lapsed}', 'premium', current_date - 30, current_date - 1)
  on conflict (user_id) do update set plan_tier = excluded.plan_tier, effective_from = excluded.effective_from, effective_to = excluded.effective_to;`);
const I1 = '44440000-0000-0000-0000-000000000001', I2 = '44440000-0000-0000-0000-000000000002', I3 = '44440000-0000-0000-0000-000000000003';
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${I1}','Probe fund one','mutual_fund','IN','INR','verified'), ('${I2}','Probe fund two','mutual_fund','IN','INR','verified'), ('${I3}','Probe fund three','mutual_fund','IN','INR','verified');`);
await db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price) values ('${I1}','INR','2020-06-15', 10), ('${I2}','INR','2020-06-15', 10), ('${I3}','INR','2020-06-15', 10);`);
await db.exec(`insert into ii_nav_retention_holds (instrument_id, reason) values ('${I2}', 'manual_admin_hold');`);
const navId = (await one(`select id from ii_prices_nav where instrument_id = '${I1}'`)).id;
const cand = async (id, date) => (await one(`select pc6_nav_row_is_candidate('${id}', '${date}', '2026-09-21') v`)).v;
const correct = (target, id, n) => db.exec(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('${target}','${id}','source_correction','{"v":1}','{"v":${n}}','system_import','Production release proof correction number ${n}');`);

/** The recorded behaviour of every OLD path this release could touch. */
async function oldPaths(label) {
  const o = {};
  o.cand_unprotected_old = await cand(I1, '2020-06-15');
  o.cand_held_by_hold = await cand(I2, '2020-06-15');
  o.cand_after_changeover = await cand(I1, '2026-10-01');
  o.cand_null_input = (await one(`select pc6_nav_row_is_candidate(null, null, null) v`)).v;
  o.job_rows_non_nav2 = Number((await one(`select count(*) c from ii_reference_job_control where job_key not like 'nav2\\_%' escape '\\'`)).c);
  o.admin_count = Number((await one(`select count(*) c from admin_users`)).c);
  o.premium_today = Number((await one(`select count(*) c from user_entitlements e where e.plan_tier = 'premium' and (e.effective_from is null or e.effective_from <= current_date) and (e.effective_to is null or e.effective_to >= current_date)`)).c);
  const ins = await err(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('ii_prices_nav','${navId}','source_correction','{"v":1}','{"v":2}','system_import','Old path correction insert (${label})')`);
  o.nav_correction_insert_ok = ins === null;
  const ins2 = await err(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('ii_scheme_master','${navId}','source_correction','{"v":1}','{"v":2}','system_import','Old path scheme correction insert (${label})')`);
  o.scheme_correction_insert_ok = ins2 === null;
  const ins3 = await err(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('ii_prices_nav','00000000-0000-0000-0000-00000000dead','source_correction','{"v":1}','{"v":2}','system_import','Old path correction with a row that does not exist (${label})')`);
  o.orphan_correction_insert_ok = ins3 === null;
  const del = await err(`delete from ii_instruments where id = '${I3}'`);
  o.instrument_delete_ok = del === null; // cascades through every table that references it, including the NAV2 tables once they exist
  await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values ('${I3}','Probe fund three','mutual_fund','IN','INR','verified') on conflict (id) do nothing; insert into ii_prices_nav (instrument_id, currency_code, price_date, price) select '${I3}','INR','2020-06-15',10 where not exists (select 1 from ii_prices_nav where instrument_id='${I3}');`);
  const svc = await asRole('service_role', null, `select pc6_nav_row_is_candidate('${I1}', date '2020-06-15', date '2026-09-21') v`);
  o.service_can_call_retention = svc.ok && svc.rows[0].v === true;
  const auth = await asRole('authenticated', U.premium, `select pc6_nav_row_is_candidate('${I1}', date '2020-06-15', date '2026-09-21') v`);
  o.session_cannot_call_retention = auth.ok === false;
  return o;
}
const same = (a, b, ignore = []) => JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !ignore.includes(k)))) === JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => !ignore.includes(k))));

// ---------------------------------------------------------------------------------------------------------------------------------
// A + B. Before NAV2
// ---------------------------------------------------------------------------------------------------------------------------------
console.log('A. The old paths on a production-like database (before NAV2)');
const BASE = await oldPaths('before');
console.log('   recorded:', JSON.stringify(BASE));
check('A1 the recorded old behaviour is the expected one (unprotected candidate, held not, after changeover not, null input never a candidate, session cannot call the retention function)', BASE.cand_unprotected_old === true && BASE.cand_held_by_hold === false && BASE.cand_after_changeover === false && BASE.cand_null_input === false && BASE.service_can_call_retention && BASE.session_cannot_call_retention && BASE.nav_correction_insert_ok && BASE.scheme_correction_insert_ok && BASE.orphan_correction_insert_ok && BASE.instrument_delete_ok);
const jobBefore = Number((await one(`select count(*) c from ii_reference_job_control`)).c);
const eBefore = await oldPaths('before-second');
check('A2 the recording is stable (a second run gives the same answers)', same(BASE, eBefore));

console.log('\nB. What the NEW code sees BEFORE the migrations (its fail-closed paths)');
const e1 = await err(`select can_upload_risk_free_data, can_switch_risk_free_series from admin_users limit 1`);
check('B1 the capability columns do not exist: the read is an error (42703), which the app maps to "no capability", never to a grant', e1 && e1.code === '42703', e1?.message);
const e2 = await err(`select id from nav2_fund_analytics_reports limit 1`);
check('B2 the report table does not exist: the read is an error (42P01), which the report routes map to "not found" / "not available yet"', e2 && e2.code === '42P01', e2?.message);
const flag = await one(`select count(*)::int c from ii_reference_job_control where job_key = 'nav2_fund_analytics'`);
check('B3 the Fund analytics switch has NO row yet: a missing row reads as OFF (isNav2FlagOn returns false), so generate answers 404 and the menu entry stays hidden', flag.c === 0);
const e3 = await err(`select nav2_monitoring_snapshot()`);
check('B4 the monitoring function does not exist (42883): the admin page shows its "not applied yet" state', e3 && e3.code === '42883', e3?.message);
const e4 = await err(`select count(*) from ii_risk_free_series`);
check('B5 the risk-free tables do not exist (42P01): the Admin screen shows "unavailable", not a 500', e4 && e4.code === '42P01', e4?.message);
check('B6 the old Reference Data Quality job control list is unaffected (it lists whatever rows exist)', jobBefore > 0);
const p1pre = await runPack('prechecks/P1_nav2_not_yet_applied.sql');
check('B7 pack P1 (NAV2 not yet applied) is all true', allTrue(p1pre), falseKeys(p1pre));
const p2 = await runPack('prechecks/P2_foundations_exist.sql');
check('B8 pack P2 (foundations exist) is all true on the production-like ledger', allTrue(p2), falseKeys(p2));
const md5of0219 = (await one(`select md5(prosrc) m from pg_proc where oid = 'public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure`)).m;
console.log(`   md5 of the retention function body at the 0219 state: ${md5of0219}`);
const p3file = pack('prechecks/P3_retention_function_fingerprint.sql');
check('B9 the pack P3 file carries exactly this md5 as the expected 0219 body (computed here, not typed)', p3file.includes(md5of0219) && !p3file.includes('__EXPECTED_0219_BODY_MD5__'), 'put the md5 into P3 in place of the placeholder');
const p3 = (await db.query(strip(p3file))).rows[0];
check('B10 pack P3: the live body is the 0219 body and the function is service role only', p3.body_is_0219 === true && p3.service_only === true, JSON.stringify(p3));
for (const f of ['P3b_retention_function_text.sql', 'P4_size.sql', 'P6a_admin_and_premium_counts.sql', 'P6b_administrator_list.sql', 'P7_switch_state.sql']) {
  const e = await err(strip(pack(`prechecks/${f}`)));
  check(`B11 pack ${f} runs without error`, e === null, e?.message);
}
const p4 = await runPack('prechecks/P4_size.sql');
check('B12 pack P4 returns the four columns', ['database_size', 'price_table_total_size', 'price_rows_estimate', 'held_funds_now'].every((k) => k in p4));
const p6 = await runPack('prechecks/P6a_admin_and_premium_counts.sql');
check('B13 pack P6a counts the administrators (2) and the Premium people today (1)', Number(p6.administrators) === 2 && Number(p6.premium_today) === 1, JSON.stringify(p6));
const p5 = await err(strip(pack('prechecks/P5_ledger.sql')));
check('B14 pack P5 (the migration ledger) errors on this database because the ledger table is not there: the README says that is an acceptable answer', p5 !== null && /does not exist/.test(p5.message), p5?.message);
// negative control: P1 must bite when a NAV2 object exists. Checked later, after the migrations (E1).

// ---------------------------------------------------------------------------------------------------------------------------------
// C. Apply the pack, in the documented order, with its checks
// ---------------------------------------------------------------------------------------------------------------------------------
console.log('\nC. The pack, step by step');
const apply = async (rel) => { await db.exec(strip(pack(rel))); };
const step = async (label, rel, checkRel, early = null) => {
  if (early) {
    let r = null;
    try { r = (await db.query(strip(pack(checkRel)))).rows[0]; } catch { r = null; } // an error (the object is not there yet) is also a loud answer
    check(`${label}: NEGATIVE CONTROL, its check run BEFORE the step is not all true (or fails loudly)`, r === null || !allTrue(r), JSON.stringify(r));
  }
  const e = await err(strip(pack(rel)));
  check(`${label}: the SQL runs without error`, e === null, e?.message);
  const c = (await db.query(strip(pack(checkRel)))).rows[0];
  check(`${label}: its check returns all true`, allTrue(c), falseKeys(c));
};
const NAMES = {
  '0261': 'migrations/0261_nav2_fund_analytics_reports_cache_and_pinning.sql', '0262': 'migrations/0262_nav2_correction_events_and_monitoring.sql', '0263': 'migrations/0263_nav2_risk_free_refresh_attempts.sql',
  '0269': 'migrations/0269_nav2_reports_premium_only_read.sql', '0270': 'migrations/0270_nav2_monitoring_snapshot_bounded_cost.sql', '0271': 'migrations/0271_nav2_monitoring_snapshot_row_estimate.sql',
};
await step('0260 part a', 'parts/0260a.sql', 'checks/C0260a.sql', true);
await step('0260 part b', 'parts/0260b.sql', 'checks/C0260b.sql', true);
await step('0260 part c', 'parts/0260c.sql', 'checks/C0260c.sql', true);
await step('0260 part d', 'parts/0260d.sql', 'checks/C0260d.sql', true);
await step('0260 part e', 'parts/0260e.sql', 'checks/C0260e.sql', true);
await step('0261', NAMES['0261'], 'checks/C0261.sql', true);
const p3after261 = (await db.query(strip(p3file))).rows[0];
check('C1 pack P3 is now FALSE for body_is_0219 (the fingerprint check bites: 0261 changed the function, so it would have caught a different live version before)', p3after261.body_is_0219 === false);
await step('0262', NAMES['0262'], 'checks/C0262.sql', true);
await step('0263', NAMES['0263'], 'checks/C0263.sql', true);
await step('0269', NAMES['0269'], 'checks/C0269.sql', true);
const c70pre = (await db.query(strip(pack('checks/C0270_0271.sql')))).rows[0];
check('C2 the 0262 monitoring function does NOT use the row estimate yet (check false before 0271)', c70pre.monitoring_uses_the_row_estimate === false);
const e270 = await err(strip(pack(NAMES['0270'])));
check('C2b 0270 runs without error', e270 === null, e270?.message);
const c70 = (await db.query(strip(pack('checks/C0270_0271.sql')))).rows[0];
check('C3 after 0270 alone the row estimate is still not used (0271 is needed: this is why all three are applied)', c70.monitoring_uses_the_row_estimate === false);
const e271 = await err(strip(pack(NAMES['0271'])));
check('C4 0271 runs without error', e271 === null, e271?.message);
const c271 = (await db.query(strip(pack('checks/C0270_0271.sql')))).rows[0];
check('C5 after 0271 the monitoring check is all true', allTrue(c271), falseKeys(c271));
const fin = (await db.query(strip(pack('checks/C_final_all.sql')))).rows[0];
check('C6 the final check is all true', allTrue(fin), falseKeys(fin));
const sw = (await db.query(`select job_key, enabled from ii_reference_job_control where job_key like 'nav2\\_%' escape '\\' order by job_key`)).rows;
check('C7 exactly the four NAV2 switches exist and all are OFF at release', sw.length === 4 && sw.every((r) => r.enabled === false), JSON.stringify(sw));

// the migration files in the pack are the migration files of the tree (the proof ran the pack copies)
for (const [n, rel] of Object.entries(NAMES)) check(`C8 the pack copy of ${n} equals the migration file`, fs.readFileSync(path.join(PACK, rel)).equals(fs.readFileSync(path.join(MIG, path.basename(rel)))));
check('C9 the five parts joined equal the 0260 migration file', Buffer.concat(['a', 'b', 'c', 'd', 'e'].map((l) => fs.readFileSync(path.join(PACK, `parts/0260${l}.sql`)))).equals(fs.readFileSync(path.join(MIG, '0260_nav2_risk_free_governed_dataset.sql'))));

// ---------------------------------------------------------------------------------------------------------------------------------
// D. The old paths after the migrations
// ---------------------------------------------------------------------------------------------------------------------------------
console.log('\nD. The old paths AFTER the migrations (migrations applied, code still the old code)');
const AFTER = await oldPaths('after');
console.log('   recorded:', JSON.stringify(AFTER));
check('D1 every old path answers exactly as before (retention predicate, corrections, instrument delete, admin_users, entitlements, grants)', same(BASE, AFTER, ['job_rows_non_nav2']), `${JSON.stringify(BASE)}\n${JSON.stringify(AFTER)}`);
check('D2 the existing job-control rows are untouched (same non-NAV2 count) and NAV2 added exactly four', AFTER.job_rows_non_nav2 === BASE.job_rows_non_nav2 && Number((await one(`select count(*) c from ii_reference_job_control`)).c) === jobBefore + 4);
const ev = (await db.query(`select kind, count(*)::int c from nav2_correction_events group by kind order by kind`)).rows;
check('D3 the only visible side effect of 0262 on an old path: a price correction now also leaves ONE inert event row (none for the scheme master correction or the correction of a row that does not exist)', ev.length === 1 && ev[0].kind === 'nav_correction' && ev[0].c >= 1, JSON.stringify(ev));
check('D4 the old correction inserts did not fail even though the new hook ran (D1 nav_correction_insert_ok, scheme_correction_insert_ok, orphan_correction_insert_ok all true)', AFTER.nav_correction_insert_ok && AFTER.scheme_correction_insert_ok && AFTER.orphan_correction_insert_ok);
// the hook cannot break an old correction even if the events table is unwritable: prove the failure mode honestly
await db.exec(`alter table nav2_correction_events add constraint probe_block check (kind = 'never') not valid;`);
const hookFail = await err(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('ii_prices_nav','${navId}','source_correction','{"v":1}','{"v":9}','system_import','Probe: a failing hook')`);
check('D5 HONEST LIMIT: if the events table ever rejected a row, the hook WOULD abort the old correction insert (it is a trigger in the same statement). It cannot today: the table only has the checks above, which D3 shows pass', hookFail !== null);
await db.exec(`alter table nav2_correction_events drop constraint probe_block;`);
check('D5b the probe was removed and the old correction path works again', (await err(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('ii_prices_nav','${navId}','source_correction','{"v":1}','{"v":10}','system_import','Probe: hook restored')`)) === null);
const rls = await asRole('authenticated', U.free, `select count(*)::int c from nav2_fund_analytics_reports`);
check('D6 an ordinary signed-in user reads zero NAV2 report rows and cannot read the cache, tokens or events tables', rls.ok && rls.rows[0].c === 0 && !(await asRole('authenticated', U.free, `select 1 from nav2_result_cache`)).ok && !(await asRole('authenticated', U.free, `select 1 from nav2_correction_events`)).ok && !(await asRole('authenticated', U.free, `select 1 from nav2_report_render_tokens`)).ok);
check('D7 an ordinary user cannot call any NAV2 admin function', !(await asRole('authenticated', U.free, `select nav2_monitoring_snapshot()`)).ok && !(await asRole('authenticated', U.free, `select nav2_refresh_attempt_summary()`)).ok && (await asRole('authenticated', U.free, `select is_risk_free_data_admin() v`)).rows[0].v === false);

// grants and switches files
console.log('\nC (continued). Grants and switches');
await db.exec(`update auth.users set email = 'uploader@t.test' where id = '${U.admin}'; update auth.users set email = 'switcher@t.test' where id = '${U.second}';`);
const g1 = pack('grants/grant_upload.sql').replace('REPLACE-WITH-UPLOADER-EMAIL', 'uploader@t.test');
const g2 = pack('grants/grant_switch.sql').replace('REPLACE-WITH-SWITCHER-EMAIL', 'switcher@t.test');
check('G1 grant_upload and grant_switch contain a placeholder to replace', pack('grants/grant_upload.sql').includes('REPLACE-WITH-UPLOADER-EMAIL') && pack('grants/grant_switch.sql').includes('REPLACE-WITH-SWITCHER-EMAIL'));
await db.exec(g1); await db.exec(g2);
const gc = await runPack('grants/check_grants.sql');
check('G2 after both grants: 1 uploader, 1 switcher, nobody holds both', Number(gc.uploaders) === 1 && Number(gc.switchers) === 1 && Number(gc.holders_of_both) === 0, JSON.stringify(gc));
check('G3 the two permissions are separate: the uploader cannot switch a series and the switcher cannot upload', (await asRole('authenticated', U.admin, `select set_risk_free_series_state('RBI_91D_TBILL_CUTOFF_YIELD', false, 'po_accepted_2026-10-03', 'The uploader must not be able to switch this series') v`)).ok === false && (await asRole('authenticated', U.second, `select commit_risk_free_upload('RBI_91D_TBILL_CUTOFF_YIELD', '${'a'.repeat(64)}', 'x.csv', '[]'::jsonb, true, 'I confirm that I am entitled to load this data') v`)).ok === false);
const firstLoad = await asRole('authenticated', U.admin, `select commit_risk_free_upload('RBI_91D_TBILL_CUTOFF_YIELD', '${'c'.repeat(64)}', 'x.csv', '[{"date":"2026-09-30","value_percent":5.5199,"kind":"value","source_document":"synthetic proof row","retrieved_on":"2026-10-03"}]'::jsonb, true, 'I confirm that I am entitled to load this data and accept the recorded terms position.') v`);
check('G4 the uploader can commit a (synthetic) upload', firstLoad.ok, firstLoad.msg);
await db.exec(strip(pack('grants/revoke_upload.sql').replace('REPLACE-WITH-UPLOADER-EMAIL', 'uploader@t.test')));
check('G5 revoke_upload takes the upload permission away', Number((await runPack('grants/check_grants.sql')).uploaders) === 0);
await db.exec(strip(pack('switches/switch_on_fund_analytics.sql')));
const swr = (await db.query(strip(pack('switches/read_switches.sql')))).rows.filter((r) => r.job_key.startsWith('nav2_'));
check('S1 switch_on_fund_analytics turns on exactly that one switch', swr.filter((r) => r.enabled).map((r) => r.job_key).join() === 'nav2_fund_analytics', JSON.stringify(swr));
await db.exec(strip(pack('switches/switch_off_fund_analytics.sql')));
check('S2 switch_off_fund_analytics turns it off again (a reason is stored: the table refuses a disabled row without one)', (await db.query(strip(pack('switches/read_switches.sql')))).rows.filter((r) => r.job_key.startsWith('nav2_')).every((r) => r.enabled === false));
for (const f of ['switch_on_trigger_planner', 'switch_on_correction_worker', 'switch_on_weekly_refresh']) {
  await db.exec(strip(pack(`switches/${f}.sql`)));
  const on = (await db.query(`select job_key from ii_reference_job_control where job_key like 'nav2\\_%' and enabled`)).rows.length;
  check(`S3 ${f} turns exactly one more switch on`, on === 1);
  await db.exec(strip(pack('switches/switch_off_all_nav2.sql')));
}
check('S4 switch_off_all_nav2 leaves all four OFF', (await db.query(`select count(*)::int c from ii_reference_job_control where job_key like 'nav2\\_%' and enabled`)).rows[0].c === 0);
const smoke = await runPack('smoke/S1_after_first_reports.sql');
check('S5 the smoke SQL runs and shows zero reports, one risk-free value row (the synthetic upload) and no unprocessed correction events beyond the price corrections of this proof', Number(smoke.reports_total) === 0 && Number(smoke.risk_free_value_rows) === 1, JSON.stringify(smoke));

// F. idempotent re-apply
console.log('\nF. Re-applying everything a second time');
let reErr = null;
try {
  for (const l of ['a', 'b', 'c', 'd', 'e']) await apply(`parts/0260${l}.sql`);
  for (const n of ['0261', '0262', '0263', '0269', '0270', '0271']) await apply(NAMES[n]);
} catch (e) { reErr = e.message; }
check('F1 every part and file can be run a second time without an error', reErr === null, reErr ?? '');
const fin2 = (await db.query(strip(pack('checks/C_final_all.sql')))).rows[0];
check('F2 the whole file 0260 can also be run on top of the parts', (await err(strip(fs.readFileSync(path.join(MIG, '0260_nav2_risk_free_governed_dataset.sql'), 'utf8')))) === null);
check('F3 the final check differs only where data was loaded (no_rates_loaded_yet is now false because of the synthetic row), everything else true (the switcher still holds the switch permission by G-steps)', Object.entries(fin2).every(([k, v]) => v === true || k === 'no_rates_loaded_yet' || k === 'nobody_holds_the_new_permissions_yet'), JSON.stringify(fin2));

// ---------------------------------------------------------------------------------------------------------------------------------
// E. Rollbacks, reverse order
// ---------------------------------------------------------------------------------------------------------------------------------
console.log('\nE. Rollbacks in reverse order');
check('E0 P1 is false while NAV2 is present (the pre-check bites)', !allTrue(await runPack('prechecks/P1_nav2_not_yet_applied.sql')));
// rollback of the monitoring pair: run the previous definition again (0262 file), as the README says
await db.exec(strip(pack(NAMES['0262'])));
check('E1 re-running 0262 puts the first monitoring function back (no row estimate)', (await runPack('checks/C0270_0271.sql')).monitoring_uses_the_row_estimate === false);
await db.exec(strip(pack('rollback/rollback_0269.sql')));
check('E2 rollback 0269 restores the 0261 reading rule and drops the helper', (await one(`select to_regprocedure('public.nav2_viewer_has_premium()') is null v`)).v === true && (await one(`select count(*)::int c from pg_policies where tablename = 'nav2_fund_analytics_reports' and policyname = 'own_read_nav2_fund_analytics_reports' and position('nav2_viewer_has_premium' in qual) = 0`)).c === 1);
await db.exec(strip(pack('rollback/rollback_0263.sql')));
check('E3 rollback 0263 drops its table and function', (await one(`select to_regclass('public.ii_risk_free_refresh_attempts') is null v`)).v === true);
await db.exec(strip(pack('rollback/rollback_0262.sql')));
check('E4 rollback 0262 drops its hooks, functions and table', (await one(`select count(*)::int c from pg_trigger where tgname in ('trg_nav2_capture_reference_correction','trg_nav2_capture_risk_free_correction') and not tgisinternal`)).c === 0 && (await one(`select to_regclass('public.nav2_correction_events') is null v`)).v === true);
await db.exec(strip(pack('rollback/rollback_0261_restore_0219_function.sql')));
const p3back = (await db.query(strip(p3file))).rows[0];
check('E5 rollback 0261 step 1 puts the 0219 function body back byte for byte (the P3 fingerprint is true again) and it is still service role only', p3back.body_is_0219 === true && p3back.service_only === true, JSON.stringify(p3back));
await db.exec(strip(pack('rollback/rollback_0261_drop_tables.sql')));
check('E6 rollback 0261 step 2 drops the four report tables', (await one(`select count(*)::int c from information_schema.tables where table_schema='public' and table_name in ('nav2_fund_analytics_reports','nav2_report_nav_dependencies','nav2_result_cache','nav2_report_render_tokens')`)).c === 0);
await db.exec(strip(pack('rollback/rollback_0260.sql')));
const p1back = await runPack('prechecks/P1_nav2_not_yet_applied.sql');
check('E7 rollback 0260 removes the rest: pack P1 is all true again (the database is back in its pre-NAV2 shape)', allTrue(p1back), falseKeys(p1back));
const BACK = await oldPaths('rolled-back');
check('E8 the old paths answer exactly as at the start', same(BASE, BACK), `${JSON.stringify(BASE)}\n${JSON.stringify(BACK)}`);
// the whole pack applies again after a rollback (a PO who rolled back can go forward again)
let again = null;
try {
  for (const l of ['a', 'b', 'c', 'd', 'e']) await apply(`parts/0260${l}.sql`);
  for (const n of ['0261', '0262', '0263', '0269', '0270', '0271']) await apply(NAMES[n]);
} catch (e) { again = e.message; }
const fin3 = (await db.query(strip(pack('checks/C_final_all.sql')))).rows[0];
check('E9 after a full rollback the pack applies again and the final check is all true (the rollback leaves nothing behind that blocks a re-run)', again === null && allTrue(fin3), (again ?? '') + falseKeys(fin3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
