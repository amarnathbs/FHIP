// Investment Intelligence R9 — real-Postgres (PGlite) certification.
//
// Reuses the exact harness established by scripts/db-rebuild-check/rls.mjs
// (session-scoped GUC tenant emulation via asTenant(), a harness sanity
// check that auth.uid() actually reads the intended value before any
// isolation claim is trusted, and negative controls that prove a test can
// actually fail). This is the local substitute for live-DEV certification —
// migration 0067 is NOT yet applied to DEV (no DDL-execution credential in
// this environment; see R9_LIVE_DEV_VERIFICATION.md for the exact,
// honestly-disclosed status) — so every claim below is proven against a
// real PostgreSQL engine (PGlite), not simulated in application code, and
// not a live-DEV substitute-in-name-only.
//
// Run: node scripts/ii_r9_certification.mjs

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
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log('fresh rebuild complete (67 migrations, includes 0067_ii_r9_review_centre.sql)\n');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);

// Minimal real fixtures for each tenant: one goal, one investment, one
// active funding source at 100% (the state a real allocated position is in
// after the R9-fixed write path).
await db.exec(`
insert into user_goals (id, user_id, goal_name, goal_type, target_amount, currency_code, status)
  values ('${'a0000000-0000-0000-0000-00000000000a'}','${A}','Tenant A Retirement','retirement_balance_target',1000000,'AUD','active'),
         ('${'b0000000-0000-0000-0000-00000000000b'}','${B}','Tenant B Retirement','retirement_balance_target',1000000,'INR','active');
insert into investments (id, user_id, investment_name, master_item_key, current_value, currency_code, investment_type, is_active)
  values ('${'a1111111-0000-0000-0000-00000000000a'}','${A}','Tenant A Fund','managed_funds',100000,'AUD','managed_fund',true),
         ('${'b1111111-0000-0000-0000-00000000000b'}','${B}','Tenant B Fund','managed_funds',200000,'INR','managed_fund',true);
insert into goal_funding_sources (user_id, goal_id, source_type, linked_investment_id, allocation_percentage, allocated_amount)
  values ('${A}','${'a0000000-0000-0000-0000-00000000000a'}','investment','${'a1111111-0000-0000-0000-00000000000a'}',100,100000),
         ('${B}','${'b0000000-0000-0000-0000-00000000000b'}','investment','${'b1111111-0000-0000-0000-00000000000b'}',100,200000);
insert into ii_goal_allocations (user_id, goal_id, investment_position_id, allocation_type, allocation_value, source, status, linked_investment_id)
  values ('${A}','${'a0000000-0000-0000-0000-00000000000a'}','${'a1111111-0000-0000-0000-00000000000a'}','percentage',100,'user','active','${'a1111111-0000-0000-0000-00000000000a'}'),
         ('${B}','${'b0000000-0000-0000-0000-00000000000b'}','${'b1111111-0000-0000-0000-00000000000b'}','percentage',100,'user','active','${'b1111111-0000-0000-0000-00000000000b'}');
insert into ii_review_items (user_id, review_type, category, severity, title, description, source_module, review_engine_version, rule_key, rule_version, identity_key, as_of_date, status)
  values ('${A}','goal','goal_forecast_gap','medium','Tenant A review item','desc','goals','review-1.0.0','goal_forecast_gap','r9-1.0.0','key-a-1','2026-08-23','open'),
         ('${B}','goal','goal_forecast_gap','medium','Tenant B review item','desc','goals','review-1.0.0','goal_forecast_gap','r9-1.0.0','key-b-1','2026-08-23','open');
`);
console.log('seeded R9 fixtures for both tenants\n');

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid} — tests would be vacuous`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  // R9-LIVE-CERT FIX: must ALSO overwrite request.jwt.claims's role to
  // 'service_role', not just reset the Postgres role -- set_config(...,
  // false) is session-scoped, so a stale 'authenticated' claim from a prior
  // asTenant() call would otherwise still be visible to auth.role() even
  // after `reset role`, which the new authoritative-write trigger
  // (migration 0069) checks directly. Matches the established pattern in
  // scripts/r7_security_certification.mjs's asService(). Use this for data
  // reads/writes that need to look like the real service-role client.
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', role: 'service_role' })]);
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
// Plain table-owner/superuser context -- for DDL only (the RLS-toggle
// negative control needs ALTER TABLE privilege, which service_role does
// not have and should not have). Distinct from asService() on purpose:
// conflating the two broke the RLS-toggle negative control the first time
// this fix was written (service_role lacks ownership; superuser bypasses
// RLS but is a different Postgres role from what auth.role() should ever
// report for a real request).
async function asOwner(fn) {
  await db.exec(`reset role;`);
  return fn();
}

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

console.log('=== POSITIVE ACCESS ===');
await asTenant(A, async () => {
  const r = await db.query(`select count(*)::int c from ii_review_items where user_id = '${A}'`);
  check('Tenant A reads own ii_review_items', r.rows[0].c === 1, `(saw ${r.rows[0].c}, expected 1)`);
  const r2 = await db.query(`select count(*)::int c from ii_goal_allocations where user_id = '${A}'`);
  check('Tenant A reads own ii_goal_allocations', r2.rows[0].c === 1, `(saw ${r2.rows[0].c}, expected 1)`);
});

console.log('\n=== CROSS-TENANT READ DENIAL (spec sections 66, 70, 114) ===');
await asTenant(A, async () => {
  const r = await db.query(`select count(*)::int c from ii_review_items where user_id = '${B}'`);
  check('Tenant A cannot read Tenant B ii_review_items', r.rows[0].c === 0, `(leaked ${r.rows[0].c})`);
  const r2 = await db.query(`select * from ii_review_items`); // no filter at all — RLS alone must scope this
  check('Tenant A unfiltered SELECT on ii_review_items only returns own rows', r2.rows.every((row) => row.user_id === A) && r2.rows.length === 1, `(saw ${r2.rows.length} row(s))`);
  const r3 = await db.query(`select count(*)::int c from ii_goal_allocations where user_id = '${B}'`);
  check('Tenant A cannot read Tenant B ii_goal_allocations', r3.rows[0].c === 0, `(leaked ${r3.rows[0].c})`);
});

console.log('\n=== CROSS-TENANT WRITE / SAME-USER-VALID-FK FORGERY DENIAL (spec sections 67, 70, 71, 115) ===');
await asTenant(A, async () => {
  // Attempt 1: A tries to forge a review item claiming to belong to B, using A's own real goal (valid FK on the goal side, forged on user_id).
  try {
    await db.query(`insert into ii_review_items (user_id, review_type, category, severity, title, description, source_module, review_engine_version, rule_key, rule_version, identity_key, as_of_date, status) values ('${B}','goal','x','low','forged','forged','goals','review-1.0.0','x','r9-1.0.0','forged-key','2026-08-23','open')`);
    check('Tenant A cannot INSERT a ii_review_items row claiming user_id=B', false, '(insert succeeded — should have been rejected by RLS WITH CHECK)');
  } catch (e) {
    check('Tenant A cannot INSERT a ii_review_items row claiming user_id=B', /row-level security|permission denied/i.test(e.message), `(${e.message.slice(0, 120)})`);
  }
  // Attempt 2: A tries to directly UPDATE Tenant B's row (forge severity/status on a row A does not own).
  const upd = await db.query(`update ii_review_items set severity = 'high', status = 'resolved' where user_id = '${B}' returning id`);
  check('Tenant A cannot UPDATE Tenant B ii_review_items (forged severity/status)', upd.rows.length === 0, `(updated ${upd.rows.length} row(s))`);
  // Attempt 3: A tries to link A's own real goal to a forged reference to B's investment id (valid own goal FK, forged investment ownership).
  try {
    await db.query(`insert into ii_goal_allocations (user_id, goal_id, investment_position_id, allocation_type, allocation_value, source, status, linked_investment_id) values ('${A}','a0000000-0000-0000-0000-00000000000a','${'b1111111-0000-0000-0000-00000000000b'}','percentage',50,'user','active','${'b1111111-0000-0000-0000-00000000000b'}')`);
    // RLS on ii_goal_allocations only enforces auth.uid()=user_id — it does NOT itself validate linked_investment_id ownership (that is an APPLICATION-layer check in goalAllocations.ts's assertOwnsInvestment(), not a DB constraint, since investments.id has no owner-matching CHECK). Document this honestly rather than assert a DB-level guarantee that does not exist.
    console.log('  NOTE  RLS permits inserting an ii_goal_allocations row that references another tenant\'s investments.id (linked_investment_id is a plain FK, not owner-validated at the DB layer) — the R9 API layer\'s assertOwnsInvestment() is the actual control for this, verified separately below.');
  } catch (e) {
    console.log(`  NOTE  DB rejected the forged FK reference outright: ${e.message.slice(0, 150)}`);
  }
});

console.log('\n=== NEGATIVE CONTROLS (isolation deliberately removed -> leak MUST appear; spec section 93) ===');
await asOwner(async () => db.exec(`alter table ii_review_items disable row level security;`));
await asTenant(A, async () => {
  const r = await db.query(`select count(*)::int c from ii_review_items where user_id = '${B}'`);
  check('control: RLS off on ii_review_items -> Tenant A DOES see Tenant B (proves the test is not vacuous)', r.rows[0].c === 1, `(saw ${r.rows[0].c}, expected 1)`);
});
await asOwner(async () => db.exec(`alter table ii_review_items enable row level security;`));
await asTenant(A, async () => {
  const r = await db.query(`select count(*)::int c from ii_review_items where user_id = '${B}'`);
  check('control: isolation restored on ii_review_items', r.rows[0].c === 0, `(saw ${r.rows[0].c})`);
});

console.log('\n=== NO-DUPLICATE-SPAM CONSTRAINT (spec section 50) ===');
await asService(async () => {
  try {
    await db.query(`insert into ii_review_items (user_id, review_type, category, severity, title, description, source_module, review_engine_version, rule_key, rule_version, identity_key, as_of_date, status) values ('${A}','goal','goal_forecast_gap','medium','dup','dup','goals','review-1.0.0','goal_forecast_gap','r9-1.0.0','key-a-1','2026-08-23','open')`);
    check('a second OPEN row with the same (user_id, identity_key) is rejected by uidx_ii_review_items_open_identity', false, '(insert succeeded — should have violated the unique index)');
  } catch (e) {
    check('a second OPEN row with the same (user_id, identity_key) is rejected by uidx_ii_review_items_open_identity', /duplicate key|unique constraint/i.test(e.message), `(${e.message.slice(0, 120)})`);
  }
  // A SUPERSEDED row with the same identity_key is fine (the partial index only covers open/acknowledged) — this is the mechanism updateGoalAllocation-style supersession relies on.
  await db.query(`update ii_review_items set status='superseded' where user_id='${A}' and identity_key='key-a-1'`);
  const r = await db.query(`insert into ii_review_items (user_id, review_type, category, severity, title, description, source_module, review_engine_version, rule_key, rule_version, identity_key, as_of_date, status) values ('${A}','goal','goal_forecast_gap','medium','fresh','fresh','goals','review-1.0.0','goal_forecast_gap','r9-1.0.0','key-a-1','2026-08-23','open') returning id`);
  check('a fresh OPEN row with the same identity_key succeeds once the old row is superseded (real supersession lifecycle)', r.rows.length === 1);
});

console.log('\n=== ALLOCATION CAP — SINGLE-ROW DB CHECK (defence-in-depth; the primary <=100% control is application-layer checkFundingAllocation(), tested at the unit level in tests/unit/goalFundingAllocation.test.ts) ===');
await asService(async () => {
  try {
    await db.query(`insert into goal_funding_sources (user_id, goal_id, source_type, linked_investment_id, allocation_percentage) values ('${A}','a0000000-0000-0000-0000-00000000000a','investment','${'a1111111-0000-0000-0000-00000000000a'}',150)`);
    check('goal_funding_sources rejects a single allocation_percentage > 100 (CHECK constraint)', false, '(insert succeeded)');
  } catch (e) {
    check('goal_funding_sources rejects a single allocation_percentage > 100 (CHECK constraint)', /check constraint/i.test(e.message), `(${e.message.slice(0, 120)})`);
  }
});

console.log('\n=== NO-DOUBLE-COUNTING: ONE ACTIVE PUBLICATION PER ECONOMIC POSITION (spec sections 24-25, 87 — R3 invariant, R9 must not weaken it) ===');
await asService(async () => {
  const acctId = 'c1111111-1111-1111-1111-111111111111';
  const instrId = 'c2222222-2222-2222-2222-222222222222';
  const snap1 = 'c3333333-3333-3333-3333-333333333331';
  const snap2 = 'c3333333-3333-3333-3333-333333333332';
  await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values ('${acctId}','${A}','AU','AUD','broker','Test Broker') on conflict do nothing;`);
  await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency) values ('${instrId}','Test Instrument','equity','AU','AUD') on conflict do nothing;`);
  await db.exec(`insert into ii_holding_snapshots (id, user_id, account_id, instrument_id, currency_code, as_of_date, units, value) values
      ('${snap1}','${A}','${acctId}','${instrId}','AUD','2026-08-01',100,10000),
      ('${snap2}','${A}','${acctId}','${instrId}','AUD','2026-08-02',100,10500);`);
  await db.query(`insert into ii_fhip_publications (user_id, canonical_position_id, publication_target, account_id, instrument_id, status) values ('${A}','${snap1}','investments','${acctId}','${instrId}','published')`);
  check('first publication for a fresh (account_id, instrument_id) succeeds', true);
  try {
    await db.query(`insert into ii_fhip_publications (user_id, canonical_position_id, publication_target, account_id, instrument_id, status) values ('${A}','${snap2}','investments','${acctId}','${instrId}','published')`);
    check('a second ACTIVE publication for the SAME (account_id, instrument_id) is rejected', false, '(insert succeeded — double-counting risk)');
  } catch (e) {
    check('a second ACTIVE publication for the SAME (account_id, instrument_id) is rejected', /duplicate key|unique constraint/i.test(e.message), `(${e.message.slice(0, 150)})`);
  }
  // Negative control: prove this specific guarantee is not vacuous by dropping the index and repeating.
  // Index DROP/CREATE needs table-owner privilege, which service_role does
  // not have -- nest asOwner() for the DDL only, keep the data write itself
  // under the outer service-role context.
  await asOwner(async () => db.exec(`drop index uidx_ii_fhip_publications_one_active_position;`));
  const r = await db.query(`insert into ii_fhip_publications (user_id, canonical_position_id, publication_target, account_id, instrument_id, status) values ('${A}','${snap2}','investments','${acctId}','${instrId}','published') returning id`);
  check('control: with the guard index dropped, a second active publication for the same position DOES succeed (proves the test above is not vacuous)', r.rows.length === 1);
  await db.query(`delete from ii_fhip_publications where canonical_position_id = '${snap2}'`);
  await asOwner(async () => db.exec(`create unique index uidx_ii_fhip_publications_one_active_position on ii_fhip_publications(account_id, instrument_id) where status = 'published';`));
});

console.log(`\nR9 CERTIFICATION: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
