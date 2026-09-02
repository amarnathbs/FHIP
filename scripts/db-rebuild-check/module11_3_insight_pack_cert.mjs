// Module 11.3 certification: proves, on a freshly rebuilt real Postgres
// (PGlite, full chain through migration 0121 included), that:
//   - the full 0001..0121 chain applies cleanly from empty
//   - ai_insight_packs / ai_insight_pack_blocks / ai_insight_pack_batches all
//     have RLS enabled
//   - a tenant can read their own pack/block rows and NOT another tenant's
//     (real tenant isolation, with a negative control)
//   - anon sees zero rows on every table
//   - ai_insight_pack_batches (governance-only) is invisible to an ordinary
//     authenticated tenant, matching the ai_model_registry precedent
//   - the structural READY invariant (spec section 107) is real: a row
//     claiming status=READY without validated_at/ready_at/grounding_status=
//     PASS is REJECTED at the database level; a compliant row is accepted
//   - the pack-identity unique index (spec section 9) rejects a genuine
//     duplicate generation for the same identity tuple
//   - the (pack_id, block_code) unique index rejects a duplicate block
//   - migration 0121's prompt/model/cost-limit seeds are present

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

console.log('=== A. Tables exist, RLS enabled ===');
for (const t of ['ai_insight_packs', 'ai_insight_pack_blocks', 'ai_insight_pack_batches']) {
  const rls = await db.query(`select relrowsecurity from pg_class where relname = '${t}'`);
  check(`${t} exists with RLS enabled`, rls.rows[0]?.relrowsecurity === true);
}

console.log('\n=== B. Seed one real READY pack per tenant, via service role ===');
const PACK_A = 'cccccccc-0000-0000-0000-000000000001';
const PACK_B = 'dddddddd-0000-0000-0000-000000000002';
await asService(async () => {
  await db.exec(`
    insert into ai_insight_packs (id, user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, overall_confidence, grounding_status, critical_safety_failure, generated_at, validated_at, ready_at)
    values
      ('${PACK_A}', '${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'snap-a', 'hash-a', 'ai-context-1.0.0', 'insight-pack-1.0.0', 'PR-AI-013', 1, 'mock', 'mock-1', 'READY', 'HIGH', 'PASS', false, now(), now(), now()),
      ('${PACK_B}', '${B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'snap-b', 'hash-b', 'ai-context-1.0.0', 'insight-pack-1.0.0', 'PR-AI-013', 1, 'mock', 'mock-1', 'READY', 'HIGH', 'PASS', false, now(), now(), now());
  `);
  await db.exec(`
    insert into ai_insight_pack_blocks (pack_id, user_id, household_id, block_code, status, headline, block_order)
    values
      ('${PACK_A}', '${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'overall_financial_summary', 'GROUNDED', 'A summary', 0),
      ('${PACK_B}', '${B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'overall_financial_summary', 'GROUNDED', 'B summary', 0);
  `);
});

console.log('\n=== C. Tenant isolation on ai_insight_packs (spec sections 93, 140) ===');
await asTenant(A, async () => {
  const own = await db.query(`select * from ai_insight_packs where user_id = '${A}'`);
  check('A sees exactly their own pack', own.rows.length === 1 && own.rows[0].id === PACK_A);
  const other = await db.query(`select * from ai_insight_packs where id = '${PACK_B}'`);
  check('A sees ZERO of B\'s pack via direct id lookup (RLS, not a WHERE clause artefact)', other.rows.length === 0);
  const allRows = await db.query(`select * from ai_insight_packs`);
  check('A\'s unfiltered SELECT * still returns only A\'s own row(s)', allRows.rows.every((r) => r.user_id === A));
});

console.log('\n=== C2. Negative control — disable RLS, prove the leak becomes observable, then re-enable ===');
await db.exec(`alter table ai_insight_packs disable row level security;`);
await asTenant(A, async () => {
  const leaked = await db.query(`select * from ai_insight_packs where id = '${PACK_B}'`);
  check('RLS-disabled negative control: A CAN now see B\'s pack (proves the block above is real enforcement, not a vacuous empty table)', leaked.rows.length === 1);
});
await db.exec(`alter table ai_insight_packs enable row level security;`);
await asTenant(A, async () => {
  const blocked = await db.query(`select * from ai_insight_packs where id = '${PACK_B}'`);
  check('RLS re-enabled: A is blocked again', blocked.rows.length === 0);
});

console.log('\n=== D. Tenant isolation on ai_insight_pack_blocks ===');
await asTenant(B, async () => {
  const own = await db.query(`select * from ai_insight_pack_blocks where user_id = '${B}'`);
  check('B sees exactly their own block', own.rows.length === 1);
  const other = await db.query(`select * from ai_insight_pack_blocks where pack_id = '${PACK_A}'`);
  check('B sees ZERO of A\'s blocks', other.rows.length === 0);
});

console.log('\n=== E. Anon sees zero rows on every table ===');
await asAnon(async () => {
  for (const t of ['ai_insight_packs', 'ai_insight_pack_blocks', 'ai_insight_pack_batches']) {
    const r = await db.query(`select * from ${t}`);
    check(`anon sees 0 rows in ${t}`, r.rows.length === 0);
  }
});

console.log('\n=== F. Governance-only table (ai_insight_pack_batches) — zero end-user policies ===');
await asService(async () => {
  await db.exec(`insert into ai_insight_pack_batches (id, provider, status, request_count) values ('eeeeeeee-0000-0000-0000-000000000001', 'mock', 'COMPLETED', 2);`);
});
await asTenant(A, async () => {
  const r = await db.query(`select * from ai_insight_pack_batches`);
  check('ordinary authenticated tenant sees 0 rows in ai_insight_pack_batches (governance-only, matches ai_model_registry precedent)', r.rows.length === 0);
});
await asService(async () => {
  const r = await db.query(`select * from ai_insight_pack_batches`);
  check('service_role CAN see the batch row (positive control — the table exists and has real data, "0 rows" above is real isolation)', r.rows.length === 1);
});

console.log('\n=== G. Structural READY invariant (spec section 107) ===');
await asService(async () => {
  let rejected = false;
  try {
    await db.exec(`
      insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, grounding_status, validated_at, ready_at)
      values ('${A}', null, 'snap-bad-1', 'hash-bad-1', 'v1', 'v1', 'PR-AI-013', 1, 'mock', 'mock-1', 'READY', 'PASS', null, null);
    `);
  } catch (e) { rejected = true; }
  check('READY row with validated_at/ready_at NULL is REJECTED by the DB (not just application code)', rejected);
});
await asService(async () => {
  let rejected = false;
  try {
    await db.exec(`
      insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, grounding_status, validated_at, ready_at)
      values ('${A}', null, 'snap-bad-2', 'hash-bad-2', 'v1', 'v1', 'PR-AI-013', 1, 'mock', 'mock-1', 'READY', 'FAIL', now(), now());
    `);
  } catch (e) { rejected = true; }
  check('READY row with grounding_status != PASS is REJECTED', rejected);
});
await asService(async () => {
  let rejected = false;
  try {
    await db.exec(`
      insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, grounding_status, critical_safety_failure, validated_at, ready_at)
      values ('${A}', null, 'snap-bad-3', 'hash-bad-3', 'v1', 'v1', 'PR-AI-013', 1, 'mock', 'mock-1', 'READY', 'PASS', true, now(), now());
    `);
  } catch (e) { rejected = true; }
  check('READY row with critical_safety_failure=true is REJECTED', rejected);
});
await asService(async () => {
  let accepted = false;
  try {
    await db.exec(`
      insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, grounding_status, critical_safety_failure, validated_at, ready_at)
      values ('${A}', null, 'snap-good-1', 'hash-good-1', 'v1', 'v1', 'PR-AI-013', 1, 'mock', 'mock-1', 'READY', 'PASS', false, now(), now());
    `);
    accepted = true;
  } catch (e) { console.log('    unexpected rejection: ' + e.message); }
  check('A FULLY compliant READY row (validated_at+ready_at+PASS+no safety failure) IS accepted — proves the constraint isn\'t just always-reject', accepted);
});

console.log('\n=== H. PARTIAL invariant ===');
await asService(async () => {
  let rejected = false;
  try {
    await db.exec(`
      insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, grounding_status, validated_at)
      values ('${A}', null, 'snap-bad-4', 'hash-bad-4', 'v1', 'v1', 'PR-AI-013', 1, 'mock', 'mock-1', 'PARTIAL', null, null);
    `);
  } catch (e) { rejected = true; }
  check('PARTIAL row with no validated_at is REJECTED', rejected);
});

console.log('\n=== H2. NULL-propagation bypass of the READY/PARTIAL invariants (migration 0123) ===');
// Migration 0123 continuation — a real, live-DEV-discovered gap in 0121's
// original constraint wording: `grounding_status = 'PASS'` evaluates to
// NULL (not FALSE) when grounding_status IS NULL, and Postgres CHECK
// constraints only reject an expression that evaluates to FALSE, so a raw
// UPDATE nulling grounding_status alone on an otherwise-READY row was
// SILENTLY ACCEPTED under the original 0121 wording. This section proves
// migration 0123's IS NOT DISTINCT FROM / explicit IS NOT NULL fix closes
// that gap, against the REAL rebuilt chain (0001..latest, 0123 included).
await asService(async () => {
  await db.exec(`
    insert into ai_insight_packs (id, user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, grounding_status, critical_safety_failure, validated_at, ready_at)
    values ('ffffffff-0000-0000-0000-000000000001', '${A}', null, 'snap-nullsafety', 'hash-nullsafety', 'v1', 'v1', 'PR-AI-013', 1, 'mock', 'mock-1', 'READY', 'PASS', false, now(), now());
  `);
  let rejected = false;
  try {
    await db.exec(`update ai_insight_packs set grounding_status = null where id = 'ffffffff-0000-0000-0000-000000000001';`);
  } catch (e) { rejected = true; }
  check('POST-0123: raw UPDATE nulling grounding_status alone on a status=READY row is REJECTED (the live-DEV-discovered NULL-propagation gap is fixed)', rejected);

  const stillGood = await db.query(`select grounding_status from ai_insight_packs where id = 'ffffffff-0000-0000-0000-000000000001'`);
  check('the row is genuinely unchanged after the rejected attempt (grounding_status still PASS)', stillGood.rows[0]?.grounding_status === 'PASS');

  // PARTIAL invariant's own IN(...) term has the same NULL-propagation
  // shape — prove it independently.
  await db.exec(`
    insert into ai_insight_packs (id, user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, provider, model, status, grounding_status, critical_safety_failure, validated_at)
    values ('ffffffff-0000-0000-0000-000000000002', '${A}', null, 'snap-nullsafety-2', 'hash-nullsafety-2', 'v1', 'v1', 'PR-AI-013', 1, 'mock', 'mock-1', 'PARTIAL', 'PARTIAL', false, now());
  `);
  let partialRejected = false;
  try {
    await db.exec(`update ai_insight_packs set grounding_status = null where id = 'ffffffff-0000-0000-0000-000000000002';`);
  } catch (e) { partialRejected = true; }
  check('POST-0123: raw UPDATE nulling grounding_status alone on a status=PARTIAL row is also REJECTED', partialRejected);
});

console.log('\n=== I. Pack identity uniqueness (spec section 9) ===');
await asService(async () => {
  await db.exec(`
    insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, country_context, language, provider, model, status)
    values ('${A}', null, 'snap-dup', 'hash-dup', 'v1', 'v1', 'PR-AI-013', 1, 'AU', 'en', 'mock', 'mock-1', 'PENDING');
  `);
  let rejected = false;
  try {
    await db.exec(`
      insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, country_context, language, provider, model, status)
      values ('${A}', null, 'snap-dup', 'hash-dup', 'v1', 'v1', 'PR-AI-013', 1, 'AU', 'en', 'mock', 'mock-1', 'PENDING');
    `);
  } catch (e) { rejected = true; }
  check('A second INSERT with the IDENTICAL identity tuple is REJECTED by the unique index (duplicate generation collapses at the DB level)', rejected);

  let accepted = false;
  try {
    await db.exec(`
      insert into ai_insight_packs (user_id, household_id, snapshot_id, financial_context_hash, context_schema_version, pack_schema_version, prompt_code, prompt_version, country_context, language, provider, model, status)
      values ('${A}', null, 'snap-dup-2', 'hash-dup', 'v1', 'v1', 'PR-AI-013', 1, 'AU', 'en', 'mock', 'mock-1', 'PENDING');
    `);
    accepted = true;
  } catch (e) { /* unexpected */ }
  check('A DIFFERENT snapshot_id with everything else identical IS accepted (identity is the whole tuple, not over-broad)', accepted);
});

console.log('\n=== J. (pack_id, block_code) uniqueness ===');
await asService(async () => {
  let rejected = false;
  try {
    await db.exec(`insert into ai_insight_pack_blocks (pack_id, user_id, household_id, block_code, status) values ('${PACK_A}', '${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'overall_financial_summary', 'GROUNDED');`);
  } catch (e) { rejected = true; }
  check('a duplicate block_code for the SAME pack is REJECTED', rejected);
});

console.log('\n=== K. Migration 0121 seeds present ===');
await asService(async () => {
  const prompt = await db.query(`select * from ai_prompt_templates where prompt_code = 'PR-AI-013'`);
  check('PR-AI-013 prompt seeded', prompt.rows.length === 1 && prompt.rows[0].status === 'DRAFT');
  const model = await db.query(`select * from ai_model_registry where provider = 'mock'`);
  check('mock model registry row includes monthly_insight_pack in task_types', model.rows[0]?.task_types?.includes('monthly_insight_pack'));
  const costLimit = await db.query(`select * from ai_task_cost_limits where task_type = 'monthly_insight_pack'`);
  check('ai_task_cost_limits row seeded for monthly_insight_pack', costLimit.rows.length === 1);
});

console.log('\n=== L. Full-chain RLS coverage unaffected ===');
{
  const total = await db.query(`select count(*)::int n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relkind='r'`);
  const rlsOn = await db.query(`select count(*)::int n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relkind='r' and c.relrowsecurity`);
  check(`all ${total.rows[0].n} public tables have RLS enabled`, total.rows[0].n === rlsOn.rows[0].n, `(${rlsOn.rows[0].n}/${total.rows[0].n})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
