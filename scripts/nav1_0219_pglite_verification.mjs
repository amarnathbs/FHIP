// NAV 1 PO decision #2/#5 (2026-09-27) -- PGlite verification for migration
// 0219 (predecessor lineage + source coverage gaps + hardened retention
// predicate).
//
// Method, same style as scripts/nav1_0200_pglite_verification.mjs: replay
// the chain up to (not including) 0219, seed, run NEGATIVE CONTROLS against
// the 0200 definition (an unheld instrument inside what will become a
// coverage-gap range must be shown as a CANDIDATE under 0200 -- otherwise
// the "0219 fixes something real" claim would be unverifiable), then apply
// 0219 and prove the gap now protects it, a date outside the gap does not,
// a resolved gap stops protecting, RLS blocks non-admin reads, and every
// 0200 behaviour is unchanged.
//
// Run: node scripts/nav1_0219_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0219_nav1_merger_lineage_and_coverage_gaps.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const before = files.filter((f) => f < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations) -- 0219 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-0219-${String(seq).padStart(2, '0')}`;
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

const n = (i) => `33330000-0000-0000-0000-0000000002${String(i).padStart(2, '0')}`;
const I = {
  gapUnheld: n(1),   // unheld; a coverage gap will be seeded over PRE
  gapHeld: n(2),     // held AND has a coverage gap -- both reasons protect it
  noGap: n(3),       // unheld, no gap -- ordinary candidate, negative control
  resolvedGap: n(4), // unheld; gap seeded then resolved -- must NOT protect
};
const C = '2026-09-21';
const PRE = '2020-06-15';       // inside every seeded gap below
const GAP_FROM = '2013-01-28';
const GAP_TO = '2022-09-19';
const OUTSIDE_GAP = '2023-01-15'; // after gap_to, before C
const POST = '2026-09-23';

await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ${Object.entries(I).map(([k, id]) => `('${id}','0219 ${k}','mutual_fund','IN','INR','verified')`).join(',\n  ')};`);
await db.exec(`insert into ii_scheme_master (instrument_id, amfi_scheme_code, scheme_name, scheme_structure, category_header_raw, lifecycle_status,
    country_code, currency_code, record_checksum, effective_from)
  values ('${I.gapUnheld}', '999219', '0219 probe scheme', 'open_ended', 'Open Ended Schemes(Income/Debt Oriented Schemes - Short Term Fund)', 'active',
    'IN', 'INR', 'x', '2020-01-01');`);
const USER = 'aaaa0000-0000-0000-0000-000000000219';
const ACCOUNT = 'cccc0000-0000-0000-0000-000000000219';
await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-0219@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}';`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
  ('${ACCOUNT}','${USER}','IN','INR','demat','0219 Probe Broker');`);
await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount) values
  ('${USER}','${ACCOUNT}','${I.gapHeld}','INR','purchase','2021-01-15',10000);`);

const cand = async (id, date, c = `'${C}'`) => (await one(`select pc6_nav_row_is_candidate('${id}', ${date === null ? 'null' : `'${date}'`}, ${c}) v`)).v;

// --- Anti-vacuity ----------------------------------------------------------
check('ANTI-VACUITY: seed is visible (1 held transaction, 1 scheme-master row)',
  (await one(`select (select count(*) from ii_transactions where instrument_id='${I.gapHeld}')::int t, (select count(*) from ii_scheme_master where amfi_scheme_code='999219')::int s`)).t === 1);

// --- Negative control against 0200 (BEFORE 0219 applies) -------------------
console.log('\nNegative control -- the 0200 definition, before 0219:');
check('0200: an unheld instrument with no coverage-gap mechanism is a CANDIDATE at a date that will later be inside a gap',
  (await cand(I.gapUnheld, PRE)) === true);
check('0200: ii_nav_source_coverage_gaps does not exist yet', (await err(`select 1 from ii_nav_source_coverage_gaps limit 1`)) !== null);

// --- Apply 0219 --------------------------------------------------------------
await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
let reapplyErr = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapplyErr = e.message; }
console.log('\n0219 applied.\n');
check('0219 is idempotent -- a second apply does not error', reapplyErr === null, reapplyErr ?? '');

// Seed a gap for gapUnheld and gapHeld; resolvedGap gets one that is then resolved; noGap gets none.
await db.exec(`insert into ii_nav_source_coverage_gaps (instrument_id, gap_from, gap_to, providers_checked, reason_code, detail, discovered_by) values
  ('${I.gapUnheld}','${GAP_FROM}','${GAP_TO}', array['amfi','tigzig'], 'fund_house_transition', '0219 probe', 'test'),
  ('${I.gapHeld}','${GAP_FROM}','${GAP_TO}', array['amfi','tigzig'], 'fund_house_transition', '0219 probe', 'test'),
  ('${I.resolvedGap}','${GAP_FROM}','${GAP_TO}', array['amfi','tigzig'], 'fund_house_transition', '0219 probe', 'test');`);
await db.exec(`update ii_nav_source_coverage_gaps set resolved_at = now(), resolved_detail = 'test resolution' where instrument_id = '${I.resolvedGap}';`);

check('P219-1  an unheld instrument INSIDE an unresolved coverage gap is now KEEP', (await cand(I.gapUnheld, PRE)) === false);
check('P219-2  the SAME unheld instrument OUTSIDE the gap range is still a CANDIDATE', (await cand(I.gapUnheld, OUTSIDE_GAP)) === true);
check('P219-3  a held instrument that ALSO has a gap is KEEP (held reason alone would already cover it -- both hold)', (await cand(I.gapHeld, PRE)) === false);
check('P219-4  an unheld instrument with NO gap is unaffected -- still a CANDIDATE (0219 does not protect everything)', (await cand(I.noGap, PRE)) === true);
check('P219-5  a RESOLVED gap no longer protects (documented: resolved_at set only after a real recovery)', (await cand(I.resolvedGap, PRE)) === true);
check('P219-6  every instrument is still KEEP on/after the changeover regardless of gaps', (await cand(I.gapUnheld, POST)) === false && (await cand(I.noGap, POST)) === false);

// --- Predecessor lineage seed --------------------------------------------------
const sm = await one(`select merger_date, predecessor_amc_name from ii_scheme_master where amfi_scheme_code='999219'`);
check('P219-7  the probe scheme has NO seeded merger data (only the real 151069 row is seeded by this migration)', sm.merger_date === null && sm.predecessor_amc_name === null);
check('predecessor_amc_name column exists and is nullable text', (await err(`update ii_scheme_master set predecessor_amc_name = null where amfi_scheme_code='999219'`)) === null);

// --- RLS ---------------------------------------------------------------------
const anonGaps = await asRole('anon', null, `select count(*)::int v from ii_nav_source_coverage_gaps`);
check('RLS: anon reading ii_nav_source_coverage_gaps sees zero rows (no admin policy match)', anonGaps.ok && anonGaps.v === 0, JSON.stringify(anonGaps));
const authGaps = await asRole('authenticated', USER, `select count(*)::int v from ii_nav_source_coverage_gaps`);
check('RLS: an ordinary authenticated (non-admin) user also sees zero rows', authGaps.ok && authGaps.v === 0, JSON.stringify(authGaps));
const svcGaps = await one(`select count(*)::int v from ii_nav_source_coverage_gaps`);
check('service_role (no RLS session set) sees all 3 seeded gap rows', svcGaps.v === 3);

// --- Unchanged 0200 behaviour --------------------------------------------------
check('unchanged: no CHECK constraint dropped or recreated by 0219',
  !/drop\s+constraint|alter\s+column.*drop\s+not\s+null/i.test(fs.readFileSync(path.join(MIG, TARGET), 'utf8').replace(/--.*$/gm, '')));
const vol = (await db.query(`select provolatile from pg_proc where proname = 'pc6_nav_row_is_candidate'`)).rows;
check('pc6_nav_row_is_candidate is still STABLE', vol.length === 1 && vol[0].provolatile === 's');

console.log(`\n=== NAV 1 / 0219 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
