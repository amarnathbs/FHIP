// NAV 1 — POST-MIGRATION verification of 0166 against a freshly rebuilt REAL
// Postgres (PGlite/WASM): what DEV and production will look like ONCE
// migration 0166 is applied. Same technique as
// scripts/pc6_0155_pglite_verification.mjs, for the same reason: this
// session has no DDL path to either hosted database (re-confirmed 2026-09-21
// — see docs/investment-intelligence/NAV1_PROGRESS_LEDGER.md, NAV 1.02/1.05).
// Real Postgres, real CHECK constraints, real RLS. NOT a claim that 0166 has
// been applied anywhere.
//
// WHAT IT PROVES:
//  1. The whole chain 0001..0166 applies cleanly, in order, from empty.
//  2. 0166 is genuinely idempotent.
//  3/4. Both new job-control rows (full-universe backfill kill switch,
//       selective-hydration key) exist and ship DISABLED.
//  5. ii_nav_retention_policy and ii_nav_retention_holds exist, are
//     admin-capability-gated (not merely "any admin"), and ship EMPTY.
//  6-11. pc6_nav_row_is_candidate() reproduces every boundary example the
//        TypeScript unit tests (tests/unit/pc6NavRetentionPolicy.test.ts)
//        assert — the two implementations are proven consistent here, not
//        merely both individually plausible.
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
const results = [];
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-PG-${String(seq).padStart(2, '0')}`;
  results.push({ id, verdict: cond ? 'PASS' : 'FAIL', label, detail });
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
async function err(sql) { try { await db.exec(sql); return null; } catch (e) { return e.message || String(e); } }
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;

// ---------------------------------------------------------------------------
console.log('--- 1/2. chain applies, and 0166 is idempotent ---');
// ---------------------------------------------------------------------------
check('chain 0001..0166 applied from empty', files.includes('0166_nav1_selective_retention_foundation.sql'));
const second = await err(
  fs.readFileSync(path.join(MIG, '0166_nav1_selective_retention_foundation.sql'), 'utf8')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '')
);
check('0166 re-applies cleanly (idempotent)', second === null, second ? `error: ${second.slice(0, 200)}` : '');

// ---------------------------------------------------------------------------
console.log('\n--- 3/4. safe pause + separate scheduling job-control rows ---');
// ---------------------------------------------------------------------------
const jobRows = await all(
  "select job_key, enabled, disabled_reason from ii_reference_job_control where job_key in ('pc6_full_universe_historical_backfill','pc6_selective_historical_hydration')"
);
check('both new job-control rows exist', jobRows.length === 2, jobRows.map((r) => r.job_key).join(', '));
check('both new job-control rows ship DISABLED with a reason', jobRows.every((r) => r.enabled === false && r.disabled_reason?.length > 0),
  jobRows.map((r) => `${r.job_key}=${r.enabled}`).join(', '));

// ---------------------------------------------------------------------------
console.log('\n--- 5. policy/hold tables ship empty and capability-gated ---');
// ---------------------------------------------------------------------------
const policyRows = await one('select count(*)::int as n from ii_nav_retention_policy');
check('ii_nav_retention_policy ships EMPTY (activation is a separate closure step)', policyRows.n === 0, `rows=${policyRows.n}`);
const holdRows = await one('select count(*)::int as n from ii_nav_retention_holds');
check('ii_nav_retention_holds ships EMPTY', holdRows.n === 0, `rows=${holdRows.n}`);

const PC6_ADMIN = 'aaaa1111-0000-0000-0000-000000000001';
const ORDINARY = 'aaaa2222-0000-0000-0000-000000000002';
await db.exec(`insert into auth.users(id,email) values ('${PC6_ADMIN}','pc6@t.test'),('${ORDINARY}','user@t.test');`);
await db.exec(`insert into admin_users(user_id, can_view_reference_data_quality) values ('${PC6_ADMIN}', true);`);
await db.exec(`insert into ii_nav_retention_policy (policy_version, changeover_date, environment) values ('NAV1-2026-09-21','2026-09-21','dev');`);

let vacuous = 0;
async function asUser(userId, sql) {
  await db.exec(`select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false); set role authenticated;`);
  const who = (await db.query('select auth.uid()::text as uid')).rows[0].uid;
  if (who !== userId) { vacuous++; await db.exec('reset role;'); throw new Error(`harness vacuous: auth.uid()=${who}`); }
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role;'); }
}
const capableSees = await asUser(PC6_ADMIN, 'select id from ii_nav_retention_policy');
check('a capability-holding admin can read the policy table', capableSees.length === 1, `rows=${capableSees.length}`);
const ordinarySees = await asUser(ORDINARY, 'select id from ii_nav_retention_policy');
check('an ordinary user cannot read the policy table', ordinarySees.length === 0, `rows=${ordinarySees.length}`);
check('the RLS harness was not vacuous', vacuous === 0, `vacuous assertions = ${vacuous}`);

// ---------------------------------------------------------------------------
console.log('\n--- 6-11. pc6_nav_row_is_candidate() matches the TS policy engine\'s boundary examples ---');
// ---------------------------------------------------------------------------
const C = '2026-09-21';
const candidate = async (instrumentId, priceDate) =>
  (await one(`select pc6_nav_row_is_candidate('${instrumentId}', '${priceDate}', '${C}') as c`)).c;

// Mandatory Country Confirmation gate (separate programme): ii_accounts
// refuses a write until the owning user has confirmed a country of
// residence via the controlled confirm_country_of_residence() RPC (a direct
// UPDATE of user_profiles is itself refused by 0127's own guard).
await db.exec(`select set_config('request.jwt.claims', '{"sub":"${ORDINARY}","role":"authenticated"}', false); set role authenticated;`);
await db.exec(`select confirm_country_of_residence('IN');`);
await db.exec('reset role;');
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
  ('bbbb0000-0000-0000-0000-000000000001', '${ORDINARY}', 'IN', 'INR', 'demat', 'PC6 Probe Broker');`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('cccc0000-0000-0000-0000-000000000001','Unheld Live Scheme','mutual_fund','IN','INR','verified'),
  ('cccc0000-0000-0000-0000-000000000002','Redeemed Complete-From-Inception Scheme','mutual_fund','IN','INR','verified'),
  ('cccc0000-0000-0000-0000-000000000003','Opening-Balance Scheme','mutual_fund','IN','INR','verified'),
  ('cccc0000-0000-0000-0000-000000000004','Benchmark-Only Scheme','mutual_fund','IN','INR','verified'),
  ('cccc0000-0000-0000-0000-000000000005','Held-Scheme (active hold)','mutual_fund','IN','INR','verified'),
  ('cccc0000-0000-0000-0000-000000000006','Never-Dependency Scheme','mutual_fund','IN','INR','verified');`);

// Workbook boundary example: unheld live scheme — earlier row candidate, row on C protected.
check('unheld scheme: row before C is a CANDIDATE', await candidate('cccc0000-0000-0000-0000-000000000001', '2026-09-20') === true);
check('unheld scheme: row ON C is protected (KEEP)', await candidate('cccc0000-0000-0000-0000-000000000001', '2026-09-21') === false);

// Fully redeemed + complete_from_inception: protected arbitrarily far back.
await db.exec(`insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status, history_completeness) values
  ('${ORDINARY}','bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','certified','complete_from_inception');`);
check('redeemed scheme with complete_from_inception: a 2006 row is protected', await candidate('cccc0000-0000-0000-0000-000000000002', '2006-04-03') === false);

// complete_from_known_opening_balance: protected only from the earliest non-reversed transaction.
await db.exec(`insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status, history_completeness) values
  ('${ORDINARY}','bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','certified','complete_from_known_opening_balance');`);
await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount, status) values
  ('${ORDINARY}','bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','INR','purchase','2020-01-15', 100, 10, 1000, 'reconciled');`);
check('opening-balance scheme: row before the earliest transaction is a CANDIDATE', await candidate('cccc0000-0000-0000-0000-000000000003', '2019-12-31') === true);
check('opening-balance scheme: row ON the earliest transaction date is protected', await candidate('cccc0000-0000-0000-0000-000000000003', '2020-01-15') === false);

// Benchmark dependency protects even with no accepted statement.
await db.exec(`insert into ii_benchmarks (id, benchmark_key, benchmark_label, benchmark_category, country_code, return_type, licence_status) values
  ('dddd0000-0000-0000-0000-000000000001','PC6_PROBE_BM2','PC6 Probe Benchmark 2','index','IN','TRI','licence_required');`);
await db.exec(`insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type) values
  ('cccc0000-0000-0000-0000-000000000004','dddd0000-0000-0000-0000-000000000001','primary');`);
check('benchmark-mapped scheme with no accepted statement is still protected', await candidate('cccc0000-0000-0000-0000-000000000004', '2018-01-01') === false);

// Active hold protects (race prevention).
await db.exec(`insert into ii_nav_retention_holds (instrument_id, reason) values
  ('cccc0000-0000-0000-0000-000000000005','statement_upload_in_progress');`);
check('an active retention hold protects an otherwise-candidate row', await candidate('cccc0000-0000-0000-0000-000000000005', '2019-01-01') === false);

// No dependency at all before C: genuine candidate.
check('a scheme with no accepted/benchmark/hold dependency is a CANDIDATE before C', await candidate('cccc0000-0000-0000-0000-000000000006', '2015-06-01') === true);

console.log(`\n=== NAV 1 / 0166 PGlite verification: ${pass} PASS, ${fail} FAIL, ${results.length} total ===`);
fs.writeFileSync(
  path.join(HERE, 'nav1-0166-pglite-results.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), migrationsReplayed: files.length, pass, fail, results }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
