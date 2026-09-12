// Migration 0147 — GENERIC archive-via-UPDATE bypass fix. PGlite replay
// certification (real Postgres via PGlite, same harness pattern as
// mcc_pglite_certification.mjs / mcc14_delete_cascade_certification.mjs).
//
// This is a LOCAL-ONLY test. Migration 0147 is NOT applied to any real DEV
// or production database by this script or this session -- per this
// project's standing policy, new migrations are prepared and locally
// tested, then handed to the Product Owner for manual application. See
// supabase/migrations/0147_g8_generic_archive_bypass_fix.sql for the full
// defect writeup and tests/live-dev/g8LiveDevGenericArchiveBypassCertification.test.ts
// for the live-DEV reproduction of the pre-fix defect.
//
// Proves:
//  1. Fresh replay 0001 -> 0147 (inclusive) succeeds cleanly.
//  2. GENERIC user: ordinary field UPDATE (amount) still succeeds.
//  3. GENERIC user: archive-transition UPDATE (is_active true->false) is
//     now BLOCKED (the fix).
//  4. GENERIC user: re-activation UPDATE (is_active false->true) still
//     succeeds (unaffected by the fix).
//  5. GENERIC user: bulk archive-transition UPDATE (`in (...)`) is blocked.
//  6. FULL (country-confirmed AU) user: archive-transition UPDATE still
//     succeeds unaffected (is_write_permitted's early return is untouched).
//  7. Literal DELETE for GENERIC remains blocked (unchanged, pre-existing).
//  8. Genuine account-deletion cascade (auth.users row deleted, this
//     session's own _mcc_auth_user_exists() exemption) still succeeds for a
//     GENERIC user who owns rows in all three tables.
//  9. service_role is unaffected (bypasses is_write_permitted() entirely).

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd(), 'supabase');
const MIG = path.join(ROOT, 'migrations');
const HERE = path.resolve(process.cwd(), 'scripts');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));

const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
let replayed = 0;
for (const f of files) {
  const sql = fs
    .readFileSync(path.join(MIG, f), 'utf8')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
  try {
    await db.exec(sql);
    replayed++;
  } catch (e) {
    console.error(`\nREPLAY FAILED at ${f}\n${e.message}\n`);
    process.exit(3);
  }
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`REPLAY COMPLETE: ${replayed}/${files.length} migrations applied cleanly (0001 -> ${files[files.length - 1]})\n`);
if (!files.some((f) => f.startsWith('0147'))) {
  console.error('FATAL: migration 0147 was not found in supabase/migrations -- nothing to certify.');
  process.exit(4);
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
async function expectReject(label, fn) {
  try { await fn(); check(label, false, '(expected rejection, but it succeeded)'); }
  catch (e) { check(label, true, `(rejected: ${e.message.slice(0, 140)})`); }
}
async function expectOk(label, fn) {
  try { const r = await fn(); check(label, true); return r; }
  catch (e) { check(label, false, `(unexpected error: ${e.message.slice(0, 160)})`); }
}
async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
// Real account deletion at the platform level runs as the DB owner/superuser
// (a service-role JWT is only how the *application* invokes it) -- mirrors
// mcc14_delete_cascade_certification.mjs's own asAccountDeletionCascade().
async function asAccountDeletionCascade(fn) {
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec(`reset role;`);
  return fn();
}

function uuid() { return crypto.randomUUID(); }

async function makeUser(id, email) {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
}

async function confirmGeneric(userId, country) {
  await asService(async () => {
    await db.query(
      `update user_profiles set country_of_residence=$2, country_confirmed_at=now(), country_source='USER_CONFIRMED',
         preferred_currency='AUD', generic_disclosure_version='pglite-cert-v1',
         generic_disclosure_acknowledged_at=now(), generic_disclosure_country=$2
       where user_id=$1`,
      [userId, country]
    );
  });
}
async function confirmFull(userId, country) {
  await asService(async () => {
    await db.query(
      `update user_profiles set country_of_residence=$2, country_confirmed_at=now(), country_source='USER_CONFIRMED'
       where user_id=$1`,
      [userId, country]
    );
  });
}

async function seedIncomeRow(userId) {
  return asTenant(userId, async () => {
    const r = await db.query(
      `insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, owner, is_taxable)
       values ($1, 'pglite cert income', 'salary', 1000, 'monthly', 'AUD', 'self', true)
       returning id`,
      [userId]
    );
    return r.rows[0].id;
  });
}

console.log('--- Setup ---');
const generic1 = uuid();
const generic2 = uuid();
const fullUser = uuid();
await makeUser(generic1, 'g8-0147-generic1@test.local');
await makeUser(generic2, 'g8-0147-generic2@test.local');
await makeUser(fullUser, 'g8-0147-full@test.local');
await confirmGeneric(generic1, 'GB');
await confirmGeneric(generic2, 'GB');
await confirmFull(fullUser, 'AU');

console.log('\n--- 2. Ordinary field UPDATE (GENERIC) still succeeds ---');
const rowA = await seedIncomeRow(generic1);
await expectOk('GENERIC ordinary UPDATE (amount) succeeds', () =>
  asTenant(generic1, () => db.query(`update income_sources set amount=1500 where id=$1`, [rowA]))
);

console.log('\n--- 3. Archive-transition UPDATE (GENERIC) is now BLOCKED ---');
await expectReject('GENERIC archive UPDATE (is_active true->false) is blocked', () =>
  asTenant(generic1, () => db.query(`update income_sources set is_active=false where id=$1`, [rowA]))
);
const stillActive = await asService(() => db.query(`select is_active from income_sources where id=$1`, [rowA]));
check('row remains active after the blocked archive attempt', stillActive.rows[0].is_active === true);

console.log('\n--- 4. Re-activation UPDATE (GENERIC) still succeeds ---');
await asService(() => db.query(`update income_sources set is_active=false where id=$1`, [rowA])); // force archived via service role
await expectOk('GENERIC re-activation UPDATE (is_active false->true) succeeds', () =>
  asTenant(generic1, () => db.query(`update income_sources set is_active=true where id=$1`, [rowA]))
);

console.log('\n--- 5. Bulk archive-transition UPDATE (GENERIC) is blocked ---');
const rowB = await seedIncomeRow(generic1);
const rowC = await seedIncomeRow(generic1);
await expectReject('GENERIC bulk archive UPDATE (.in()) is blocked', () =>
  asTenant(generic1, () => db.query(`update income_sources set is_active=false where id in ($1,$2)`, [rowB, rowC]))
);
const bulkCheck = await asService(() => db.query(`select is_active from income_sources where id in ($1,$2)`, [rowB, rowC]));
check('both bulk-targeted rows remain active', bulkCheck.rows.every((r) => r.is_active === true));

console.log('\n--- 6. FULL (AU) user archive-transition UPDATE still succeeds (unaffected) ---');
const rowFull = await asTenant(fullUser, async () => {
  const r = await db.query(
    `insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, owner, is_taxable)
     values ($1, 'pglite cert income (full)', 'salary', 1000, 'monthly', 'AUD', 'self', true) returning id`,
    [fullUser]
  );
  return r.rows[0].id;
});
await expectOk('FULL user archive UPDATE (is_active true->false) still succeeds', () =>
  asTenant(fullUser, () => db.query(`update income_sources set is_active=false where id=$1`, [rowFull]))
);

console.log('\n--- 7. Literal DELETE for GENERIC remains blocked (pre-existing, unchanged) ---');
const rowD = await seedIncomeRow(generic1);
await expectReject('GENERIC literal DELETE remains blocked', () =>
  asTenant(generic1, () => db.query(`delete from income_sources where id=$1`, [rowD]))
);

console.log('\n--- 8. Genuine account-deletion cascade still succeeds ---');
await seedIncomeRow(generic2);
await asTenant(generic2, () =>
  db.query(
    `insert into expense_items (user_id, expense_name, expense_category, amount, frequency, currency_code, owner, is_essential)
     values ($1, 'pglite cert expense', 'other', 200, 'monthly', 'AUD', 'self', false)`,
    [generic2]
  )
);
await asTenant(generic2, () =>
  db.query(
    `insert into insurance_policies (user_id, policy_name, cover_type, cover_amount, premium, premium_frequency, currency_code, owner)
     values ($1, 'pglite cert insurance', 'other', 5000, 20, 'monthly', 'AUD', 'self')`,
    [generic2]
  )
);
await expectOk('genuine account-deletion cascade (auth.users DELETE) succeeds for a GENERIC user with rows in all 3 tables', () =>
  asAccountDeletionCascade(() => db.query(`delete from auth.users where id=$1`, [generic2]))
);
const residueCheck = await asService(() =>
  db.query(
    `select
       (select count(*) from income_sources where user_id=$1) as income,
       (select count(*) from expense_items where user_id=$1) as expense,
       (select count(*) from insurance_policies where user_id=$1) as insurance`,
    [generic2]
  )
);
const r = residueCheck.rows[0];
check('all 3 tables cascade-cleaned for the deleted account', Number(r.income) === 0 && Number(r.expense) === 0 && Number(r.insurance) === 0, JSON.stringify(r));

console.log('\n--- 9. service_role is unaffected ---');
await expectOk('service_role archive UPDATE succeeds unconditionally', () =>
  asService(() => db.query(`update income_sources set is_active=false where id=$1`, [rowB]))
);

console.log(`\n=== SUMMARY: ${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) process.exit(1);
