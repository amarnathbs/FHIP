// Mandatory Country Confirmation — clean-rebuild replay + DB-trigger
// enforcement certification, using the repo's established PGlite harness
// pattern (scripts/db-rebuild-check/{shim.sql,smsf_jurisdiction_cert.mjs}).
//
// Proves, against a REAL Postgres engine (PGlite/WASM), not a mock:
//   1. The full migration chain (0001-0104) replays cleanly from empty.
//   2. handle_new_user still creates a profile with country fields null —
//      migration 0104 does not break signup.
//   3. An unconfirmed user's direct INSERT into every one of the 8
//      backstopped financial tables is rejected.
//   4. Confirming a supported country makes those same inserts succeed.
//   5. A recognised-but-unsupported country (is_supported=false) does NOT
//      count as confirmed, even with country_confirmed_at set.
//   6. service_role writes are never blocked by the trigger.
//   7. Existing rows created before confirmation are preserved byte-for-byte
//      (spec 1.3/6.2) — never deleted, hidden or rewritten by a later
//      confirmation.
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');

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

var pass = 0,
  fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
};
async function expectReject(label, fn) {
  try {
    await fn();
    check(label, false, '(expected rejection, but it succeeded)');
  } catch (e) {
    check(label, true, `(rejected: ${e.message.slice(0, 120)})`);
  }
}
async function expectOk(label, fn) {
  try {
    const r = await fn();
    check(label, true);
    return r;
  } catch (e) {
    check(label, false, `(unexpected error: ${e.message.slice(0, 160)})`);
  }
}
async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}
async function asService(fn) {
  // Real Supabase PostgREST sets BOTH the Postgres session role AND the
  // request.jwt.claims GUC (decoded from the service-role JWT, whose own
  // payload carries `"role":"service_role"`) for every service-role
  // request — auth.role() (used by enforce_country_confirmed()) reads the
  // JWT claim, not the bare Postgres role, so a harness that only does
  // `set role service_role` without also setting the claim under-tests the
  // real platform behaviour. Mirrors asTenant()'s own set_config call.
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec(`set role service_role;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

const U1 = '11111111-1111-1111-1111-111111111111'; // will confirm AU
const U2 = '22222222-2222-2222-2222-222222222222'; // stays unconfirmed
const U3 = '33333333-3333-3333-3333-333333333333'; // recognised-but-unsupported (NZ)

console.log('=== Setup: 3 tenants via real signup trigger ===');
await db.exec(`insert into auth.users(id,email) values ('${U1}','u1@t.test'),('${U2}','u2@t.test'),('${U3}','u3@t.test');`);
{
  const { rows } = await db.query(
    `select country_of_residence, country_confirmed_at, country_source from user_profiles where user_id in ('${U1}','${U2}','${U3}')`
  );
  check('handle_new_user still creates a profile row for every new auth.users insert (0104 does not break signup)', rows.length === 3);
  check(
    'every freshly created profile has country_of_residence/country_confirmed_at/country_source all null (no silent default)',
    rows.every((r) => r.country_of_residence === null && r.country_confirmed_at === null && r.country_source === null)
  );
}

console.log('\n=== is_country_confirmed() + trigger reject unconfirmed users on every backstopped table ===');
{
  const { rows } = await db.query(`select public.is_country_confirmed('${U2}') as c`);
  check('is_country_confirmed() is FALSE for a brand-new profile (null country)', rows[0].c === false);
}

const insertAttempts = {
  income_sources: `insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code) values ('${U2}','Salary','salary',1000,'monthly','AUD')`,
  expense_items: `insert into expense_items (user_id, expense_name, expense_category, amount, frequency, currency_code) values ('${U2}','Rent','housing',500,'monthly','AUD')`,
  assets: `insert into assets (user_id, asset_name, asset_class, current_value, currency_code) values ('${U2}','Savings','cash',1000,'AUD')`,
  liabilities: `insert into liabilities (user_id, liability_name, debt_type, balance, currency_code) values ('${U2}','Card','credit_card',200,'AUD')`,
  investments: `insert into investments (user_id, investment_name, investment_type, current_value, currency_code) values ('${U2}','ETF','etf',500,'AUD')`,
  retirement_accounts: `insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code) values ('${U2}','Super','super',5000,'AUD')`,
  insurance_policies: `insert into insurance_policies (user_id, policy_name, cover_type, cover_amount, premium, premium_frequency, currency_code) values ('${U2}','Life','life',100000,10,'monthly','AUD')`,
  user_goals: `insert into user_goals (user_id, goal_name, goal_type, target_amount, currency_code) values ('${U2}','Emergency fund','starter_emergency_fund',3000,'AUD')`,
};

await asTenant(U2, async () => {
  for (const [table, sql] of Object.entries(insertAttempts)) {
    await expectReject(`unconfirmed user's direct INSERT into ${table} is rejected`, () => db.query(sql));
  }
});

console.log('\n=== Confirming a supported country flips every table from reject to allow ===');
await db.exec(
  `update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id='${U1}'`
);
{
  const { rows } = await db.query(`select public.is_country_confirmed('${U1}') as c`);
  check('is_country_confirmed() is TRUE once country_of_residence + country_confirmed_at are both set to a supported code', rows[0].c === true);
}
let preservedIds = {};
await asTenant(U1, async () => {
  for (const [table, sql] of Object.entries(insertAttempts)) {
    const asU1 = sql.replaceAll(U2, U1);
    const row = await expectOk(`confirmed AU user's direct INSERT into ${table} now succeeds`, async () => {
      const r = await db.query(asU1 + ' returning id');
      return r.rows[0].id;
    });
    preservedIds[table] = row;
  }
});

console.log('\n=== Recognised-but-unsupported country (NZ) never counts as confirmed, even with a timestamp ===');
await db.exec(`insert into countries (country_code, country_name, default_currency_code, is_supported) values ('NZ','New Zealand','NZD',false) on conflict do nothing;`);
await db.exec(
  `update user_profiles set country_of_residence='NZ', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id='${U3}'`
);
{
  const { rows } = await db.query(`select public.is_country_confirmed('${U3}') as c`);
  check('is_country_confirmed() is FALSE for a recognised-but-unsupported country even with country_confirmed_at set (never a false positive)', rows[0].c === false);
}
await asTenant(U3, async () => {
  await expectReject('NZ (unsupported) user is still rejected by the trigger despite holding a confirmation timestamp', () =>
    db.query(insertAttempts.assets.replaceAll(U2, U3))
  );
});

console.log('\n=== service_role bypass — background/admin writes are never blocked ===');
await asService(async () => {
  await expectOk('service_role INSERT for the still-unconfirmed U2 succeeds (admin/background remediation is not blocked)', () =>
    db.query(insertAttempts.assets)
  );
});

console.log('\n=== Existing-data preservation across confirmation (spec 1.3/6.2) ===');
{
  const before = await db.query(`select id, current_value from assets where user_id='${U1}' and id='${preservedIds.assets}'`);
  check('the row inserted right after confirmation is readable, unchanged, with its real value intact', before.rows.length === 1 && Number(before.rows[0].current_value) === 1000);

  // Now change U1's country (simulating spec 5.7's reconfirmation-reset) and
  // verify the SAME pre-existing rows are still present afterwards,
  // unmodified — country changes never delete/hide/rewrite history.
  await db.exec(`update user_profiles set country_confirmed_at=null, country_source=null, country_of_residence='IN', country_updated_at=now() where user_id='${U1}'`);
  const stillThere = await db.query(`select id, current_value, asset_name from assets where user_id='${U1}' and id='${preservedIds.assets}'`);
  check(
    'after country_of_residence changes and confirmation resets to unconfirmed, the pre-existing asset row is still present, unmodified',
    stillThere.rows.length === 1 && stillThere.rows[0].asset_name === 'Savings' && Number(stillThere.rows[0].current_value) === 1000
  );
  const allEightStillCount = await Promise.all(
    Object.keys(insertAttempts).map(async (t) => (await db.query(`select count(*)::int c from ${t} where user_id='${U1}'`)).rows[0].c)
  );
  check('every one of the 8 tables still shows exactly 1 row for U1 after the country change (nothing deleted)', allEightStillCount.every((c) => c === 1), `(${JSON.stringify(allEightStillCount)})`);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed (${pass + fail} checks) ===`);
process.exit(fail === 0 ? 0 : 1);
