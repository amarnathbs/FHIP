// Net Worth current-NAV re-mark -- PGlite verification for migration
// 0240_networth_current_nav_remark.sql (2026-10-02).
//
// The real migration chain (every file before 0240) is replayed from an EMPTY
// database; a small two-tenant world with one published mutual-fund register row
// each is seeded; every claim 0240 makes is first PROVEN ABSENT (anti-vacuity),
// then 0240 is applied, every claim is checked, then 0240 is applied a second
// time (must change nothing and move no row).
//
// Claims proven:
//   * the six investments columns exist, are NULLable, and are NULL for every
//     pre-existing row (no backfill; current_value untouched);
//   * ii_valuation_basis accepts only market_nav / statement / redeemed;
//   * ii_investment_value_revisions exists with RLS enabled; the owner can SELECT
//     only their own rows; an authenticated INSERT is refused; authenticated
//     UPDATE / DELETE have no privilege; the service role can INSERT;
//   * a written revision row is immutable (UPDATE refused even for the service
//     role) while DELETE through the investment's cascade still works;
//   * re-applying 0240 is a no-op (schema fingerprint identical, no row moved).
//
// Every check prints PASS/FAIL; the process exits non-zero on any FAIL and
// refuses to report a pass if fewer checks ran than expected.
//
// Run: node scripts/networth_0240_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0240_networth_current_nav_remark.sql';
const EXPECTED_CHECKS = 43;
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
// NW0240_FILE lets the test apply a deliberately BROKEN copy of the migration (negative control).
const target = strip(fs.readFileSync(process.env.NW0240_FILE ?? path.join(MIG, TARGET), 'utf8'));

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
const errCodeOf = async (db, sql, params) => { try { if (params) await db.query(sql, params); else await db.exec(sql); return null; } catch (e) { return e.code ?? e.message; } };
const cols = async (db, table) => (await db.query(`select column_name, is_nullable, data_type from information_schema.columns where table_schema='public' and table_name = $1`, [table])).rows;

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
  const t = (await db.query(`select tgname, tgrelid::regclass::text r from pg_trigger where not tgisinternal order by 1,2`)).rows;
  const f = (await db.query(`select proname, md5(prosrc) h from pg_proc where pronamespace = 'public'::regnamespace order by 1,2`)).rows;
  const k = (await db.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).rows;
  const p = (await db.query(`select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2`)).rows;
  return JSON.stringify({ c, i, t, f, k, p });
};

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ACC_A = 'a0000000-0000-0000-0000-0000000000a1';
const ACC_B = 'b0000000-0000-0000-0000-0000000000b1';
const INS = 'c0000000-0000-0000-0000-0000000000c1';
const INV_A = 'a1000000-0000-0000-0000-0000000000a1';
const INV_B = 'b1000000-0000-0000-0000-0000000000b1';
const NEW_COLS = ['ii_value_as_of', 'ii_valuation_basis', 'ii_valuation_units', 'ii_valuation_nav', 'ii_valuation_fingerprint', 'ii_valuation_remarked_at'];

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
    insert into investments (id, user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, source_type, ii_canonical_account_id, ii_canonical_instrument_id) values
      ('${INV_A}', '${A}', 'Alpha Flexi Cap Fund', 'managed_fund', 10000, 'INR', 'IN', 'self', 'managed_funds', 'investment_intelligence_published', '${ACC_A}', '${INS}'),
      ('${INV_B}', '${B}', 'Alpha Flexi Cap Fund', 'managed_fund', 20000, 'INR', 'IN', 'self', 'managed_funds', 'investment_intelligence_published', '${ACC_B}', '${INS}');
  `);
}

const revisionInsert = (user, inv, extra = '') => `insert into ii_investment_value_revisions
  (user_id, investment_id, reason, remark_trigger, previous_value, new_value, new_basis, units, nav, value_as_of, fingerprint, rule_version${extra ? ', ' + extra.split('=')[0] : ''})
  values ('${user}', '${inv}', 'baseline', 'manual', 10000, 11200, 'market_nav', 100, 112, '2026-09-30', 'fp-${user.slice(0, 2)}', 'nav-remark-v1'${extra ? ', ' + extra.split('=')[1] : ''})`;

// ============================================================================
console.log('Case A -- full chain before 0240 (from an empty database), two tenants, then 0240 (twice)');
const { db, applied } = await replayUpToTarget();
check(`the chain before 0240 replayed from empty (${applied} migrations)`, applied > 200, `applied ${applied}`);
await seed(db);

// --- anti-vacuity: every claim is ABSENT before 0240 ---------------------------------------
const before = await cols(db, 'investments');
check('BEFORE: none of the six valuation columns exists on investments', NEW_COLS.every((c) => !before.some((r) => r.column_name === c)));
check('BEFORE: ii_investment_value_revisions does not exist', (await one(db, `select to_regclass('public.ii_investment_value_revisions') as t`)).t === null);
check('BEFORE: writing a valuation column fails (undefined_column 42703)', (await errCodeOf(db, `update investments set ii_value_as_of = '2026-09-30' where id = '${INV_A}'`)) === '42703');
const rowsBefore = (await db.query(`select id, current_value, updated_at from investments order by id`)).rows;
const fpBefore = await schemaFingerprint(db);

// --- apply 0240 -------------------------------------------------------------------------------
await db.exec(target);

const after = await cols(db, 'investments');
for (const c of NEW_COLS) {
  const r = after.find((x) => x.column_name === c);
  check(`AFTER: investments.${c} exists and is NULLable`, !!r && r.is_nullable === 'YES');
}
check('AFTER: types are date / text / numeric / numeric / text / timestamptz', after.find((x) => x.column_name === 'ii_value_as_of').data_type === 'date'
  && after.find((x) => x.column_name === 'ii_valuation_units').data_type === 'numeric'
  && after.find((x) => x.column_name === 'ii_valuation_nav').data_type === 'numeric'
  && after.find((x) => x.column_name === 'ii_valuation_remarked_at').data_type === 'timestamp with time zone');
const rowsAfter = (await db.query(`select id, current_value, updated_at from investments order by id`)).rows;
check('no backfill: every pre-existing row keeps its current_value and updated_at', JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter));
const nulls = await one(db, `select count(*) filter (where ii_value_as_of is null and ii_valuation_basis is null and ii_valuation_units is null and ii_valuation_nav is null and ii_valuation_fingerprint is null and ii_valuation_remarked_at is null) as n, count(*) as total from investments`);
check('every pre-existing investments row has all six new columns NULL', Number(nulls.n) === Number(nulls.total) && Number(nulls.total) === 2);

// basis CHECK (the only constraint 0240 adds to an existing table)
check('ii_valuation_basis rejects an unknown value (23514)', (await errCodeOf(db, `update investments set ii_valuation_basis = 'bogus' where id = '${INV_A}'`)) === '23514');
for (const v of ['market_nav', 'statement', 'redeemed']) {
  check(`ii_valuation_basis accepts '${v}'`, (await errCodeOf(db, `update investments set ii_valuation_basis = '${v}' where id = '${INV_A}'`)) === null);
}
await db.exec(`update investments set ii_valuation_basis = null where id = '${INV_A}'`);

// the owner can write the valuation columns on their own row (the application's user-client update), and not on another tenant's
await asUser(db, A, async () => {
  const own = await db.query(`update investments set ii_value_as_of = '2026-09-30', ii_valuation_basis = 'market_nav', ii_valuation_units = 100, ii_valuation_nav = 112, ii_valuation_fingerprint = 'fp-1', ii_valuation_remarked_at = now(), current_value = 11200 where id = '${INV_A}' returning id`);
  check('an authenticated owner can update the valuation columns of their own row', own.rows.length === 1);
  const other = await db.query(`update investments set current_value = 1 where id = '${INV_B}' returning id`);
  check("an authenticated owner cannot update another tenant's investments row (RLS)", other.rows.length === 0);
});

// --- revision table: structure and RLS ------------------------------------------------------
const rel = await one(db, `select relrowsecurity as rls from pg_class where oid = 'public.ii_investment_value_revisions'::regclass`);
check('ii_investment_value_revisions exists with row level security ENABLED', rel.rls === true);
const policies = (await db.query(`select policyname, cmd from pg_policies where tablename = 'ii_investment_value_revisions'`)).rows;
check('exactly one policy exists and it is SELECT-only', policies.length === 1 && policies[0].cmd === 'SELECT', JSON.stringify(policies));

// service role writes
await asService(db, async () => {
  check('the service role can INSERT a revision for tenant A', (await errCodeOf(db, revisionInsert(A, INV_A))) === null);
  check('the service role can INSERT a revision for tenant B', (await errCodeOf(db, revisionInsert(B, INV_B))) === null);
});

// authenticated reads/writes
await asUser(db, A, async () => {
  const mine = (await db.query(`select user_id from ii_investment_value_revisions`)).rows;
  check('tenant A sees exactly their own revision row (RLS select)', mine.length === 1 && mine[0].user_id === A);
  check('tenant A cannot INSERT a revision (forged history refused: 42501)', (await errCodeOf(db, revisionInsert(A, INV_A))) === '42501');
  check("tenant A cannot INSERT a revision for tenant B (42501)", (await errCodeOf(db, revisionInsert(B, INV_B))) === '42501');
  check('tenant A has no UPDATE privilege on revisions (42501)', (await errCodeOf(db, `update ii_investment_value_revisions set new_value = 1`)) === '42501');
  check('tenant A has no DELETE privilege on revisions (42501)', (await errCodeOf(db, `delete from ii_investment_value_revisions`)) === '42501');
});
await asUser(db, B, async () => {
  const theirs = (await db.query(`select user_id from ii_investment_value_revisions`)).rows;
  check('tenant B sees only their own revision row', theirs.length === 1 && theirs[0].user_id === B);
});
await db.exec(`select set_config('request.jwt.claims', '{}', false)`);
await db.exec('set role anon');
check('anon sees no revision rows (RLS: no policy matches an anonymous caller)', (await db.query(`select * from ii_investment_value_revisions`)).rows.length === 0);
check('anon cannot INSERT a revision (42501)', (await errCodeOf(db, revisionInsert(A, INV_A))) === '42501');
await db.exec('reset role');

// table constraints
await asService(db, async () => {
  check('revision reason is constrained (23514)', (await errCodeOf(db, `insert into ii_investment_value_revisions (user_id, investment_id, reason, remark_trigger, previous_value, new_value, new_basis, units, fingerprint, rule_version) values ('${A}', '${INV_A}', 'made_up', 'manual', 1, 1, 'statement', 1, 'x', 'v')`)) === '23514');
  check('revision new_value cannot be negative (23514)', (await errCodeOf(db, `insert into ii_investment_value_revisions (user_id, investment_id, reason, remark_trigger, previous_value, new_value, new_basis, units, fingerprint, rule_version) values ('${A}', '${INV_A}', 'baseline', 'manual', 1, -1, 'statement', 1, 'x', 'v')`)) === '23514');
  check('revision new_basis is constrained (23514)', (await errCodeOf(db, `insert into ii_investment_value_revisions (user_id, investment_id, reason, remark_trigger, previous_value, new_value, new_basis, units, fingerprint, rule_version) values ('${A}', '${INV_A}', 'baseline', 'manual', 1, 1, 'guess', 1, 'x', 'v')`)) === '23514');
  check('revision remark_trigger is constrained (23514)', (await errCodeOf(db, `insert into ii_investment_value_revisions (user_id, investment_id, reason, remark_trigger, previous_value, new_value, new_basis, units, fingerprint, rule_version) values ('${A}', '${INV_A}', 'baseline', 'cron', 1, 1, 'statement', 1, 'x', 'v')`)) === '23514');
  check('revision must reference a real investment (23503)', (await errCodeOf(db, `insert into ii_investment_value_revisions (user_id, investment_id, reason, remark_trigger, previous_value, new_value, new_basis, units, fingerprint, rule_version) values ('${A}', '99999999-9999-9999-9999-999999999999', 'baseline', 'manual', 1, 1, 'statement', 1, 'x', 'v')`)) === '23503');
});

// append-only
await asService(db, async () => {
  check('append-only: an UPDATE of a written revision is refused even for the service role (55000/restrict_violation)', ['23001', '55000'].includes(await errCodeOf(db, `update ii_investment_value_revisions set new_value = 99999 where user_id = '${A}'`)));
  const v = await one(db, `select new_value from ii_investment_value_revisions where user_id = '${A}'`);
  check('append-only: the written value is unchanged', Number(v.new_value) === 11200);
});

// idempotency: re-apply 0240
const rowsBeforeSecond = JSON.stringify((await db.query(`select * from ii_investment_value_revisions order by id`)).rows);
const investmentsBeforeSecond = JSON.stringify((await db.query(`select * from investments order by id`)).rows);
const fpOnce = await schemaFingerprint(db);
await db.exec(target);
const fpTwice = await schemaFingerprint(db);
check('re-applying 0240 is a no-op: schema fingerprint (constraints, indexes, triggers, functions, columns, policies) identical', fpOnce === fpTwice);
check('re-applying 0240 moves no revision row', rowsBeforeSecond === JSON.stringify((await db.query(`select * from ii_investment_value_revisions order by id`)).rows));
check('re-applying 0240 moves no investments row', investmentsBeforeSecond === JSON.stringify((await db.query(`select * from investments order by id`)).rows));
check('the schema changed between "before" and "after" (anti-vacuity of the fingerprint)', fpBefore !== fpOnce);

// cascade: deleting the investment removes its revisions (delete is not blocked by the immutability trigger)
await asService(db, async () => {
  await db.exec(`delete from investments where id = '${INV_B}'`);
  const left = await one(db, `select count(*)::int as n from ii_investment_value_revisions where investment_id = '${INV_B}'`);
  check("deleting an investment cascades to its revisions (the immutability trigger does not block DELETE)", left.n === 0);
  check("the other tenant's revision is untouched by that cascade", Number((await one(db, `select count(*)::int as n from ii_investment_value_revisions where investment_id = '${INV_A}'`)).n) === 1);
});

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} checks)`);
if (fail > 0) process.exit(1);
if (pass + fail < EXPECTED_CHECKS) {
  console.error(`REFUSING to report a pass: expected at least ${EXPECTED_CHECKS} checks, only ${pass + fail} ran`);
  process.exit(2);
}
console.log('ALL CHECKS PASSED');
process.exit(0);
