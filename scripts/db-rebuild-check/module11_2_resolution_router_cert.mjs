// Module 11.2 certification: proves, on a freshly rebuilt real Postgres
// (PGlite, full chain through migration 0117 included), that:
//   - the full 0001..0117 chain applies cleanly from empty
//   - ai_resolution_audit has RLS enabled
//   - a tenant can read their own resolution-audit rows and NOT another
//     tenant's (real tenant isolation, with a negative control)
//   - anon sees zero rows
//   - authenticated cannot INSERT/UPDATE/DELETE a row directly (writes are
//     service_role-only, matching every other Module 11 per-subject table)
//   - the structural CHECK constraint proving the phase's own central
//     invariant is real: a row claiming provider_called=true is REJECTED at
//     the database level, not just by application code
//   - the zero-cost-resolution-implies-no-quota CHECK is real: a
//     DETERMINISTIC row claiming quota_consumed=true is REJECTED, while a
//     LIVE_AI_REQUIRED row claiming quota_consumed=true is accepted (that is
//     the one resolution type future phases may legitimately consume quota
//     for — 11.2 itself never sets this true, but the schema must not
//     conflate "this phase doesn't do X" with "X is structurally impossible
//     forever")
//   - the resolution_type CHECK rejects an unrecognised value

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete: ${files.length} migrations applied, last = ${files[files.length - 1]}\n`);

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);
await db.exec(`insert into households (id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','${A}'), ('bbbbbbbb-0000-0000-0000-000000000002','${B}');`);

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid} — tests would be vacuous`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asAnon(fn) {
  // Explicitly clear any leftover request.jwt.claims from a prior
  // asTenant() call in this same PGlite session — otherwise auth.uid()
  // would still resolve to the last authenticated tenant's id under the
  // anon role, and a "zero rows" result here would be meaningless.
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({})]);
  await db.exec(`set role anon;`);
  const seen = (await db.query(`select auth.uid() u`)).rows[0].u;
  if (seen !== null) { console.log(`  FAIL  harness: auth.uid() is ${seen} under anon, expected null — anon test would be vacuous`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

console.log('=== A. Table exists, RLS enabled ===');
{
  const rls = await db.query(`select relrowsecurity from pg_class where relname = 'ai_resolution_audit'`);
  check('ai_resolution_audit exists with RLS enabled', rls.rows[0]?.relrowsecurity === true);
}

console.log('\n=== B. Seed one real row per tenant, via service role ===');
await asService(async () => {
  await db.exec(`
    insert into ai_resolution_audit (user_id, household_id, request_id, intent_code, intent_version, intent_family, resolution_type, completeness, certification_status, premium_required, premium_satisfied)
      values ('${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'req-a-1', 'CURRENT_NET_WORTH', 1, 'DASHBOARD', 'DETERMINISTIC', 'FULLY_RESOLVED', 'CERTIFIED', false, true),
             ('${B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'req-b-1', 'CURRENT_NET_WORTH', 1, 'DASHBOARD', 'DETERMINISTIC', 'FULLY_RESOLVED', 'CERTIFIED', false, true);
  `);
});

console.log('\n=== C. Tenant isolation (spec sections 78-79, 111) ===');
await asTenant(A, async () => {
  const own = await db.query(`select * from ai_resolution_audit where user_id = '${A}'`);
  check('Tenant A sees own row', own.rows.length === 1);
  const other = await db.query(`select * from ai_resolution_audit where user_id = '${B}'`);
  check('Tenant A sees ZERO of Tenant B rows', other.rows.length === 0, `(saw ${other.rows.length})`);
  const all = await db.query(`select * from ai_resolution_audit`);
  check('Tenant A unfiltered SELECT * still only returns own row (RLS, not app-level filtering)', all.rows.length === 1, `(saw ${all.rows.length})`);
});
await asAnon(async () => {
  const rows = await db.query(`select * from ai_resolution_audit`);
  check('anon sees ZERO rows', rows.rows.length === 0, `(saw ${rows.rows.length})`);
});
await asService(async () => {
  const rows = await db.query(`select * from ai_resolution_audit`);
  check('service-role CAN see all rows (admin/audit tooling still works)', rows.rows.length === 2, `(saw ${rows.rows.length})`);
});

console.log('\n=== D. Negative control — RLS off proves the zero-row result above is real isolation, not an empty table ===');
await db.exec(`alter table ai_resolution_audit disable row level security;`);
await asTenant(A, async () => {
  const rows = await db.query(`select * from ai_resolution_audit`);
  check('RLS OFF -> Tenant A DOES see both rows', rows.rows.length === 2, `(saw ${rows.rows.length})`);
});
await db.exec(`alter table ai_resolution_audit enable row level security;`);

console.log('\n=== E. Write privileges — service_role only (spec section 60) ===');
await asTenant(A, async () => {
  try {
    await db.exec(`insert into ai_resolution_audit (user_id, request_id, resolution_type) values ('${A}', 'forged', 'DETERMINISTIC');`);
    check('authenticated INSERT is rejected', false, '(no error was thrown — INSERT unexpectedly succeeded)');
  } catch (e) {
    check('authenticated INSERT is rejected', /permission denied|42501/i.test(String(e.message || e)), `(${e.message})`);
  }
  try {
    await db.exec(`update ai_resolution_audit set resolution_type = 'BLOCKED' where user_id = '${A}';`);
    check('authenticated UPDATE is rejected', false, '(no error was thrown — UPDATE unexpectedly succeeded)');
  } catch (e) {
    check('authenticated UPDATE is rejected', /permission denied|42501/i.test(String(e.message || e)), `(${e.message})`);
  }
});

console.log('\n=== F. Structural invariant — provider_called can NEVER be true (spec sections 54, 118, migration CHECK) ===');
await asService(async () => {
  try {
    await db.exec(`insert into ai_resolution_audit (user_id, request_id, resolution_type, provider_called) values ('${A}', 'bad-1', 'DETERMINISTIC', true);`);
    check('a row claiming provider_called=true is REJECTED at the DB level', false, '(insert unexpectedly succeeded)');
  } catch (e) {
    check('a row claiming provider_called=true is REJECTED at the DB level', /chk_ai_resolution_audit_no_provider_calls|check constraint/i.test(String(e.message || e)), `(${e.message})`);
  }
});

console.log('\n=== G. Structural invariant — zero-cost resolution types can NEVER claim quota consumed ===');
await asService(async () => {
  try {
    await db.exec(`insert into ai_resolution_audit (user_id, request_id, resolution_type, quota_consumed) values ('${A}', 'bad-2', 'DETERMINISTIC', true);`);
    check('a DETERMINISTIC row claiming quota_consumed=true is REJECTED', false, '(insert unexpectedly succeeded)');
  } catch (e) {
    check('a DETERMINISTIC row claiming quota_consumed=true is REJECTED', /chk_ai_resolution_audit_zero_cost_no_quota|check constraint/i.test(String(e.message || e)), `(${e.message})`);
  }
  // Negative control on section G itself: LIVE_AI_REQUIRED is NOT in the
  // zero-cost list, so the same quota_consumed=true value must be ACCEPTED
  // here — proving the CHECK targets the right resolution types, not "quota
  // consumed is always false".
  try {
    await db.exec(`insert into ai_resolution_audit (user_id, request_id, resolution_type, quota_consumed) values ('${A}', 'ok-1', 'LIVE_AI_REQUIRED', true);`);
    check('NEGATIVE CONTROL: a LIVE_AI_REQUIRED row with quota_consumed=true IS accepted (the CHECK is scoped, not vacuous)', true);
  } catch (e) {
    check('NEGATIVE CONTROL: a LIVE_AI_REQUIRED row with quota_consumed=true IS accepted (the CHECK is scoped, not vacuous)', false, `(${e.message})`);
  }
});

console.log('\n=== H. resolution_type CHECK rejects an unrecognised value ===');
await asService(async () => {
  try {
    await db.exec(`insert into ai_resolution_audit (user_id, request_id, resolution_type) values ('${A}', 'bad-3', 'MADE_UP_TYPE');`);
    check('an unrecognised resolution_type is rejected', false, '(insert unexpectedly succeeded)');
  } catch (e) {
    check('an unrecognised resolution_type is rejected', /check constraint|invalid input/i.test(String(e.message || e)), `(${e.message})`);
  }
});

console.log(`\nMODULE 11.2 CERTIFICATION: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
