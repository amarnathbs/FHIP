// NAV 1 PO decision #6 (2026-09-27) -- PGlite verification for migration
// 0223 (ii_report_nav_dependency_alerts).
//
// This migration only creates a table + RLS + indexes -- there is no
// function to negative-control against a "before" definition, so this
// script verifies: RLS (admin-read only, no non-admin access at all, since
// the table has no insert/update/delete policy for anyone), the dedup
// unique index (one open alert per report/instrument/basis; a NEW alert
// after a resolved one gets its own row), the FK behaviour on report
// deletion (cascade -- an alert cannot outlive the report it is about), and
// idempotency.
//
// Run: node scripts/nav1_0223_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0223_nav1_report_nav_dependency_alerts.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const before = files.filter((f) => f < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations) -- 0223 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-0223-${String(seq).padStart(2, '0')}`;
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };
const asRole = async (role, sub, sql) => {
  try {
    await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false);`);
    const r = await db.query(sql);
    return { ok: true, v: r.rows[0]?.v };
  } catch (e) {
    return { ok: false, msg: e.message };
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
};

await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
let reapplyErr = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapplyErr = e.message; }
check('0223 is idempotent -- a second apply does not error', reapplyErr === null, reapplyErr ?? '');

const USER = 'aaaa0000-0000-0000-0000-000000000223';
const REPORT = 'dddd0000-0000-0000-0000-000000000223';
const REPORT2 = 'dddd0000-0000-0000-0000-000000000221';
const INSTR = '44440000-0000-0000-0000-000000000223';

await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-0223@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}';`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INSTR}','0223 probe','mutual_fund','IN','INR','verified');`);
await db.exec(`insert into reports (id, user_id, report_type_code, report_period_start, report_period_end, report_month, as_of_date, title, status, reporting_currency) values
  ('${REPORT}','${USER}','net_worth','2026-01-01','2026-09-18','2026-09-01','2026-09-18','0223 Probe Report','published','INR'),
  ('${REPORT2}','${USER}','net_worth','2026-01-01','2026-09-18','2026-10-01','2026-10-18','0223 Probe Report 2','published','INR');`);

const insertAlert = (reportId, resolved = false) => db.exec(`insert into ii_report_nav_dependency_alerts
  (report_id, instrument_id, basis, nav_date_from, nav_date_to, rows_found, detail, detected_by${resolved ? ', resolved_at' : ''})
  values ('${reportId}','${INSTR}','xirr_since_inception','2013-01-28','2022-09-19', 0, '0223 probe', 'test'${resolved ? ', now()' : ''});`);

await insertAlert(REPORT);
const dupErr = await err(`insert into ii_report_nav_dependency_alerts
  (report_id, instrument_id, basis, nav_date_from, nav_date_to, rows_found, detail, detected_by)
  values ('${REPORT}','${INSTR}','xirr_since_inception','2013-01-28','2022-09-19', 0, 'second detection attempt', 'test');`);
check('a SECOND open alert for the same (report, instrument, basis) is REFUSED (dedup index)', dupErr !== null && /idx_ii_report_nav_dependency_alerts_open_dedup/.test(dupErr), dupErr ?? 'no error');

await db.exec(`update ii_report_nav_dependency_alerts set resolved_at = now(), resolution_detail = 'recovered' where report_id = '${REPORT}';`);
const afterResolve = await err(`insert into ii_report_nav_dependency_alerts
  (report_id, instrument_id, basis, nav_date_from, nav_date_to, rows_found, detail, detected_by)
  values ('${REPORT}','${INSTR}','xirr_since_inception','2013-01-28','2022-09-19', 0, 'a genuinely new break after resolution', 'test');`);
check('after resolving, a NEW alert for the same (report, instrument, basis) is allowed (its own row, not a reopen)', afterResolve === null, afterResolve ?? '');
const countAfter = (await one(`select count(*)::int c from ii_report_nav_dependency_alerts where report_id = '${REPORT}'`)).c;
check('exactly 2 rows now exist for that report: the resolved one and the new one', countAfter === 2, `count=${countAfter}`);

await insertAlert(REPORT2);
const beforeCascade = (await one(`select count(*)::int c from ii_report_nav_dependency_alerts`)).c;
await db.exec(`delete from reports where id = '${REPORT2}';`);
const afterCascade = (await one(`select count(*)::int c from ii_report_nav_dependency_alerts`)).c;
check('deleting the report CASCADES to its alert (an alert cannot outlive the report it is about)', afterCascade === beforeCascade - 1, `before=${beforeCascade} after=${afterCascade}`);

const rangeErr = await err(`insert into ii_report_nav_dependency_alerts
  (report_id, instrument_id, basis, nav_date_from, nav_date_to, rows_found, detail, detected_by)
  values ('${REPORT}','${INSTR}','xirr_since_inception','2025-01-01','2020-01-01', 0, 'inverted range', 'test');`);
check('an inverted date range (from > to) is rejected by the CHECK constraint', rangeErr !== null && /ii_report_nav_dependency_alerts_range/.test(rangeErr), rangeErr ?? 'no error');

const anonRead = await asRole('anon', null, `select count(*)::int v from ii_report_nav_dependency_alerts`);
check('RLS: anon sees zero alert rows', anonRead.ok && anonRead.v === 0, JSON.stringify(anonRead));
const authRead = await asRole('authenticated', USER, `select count(*)::int v from ii_report_nav_dependency_alerts`);
check('RLS: an ordinary authenticated user (even the report owner) sees zero alert rows -- admin-only by design', authRead.ok && authRead.v === 0, JSON.stringify(authRead));
const anonWrite = await asRole('anon', null, `insert into ii_report_nav_dependency_alerts
  (report_id, instrument_id, basis, nav_date_from, nav_date_to, rows_found, detail, detected_by)
  values ('${REPORT}','${INSTR}','tax_lot_fifo','2013-01-28','2022-09-19', 0, 'anon forging an alert', 'test') returning id as v`);
check('anon cannot INSERT an alert (no insert policy at all -- RLS blocks by default)', !anonWrite.ok, JSON.stringify(anonWrite));

console.log(`\n=== NAV 1 / 0223 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
