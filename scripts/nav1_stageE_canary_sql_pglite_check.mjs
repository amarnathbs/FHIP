// NAV 1 -- validates the Stage E canary PROPOSAL SQL (docs/nav1/
// NAV1_StageE_canary_PROPOSAL_do_not_run.sql) against real Postgres semantics
// in PGlite, on a synthetic table: it deletes only listed candidate ids, skips
// a listed id that is protected by the live predicate, never touches a held
// fund, and the batch loop terminates. Nothing here touches any real database.
//
// Run: node scripts/nav1_stageE_canary_sql_pglite_check.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); };
const one = async (q) => (await db.query(q)).rows[0];

const USER = 'aaaa0000-0000-0000-0000-00000000e001', ACC = 'cccc0000-0000-0000-0000-00000000e001';
const CAND = '66660000-0000-0000-0000-000000000001', HELD = '66660000-0000-0000-0000-000000000002', LATE = '66660000-0000-0000-0000-000000000003';
await db.exec(`insert into auth.users(id,email) values ('${USER}','e@t.test')`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}'`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${CAND}','cand','mutual_fund','IN','INR','verified'),('${HELD}','held','mutual_fund','IN','INR','verified'),('${LATE}','late-protected','mutual_fund','IN','INR','verified')`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values ('${ACC}','${USER}','IN','INR','demat','x')`);
await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount) values ('${USER}','${ACC}','${HELD}','INR','purchase','2020-01-01',1)`);
for (const id of [CAND, HELD, LATE]) {
  await db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, quality_status)
    select '${id}', 'INR', date '2019-01-01' + g, 10, 'ok' from generate_series(0, 1199) g`);
}
// The canary list: all pre-changeover rows of CAND and LATE, plus -- wrongly -- 10 rows of HELD and 5 post-changeover rows of CAND.
await db.exec(`create table nav1_canary_ids (id uuid primary key)`);
await db.exec(`insert into nav1_canary_ids select id from ii_prices_nav where instrument_id in ('${CAND}','${LATE}') and price_date < date '2021-09-21'`);
await db.exec(`insert into nav1_canary_ids select id from (select id from ii_prices_nav where instrument_id = '${HELD}' order by price_date limit 10) h`);
await db.exec(`insert into nav1_canary_ids select id from (select id from ii_prices_nav where instrument_id = '${CAND}' and price_date >= date '2021-09-21' order by price_date limit 5) x`);
// After the "manifest", LATE becomes protected (a new user holds it).
await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount) values ('${USER}','${ACC}','${LATE}','INR','purchase','2021-01-01',1)`);

const C = '2021-09-21';
const heldBefore = (await one(`select count(*)::int n from ii_prices_nav where instrument_id in ('${HELD}','${LATE}')`)).n;
const candPre = (await one(`select count(*)::int n from ii_prices_nav where instrument_id = '${CAND}' and price_date < date '${C}'`)).n;
const sql = fs.readFileSync(path.resolve(HERE, '..', 'docs/nav1/NAV1_StageE_canary_PROPOSAL_do_not_run.sql'), 'utf8');
const at = (a, b) => sql.slice(sql.indexOf(a), sql.indexOf(b) + b.length);
const setup = at('create temp table nav1_canary_queue', "at timestamptz default clock_timestamp());");
const batch = at('with taken as (', 'returning batch_no, taken, deleted;').replaceAll("date '2026-09-21'", `date '${C}'`);
check('the proposal contains the queue-consuming batch DELETE with the live-predicate guard', /pc6_nav_row_is_candidate/.test(batch) && /limit 500/.test(batch) && /delete from nav1_canary_queue/.test(batch));
await db.exec(setup.replaceAll('create temp table', 'create table'));

let total = 0, rounds = 0, anomalies = 0;
const listed = (await one(`select count(*)::int n from nav1_canary_ids`)).n;
for (;;) {
  await db.exec('begin');
  const r = (await db.query(batch)).rows[0];
  await db.exec('commit');
  rounds++;
  total += r.deleted;
  if (r.deleted !== r.taken) anomalies++;
  if ((await one(`select count(*)::int n from nav1_canary_queue`)).n === 0 || rounds > 50) break;
}
check('the queue drains: every listed id is visited exactly once', (await one(`select coalesce(sum(taken),0)::int n from nav1_canary_log`)).n === listed, `${listed} listed, ${rounds} batch(es)`);
check('batches with skipped ids are flagged as anomalies (deleted < taken) -- the operator stops on the first', anomalies > 0, `${anomalies} anomalous batch(es)`);
check('every listed CANDIDATE row was deleted', (await one(`select count(*)::int n from ii_prices_nav where instrument_id = '${CAND}' and price_date < date '${C}'`)).n === 0, `deleted ${total} of ${candPre} in ${rounds} batch(es)`);
check('exactly the candidate rows, no more', total === candPre);
check('listed rows of a fund that became held AFTER the manifest were skipped, not deleted', (await one(`select count(*)::int n from ii_prices_nav where instrument_id = '${LATE}'`)).n === 1200);
check('listed rows of an already-held fund were skipped', (await one(`select count(*)::int n from ii_prices_nav where instrument_id = '${HELD}'`)).n === 1200);
check('listed post-changeover rows were skipped', (await one(`select count(*)::int n from ii_prices_nav where instrument_id = '${CAND}' and price_date >= date '${C}'`)).n > 0);
check('protected rows unchanged in total', (await one(`select count(*)::int n from ii_prices_nav where instrument_id in ('${HELD}','${LATE}')`)).n === heldBefore);
console.log(`\n=== NAV 1 Stage E canary SQL (PGlite): ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
