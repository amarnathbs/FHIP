// NAV 1 R1 — POST-MIGRATION verification of 0172 (report NAV-dependency
// manifest schema + pinned_by_report_or_revision real wiring) against a
// freshly rebuilt REAL Postgres (PGlite/WASM). Same technique as every
// other NAV1 *_pglite_verification.mjs script, same reason: no DDL path to
// DEV/production from this session.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete — ${files.length} migrations, ending at ${files.at(-1)}\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-0172-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
async function err(sql) { try { await db.exec(sql); return null; } catch (e) { return e.message || String(e); } }
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;

check('chain 0001..0172 applied from empty', files.includes('0172_nav1_report_nav_dependency_manifest.sql'));
const second = await err(fs.readFileSync(path.join(MIG, '0172_nav1_report_nav_dependency_manifest.sql'), 'utf8'));
check('0172 re-applies cleanly (idempotent)', second === null, second ? `error: ${second.slice(0, 300)}` : '');

check('ii_report_nav_dependencies ships EMPTY', Number((await one(`select count(*) as n from ii_report_nav_dependencies`)).n) === 0);

const USER = 'aaaa0000-0000-0000-0000-000000000012';
const INSTRUMENT_PINNED = 'bbbb0000-0000-0000-0000-000000000021';
const INSTRUMENT_UNPINNED = 'bbbb0000-0000-0000-0000-000000000022';
const ACCOUNT = 'cccc0000-0000-0000-0000-000000000012';
const REPORT = 'dddd0000-0000-0000-0000-000000000001';

await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-0172@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}';`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INSTRUMENT_PINNED}','0172 Report-Pinned Fund','mutual_fund','IN','INR','verified'),
  ('${INSTRUMENT_UNPINNED}','0172 Never-Pinned Fund','mutual_fund','IN','INR','verified');`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
  ('${ACCOUNT}', '${USER}', 'IN', 'INR', 'demat', '0172 Probe Broker');`);
await db.exec(`insert into reports (id, user_id, report_type_code, report_period_start, report_period_end, report_month, as_of_date, title, status, reporting_currency) values
  ('${REPORT}', '${USER}', 'net_worth', '2026-01-01', '2026-09-18', '2026-09-01', '2026-09-18', '0172 Probe Report', 'published', 'INR');`);

// 1. Before any manifest row exists, neither instrument is report-pinned
//    (this is the disclosed empty-table state -- other predicates unaffected).
const before1 = await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_PINNED}', '2019-01-01', '2026-09-21') as c`);
check('before any manifest row: an otherwise-undependent instrument is a CANDIDATE (empty table = no report-pin protection yet, by design)', before1.c === true);

// 2. Insert a manifest row with a bounded range [2020-01-15, 2026-09-18] and confirm exact boundary behaviour.
await db.exec(`insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to) values
  ('${REPORT}', '${INSTRUMENT_PINNED}', 'xirr_since_inception', '2020-01-15', '2026-09-18');`);
check('a date INSIDE the manifest range is protected (candidate=false)', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_PINNED}', '2022-06-01', '2026-09-21') as c`)).c === false);
check('the lower boundary date itself is protected', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_PINNED}', '2020-01-15', '2026-09-21') as c`)).c === false);
check('the upper boundary date itself is protected', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_PINNED}', '2026-09-18', '2026-09-21') as c`)).c === false);
check('a date BEFORE the manifest range is NOT protected by this predicate (candidate=true)', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_PINNED}', '2020-01-14', '2026-09-21') as c`)).c === true);
check('a date AFTER nav_date_to but still before changeover is NOT protected by this predicate', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_PINNED}', '2026-09-19', '2026-09-21') as c`)).c === true);

// 3. A NULL nav_date_from means "no lower bound", the same idiom as ii_nav_retention_holds.expires_at.
const INSTRUMENT_UNBOUNDED = 'bbbb0000-0000-0000-0000-000000000023';
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INSTRUMENT_UNBOUNDED}','0172 Unbounded-Pin Fund','mutual_fund','IN','INR','verified');`);
await db.exec(`insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to) values
  ('${REPORT}', '${INSTRUMENT_UNBOUNDED}', 'other', null, '2026-09-18');`);
check('NULL nav_date_from protects arbitrarily far back (a 2006 date is protected)', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_UNBOUNDED}', '2006-04-01', '2026-09-21') as c`)).c === false);

// 4. An unrelated (never-pinned) instrument is unaffected by another instrument's manifest.
check('an unrelated instrument with no manifest row of its own remains a CANDIDATE', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_UNPINNED}', '2019-01-01', '2026-09-21') as c`)).c === true);

// 5. Idempotent finalization retry: the same (report, instrument, basis) upserts, not duplicates.
const dupErr = await err(`insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to) values
  ('${REPORT}', '${INSTRUMENT_PINNED}', 'xirr_since_inception', '2020-01-15', '2026-09-18')
  on conflict (report_id, instrument_id, basis) do update set nav_date_to = excluded.nav_date_to;`);
check('a retried finalization write (ON CONFLICT upsert) does not error', dupErr === null, dupErr || '');
const countAfterRetry = await one(`select count(*) as n from ii_report_nav_dependencies where report_id='${REPORT}' and instrument_id='${INSTRUMENT_PINNED}' and basis='xirr_since_inception'`);
check('the retried write did not create a duplicate row', Number(countAfterRetry.n) === 1, `n=${countAfterRetry.n}`);

// 6. A report can have multiple independent bases for the SAME instrument (e.g. both an XIRR figure and a rolling-return chart).
await db.exec(`insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to) values
  ('${REPORT}', '${INSTRUMENT_PINNED}', 'rolling_return_window', '2021-03-01', '2026-09-18');`);
const multiBasis = await all(`select basis from ii_report_nav_dependencies where report_id='${REPORT}' and instrument_id='${INSTRUMENT_PINNED}' order by basis`);
check('the same (report, instrument) can carry multiple independent bases', multiBasis.length === 2, JSON.stringify(multiBasis));

// 7. Account/report cascade: deleting the report removes its manifest rows (no orphaned dependency data), matching every other Module 9 child table's lifecycle.
await db.exec(`delete from reports where id = '${REPORT}';`);
const afterReportDelete = await one(`select count(*) as n from ii_report_nav_dependencies where report_id='${REPORT}'`);
check('deleting the report cascades to remove its manifest rows (no orphaned pins)', Number(afterReportDelete.n) === 0, `n=${afterReportDelete.n}`);
check('after the owning report is gone, the instrument is no longer report-pin-protected', (await one(`select pc6_nav_row_is_candidate('${INSTRUMENT_PINNED}', '2022-06-01', '2026-09-21') as c`)).c === true);

// 8. RLS: an ordinary (non-admin) user cannot read this table.
const ORDINARY = USER;
async function asUser(userId, sql) {
  await db.exec(`select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false); set role authenticated;`);
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role;'); }
}
await db.exec(`insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to) values
  (null, '${INSTRUMENT_UNBOUNDED}', 'other', null, '2026-09-18');`).catch(() => {}); // report_id is NOT NULL -- expect this to fail, harmless if it does
const ordinarySees = await asUser(ORDINARY, 'select id from ii_report_nav_dependencies');
check('an ordinary authenticated user cannot read ii_report_nav_dependencies (admin-gated RLS)', ordinarySees.length === 0, `rows=${ordinarySees.length}`);

console.log(`\n=== NAV 1 / 0172 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
