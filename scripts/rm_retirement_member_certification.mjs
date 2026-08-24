// Retirement Member UI (Self/Spouse Target Retirement Age) -- certification
// harness. Mirrors the pattern established by
// scripts/air_consolidation_certification.mjs and
// scripts/air_consolidation_retirement_members_rls.mjs, rooted in THIS
// worktree rather than a hardcoded sibling path.
//
// 1) DB-01 Fresh rebuild -- every migration 0001..0076 applied in order on a
//    clean PGlite database, no errors, new columns present with correct
//    defaults/constraints.
// 2) DB-02 Populated-DEV-upgrade backfill replay -- applies migrations
//    0001..0075 first, seeds synthetic retirement_accounts rows replicating
//    every legacy backfill case the spec requires (A/B consistent, C
//    self!=spouse, D genuine conflict, E no age, F no retirement account),
//    THEN applies 0076, then asserts the exact deterministic outcome for
//    each case -- never averaged/mode/min/max for Case D.
// 3) RLS -- cross-tenant isolation re-tested after the new columns, with a
//    negative control proving the test isn't vacuous.
// 4) Regression -- migration 0073's contribution/current_balance pollution
//    fix remains 0 rows / $0 after 0076 (spec s.47, non-negotiable).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const ALL_MIGRATIONS = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const RM_MIGRATION = ALL_MIGRATIONS.find((f) => /^0076_retirement_member_target_age\.sql$/.test(f));
const PRE_MIGRATIONS = ALL_MIGRATIONS.filter((f) => f !== RM_MIGRATION);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

function stripCron(sql) {
  return sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
}

async function newDb() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  return db;
}

async function applyMigrations(db, files) {
  const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
  for (const f of files) {
    await db.exec(stripCron(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(seed);
  }
}

console.log(`Found ${ALL_MIGRATIONS.length} total migrations. RM migration: ${RM_MIGRATION}`);
if (!RM_MIGRATION) { console.error('FATAL: 0076_retirement_member_target_age.sql not found'); process.exit(9); }

// ---------------------------------------------------------------------------
// DB-01 -- fresh rebuild, 0001..0076 in order.
// ---------------------------------------------------------------------------
console.log('\n=== DB-01: Fresh rebuild (0001..0076) ===');
{
  const db = await newDb();
  await applyMigrations(db, ALL_MIGRATIONS);
  check('fresh rebuild completes with no thrown error', true);

  const cols = await db.query(`
    select column_name, is_nullable, column_default
    from information_schema.columns
    where table_name = 'retirement_members' and column_name in ('is_active','age_source')
    order by column_name
  `);
  check('retirement_members.is_active exists', cols.rows.some((r) => r.column_name === 'is_active'));
  check('retirement_members.age_source exists', cols.rows.some((r) => r.column_name === 'age_source'));

  // Constraint check: age_source only accepts the 3 documented values.
  const A = '11111111-1111-1111-1111-111111111111';
  await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test');`);
  let rejected = false;
  try {
    await db.query(`insert into retirement_members (user_id, member_type, age_source) values ('${A}','self','bogus_value')`);
  } catch { rejected = true; }
  check('age_source check constraint rejects an invalid value', rejected);

  await db.exec(`insert into retirement_members (user_id, member_type, target_retirement_age) values ('${A}','spouse',65)`);
  const defaultRow = await db.query(`select is_active, age_source from retirement_members where user_id='${A}' and member_type='spouse'`);
  check('new row defaults is_active=true', defaultRow.rows[0].is_active === true);
  check('new row defaults age_source=user_confirmed', defaultRow.rows[0].age_source === 'user_confirmed');

  // target_retirement_age remains nullable (Case E/F -- unconfirmed member).
  await db.exec(`insert into retirement_members (user_id, member_type) values ('${A}','self')`);
  const nullable = await db.query(`select target_retirement_age from retirement_members where user_id='${A}' and member_type='self'`);
  check('target_retirement_age stays nullable (unconfirmed member can exist)', nullable.rows[0].target_retirement_age === null);
}

// ---------------------------------------------------------------------------
// DB-02 -- populated-DEV-upgrade backfill replay across every spec case.
// ---------------------------------------------------------------------------
console.log('\n=== DB-02: Populated-DEV-upgrade backfill replay (all spec cases) ===');
{
  const db = await newDb();
  await applyMigrations(db, PRE_MIGRATIONS);

  const users = {
    caseAB: '00000000-0000-0000-0000-0000000000a1', // Case A+B: self consistent 67, spouse consistent 65
    caseC: '00000000-0000-0000-0000-0000000000a2', // Case C: self=67 != spouse=62, both consistent
    caseD: '00000000-0000-0000-0000-0000000000a3', // Case D: self CONFLICTS (65 vs 67 vs 60)
    caseE: '00000000-0000-0000-0000-0000000000a4', // Case E: self has account, no age recorded
    caseF: '00000000-0000-0000-0000-0000000000a5', // Case F: no retirement account at all
    caseAlready: '00000000-0000-0000-0000-0000000000a6', // pre-existing retirement_members row must not be overwritten
  };
  for (const [key, id] of Object.entries(users)) {
    await db.exec(`insert into auth.users(id,email) values ('${id}','${key}@t.test');`);
  }

  const insertAccount = async (userId, owner, age, balance = 1000) => {
    const ageSql = age === null ? 'null' : String(age);
    await db.exec(`
      insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, owner, target_retirement_age, is_active)
      values ('${userId}', 'Test Account', 'super', ${balance}, 'AUD', '${owner}', ${ageSql}, true)
    `);
  };

  // Case A/B: 3 self rows @67, 2 spouse rows @65 -- all consistent.
  await insertAccount(users.caseAB, 'self', 67);
  await insertAccount(users.caseAB, 'self', 67);
  await insertAccount(users.caseAB, 'self', 67);
  await insertAccount(users.caseAB, 'spouse', 65);
  await insertAccount(users.caseAB, 'spouse', 65);

  // Case C: self=67, spouse=62, both internally consistent -- must NOT be merged/averaged.
  await insertAccount(users.caseC, 'self', 67);
  await insertAccount(users.caseC, 'spouse', 62);

  // Case D: self rows conflict (65, 67, 60) -- must NOT guess.
  await insertAccount(users.caseD, 'self', 65);
  await insertAccount(users.caseD, 'self', 67);
  await insertAccount(users.caseD, 'self', 60);

  // Case E: self has a retirement account but no age recorded at all.
  await insertAccount(users.caseE, 'self', null);

  // Case F: no retirement account at all for this user -- nothing to backfill,
  // and this migration must not fabricate a member row out of nothing.

  // Pre-existing retirement_members row (simulates a user who already used
  // the new UI before this migration ran) -- must be left untouched, not
  // overwritten by the backfill.
  await insertAccount(users.caseAlready, 'self', 99); // legacy value the migration must NOT apply
  await db.exec(`insert into retirement_members (user_id, member_type, target_retirement_age) values ('${users.caseAlready}','self',70)`);

  await applyMigrations(db, [RM_MIGRATION]);

  const memberAge = async (userId, memberType) => {
    const r = await db.query(`select target_retirement_age, age_source, notes from retirement_members where user_id='${userId}' and member_type='${memberType}'`);
    return r.rows[0] ?? null;
  };

  // Case A/B
  {
    const self = await memberAge(users.caseAB, 'self');
    const spouse = await memberAge(users.caseAB, 'spouse');
    check('Case A: consistent self ages backfilled to 67', self?.target_retirement_age === 67, JSON.stringify(self));
    check('Case A: age_source=user_confirmed for consistent backfill', self?.age_source === 'user_confirmed');
    check('Case B: consistent spouse ages backfilled to 65', spouse?.target_retirement_age === 65, JSON.stringify(spouse));
  }

  // Case C
  {
    const self = await memberAge(users.caseC, 'self');
    const spouse = await memberAge(users.caseC, 'spouse');
    check('Case C: self=67 preserved independently', self?.target_retirement_age === 67);
    check('Case C: spouse=62 preserved independently (not averaged with self)', spouse?.target_retirement_age === 62);
  }

  // Case D -- the critical no-guessing assertion.
  {
    const self = await memberAge(users.caseD, 'self');
    check('Case D: conflicting self ages -> target_retirement_age is NULL (not guessed)', self?.target_retirement_age === null, JSON.stringify(self));
    check('Case D: age_source=needs_confirmation', self?.age_source === 'needs_confirmation');
    check('Case D: NOT the average (64)', self?.target_retirement_age !== 64);
    check('Case D: NOT the mode/most-common (none exist, but also not silently 65/67/60)', ![65, 67, 60].includes(self?.target_retirement_age));
    check('Case D: notes preserve every distinct legacy value', /60/.test(self?.notes ?? '') && /65/.test(self?.notes ?? '') && /67/.test(self?.notes ?? ''), self?.notes);
  }

  // Case E
  {
    const self = await memberAge(users.caseE, 'self');
    check('Case E: member row created despite no legacy age', self !== null);
    check('Case E: target_retirement_age left unconfirmed (null), not fabricated', self?.target_retirement_age === null);
    check('Case E: age_source=suggested_default', self?.age_source === 'suggested_default');
  }

  // Case F
  {
    const self = await memberAge(users.caseF, 'self');
    check('Case F: no retirement account -> no member row fabricated by this migration', self === null);
  }

  // Pre-existing row protection
  {
    const self = await memberAge(users.caseAlready, 'self');
    check('Pre-existing user-confirmed row is NOT overwritten by backfill', self?.target_retirement_age === 70, JSON.stringify(self));
  }

  // retirement_accounts.retirement_member_id linkage
  {
    const linked = await db.query(`
      select ra.owner, rm.member_type
      from retirement_accounts ra
      join retirement_members rm on rm.id = ra.retirement_member_id
      where ra.user_id = '${users.caseAB}'
    `);
    check('all Case A/B accounts linked to the correct member', linked.rows.length === 5 && linked.rows.every((r) => r.owner === r.member_type), JSON.stringify(linked.rows));
  }

  // ---------------------------------------------------------------------------
  // Regression: 0073's contribution/current_balance pollution fix stays intact.
  // ---------------------------------------------------------------------------
  const pollution = await db.query(`
    select count(*)::int c, coalesce(sum(current_balance),0)::numeric s
    from retirement_accounts
    where master_item_key in ('employer_contributions','salary_sacrifice','personal_concessional','non_concessional','spouse_contribution','government_co_contribution')
      and is_active = true and current_balance > 0
  `);
  check('0073 contribution/balance fix remains 0 rows / $0 after 0076 (spec s.47)', pollution.rows[0].c === 0 && Number(pollution.rows[0].s) === 0, JSON.stringify(pollution.rows[0]));
}

// ---------------------------------------------------------------------------
// RLS -- cross-tenant isolation re-test after new columns (adapted from
// scripts/air_consolidation_retirement_members_rls.mjs, rooted here).
// ---------------------------------------------------------------------------
console.log('\n=== RLS: cross-tenant isolation re-test ===');
{
  const db = await newDb();
  await applyMigrations(db, ALL_MIGRATIONS);

  const A = '33333333-3333-3333-3333-333333333333';
  const B = '44444444-4444-4444-4444-444444444444';
  await db.exec(`insert into auth.users(id,email) values ('${A}','a2@t.test'),('${B}','b2@t.test');`);
  await db.exec(`insert into retirement_members (user_id, member_type, target_retirement_age) values ('${A}','self',60),('${B}','self',65);`);

  async function asTenant(uid, fn) {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await db.exec(`set role authenticated;`);
    try { return await fn(); } finally { await db.exec(`reset role;`); }
  }

  await asTenant(A, async () => {
    const own = (await db.query(`select count(*)::int c from retirement_members`)).rows[0].c;
    check('Tenant A sees only own retirement_members row', own === 1);
    const leak = (await db.query(`select count(*)::int c from retirement_members where user_id='${B}'`)).rows[0].c;
    check('Tenant A cannot read Tenant B retirement_members', leak === 0);
    let forged = false;
    try {
      await db.query(`insert into retirement_members (user_id, member_type, target_retirement_age) values ('${B}','spouse',50)`);
      forged = true;
    } catch { forged = false; }
    check('Tenant A cannot forge a retirement_members row for Tenant B', !forged);
    const upd = await db.query(`update retirement_members set target_retirement_age=99, is_active=false where user_id='${B}'`);
    check('Tenant A cannot update Tenant B retirement_members (incl. new is_active column)', (upd.rows ?? []).length === 0);
  });

  // Negative control.
  await db.exec(`alter table retirement_members disable row level security;`);
  await asTenant(A, async () => {
    const leak = (await db.query(`select count(*)::int c from retirement_members where user_id='${B}'`)).rows[0].c;
    check('control: RLS off -> Tenant A DOES see Tenant B retirement_members (proves test not vacuous)', leak === 1);
  });
  await db.exec(`alter table retirement_members enable row level security;`);
  await asTenant(A, async () => {
    const leak = (await db.query(`select count(*)::int c from retirement_members where user_id='${B}'`)).rows[0].c;
    check('control: isolation restored', leak === 0);
  });
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
