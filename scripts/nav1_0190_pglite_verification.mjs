// NAV 1 Stage D — PGlite verification for migration 0190 (per-instrument
// history floor).
//
// The access check is deliberately NON-vacuous: a real row is inserted first
// and the superuser is shown to see it, so "an ordinary user sees 0 rows"
// can only pass because RLS hid the row -- not because the table was empty.
// (The 0172 suite's equivalent check reads a table after an insert it expects
// to fail, so its "0 rows" would pass with RLS switched off.)
//
// Run: node scripts/nav1_0190_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0190_nav1_history_floor.sql';

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
for (const f of files) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete -- ${files.length} migrations, ending at ${files.at(-1)}\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-0190-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const err = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message || String(e); } };
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;
async function asUser(userId, sql) {
  await db.exec(`select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false); set role authenticated;`);
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role;'); }
}

check('chain applied from empty through 0190', files.includes(TARGET));
check('0190 is idempotent -- a second apply does not error', (await err(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')))) === null);

const ORDINARY = 'aaaa0000-0000-0000-0000-000000000190';
const ADMIN = 'bbbb0000-0000-0000-0000-000000000190';
const INSTRUMENT = '11110000-0000-0000-0000-000000000190';
for (const [id, email] of [[ORDINARY, 'ordinary-0190@t.test'], [ADMIN, 'admin-0190@t.test']]) {
  await db.exec(`insert into auth.users(id,email) values ('${id}','${email}');`);
}
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INSTRUMENT}','0190 Probe Fund','mutual_fund','IN','INR','verified');`);
const adminErr = await err(`insert into admin_users (user_id, can_view_reference_data_quality) values ('${ADMIN}', true);`);
check('a reference-data admin could be seeded', adminErr === null, adminErr ?? '');

// --- Shape ----------------------------------------------------------------------
const cols = Object.fromEntries((await all(`select column_name, is_nullable from information_schema.columns where table_name = 'ii_nav_history_floors'`)).map((r) => [r.column_name, r.is_nullable]));
check('floor_date and confirmed_by are required', cols.floor_date === 'NO' && cols.confirmed_by === 'NO', JSON.stringify(cols));
check('one floor per instrument (instrument_id is the primary key)',
  (await one(`select count(*)::int n from pg_constraint where conrelid = 'ii_nav_history_floors'::regclass and contype = 'p'`)).n === 1);
check('a missing floor_date is refused',
  (await err(`insert into ii_nav_history_floors (instrument_id, confirmed_by) values ('${INSTRUMENT}','test')`)) !== null);

await db.exec(`insert into ii_nav_history_floors (instrument_id, floor_date, confirmed_by, detail) values
  ('${INSTRUMENT}', '2018-03-01', 'pc6_selective_hydration', 'probe');`);
check('a second floor for the same instrument is refused (upsert is the only way to change it)',
  (await err(`insert into ii_nav_history_floors (instrument_id, floor_date, confirmed_by) values ('${INSTRUMENT}','2019-01-01','test')`)) !== null);
const upsertErr = await err(`insert into ii_nav_history_floors (instrument_id, floor_date, confirmed_by) values ('${INSTRUMENT}','2017-06-01','pc6_selective_hydration')
  on conflict (instrument_id) do update set floor_date = excluded.floor_date, confirmed_at = now()`);
check('the conflict target the live code uses (instrument_id) works for an upsert', upsertErr === null, upsertErr ?? '');

// --- Access: NON-vacuous -------------------------------------------------------
const superSees = (await all(`select instrument_id from ii_nav_history_floors`)).length;
check('the row genuinely exists (anti-vacuity for the RLS checks below)', superSees === 1, `superuser sees ${superSees}`);
check('RLS is enabled', (await one(`select relrowsecurity r from pg_class where relname = 'ii_nav_history_floors'`)).r === true);
const ordinarySees = (await asUser(ORDINARY, 'select instrument_id from ii_nav_history_floors')).length;
check('an ordinary user cannot read it', ordinarySees === 0, `ordinary sees ${ordinarySees}`);
const adminSees = (await asUser(ADMIN, 'select instrument_id from ii_nav_history_floors')).length;
check('a reference-data admin CAN read it', adminSees === 1, `admin sees ${adminSees}`);
const ordinaryWrite = await asUser(ORDINARY, `insert into ii_nav_history_floors (instrument_id, floor_date, confirmed_by) values ('${INSTRUMENT}','2010-01-01','x') returning instrument_id`).catch((e) => e.message);
check('an ordinary user cannot write a floor (no insert policy)', typeof ordinaryWrite === 'string', String(ordinaryWrite).slice(0, 90));

// --- Lifecycle -------------------------------------------------------------------
await db.exec(`delete from ii_instruments where id = '${INSTRUMENT}'`);
check('deleting the instrument removes its floor (no orphan)',
  (await one(`select count(*)::int n from ii_nav_history_floors where instrument_id = '${INSTRUMENT}'`)).n === 0);

// --- Retention is untouched -------------------------------------------------------
const candSrc = (await one(`select prosrc from pg_proc where proname = 'pc6_nav_row_is_candidate'`)).prosrc;
check('retention never consults the floor (it only bounds what hydration fetches)', !candSrc.includes('ii_nav_history_floors'));

console.log(`\n=== NAV 1 / 0190 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
