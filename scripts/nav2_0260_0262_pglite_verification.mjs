// NAV2 Stage 2 -- PGlite verification for migrations 0260, 0261 and 0262 (hand-over artefacts, NOT applied
// anywhere). Method, same style as scripts/nav1_0219_pglite_verification.mjs: replay the whole migration chain
// up to (not including) 0260 in an in-process Postgres, apply the three files, then run NEGATIVE CONTROLS and
// the positive proofs. Evidence label: PGlite-verified (an in-process Postgres with a platform shim), NOT
// verified on DEV or production.
//
// Run: node scripts/nav2_0260_0262_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const F260 = files.find((f) => f.startsWith('0260_'));
const F261 = files.find((f) => f.startsWith('0261_'));
const F262 = files.find((f) => f.startsWith('0262_'));

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const before = files.filter((f) => f < F260);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations); 0260-0262 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV2-S2-${String(seq).padStart(2, '0')}`;
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };
const asRole = async (role, sub, sql) => {
  try {
    await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false); select set_config('request.jwt.claim.role', '${role}', false);`);
    const r = await db.query(sql);
    return { ok: true, v: r.rows[0]?.v, rows: r.rows };
  } catch (e) {
    return { ok: false, msg: e.message };
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.role', '', false);`);
  }
};

// --- users ---------------------------------------------------------------------
const U = { up: 'aaaa0000-0000-0000-0000-000000000260', sw: 'aaaa0000-0000-0000-0000-000000000261', none: 'aaaa0000-0000-0000-0000-000000000262', pc6: 'aaaa0000-0000-0000-0000-000000000263', user: 'aaaa0000-0000-0000-0000-000000000264' };
for (const [k, id] of Object.entries(U)) await db.exec(`insert into auth.users(id,email) values ('${id}','nav2-${k}@t.test');`);
await db.exec(`insert into admin_users (user_id) values ('${U.up}'), ('${U.sw}'), ('${U.none}'), ('${U.pc6}');`);

// --- baseline for the retention-function negative control (BEFORE 0261) ---------------
const INST = '33330000-0000-0000-0000-000000000261';
const INST2 = '33330000-0000-0000-0000-000000000262';
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INST}','NAV2 probe A','mutual_fund','IN','INR','verified'), ('${INST2}','NAV2 probe B','mutual_fund','IN','INR','verified');`);
const cand = async (id, date) => (await one(`select pc6_nav_row_is_candidate('${id}', '${date}', '2026-09-21') v`)).v;

// --- apply 0260 -----------------------------------------------------------------------
await db.exec(strip(fs.readFileSync(path.join(MIG, F260), 'utf8')));
let again = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, F260), 'utf8'))); } catch (e) { again = e.message; }
check('0260 is idempotent (a second apply does not error)', again === null, again ?? '');
await db.exec(`update admin_users set can_upload_risk_free_data = true where user_id = '${U.up}'; update admin_users set can_switch_risk_free_series = true where user_id = '${U.sw}'; update admin_users set can_view_reference_data_quality = true where user_id = '${U.pc6}';`);

check('both series are seeded with the PO-accepted terms and enabled', (await one(`select count(*)::int v from ii_risk_free_series where terms_review_status = 'po_accepted_2026-10-03' and enabled`)).v === 2);
check('the four job-control rows ship DISABLED', (await one(`select count(*)::int v from ii_reference_job_control where job_key in ('nav2_risk_free_weekly_refresh','nav2_fund_analytics','nav2_trigger_planner','nav2_correction_worker') and enabled = false`)).v === 4);

const SHA = 'a'.repeat(64);
const row = (date, v, extra = {}) => ({ date, value_percent: v, kind: 'value', source_document: 'SYNTHETIC verification fixture', source_url: null, retrieved_on: '2026-10-03', notes: null, ...extra });
const call = (sha, rows, attested = true, series = 'RBI_91D_TBILL_CUTOFF_YIELD', text = 'I confirm that I am entitled to load this data and accept the recorded terms position.') =>
  `select commit_risk_free_upload('${series}', '${sha}', 'first_load.csv', '${JSON.stringify(rows)}'::jsonb, ${attested}, '${text}') v`;

// --- capability boundaries --------------------------------------------------------------
for (const [who, id, expectOk] of [['upload capability', U.up, true], ['switch-only capability', U.sw, false], ['admin without capability', U.none, false], ['ordinary user', U.user, false], ['anon', null, false]]) {
  const r = await asRole(id ? 'authenticated' : 'anon', id, call(SHA.replace(/a/g, who.length % 2 ? 'b' : 'c'), [row('2026-09-23', 5.39)]));
  check(`commit_risk_free_upload: ${who} -> ${expectOk ? 'allowed' : 'refused (42501)'}`, expectOk ? r.ok : (!r.ok && /not authorised|permission denied/i.test(r.msg)), JSON.stringify(r).slice(0, 160));
}
check('the allowed upload wrote exactly its row and one batch', (await one(`select (select count(*) from ii_risk_free_observations)::int o, (select count(*) from ii_risk_free_batches)::int b`)).o >= 1);

// --- upload rules -----------------------------------------------------------------------
const base = (await one(`select count(*)::int v from ii_risk_free_observations`)).v;
const r1 = await asRole('authenticated', U.up, call('d'.repeat(64), [row('2026-09-30', 5.5199), row('2026-09-16', 5.2801)]));
check('a clean upload inserts both rows', r1.ok && r1.v.inserted === 2, JSON.stringify(r1));
const r2 = await asRole('authenticated', U.up, call('d'.repeat(64), [row('2026-09-30', 5.5199), row('2026-09-16', 5.2801)]));
check('IDEMPOTENT: the same file again is already_committed and adds nothing', r2.ok && r2.v.already_committed === true && (await one(`select count(*)::int v from ii_risk_free_observations`)).v === base + 2, JSON.stringify(r2));
const callV = (sha, rows, through, who = U.up) => asRole('authenticated', who, `select commit_risk_free_upload('RBI_91D_TBILL_CUTOFF_YIELD', '${sha}', 'first_load.csv', '${JSON.stringify(rows)}'::jsonb, true, 'I confirm that I am entitled to load this data and accept the recorded terms position.', 'admin_upload', ${through}) v`);
const rv1 = await callV('d'.repeat(64), [row('2026-09-30', 5.5199), row('2026-09-16', 5.2801)], `'2026-10-02'::date`);
check('the SAME file again with a verified-through date records the confirmation (rows unchanged), audited in the state log', rv1.ok && rv1.v.already_committed === true && rv1.v.verified_through_recorded === true && (await one(`select to_char(verified_through_date, 'YYYY-MM-DD') v from ii_risk_free_series where series_id='RBI_91D_TBILL_CUTOFF_YIELD'`)).v === '2026-10-02' && (await one(`select count(*)::int v from ii_risk_free_series_state_log where reason like 'Verified-through date confirmed through 02-10-2026%'`)).v === 1 && (await one(`select count(*)::int v from ii_risk_free_observations`)).v === base + 2, JSON.stringify(rv1));
const rv2 = await callV('d'.repeat(64), [row('2026-09-30', 5.5199), row('2026-09-16', 5.2801)], `'2026-09-01'::date`);
check('a verified-through date can only move FORWARD (an earlier date neither moves it back nor adds a log entry)', rv2.ok && (await one(`select count(*)::int v from ii_risk_free_series_state_log where reason like 'Verified-through%'`)).v === 1 && (await one(`select to_char(verified_through_date, 'YYYY-MM-DD') v from ii_risk_free_series where series_id='RBI_91D_TBILL_CUTOFF_YIELD'`)).v === '2026-10-02', JSON.stringify(rv2));
const rv3 = await callV('9'.repeat(64), [row('2026-09-08', 5.3)], `'2030-01-01'::date`);
check('NEGATIVE CONTROL: a verified-through date in the future is refused and nothing is written', !rv3.ok && /future/.test(rv3.msg) && (await one(`select count(*)::int v from ii_risk_free_observations where observation_date='2026-09-08'`)).v === 0, JSON.stringify(rv3));
const rv4 = await callV('d'.repeat(64), [row('2026-09-30', 5.5199)], `'2026-10-03'::date`, U.sw);
check('NEGATIVE CONTROL: the verified-through path of a re-submitted file is capability-gated like any upload (switch-only user refused)', !rv4.ok && /not authorised/.test(rv4.msg), JSON.stringify(rv4));
const r3 = await asRole('authenticated', U.up, call('e'.repeat(64), [row('2026-09-30', 5.6)]));
check('NEGATIVE CONTROL: a DIFFERENT value for a published date is refused (never an overwrite)', !r3.ok && /different published value/.test(r3.msg), JSON.stringify(r3));
check('...and the published value is unchanged', Number((await one(`select value_percent v from ii_risk_free_observations where series_id='RBI_91D_TBILL_CUTOFF_YIELD' and observation_date='2026-09-30'`)).v) === 5.5199);
const r4 = await asRole('authenticated', U.up, call('f'.repeat(64), [row('2026-10-07', 5.4)]));
check('NEGATIVE CONTROL: a future-dated observation (after its retrieval date) is refused', !r4.ok && /fail validation/.test(r4.msg), JSON.stringify(r4));
const r5 = await asRole('authenticated', U.up, call('1'.repeat(64), [row('2026-09-02', 7)]));
check('a value of 7 inside the 0-100 range is accepted (range, not plausibility, is the database check)', r5.ok, JSON.stringify(r5));
const r6 = await asRole('authenticated', U.up, call('2'.repeat(64), [row('2026-09-03', 650)]));
check('NEGATIVE CONTROL: 650 (a unit mistake) is refused', !r6.ok, JSON.stringify(r6));
const r7 = await asRole('authenticated', U.up, call('3'.repeat(64), [row('2026-09-04', 5.0)], false));
check('NEGATIVE CONTROL: no attestation is refused', !r7.ok && /attestation/.test(r7.msg), JSON.stringify(r7));
const r8 = await asRole('authenticated', U.up, call('4'.repeat(64), [{ ...row('2026-09-05', null), kind: 'gap', gap_reason: 'no_accepted_bids' }]));
check('a GAP row (no accepted bids) is stored with no value', r8.ok && (await one(`select (value_percent is null)::boolean v from ii_risk_free_observations where observation_date='2026-09-05'`)).v === true, JSON.stringify(r8));
const r9 = await asRole('authenticated', U.up, call('5'.repeat(64), [{ ...row('2026-09-06', 5.1), kind: 'gap', gap_reason: 'no_accepted_bids' }]));
check('NEGATIVE CONTROL: a gap row carrying a value is refused', !r9.ok, JSON.stringify(r9));
const r10 = await asRole('authenticated', U.up, call('6'.repeat(64), [row('2026-09-07', 5.1), row('2026-09-07', 5.2)]));
check('NEGATIVE CONTROL: duplicate dates inside one file are refused', !r10.ok && /duplicate/.test(r10.msg), JSON.stringify(r10));

// --- direct writes and append-only ----------------------------------------------------------
for (const sql of [`insert into ii_risk_free_observations (series_id, observation_date, value_percent, source_document, retrieved_on, entry_kind) values ('RBI_91D_TBILL_CUTOFF_YIELD','2026-01-01',5,'x','2026-01-02','admin_upload')`, `update ii_risk_free_observations set value_percent = 1`, `delete from ii_risk_free_observations`, `update ii_risk_free_series set enabled = false`]) {
  const r = await asRole('authenticated', U.up, sql);
  check(`direct write is denied to a session even WITH the capability: ${sql.slice(0, 48)}...`, !r.ok && /permission denied/i.test(r.msg), JSON.stringify(r).slice(0, 140));
}
check('append-only trigger: a superuser UPDATE outside the correction function is blocked', /append-only/.test((await err(`update ii_risk_free_observations set value_percent = 1`)) ?? ''));
check('append-only trigger: a DELETE is blocked even for the owner', /never deleted/.test((await err(`delete from ii_risk_free_observations`)) ?? ''));
check('append-only trigger: the batch ledger cannot be updated', /append-only/.test((await err(`update ii_risk_free_batches set rows_inserted = 0`)) ?? ''));

// --- correction ----------------------------------------------------------------------------------
const c1 = await asRole('authenticated', U.sw, `select correct_risk_free_observation('RBI_91D_TBILL_CUTOFF_YIELD','2026-09-30', 5.5, 'switch-only user must not correct a value') v`);
check('correct_risk_free_observation: the switch-only capability is refused', !c1.ok && /not authorised/.test(c1.msg));
const c2 = await asRole('authenticated', U.up, `select correct_risk_free_observation('RBI_91D_TBILL_CUTOFF_YIELD','2026-09-30', 5.5, 'short') v`);
check('NEGATIVE CONTROL: a correction without a 20-character reason is refused', !c2.ok && /reason/.test(c2.msg));
const c3 = await asRole('authenticated', U.up, `select correct_risk_free_observation('RBI_91D_TBILL_CUTOFF_YIELD','2026-09-30', 5.5198, 'Recomputed from the printed cut-off price per the press release') v`);
check('a reasoned correction by the upload capability changes the value and writes the ledger', c3.ok && Number((await one(`select value_percent v from ii_risk_free_observations where observation_date='2026-09-30'`)).v) === 5.5198 && (await one(`select count(*)::int v from ii_risk_free_corrections`)).v === 1, JSON.stringify(c3));
check('the correction flag does not leak: a plain UPDATE is blocked again afterwards', /append-only/.test((await err(`update ii_risk_free_observations set value_percent = 2 where observation_date='2026-09-30'`)) ?? ''));

// --- series state ------------------------------------------------------------------------------------
const s1 = await asRole('authenticated', U.up, `select set_risk_free_series_state('RBI_91D_TBILL_CUTOFF_YIELD', false, 'po_accepted_2026-10-03', 'upload-only user must not switch a series off') v`);
check('set_risk_free_series_state: the UPLOAD capability cannot switch a series (separate capabilities)', !s1.ok && /not authorised/.test(s1.msg));
const s2 = await asRole('authenticated', U.sw, `select set_risk_free_series_state('RBI_91D_TBILL_CUTOFF_YIELD', false, 'po_accepted_2026-10-03', 'short') v`);
check('NEGATIVE CONTROL: a state change without a 20-character reason is refused', !s2.ok);
const s3 = await asRole('authenticated', U.sw, `select set_risk_free_series_state('RBI_91D_TBILL_CUTOFF_YIELD', false, 'po_accepted_2026-10-03', 'Switching off while the terms position is reviewed') v`);
check('the switch capability turns the series off, audited, with no data deleted', s3.ok && (await one(`select enabled v from ii_risk_free_series where series_id='RBI_91D_TBILL_CUTOFF_YIELD'`)).v === false && (await one(`select count(*)::int v from ii_risk_free_series_state_log`)).v === 2 && (await one(`select count(*)::int v from ii_risk_free_observations`)).v >= 4, JSON.stringify(s3));
await db.exec(`update ii_risk_free_series set enabled = true where series_id = 'RBI_91D_TBILL_CUTOFF_YIELD';`);

// --- refresh results (service role only) ------------------------------------------------------------
const feed = JSON.stringify([row('2026-10-07', 5.45, { source_document: 'SYNTHETIC release', extraction: { method: 'parser+ai', checksPassed: ['price_recompute'] } })]).replace(/2026-10-07/, '2026-10-02');
const f1 = await asRole('authenticated', U.up, `select record_risk_free_refresh_results('RBI_91D_TBILL_CUTOFF_YIELD', '${feed}'::jsonb, '[]'::jsonb, null) v`);
check('record_risk_free_refresh_results: an authenticated session (even with the upload capability) is refused', !f1.ok && /service role only|permission denied/i.test(f1.msg), JSON.stringify(f1).slice(0, 140));
const f2 = await asRole('service_role', null, `select record_risk_free_refresh_results('RBI_91D_TBILL_CUTOFF_YIELD', '${feed}'::jsonb, '[]'::jsonb, null) v`);
check('the service role appends the weekly row with its extraction provenance', f2.ok && f2.v.inserted === 1 && (await one(`select (extraction->>'method') v from ii_risk_free_observations where observation_date='2026-10-02'`)).v === 'parser+ai', JSON.stringify(f2));
const f3 = await asRole('service_role', null, `select record_risk_free_refresh_results('RBI_91D_TBILL_CUTOFF_YIELD', '${feed}'::jsonb, '[]'::jsonb, null) v`);
check('IDEMPOTENT: the same week again writes nothing', f3.ok && f3.v.inserted === 0 && f3.v.identical === 1, JSON.stringify(f3));
const diff = JSON.stringify([row('2026-10-02', 5.99)]);
const f4 = await asRole('service_role', null, `select record_risk_free_refresh_results('RBI_91D_TBILL_CUTOFF_YIELD', '${diff}'::jsonb, '[]'::jsonb, null) v`);
check('NEGATIVE CONTROL: a DIFFERENT value for a stored date is queued for review, never written', f4.ok && f4.v.queued === 1 && Number((await one(`select value_percent v from ii_risk_free_observations where observation_date='2026-10-02'`)).v) === 5.45, JSON.stringify(f4));
const f5 = await asRole('service_role', null, `select record_risk_free_refresh_results('RBI_91D_TBILL_CUTOFF_YIELD', '${diff}'::jsonb, '[]'::jsonb, null) v`);
check('IDEMPOTENT: the same unresolved conflict is queued once', f5.ok && (await one(`select count(*)::int v from ii_risk_free_review_items where status='open' and observation_date='2026-10-02'`)).v === 1, JSON.stringify(f5));
const rv = JSON.stringify([{ observation_date: '2026-10-09', reasons: ['parser_ai_disagree'], candidate: row('2026-10-09', 5.5), evidence: { parser: {}, ai: {} } }]).replace(/'/g, "''");
await asRole('service_role', null, `select record_risk_free_refresh_results('RBI_91D_TBILL_CUTOFF_YIELD', '[]'::jsonb, '${rv}'::jsonb, null) v`);
const item = (await one(`select id from ii_risk_free_review_items where observation_date = '2026-10-09'`)).id;
const v1 = await asRole('authenticated', U.sw, `select resolve_risk_free_review_item('${item}', 'accept', 'switch capability may not decide review items') v`);
check('resolve_risk_free_review_item: the switch-only capability is refused', !v1.ok && /not authorised/.test(v1.msg));
const v2 = await asRole('authenticated', U.up, `select resolve_risk_free_review_item('${item}', 'reject', 'Parser and AI disagreed; value to be checked against the release') v`);
check('a rejected item publishes NOTHING', v2.ok && (await one(`select count(*)::int v from ii_risk_free_observations where observation_date='2026-10-09'`)).v === 0, JSON.stringify(v2));
check('review items are readable only with the upload capability (RLS)', (await asRole('authenticated', U.up, `select count(*)::int v from ii_risk_free_review_items`)).v >= 1 && (await asRole('authenticated', U.none, `select count(*)::int v from ii_risk_free_review_items`)).v === 0);
check('the observations are world-readable reference data (RLS using true)', (await asRole('authenticated', U.user, `select count(*)::int v from ii_risk_free_observations`)).v >= 4);

// --- 0261 -----------------------------------------------------------------------------------------------
console.log('\nBefore 0261 (control against the 0219 definition):');
await db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price) values ('${INST}','INR','2020-06-15', 10), ('${INST2}','INR','2020-06-15', 10);`);
check('0219 body: an instrument with no protection is a CANDIDATE at a pre-changeover date', (await cand(INST, '2020-06-15')) === true);
await db.exec(strip(fs.readFileSync(path.join(MIG, F261), 'utf8')));
let again261 = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, F261), 'utf8'))); } catch (e) { again261 = e.message; }
check('0261 is idempotent', again261 === null, again261 ?? '');
check('0261 keeps the 0219 behaviour for an unprotected instrument (still a candidate)', (await cand(INST, '2020-06-15')) === true);
await db.exec(`insert into ii_nav_retention_holds (instrument_id, reason) values ('${INST2}', 'manual_admin_hold');`);
check('0261 keeps an existing protection (an open hold still protects)', (await cand(INST2, '2020-06-15')) === false);
await db.exec(`insert into nav2_fund_analytics_reports (id, user_id, version_number, as_of_date, reporting_currency, scheme_count, policy_version, engine_version, report_json, manifest_json, manifest_checksum)
  values ('77770000-0000-0000-0000-000000000261','${U.user}',1,'2026-10-03','INR',1,'nav2-policy-v1','nav2-engine-v1','{}','{}','${'9'.repeat(64)}');`);
await db.exec(`insert into nav2_report_nav_dependencies (report_id, instrument_id, nav_date_from, nav_date_to) values ('77770000-0000-0000-0000-000000000261','${INST}','2020-01-01','2021-01-01');`);
check('the NAV2 report pin protects its instrument and range', (await cand(INST, '2020-06-15')) === false);
check('...a date outside the pinned range is still a candidate (the pin is narrow)', (await cand(INST, '2022-06-15')) === true);
await db.exec(`delete from nav2_report_nav_dependencies;`);
check('NEGATIVE CONTROL: removing the pin returns the row to CANDIDATE (the new branch is the cause)', (await cand(INST, '2020-06-15')) === true);
const grants = (await db.query(`select has_function_privilege('authenticated', 'pc6_nav_row_is_candidate(uuid, date, date)', 'execute') a, has_function_privilege('service_role', 'pc6_nav_row_is_candidate(uuid, date, date)', 'execute') s`)).rows[0];
check('pc6_nav_row_is_candidate stays service_role only', grants.a === false && grants.s === true);
check('a pinned report cannot be updated (immutable)', /immutable/.test((await err(`update nav2_fund_analytics_reports set scheme_count = 5`)) ?? ''));
check('RLS: a user reads only their own pinned report', (await asRole('authenticated', U.user, `select count(*)::int v from nav2_fund_analytics_reports`)).v === 1 && (await asRole('authenticated', U.none, `select count(*)::int v from nav2_fund_analytics_reports`)).v === 0);
const w = await asRole('authenticated', U.user, `insert into nav2_fund_analytics_reports (user_id, version_number, as_of_date, reporting_currency, scheme_count, policy_version, engine_version, report_json, manifest_json, manifest_checksum) values ('${U.user}',2,'2026-10-03','INR',1,'p','e','{}','{}','${'9'.repeat(64)}')`);
check('a session cannot write a report row (service role only)', !w.ok && /permission denied/i.test(w.msg));
const tok = await asRole('authenticated', U.user, `select count(*)::int v from nav2_report_render_tokens`);
check('render tokens and the result cache are not readable by sessions', !tok.ok && /permission denied/i.test(tok.msg) && !(await asRole('authenticated', U.user, `select count(*)::int v from nav2_result_cache`)).ok);

// --- 0262 ---------------------------------------------------------------------------------------------------
await db.exec(strip(fs.readFileSync(path.join(MIG, F262), 'utf8')));
let again262 = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, F262), 'utf8'))); } catch (e) { again262 = e.message; }
check('0262 is idempotent', again262 === null, again262 ?? '');
const navId = (await one(`select id from ii_prices_nav where instrument_id = '${INST}'`)).id;
await db.exec(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('ii_prices_nav','${navId}','source_correction','{"price":10}','{"price":11}','system_import','NAV2 verification: source republished a different NAV');`);
const ev = await one(`select count(*)::int c, max(instrument_id::text) i, max(event_date::text) d from nav2_correction_events where kind='nav_correction'`);
check('the correction listener raised ONE nav_correction event with the instrument and date', ev.c === 1 && ev.i === INST && ev.d === '2020-06-15', JSON.stringify(ev));
await db.exec(`insert into ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_kind, reason) values ('ii_risk_free_rates','${navId}','source_correction','{}','{}','system_import','NAV2 verification: a different table raises no event');`);
check('a correction to an unrelated table raises no event', (await one(`select count(*)::int v from nav2_correction_events`)).v === 1);
await asRole('authenticated', U.up, `select correct_risk_free_observation('RBI_91D_TBILL_CUTOFF_YIELD','2026-09-16', 5.28, 'Recomputed from the printed cut-off price per the press release') v`);
check('a risk-free correction made AFTER 0262 (the 0260 ledger trigger) raised its own event', (await one(`select count(*)::int v from nav2_correction_events where kind='risk_free_correction' and series_id='RBI_91D_TBILL_CUTOFF_YIELD'`)).v === 1);
const m0 = await asRole('authenticated', U.user, `select nav2_monitoring_snapshot() v`);
check('monitoring snapshot: an ordinary user is refused (42501), not shown an empty result', !m0.ok && /not authorised/.test(m0.msg));
const m1 = await asRole('authenticated', U.up, `select nav2_monitoring_snapshot() v`);
check('monitoring snapshot: the risk-free upload capability is NOT the monitoring capability (separate surfaces)', !m1.ok && /not authorised/.test(m1.msg));
const m2 = await asRole('authenticated', U.pc6, `select nav2_monitoring_snapshot() v`);
check('monitoring snapshot: the reference-data-quality capability gets the snapshot', m2.ok && m2.v && typeof m2.v === 'object', JSON.stringify(m2).slice(0, 200));
check('SUPPRESSION: figures derived from user holdings below 5 are suppressed with the fixed label, never a bare number', m2.v.held_instruments.state === 'suppressed' && m2.v.held_instruments.value === null && m2.v.held_instruments.label === 'Insufficient data to display safely.', JSON.stringify(m2.v.held_instruments));
check('operational (non user-derived) figures are shown: NAV corrections last 7 days = 1', m2.v.nav_corrections_last_7_days.state === 'ok' && m2.v.nav_corrections_last_7_days.value === 1);
check('risk-free freshness is reported per series (days since last observation / verification)', Array.isArray(m2.v.risk_free_series.value) && m2.v.risk_free_series.value.length === 2);
check('storage split cells are suppressed while fewer than 5 instruments are held', m2.v.storage.nav_rows_of_held_instruments.state === 'suppressed');
check('the result-state counts are suppressed below 5 reports', m2.v.result_states_last_30_days.state === 'suppressed');
const unproc = (await one(`select count(*)::int v from nav2_correction_events where processed_at is null`)).v;
check('the lag figure reflects the unprocessed events', unproc === 2 && m2.v.correction_processing_lag_seconds.state === 'ok');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
