// NAV 1 completion (2026-09-25) -- PGlite verification for migration 0200
// (retention predicate fail-closed hardening), and the brief's P5 protection
// tests 1-10 against real Postgres semantics (RLS, grants, SQL functions).
//
// Method: replay the chain up to (not including) 0200, seed, and run the
// NEGATIVE CONTROLS against the 0189 definition -- each must reproduce its
// fail-open path. Only then apply 0200 and prove each is closed, and that
// every 0189 protection still holds.
//
// Run: node scripts/nav1_0200_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0200_nav1_retention_predicate_fail_closed.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const before = files.filter((f) => f < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations) -- 0200 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-0200-${String(seq).padStart(2, '0')}`;
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };

// --- Seed ----------------------------------------------------------------------
const USER = 'aaaa0000-0000-0000-0000-000000000200';
const USER_B = 'bbbb0000-0000-0000-0000-000000000200';
const ACCOUNT = 'cccc0000-0000-0000-0000-000000000200';
const REPORT = 'dddd0000-0000-0000-0000-000000000200';
const n = (i) => `22220000-0000-0000-0000-0000000002${String(i).padStart(2, '0')}`;
const I = {
  held: n(1),          // a current purchase
  redeemedTx: n(2),    // only a REDEMPTION transaction: fully redeemed, balance zero
  zeroSnapshot: n(3),  // only a holding snapshot with units = 0
  closedLot: n(4),     // only a tax lot with units_remaining = 0
  reportOnly: n(5),    // no holding at all, pinned by a finalized report 2020-01-01..2024-12-31
  holdActive: n(6),    // unheld, open hold
  holdReleased: n(7),  // unheld, released hold
  holdExpired: n(8),   // unheld, expired hold
  unheld: n(9),        // nobody holds it
  mergedOld: n(10),    // merged INTO `held` (ii_instruments), no user row of its own
  smMergedOld: n(11),  // merged INTO `held` via ii_scheme_master only
  chainA: n(12),       // chainA -> chainB -> held
  chainB: n(13),
  mergedUnheldOld: n(14), // merged into `unheld` -- family unprotected, must stay a candidate
  survivor: n(15),     // nobody holds it, but the fully redeemed `redeemedTx` was merged INTO it
};
const C = '2026-09-21';
const PRE = '2022-06-01';
const POST = '2026-09-23';

await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-0200@t.test'), ('${USER_B}','nav1-0200-b@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id in ('${USER}','${USER_B}');`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ${Object.entries(I).map(([k, id]) => `('${id}','0200 ${k}','mutual_fund','IN','INR','verified')`).join(',\n  ')};`);
await db.exec(`update ii_instruments set merged_into_instrument_id='${I.held}' where id='${I.mergedOld}';`);
await db.exec(`update ii_instruments set merged_into_instrument_id='${I.chainB}' where id='${I.chainA}';`);
await db.exec(`update ii_instruments set merged_into_instrument_id='${I.held}' where id='${I.chainB}';`);
await db.exec(`update ii_instruments set merged_into_instrument_id='${I.unheld}' where id='${I.mergedUnheldOld}';`);
await db.exec(`update ii_instruments set merged_into_instrument_id='${I.survivor}' where id='${I.redeemedTx}';`);
await db.exec(`insert into ii_scheme_master (instrument_id, amfi_scheme_code, scheme_name, scheme_structure, category_header_raw, lifecycle_status,
    merged_into_instrument_id, country_code, currency_code, record_checksum, effective_from)
  values ('${I.smMergedOld}', '999200', '0200 sm merged', 'open_ended', 'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)', 'merged',
    '${I.held}', 'IN', 'INR', 'x', '2020-01-01')`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
  ('${ACCOUNT}','${USER}','IN','INR','demat','0200 Probe Broker');`);
await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount) values
  ('${USER}','${ACCOUNT}','${I.held}','INR','purchase','2021-01-15',10000),
  ('${USER}','${ACCOUNT}','${I.redeemedTx}','INR','redemption','2024-03-01',12000);`);
await db.exec(`insert into ii_holding_snapshots (user_id, account_id, instrument_id, currency_code, as_of_date, units, value) values
  ('${USER}','${ACCOUNT}','${I.zeroSnapshot}','INR','2026-08-31',0,0);`);
await db.exec(`insert into ii_tax_lots (user_id, account_id, instrument_id, acquisition_date, units_acquired, units_remaining, cost_per_unit) values
  ('${USER}','${ACCOUNT}','${I.closedLot}','2019-05-01',50,0,12.5);`);
await db.exec(`insert into reports (id, user_id, report_type_code, report_period_start, report_period_end, report_month, as_of_date, title, status, reporting_currency) values
  ('${REPORT}','${USER}','net_worth','2026-01-01','2026-09-18','2026-09-01','2026-09-18','0200 Probe Report','published','INR');`);
await db.exec(`insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to) values
  ('${REPORT}','${I.reportOnly}','xirr_since_inception','2020-01-01','2024-12-31');`);
await db.exec(`insert into ii_nav_retention_holds (instrument_id, reason, expires_at, released_at) values
  ('${I.holdActive}','manual_admin_hold', now() + interval '10 days', null),
  ('${I.holdReleased}','manual_admin_hold', now() + interval '10 days', now() - interval '1 day'),
  ('${I.holdExpired}','statement_reconciliation_in_progress', now() - interval '1 day', null);`);

const cand = async (id, date, c = `'${C}'`) => (await one(`select pc6_nav_row_is_candidate('${id}', ${date === null ? 'null' : `'${date}'`}, ${c}) v`)).v;
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

// --- Anti-vacuity -------------------------------------------------------------------
check('ANTI-VACUITY: the seed is visible (1 purchase + 1 redemption, 1 snapshot, 1 lot, 1 report pin, 3 holds)',
  (await one(`select (select count(*) from ii_transactions where user_id='${USER}')::int t, (select count(*) from ii_nav_retention_holds where instrument_id in ('${I.holdActive}','${I.holdReleased}','${I.holdExpired}'))::int h`)).t === 2);
check('ANTI-VACUITY: an unheld instrument IS a candidate before the changeover (so KEEP verdicts below are real)', (await cand(I.unheld, PRE)) === true);

// --- NEGATIVE CONTROLS against 0189 ----------------------------------------------
console.log('\nNegative controls -- the 0189 definition:');
check('0189: an instrument merged INTO a user-held fund is a CANDIDATE (history stranded)', (await cand(I.mergedOld, PRE)) === true);
check('0189: the surviving fund of a merge FROM a held fund is a CANDIDATE', (await cand(I.survivor, PRE)) === true);
check('0189: a NULL changeover returns NULL for an unprotected instrument, not false', (await cand(I.unheld, PRE, 'null')) === null);
const authHeld = await asRole('authenticated', USER_B, `select pc6_nav_row_is_candidate('${I.held}','${PRE}','${C}') v`);
check('0189: an authenticated non-owner may EXECUTE the predicate and gets TRUE (deletable) for a held fund', authHeld.ok && authHeld.v === true, JSON.stringify(authHeld));
const anonHeld = await asRole('anon', null, `select pc6_nav_row_is_candidate('${I.held}','${PRE}','${C}') v`);
check('0189: anon may EXECUTE the predicate and gets TRUE for a held fund (reproduces the live DEV finding)', anonHeld.ok && anonHeld.v === true, JSON.stringify(anonHeld));

// --- Apply 0200 ------------------------------------------------------------------
await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
let reapplyErr = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapplyErr = e.message; }
console.log('\n0200 applied.\n');
check('0200 is idempotent -- a second apply does not error', reapplyErr === null, reapplyErr ?? '');

// --- P5 tests ------------------------------------------------------------------------
check('P5-1  a currently held scheme is KEEP before the changeover', (await cand(I.held, PRE)) === false);
check('P5-2a a fully redeemed scheme (only a redemption transaction) is KEEP', (await cand(I.redeemedTx, PRE)) === false);
check('P5-2b a zero-unit holding snapshot is KEEP', (await cand(I.zeroSnapshot, PRE)) === false);
check('P5-2c a closed tax lot (units_remaining = 0) is KEEP', (await cand(I.closedLot, PRE)) === false);
check('P5-3a a finalized-report pin with NO holding is KEEP inside its range', (await cand(I.reportOnly, '2022-06-01')) === false);
check('P5-3b ...including both range ends', (await cand(I.reportOnly, '2020-01-01')) === false && (await cand(I.reportOnly, '2024-12-31')) === false);
check('P5-3c ...and a CANDIDATE outside it (the pin is date-ranged, as designed)', (await cand(I.reportOnly, '2019-12-31')) === true && (await cand(I.reportOnly, '2025-01-01')) === true);
check('P5-4  an active (open, unexpired) hold is KEEP', (await cand(I.holdActive, PRE)) === false);
check('P5-5a a RELEASED hold no longer protects (documented policy: protection ends at release)', (await cand(I.holdReleased, PRE)) === true);
check('P5-5b an EXPIRED hold no longer protects (documented policy: protection ends at expires_at)', (await cand(I.holdExpired, PRE)) === true);
{
  // P5-7: re-finalization writes the same (report, instrument, basis) -- one row, no duplicate.
  const up = `insert into ii_report_nav_dependencies (report_id, instrument_id, basis, nav_date_from, nav_date_to)
    values ('${REPORT}','${I.reportOnly}','xirr_since_inception','2020-01-01','2024-12-31')
    on conflict (report_id, instrument_id, basis) do update set nav_date_to = excluded.nav_date_to returning id`;
  const e1 = await err(up); const e2 = await err(up);
  const cnt = (await one(`select count(*)::int c from ii_report_nav_dependencies where report_id='${REPORT}' and instrument_id='${I.reportOnly}'`)).c;
  check('P5-7  re-finalizing a report upserts its dependency -- exactly one row after two writes', e1 === null && e2 === null && cnt === 1, `${e1 ?? ''} ${e2 ?? ''} rows=${cnt}`);
}
check('P5-8a a NULL changeover now returns FALSE (keep), never NULL', (await cand(I.unheld, PRE, 'null')) === false);
check('P5-8b a NULL price date returns FALSE (keep)', (await cand(I.unheld, null)) === false);
{
  await db.exec('begin');
  await db.exec('alter table ii_sip_series rename to ii_sip_series_gone');
  const e = await err(`select pc6_nav_row_is_candidate('${I.unheld}','${PRE}','${C}') v`);
  await db.exec('rollback');
  check('P5-8c a MISSING protection table makes the predicate ERROR -- never answer "deletable"', e !== null && /ii_sip_series/.test(e), e ?? 'no error');
}
{
  await db.exec('begin');
  await db.exec('drop function pc6_instrument_is_user_held(uuid)');
  const e = await err(`select pc6_nav_row_is_candidate('${I.unheld}','${PRE}','${C}') v`);
  await db.exec('rollback');
  check('P5-8d a MISSING protection function makes the predicate ERROR', e !== null && /pc6_instrument_is_user_held/.test(e), e ?? 'no error');
}
check('P5-8e ...and after the rollback the predicate works again (the probes changed nothing)', (await cand(I.held, PRE)) === false && (await cand(I.unheld, PRE)) === true);

const authAfter = await asRole('authenticated', USER_B, `select pc6_nav_row_is_candidate('${I.held}','${PRE}','${C}') v`);
check('P5-9a an authenticated caller can no longer EXECUTE the predicate (permission denied, not a wrong TRUE)', !authAfter.ok && /permission denied/i.test(authAfter.msg), JSON.stringify(authAfter));
const anonAfter = await asRole('anon', null, `select count(*)::int v from pc6_user_held_instrument_ids()`);
check('P5-9b anon can no longer EXECUTE pc6_user_held_instrument_ids()', !anonAfter.ok && /permission denied/i.test(anonAfter.msg), JSON.stringify(anonAfter));
const ownerAfter = await asRole('authenticated', USER, `select pc6_instrument_is_user_held('${I.held}') v`);
check('P5-9c ...not even the OWNER of the holding (the verdict is service-only by design)', !ownerAfter.ok, JSON.stringify(ownerAfter));
const svcAfter = await asRole('service_role', null, `select pc6_nav_row_is_candidate('${I.held}','${PRE}','${C}') v`);
check('P5-9d service_role still gets the correct KEEP verdict', svcAfter.ok && svcAfter.v === false, JSON.stringify(svcAfter));
const svcUnheld = await asRole('service_role', null, `select pc6_nav_row_is_candidate('${I.unheld}','${PRE}','${C}') v`);
check('P5-9e ...and the correct CANDIDATE verdict for an unheld fund', svcUnheld.ok && svcUnheld.v === true, JSON.stringify(svcUnheld));
const crossUser = await asRole('authenticated', USER_B, `select count(*)::int v from ii_transactions where user_id='${USER}'`);
check('P5-9f user B cannot read user A\'s transactions (RLS, the source the predicate reads)', crossUser.ok && crossUser.v === 0, JSON.stringify(crossUser));

check('P5-10a an instrument merged INTO a user-held fund is now KEEP (ii_instruments link)', (await cand(I.mergedOld, PRE)) === false);
check('P5-10b ...also when the link is only in ii_scheme_master', (await cand(I.smMergedOld, PRE)) === false);
check('P5-10c ...and transitively (A -> B -> held)', (await cand(I.chainA, PRE)) === false && (await cand(I.chainB, PRE)) === false);
check('P5-10d ...and the SURVIVING fund of a merge FROM a held (here: fully redeemed) fund is KEEP too (both directions)', (await cand(I.survivor, PRE)) === false);
check('P5-10e a merge family with nothing protected stays a CANDIDATE (the term does not protect everything)',
  (await cand(I.mergedUnheldOld, PRE)) === true && (await cand(I.unheld, PRE)) === true);

// --- Unchanged 0189 behaviour ---------------------------------------------------------
check('unchanged: every instrument is KEEP on/after the changeover', (await cand(I.unheld, POST)) === false && (await cand(I.mergedUnheldOld, POST)) === false);
check('unchanged: pc6_instrument_is_user_held() still agrees with pc6_user_held_instrument_ids()',
  (await one(`select count(*)::int c from ii_instruments i where i.id::text like '22220000-%' and pc6_instrument_is_user_held(i.id) <> (i.id in (select instrument_id from pc6_user_held_instrument_ids()))`)).c === 0);
const vol = (await db.query(`select proname, provolatile from pg_proc where proname in ('pc6_instrument_is_user_held','pc6_user_held_instrument_ids','pc6_nav_row_is_candidate')`)).rows;
check('all three functions are still STABLE (read-only)', vol.length === 3 && vol.every((r) => r.provolatile === 's'));
check('no CHECK constraint was touched by 0200', !/check\s*\(|add\s+constraint|drop\s+constraint/i.test(fs.readFileSync(path.join(MIG, TARGET), 'utf8').replace(/--.*$/gm, '')));

console.log(`\n=== NAV 1 / 0200 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
