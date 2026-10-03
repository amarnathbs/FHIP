// User-supplied investment date -- PGlite verification for migration
// 0250_ii_user_supplied_investment_dates.sql (2026-10-03).
//
// The real migration chain (every file before 0250) is replayed from an EMPTY
// database; a two-tenant world (an account, a mutual fund, a holding snapshot
// and a derived purchase each) is seeded; the table is first PROVEN ABSENT
// (anti-vacuity), then 0250 is applied, every claim is checked, then 0250 is
// applied a second time (must change nothing).
//
// Claims proven: the table exists with RLS enabled and exactly one policy that
// is SELECT-only; an owner reads only their own rows; an authenticated INSERT,
// UPDATE and DELETE are refused; the service role can write; provenance and
// status are constrained; at most ONE live (awaiting_nav / applied) answer per
// position but superseded rows accumulate as history; units must be positive;
// deleting the derived transaction nulls the link (no cascade loss of the
// record); deleting the account cascades; re-applying changes nothing.
//
// Prints PASS/FAIL per check; exits non-zero on any FAIL and refuses to report
// a pass if fewer checks ran than expected.
//
// Run: node scripts/ii_investment_date_0250_pglite_verification.mjs
// II0250_FILE=<path> applies a deliberately broken copy (negative control).

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0250_ii_user_supplied_investment_dates.sql';
const EXPECTED_CHECKS = 26;
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(process.env.II0250_FILE ?? path.join(MIG, TARGET), 'utf8'));

async function replayUpToTarget() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  let applied = 0;
  for (const f of files) {
    if (f >= TARGET) break;
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    applied += 1;
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  return { db, applied };
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const errCodeOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.code ?? e.message; } };

async function asUser(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
async function asService(db, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec('set role service_role');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
const schemaFingerprint = async (db) => {
  const c = (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows;
  const i = (await db.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`)).rows;
  const k = (await db.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).rows;
  const p = (await db.query(`select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2`)).rows;
  return JSON.stringify({ c, i, k, p });
};

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ACC_A = 'a0000000-0000-0000-0000-0000000000a1';
const ACC_B = 'b0000000-0000-0000-0000-0000000000b1';
const INS = 'c0000000-0000-0000-0000-0000000000c1';
const TX_A = 'a2000000-0000-0000-0000-0000000000a2';
const SNAP_A = 'a3000000-0000-0000-0000-0000000000a3';

async function seed(db) {
  for (const [id, email] of [[A, 'a@t.test'], [B, 'b@t.test']]) {
    await db.exec(`insert into auth.users(id, email) values ('${id}', '${email}') on conflict do nothing`);
    await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  }
  await db.exec(`
    insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
      ('${ACC_A}', '${A}', 'IN', 'INR', 'mf_folio', 'Alpha AMC'),
      ('${ACC_B}', '${B}', 'IN', 'INR', 'mf_folio', 'Alpha AMC');
    insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency) values
      ('${INS}', 'Alpha Flexi Cap Fund', 'mutual_fund', 'IN', 'INR');
    insert into ii_holding_snapshots (id, user_id, account_id, instrument_id, currency_code, as_of_date, units, value) values
      ('${SNAP_A}', '${A}', '${ACC_A}', '${INS}', 'INR', '2026-09-04', 100, 15000);
    insert into ii_transactions (id, user_id, account_id, instrument_id, currency_code, status, transaction_type, transaction_date, units, gross_amount, source_reference) values
      ('${TX_A}', '${A}', '${ACC_A}', '${INS}', 'INR', 'parsed', 'purchase', '2024-03-14', 100, 4000, 'USER_INVESTMENT_DATE:x');
  `);
}

const insert = (user, acc, extra = {}) => {
  const v = { status: 'awaiting_nav', provenance: 'user_supplied', units: 100, date: '2024-03-14', ...extra };
  return `insert into ii_investment_date_inputs (user_id, account_id, instrument_id, investment_date, provenance, status, units_at_capture)
          values ('${user}', '${acc}', '${INS}', '${v.date}', '${v.provenance}', '${v.status}', ${v.units})`;
};

console.log('Case A -- full chain before 0250 (from an empty database), two tenants, then 0250 (twice)');
const { db, applied } = await replayUpToTarget();
check(`the chain before 0250 replayed from empty (${applied} migrations)`, applied > 200, `applied ${applied}`);
await seed(db);

check('BEFORE: ii_investment_date_inputs does not exist', (await one(db, `select to_regclass('public.ii_investment_date_inputs') as t`)).t === null);
check('BEFORE: inserting into it fails (undefined_table 42P01)', (await errCodeOf(db, insert(A, ACC_A))) === '42P01');
const fpBefore = await schemaFingerprint(db);

await db.exec(target);

const rel = await one(db, `select relrowsecurity as rls from pg_class where oid = 'public.ii_investment_date_inputs'::regclass`);
check('ii_investment_date_inputs exists with row level security ENABLED', rel.rls === true);
const policies = (await db.query(`select policyname, cmd from pg_policies where tablename = 'ii_investment_date_inputs'`)).rows;
check('exactly one policy exists and it is SELECT-only', policies.length === 1 && policies[0].cmd === 'SELECT', JSON.stringify(policies));

await asService(db, async () => {
  check('the service role can INSERT an answer for tenant A', (await errCodeOf(db, insert(A, ACC_A))) === null);
  check('the service role can INSERT an answer for tenant B', (await errCodeOf(db, insert(B, ACC_B))) === null);
});

await asUser(db, A, async () => {
  const mine = (await db.query(`select user_id from ii_investment_date_inputs`)).rows;
  check('tenant A sees exactly their own row (RLS select)', mine.length === 1 && mine[0].user_id === A);
  check('tenant A cannot INSERT (a forged date or provenance is refused: 42501)', (await errCodeOf(db, insert(A, ACC_A, { date: '2020-01-01' }))) === '42501');
  check('tenant A cannot INSERT for tenant B (42501)', (await errCodeOf(db, insert(B, ACC_B, { date: '2020-01-01' }))) === '42501');
  check('tenant A has no UPDATE privilege (42501)', (await errCodeOf(db, `update ii_investment_date_inputs set investment_date = '2000-01-01'`)) === '42501');
  check('tenant A has no DELETE privilege (42501)', (await errCodeOf(db, `delete from ii_investment_date_inputs`)) === '42501');
});
await asUser(db, B, async () => {
  const theirs = (await db.query(`select user_id from ii_investment_date_inputs`)).rows;
  check('tenant B sees only their own row', theirs.length === 1 && theirs[0].user_id === B);
});
await db.exec(`select set_config('request.jwt.claims', '{}', false)`);
await db.exec('set role anon');
check('anon sees no rows and cannot INSERT', (await db.query(`select * from ii_investment_date_inputs`)).rows.length === 0 && (await errCodeOf(db, insert(A, ACC_A))) === '42501');
await db.exec('reset role');

await asService(db, async () => {
  check('provenance is constrained: only user_supplied (23514)', (await errCodeOf(db, insert(A, ACC_A, { provenance: 'admin', status: 'superseded' }))) === '23514');
  check('status is constrained (23514)', (await errCodeOf(db, insert(A, ACC_A, { status: 'deleted' }))) === '23514');
  check('units_at_capture must be positive (23514)', (await errCodeOf(db, insert(A, ACC_A, { units: 0, status: 'superseded' }))) === '23514');
  check('at most ONE live answer per position (unique violation 23505)', (await errCodeOf(db, insert(A, ACC_A))) === '23505');
  check('a second live answer is refused even in the other live status (23505)', (await errCodeOf(db, insert(A, ACC_A, { status: 'applied' }))) === '23505');
  check('superseded rows accumulate as history without limit', (await errCodeOf(db, insert(A, ACC_A, { status: 'superseded', date: '2023-01-01' }))) === null && (await errCodeOf(db, insert(A, ACC_A, { status: 'superseded', date: '2023-02-01' }))) === null);
  await db.exec(`update ii_investment_date_inputs set status = 'superseded' where user_id = '${A}' and status = 'awaiting_nav'`);
  check('once the live answer is superseded a new live answer is allowed (an edit)', (await errCodeOf(db, insert(A, ACC_A, { status: 'applied', date: '2025-01-10' }))) === null);
  await db.exec(`update ii_investment_date_inputs set derived_transaction_id = '${TX_A}' where user_id = '${A}' and status = 'applied'`);
});

// the derived transaction can be removed without losing the record of what the user said
await asService(db, async () => {
  await db.exec(`delete from ii_transactions where id = '${TX_A}'`);
  const r = await one(db, `select count(*)::int as n, count(derived_transaction_id)::int as linked from ii_investment_date_inputs where user_id = '${A}' and status = 'applied'`);
  check('deleting the derived transaction keeps the answer and nulls the link (on delete set null)', r.n === 1 && r.linked === 0);
});

// idempotency
const rowsBeforeSecond = JSON.stringify((await db.query(`select * from ii_investment_date_inputs order by id`)).rows);
const fpOnce = await schemaFingerprint(db);
await db.exec(target);
const fpTwice = await schemaFingerprint(db);
check('re-applying 0250 is a no-op: schema fingerprint (constraints, indexes, columns, policies) identical', fpOnce === fpTwice);
check('re-applying 0250 moves no row', rowsBeforeSecond === JSON.stringify((await db.query(`select * from ii_investment_date_inputs order by id`)).rows));
check('the schema changed between "before" and "after" (anti-vacuity of the fingerprint)', fpBefore !== fpOnce);

// cascade
await asService(db, async () => {
  await db.exec(`delete from ii_accounts where id = '${ACC_B}'`);
  const left = await one(db, `select count(*)::int as n from ii_investment_date_inputs where account_id = '${ACC_B}'`);
  check('deleting the account cascades to its answers', left.n === 0);
  check("the other tenant's answers are untouched by that cascade", Number((await one(db, `select count(*)::int as n from ii_investment_date_inputs where account_id = '${ACC_A}'`)).n) >= 1);
});

// no existing constraint was dropped or widened
check('0250 itself contains no DROP of any constraint or table', !/\bdrop\s+(constraint|table|column)\b/i.test(target));

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} checks)`);
if (fail > 0) process.exit(1);
if (pass + fail < EXPECTED_CHECKS) {
  console.error(`REFUSING to report a pass: expected at least ${EXPECTED_CHECKS} checks, only ${pass + fail} ran`);
  process.exit(2);
}
console.log('ALL CHECKS PASSED');
process.exit(0);
