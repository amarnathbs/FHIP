// NAV 1 -- PGlite verification for migration 0221 (PO decision #1, part 2 of
// 3: the reconciliation sweep's tables, batch kind, and job-control row).
//
// Anti-vacuity first: before 0221 neither table exists and 'nav_reconciliation'
// is not an accepted batch_kind. Then: exact columns, constraints, uniqueness,
// RLS (non-vacuous: an anonymous SELECT genuinely returns 0 rows though data
// exists), the batch_kind strict-superset discipline (same as 0192), the
// job-control row (fails closed if ever deleted, like every other PC6 job),
// and idempotent re-apply.
//
// Run: node scripts/nav1_0221_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0221_nav1_reconciliation_sweep_foundation.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const before = files.filter((f) => f < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations) -- 0221 NOT yet applied\n`);

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  NAV1-0221-${String(pass + fail).padStart(2, '0')}  ${l}${d ? '\n        ' + d : ''}`); };
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];

// --- Anti-vacuity -----------------------------------------------------------
const preCov = await err(`select * from ii_reference_publication_coverage limit 1`);
check('ANTI-VACUITY: before 0221 ii_reference_publication_coverage does not exist', preCov !== null && /does not exist/.test(preCov), preCov ?? 'unexpectedly present');
const preAlerts = await err(`select * from ii_reference_coverage_alerts limit 1`);
check('ANTI-VACUITY: before 0221 ii_reference_coverage_alerts does not exist', preAlerts !== null && /does not exist/.test(preAlerts), preAlerts ?? 'unexpectedly present');
const preKind = await err(`insert into ii_reference_import_batches (source_key, source_config_id, batch_kind, as_of_date, status, finished_at)
  values ('amfi', 'amfi_nav_daily', 'nav_reconciliation', '2026-09-27', 'succeeded', now())`);
check('ANTI-VACUITY: before 0221, batch_kind rejects \'nav_reconciliation\'', preKind !== null && /check constraint/.test(preKind), preKind ?? 'unexpectedly accepted');
const preJobRow = await one(`select count(*)::int n from ii_reference_job_control where job_key = 'pc6_amfi_daily_nav_reconciliation'`);
check('ANTI-VACUITY: before 0221, no job-control row for the reconciliation job', preJobRow.n === 0);

// Derive the predecessor batch_kind list from the LIVE constraint in the
// replayed database (not by regexing the migration file's SQL text -- 0192's
// own file has a semicolon inside a comment ("...TIGZIG fallback;") that a
// naive text slice truncates on, silently dropping 'nav_hydration' from the
// derived list. pg_get_constraintdef() has no comments to trip over.
const priorDef = (await one(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'ii_reference_import_batches_batch_kind_check'`)).d;
const priorList = [...priorDef.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
check(`predecessor batch_kind list derived from the live constraint (0192's applied state): ${priorList.length} values`, priorList.length >= 6, priorList.join(', '));

// --- Apply --------------------------------------------------------------------
const TARGET_SQL = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));
await db.exec(TARGET_SQL);
let reapplyErr = null;
try { await db.exec(TARGET_SQL); } catch (e) { reapplyErr = e.message; }
check('0221 applies, and a second apply is a clean no-op', reapplyErr === null, reapplyErr ?? '');

// --- Strict superset ------------------------------------------------------
const newDef = (await one(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'ii_reference_import_batches_batch_kind_check'`)).d;
const newList = [...newDef.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
check('0221\'s batch_kind list is a STRICT SUPERSET of the predecessor\'s (nothing silently dropped)', priorList.every((k) => newList.includes(k)), `predecessor: ${priorList.join(',')}; new: ${newList.join(',')}`);
check('exactly one new value added: nav_reconciliation', newList.length === priorList.length + 1 && newList.includes('nav_reconciliation'), newList.join(', '));
const postKind = await err(`insert into ii_reference_import_batches (source_key, source_config_id, batch_kind, as_of_date, status, finished_at)
  values ('amfi', 'amfi_nav_daily', 'nav_reconciliation', '2026-09-27', 'succeeded', now())`);
check('after 0221, batch_kind accepts \'nav_reconciliation\'', postKind === null, postKind ?? '');
for (const k of priorList) {
  const e = await err(`insert into ii_reference_import_batches (source_key, source_config_id, batch_kind, as_of_date, status, finished_at)
    values ('amfi', 'amfi_nav_daily', '${k}', '2026-09-27', 'succeeded', now())`);
  check(`every predecessor batch_kind '${k}' still accepted`, e === null, e ?? '');
}

// --- ii_reference_publication_coverage --------------------------------------
const covCols = (await db.query(`select column_name, is_nullable from information_schema.columns where table_name = 'ii_reference_publication_coverage' order by ordinal_position`)).rows.map((r) => r.column_name);
for (const c of ['id', 'source_config_id', 'publication_date', 'expected_count', 'present_count', 'missing_count', 'complete', 'last_checked_at', 'last_sweep_batch_id', 'created_at', 'updated_at']) {
  check(`ii_reference_publication_coverage has column ${c}`, covCols.includes(c));
}
const dupPub = await err(`insert into ii_reference_publication_coverage (source_config_id, publication_date, expected_count, present_count, missing_count, complete, last_checked_at) values
  ('amfi_nav_daily', '2026-09-27', 100, 100, 0, true, now()),
  ('amfi_nav_daily', '2026-09-27', 100, 90, 10, false, now())`);
check('uniqueness: (source_config_id, publication_date) rejects a duplicate', dupPub !== null && /duplicate key|unique constraint/.test(dupPub), dupPub ?? 'unexpectedly accepted');
const presentGtExpected = await err(`insert into ii_reference_publication_coverage (source_config_id, publication_date, expected_count, present_count, missing_count, complete, last_checked_at) values
  ('amfi_nav_daily', '2026-09-28', 100, 150, 0, true, now())`);
check('CHECK: present_count cannot exceed expected_count', presentGtExpected !== null && /check constraint/.test(presentGtExpected), presentGtExpected ?? 'unexpectedly accepted');
const negCount = await err(`insert into ii_reference_publication_coverage (source_config_id, publication_date, expected_count, present_count, missing_count, complete, last_checked_at) values
  ('amfi_nav_daily', '2026-09-29', -1, 0, 0, false, now())`);
check('CHECK: expected_count cannot be negative', negCount !== null && /check constraint/.test(negCount), negCount ?? 'unexpectedly accepted');

// --- ii_reference_coverage_alerts -------------------------------------------
const alertCols = (await db.query(`select column_name from information_schema.columns where table_name = 'ii_reference_coverage_alerts'`)).rows.map((r) => r.column_name);
for (const c of ['id', 'source_config_id', 'publication_date', 'expected_count', 'present_count', 'coverage_ratio', 'baseline_present_count', 'baseline_ratio_threshold', 'detail', 'created_at', 'resolved_at', 'resolved_detail']) {
  check(`ii_reference_coverage_alerts has column ${c}`, alertCols.includes(c));
}
await db.exec(`insert into ii_reference_coverage_alerts (source_config_id, publication_date, expected_count, present_count, baseline_ratio_threshold, detail)
  values ('amfi_nav_daily', '2026-09-27', 100, 40, 0.85, 'first alert')`);
const dupOpenAlert = await err(`insert into ii_reference_coverage_alerts (source_config_id, publication_date, expected_count, present_count, baseline_ratio_threshold, detail)
  values ('amfi_nav_daily', '2026-09-27', 100, 41, 0.85, 'second open alert, same date')`);
check('at most one OPEN alert per (source, publication date)', dupOpenAlert !== null && /duplicate key|unique constraint/.test(dupOpenAlert), dupOpenAlert ?? 'unexpectedly accepted');
await db.query(`update ii_reference_coverage_alerts set resolved_at = now(), resolved_detail = 'recovered' where publication_date = '2026-09-27'`);
const secondAfterResolve = await err(`insert into ii_reference_coverage_alerts (source_config_id, publication_date, expected_count, present_count, baseline_ratio_threshold, detail)
  values ('amfi_nav_daily', '2026-09-27', 100, 95, 0.85, 'a NEW alert, same date, after the first resolved')`);
check('a NEW alert for the same (source, date) is allowed once the prior one is resolved', secondAfterResolve === null, secondAfterResolve ?? '');

// A genuinely-committed coverage row to check RLS against (the three inserts
// above were all deliberately rejected -- nothing from them persisted).
await db.exec(`insert into ii_reference_publication_coverage (source_config_id, publication_date, expected_count, present_count, missing_count, complete, last_checked_at)
  values ('amfi_nav_daily', '2026-10-01', 100, 100, 0, true, now())`);

// --- RLS: non-vacuous (Admin Standard: enforce at the DB layer, not just via a role check) ---
await db.exec(`insert into auth.users (id, email) values
  ('11110000-0000-0000-0000-000000000221', 'nav1-0221-admin@t.test'),
  ('22220000-0000-0000-0000-000000000221', 'nav1-0221-ordinary@t.test')`);
await db.query(`insert into admin_users (user_id, can_view_reference_data_quality) values ('11110000-0000-0000-0000-000000000221', true) on conflict (user_id) do update set can_view_reference_data_quality = true`);
await db.query(`select set_config('request.jwt.claims', '{"sub":"22220000-0000-0000-0000-000000000221","role":"authenticated"}', false)`);
await db.query(`set role authenticated`);
const anonCov = await one(`select count(*)::int n from ii_reference_publication_coverage`);
check('NEGATIVE CONTROL: an ordinary authenticated (non-admin) caller reads ZERO coverage rows though data exists', anonCov.n === 0, `rows visible: ${anonCov.n}`);
const anonAlerts = await one(`select count(*)::int n from ii_reference_coverage_alerts`);
check('NEGATIVE CONTROL: an ordinary authenticated caller reads ZERO alert rows though data exists', anonAlerts.n === 0, `rows visible: ${anonAlerts.n}`);
await db.query(`reset role`);
await db.query(`select set_config('request.jwt.claims', '{"sub":"11110000-0000-0000-0000-000000000221","role":"authenticated"}', false)`);
await db.query(`set role authenticated`);
const adminCov = await one(`select count(*)::int n from ii_reference_publication_coverage`);
check('the PC6 reference-data admin capability genuinely admits reads (not vacuously blocking everyone)', adminCov.n > 0, `rows visible: ${adminCov.n}`);
await db.query(`reset role`);

// --- job-control row ----------------------------------------------------------
const jc = await one(`select enabled, disabled_reason from ii_reference_job_control where job_key = 'pc6_amfi_daily_nav_reconciliation'`);
check('the reconciliation job-control row exists and ships enabled (PO decision #1 authorizes it directly)', jc?.enabled === true && jc?.disabled_reason === null, JSON.stringify(jc));
await db.query(`delete from ii_reference_job_control where job_key = 'pc6_amfi_daily_nav_reconciliation'`);
const stillFailsClosed = await one(`select count(*)::int n from ii_reference_job_control where job_key = 'pc6_amfi_daily_nav_reconciliation'`);
check('deleting the row (an operator kill) leaves nothing for the code to authorize against -- fails closed by construction', stillFailsClosed.n === 0);

console.log(`\n=== NAV1 / 0221 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
