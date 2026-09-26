// NAV 1 completion (2026-09-25) -- PGlite verification for migration 0199
// (the hydration attempt ledger behind fair, least-recently-attempted ordering).
//
// Anti-vacuity first: just before 0199 the table does not exist, so the live
// job's ledger read must fail there -- which is exactly the case the job's
// rotation fallback exists for. Then 0199: the exact column set the live code
// writes, upsert semantics, constraints, FK cascade, RLS, idempotent reapply,
// and that no shared constraint was touched.
//
// Run: node scripts/nav1_0199_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0199_nav1_hydration_attempt_ledger.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const before = files.filter((f) => f < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations) -- 0199 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  NAV1-0199-${String(seq).padStart(2, '0')}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };

const INST = '33330000-0000-0000-0000-000000000199';
const INST2 = '33330000-0000-0000-0000-000000000299';
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INST}','0199 probe','mutual_fund','IN','INR','verified'), ('${INST2}','0199 probe 2','mutual_fund','IN','INR','verified');`);

// --- Anti-vacuity ---------------------------------------------------------------
const pre = await err(`select * from ii_nav_hydration_attempts limit 1`);
check('ANTI-VACUITY: before 0199 the ledger table does not exist (the job must fall back, and does -- see nav1HydrationFairOrdering 5c)', pre !== null && /does not exist/.test(pre), pre ?? 'table unexpectedly present');
const constraintsBefore = (await db.query(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid <> 0 and conrelid::regclass::text <> 'ii_nav_hydration_attempts' order by conname`)).rows;

// --- Apply ------------------------------------------------------------------------
await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
let reapplyErr = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapplyErr = e.message; }
check('0199 applies, and a second apply is a clean no-op', reapplyErr === null, reapplyErr ?? '');

// The exact column set selectiveHistoricalHydrationJobLive.ts recordAttempt() upserts.
const LIVE = fs.readFileSync(path.resolve(HERE, '..', 'lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive.ts'), 'utf8');
const upsertBlock = LIVE.slice(LIVE.indexOf(".from('ii_nav_hydration_attempts')\n        .upsert("));
const liveCols = [...upsertBlock.slice(0, upsertBlock.indexOf('onConflict')).matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
const tableCols = (await db.query(`select column_name from information_schema.columns where table_name = 'ii_nav_hydration_attempts'`)).rows.map((r) => r.column_name);
check('every column the live code writes exists (a missing one would lose every attempt record)',
  liveCols.length >= 8 && liveCols.every((c) => tableCols.includes(c)), `live writes: ${liveCols.join(', ')}`);
const readCols = (LIVE.match(/select\('instrument_id, last_attempted_at[^']*'\)/) || [''])[0].replace(/select\('|'\)/g, '').split(',').map((s) => s.trim());
check('every column the live code reads exists', readCols.length === 6 && readCols.every((c) => tableCols.includes(c)), readCols.join(', '));

// --- Upsert semantics, as the live code uses them ----------------------------------------
const upsert = (outcome, fails, total, success) => `insert into ii_nav_hydration_attempts
  (instrument_id, last_attempted_at, last_outcome, last_detail, consecutive_failures, attempts_total, last_success_at, updated_at)
  values ('${INST}', now(), '${outcome}', 'd', ${fails}, ${total}, ${success}, now())
  on conflict (instrument_id) do update set last_attempted_at = excluded.last_attempted_at, last_outcome = excluded.last_outcome,
    last_detail = excluded.last_detail, consecutive_failures = excluded.consecutive_failures, attempts_total = excluded.attempts_total,
    last_success_at = excluded.last_success_at, updated_at = excluded.updated_at returning instrument_id`;
const r1 = await db.query(upsert('fetch_failed', 1, 1, 'null'));
const r2 = await db.query(upsert('hydrated', 0, 2, 'now()'));
const row = await one(`select last_outcome, consecutive_failures, attempts_total, last_success_at is not null s, (select count(*)::int from ii_nav_hydration_attempts) n from ii_nav_hydration_attempts where instrument_id='${INST}'`);
check('an upsert returns its row (so a zero-row write is detectable) and a second attempt updates, not duplicates',
  r1.rows.length === 1 && r2.rows.length === 1 && row.n === 1 && row.last_outcome === 'hydrated' && row.attempts_total === 2 && row.consecutive_failures === 0 && row.s === true, JSON.stringify(row));

// --- Constraints ------------------------------------------------------------------------
check('an unknown outcome is rejected', (await err(upsert('bogus', 0, 1, 'null'))) !== null);
check('a negative failure streak is rejected', (await err(upsert('fetch_failed', -1, 1, 'null'))) !== null);
check('attempts_total must be >= 1', (await err(upsert('fetch_failed', 1, 0, 'null'))) !== null);
check('a record for an instrument that does not exist is rejected (FK)',
  (await err(`insert into ii_nav_hydration_attempts (instrument_id, last_attempted_at, last_outcome) values ('44440000-0000-0000-0000-000000000000', now(), 'fetch_failed')`)) !== null);
await db.exec(`insert into ii_nav_hydration_attempts (instrument_id, last_attempted_at, last_outcome) values ('${INST2}', now(), 'fetch_failed')`);
await db.exec(`delete from ii_instruments where id = '${INST2}'`);
check('deleting an instrument deletes its attempt record (cascade)', (await one(`select count(*)::int c from ii_nav_hydration_attempts where instrument_id='${INST2}'`)).c === 0);

// --- Access ------------------------------------------------------------------------------
check('RLS is enabled', (await one(`select relrowsecurity r from pg_class where relname='ii_nav_hydration_attempts'`)).r === true);
const asAuth = async (sql) => {
  try { await db.exec(`set role authenticated`); const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, msg: e.message }; }
  finally { await db.exec('reset role'); }
};
const authRead = await asAuth(`select count(*)::int c from ii_nav_hydration_attempts`);
check('a non-admin authenticated user reads nothing', authRead.ok && authRead.rows[0].c === 0, JSON.stringify(authRead));
const authWrite = await asAuth(`insert into ii_nav_hydration_attempts (instrument_id, last_attempted_at, last_outcome) values ('${INST}', now(), 'fetch_failed') on conflict do nothing`);
check('a non-admin authenticated user cannot write', !authWrite.ok, JSON.stringify(authWrite));

// --- No shared constraint touched -------------------------------------------------------
const constraintsAfter = (await db.query(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid <> 0 and conrelid::regclass::text <> 'ii_nav_hydration_attempts' order by conname`)).rows;
check('no constraint on any OTHER table changed (0199 widens nothing)', JSON.stringify(constraintsBefore) === JSON.stringify(constraintsAfter),
  `${constraintsBefore.length} before, ${constraintsAfter.length} after`);

console.log(`\n=== NAV 1 / 0199 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
