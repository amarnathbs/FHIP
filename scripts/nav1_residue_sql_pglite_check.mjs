// NAV 1 -- validates the residue-cleanup SQL in docs/nav1/po_run_2026-10-01_residue/
// against real Postgres semantics in PGlite (the full migration chain, so
// pc6_nav_row_is_candidate / pc6_user_held_instrument_ids are the REAL 0200
// definitions), on synthetic rows. Nothing here touches any real database.
//
// Proves: 01 and 03 run and report the expected numbers; 02 deletes exactly the
// residue (pre-changeover, created on/after 2026-09-30, candidate) and nothing
// else; a held / held-by-hold instrument's identically-dated rows survive; a
// rerun deletes 0; and every self-check refuses (raises, deletes nothing) when
// its condition is violated. NEGATIVE CONTROLS show the same delete WITHOUT the
// live predicate would have destroyed protected rows.
//
// Run: node scripts/nav1_residue_sql_pglite_check.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const DOCS = path.resolve(HERE, '..', 'docs/nav1/po_run_2026-10-01_residue');
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
const n = async (q) => (await one(q)).n;
const err = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };

const USER = 'aaaa0000-0000-0000-0000-00000000f001', ACC = 'cccc0000-0000-0000-0000-00000000f001';
const id = (i) => `77770000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`;
const DORMANT = [1, 2, 3, 4, 5].map(id); // unheld: residue
const OLD = id(10);      // unheld, row created BEFORE the residue window
const CURRENT = id(11);  // unheld, post-changeover row
const HELD = id(12);     // user-held
const HOLD = id(13);     // unheld but under an open retention hold

await db.exec(`insert into auth.users(id,email) values ('${USER}','f@t.test')`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}'`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ${[...DORMANT, OLD, CURRENT, HELD, HOLD].map((i) => `('${i}','r ${i.slice(-2)}','mutual_fund','IN','INR','verified')`).join(',')}`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values ('${ACC}','${USER}','IN','INR','demat','x')`);
await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount) values ('${USER}','${ACC}','${HELD}','INR','purchase','2020-01-01',1)`);
await db.exec(`insert into ii_nav_retention_holds (instrument_id, reason, expires_at, released_at) values ('${HOLD}','manual_admin_hold', now() + interval '10 days', null)`);
await db.exec(`insert into ii_nav_retention_policy (policy_version, changeover_date, environment) values ('nav1-0189-user-held', date '2026-09-21', 'production')`);

const px = (inst, date, createdAt) => db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, quality_status, created_at, data_version)
  values ('${inst}','INR',date '${date}',10,'ok', timestamptz '${createdAt}', 'pc6-amfi-parser-v1:abc')`);
const dates = ['2014-03-07', '2016-11-02', '2019-05-20', '2023-01-31', '2026-09-05'];
for (let i = 0; i < 5; i++) await px(DORMANT[i], dates[i], i % 2 ? '2026-09-30 03:32:09+00' : '2026-10-01 03:40:00+00'); // residue
await px(OLD, '2015-02-02', '2026-09-20 03:30:00+00');       // pre-C but created before the window
await px(CURRENT, '2026-09-24', '2026-10-01 03:30:00+00');   // post-C
await px(CURRENT, '2026-09-21', '2026-10-01 03:30:00+00');   // exactly C
await px(HELD, '2015-06-01', '2026-09-30 03:32:00+00');      // pre-C, in the window, but held
await px(HELD, '2026-09-24', '2026-10-01 03:30:00+00');
await px(HOLD, '2015-06-01', '2026-09-30 03:32:00+00');      // pre-C, in the window, open hold

const sql01 = fs.readFileSync(path.join(DOCS, '01_verify_before_delete.sql'), 'utf8');
const sql02 = fs.readFileSync(path.join(DOCS, '02_delete_residue.sql'), 'utf8');
const sql03 = fs.readFileSync(path.join(DOCS, '03_verify_after_delete.sql'), 'utf8');
const total = () => n(`select count(*)::int n from ii_prices_nav`);
const heldRows = () => n(`select count(*)::int n from ii_prices_nav where instrument_id in ('${HELD}','${HOLD}')`);

console.log('\n01 (read-only) runs and reports the seeded residue:');
const r01 = await db.exec(sql01);
const res = r01.find((r) => r.fields.some((f) => f.name === 'residue_rows')).rows[0];
check('01 runs as written (4 result sets)', r01.length === 4, `${r01.length} result sets`);
check('01: residue_rows = 7 (5 dormant + HELD + HOLD rows in the window)', Number(res.residue_rows) === 7, JSON.stringify(res));
check('01: candidate_rows = 5 and protected_rows = 2', Number(res.candidate_rows) === 5 && Number(res.protected_rows) === 2);
check('01: one residue row is dated 2026-09-01..20, the rest before', Number(res.sep_01_to_20) === 1 && Number(res.before_2026_09_01) === 6);
check('01: the whole-table non-held candidate count is 6 (5 residue + the OLD row, which 02 must NOT touch)',
  Number(r01.find((r) => r.fields.some((f) => f.name === 'non_held_pre_changeover_candidates')).rows[0].non_held_pre_changeover_candidates) === 6);

const before = await total();
const heldBefore = await heldRows();

console.log('\nNEGATIVE CONTROL -- the same delete WITHOUT the live predicate:');
await db.exec('begin');
const naive = await db.query(`delete from ii_prices_nav where price_date < date '2026-09-21' and created_at >= timestamptz '2026-09-30 00:00:00+00' returning instrument_id`);
await db.exec('rollback');
check('a date-only delete would have removed the HELD and HOLD rows too (7 rows) -- the predicate is what protects them', naive.rows.length === 7);
check('(rolled back: nothing changed)', (await total()) === before);

console.log('\nSelf-checks refuse, and delete nothing:');
await db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, quality_status, created_at)
  select '${DORMANT[0]}', 'INR', date '2010-01-01' + g, 10, 'ok', timestamptz '2026-09-30 03:00:00+00' from generate_series(0, 1499) g`);
const ceilingErr = await err(sql02);
check('more than 1,500 candidates: REFUSES with the ceiling message', !!ceilingErr && /exceed the 1500 ceiling/.test(ceilingErr), ceilingErr?.slice(0, 120));
check('...and nothing was deleted', (await total()) === before + 1500);
await db.exec(`delete from ii_prices_nav where price_date >= date '2010-01-01' and price_date < date '2014-03-07'`);
check('(fixture restored)', (await total()) === before);

await db.exec(`update ii_nav_retention_policy set changeover_date = date '2026-09-01'`);
const policyErr = await err(sql02);
check('wrong production changeover date: REFUSES', !!policyErr && /no production ii_nav_retention_policy row/.test(policyErr), policyErr?.slice(0, 100));
await db.exec(`update ii_nav_retention_policy set changeover_date = date '2026-09-21'`);

await db.exec(`create table _txn_bak as select * from ii_transactions; delete from ii_transactions;`);
const heldErr = await err(sql02);
await db.exec(`insert into ii_transactions select * from _txn_bak; drop table _txn_bak;`);
check('predicate cannot see holdings (held set empty): REFUSES', !!heldErr && /pc6_user_held_instrument_ids\(\) is empty/.test(heldErr), heldErr?.slice(0, 100));
check('...and nothing was deleted by any refused run', (await total()) === before);

console.log('\n02 runs:');
const e02 = await err(sql02);
check('02 executes cleanly', e02 === null, e02 ?? '');
check('exactly the 5 residue rows are gone', (await total()) === before - 5);
check('all 5 dormant-instrument rows deleted', (await n(`select count(*)::int n from ii_prices_nav where instrument_id in (${DORMANT.map((d) => `'${d}'`).join(',')})`)) === 0);
check('the pre-window OLD row survives (created before 2026-09-30)', (await n(`select count(*)::int n from ii_prices_nav where instrument_id = '${OLD}'`)) === 1);
check('post-changeover rows (incl. exactly C) survive', (await n(`select count(*)::int n from ii_prices_nav where instrument_id = '${CURRENT}'`)) === 2);
check('held and open-hold instruments\' rows are identical before/after', (await heldRows()) === heldBefore && heldBefore === 3);

console.log('\nIdempotent:');
const e02b = await err(sql02);
check('running 02 again succeeds and deletes nothing', e02b === null && (await total()) === before - 5, e02b ?? '');

console.log('\n03 (read-only) after the delete:');
const r03 = await db.exec(sql03.replace("timestamptz '2026-10-01 00:00:00+00'  -- <-- set to the deploy-finished time (UTC)", "timestamptz '2026-10-01 00:00:00+00'"));
const v = (name) => r03.find((r) => r.fields.some((f) => f.name === name)).rows[0][name];
check('03 runs as written (6 result sets)', r03.length === 6, `${r03.length} result sets`);
check('03: residue candidates remaining = 0', Number(v('residue_candidates_remaining_expect_0')) === 0);
check('03: non-held pre-changeover candidates = 1 (the OLD row, deliberately out of scope) ', Number(v('non_held_pre_changeover_candidates_expect_0')) === 1);
check('03: held instrument rows unchanged', Number(v('held_instrument_rows_expect_ge_85485')) === 2);
check('03: no pre-changeover candidate written by the daily parser since the deploy stamp', Number(v('daily_parser_pre_changeover_since_deploy_expect_0')) === 0);

console.log(`\n=== NAV 1 residue SQL (PGlite): ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
