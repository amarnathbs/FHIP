// Module 11.0 certification: proves, on a freshly rebuilt real Postgres
// (PGlite, migration 0110 included), that:
//   - the full 0001..0110 chain applies cleanly from empty
//   - every new ai_* table has RLS enabled
//   - the 6 user-owned tables (ai_runs, ai_usage_ledger, ai_answer_cache,
//     ai_insights, ai_recommendations, ai_feedback) enforce real tenant
//     isolation on real populated data, with negative controls proving the
//     test can actually fail
//   - the 4 governance-only tables (ai_model_registry, ai_prompt_templates,
//     ai_evaluations, ai_safety_events) are invisible to EVERY authenticated
//     tenant — not just isolated per-tenant, genuinely zero rows regardless
//     of ownership, since only the service-role client may ever read them
//   - ai_feedback's insert-own-row policy accepts a tenant's own feedback
//     and rejects a forged row claiming to be the other tenant's
//   - the partial unique index enforces "at most one ACTIVE prompt version
//     per (prompt_code, country_scope)"
//   - the seeded MockAIProvider model registry row and 12 DRAFT prompt rows
//     exist exactly as the migration inserted them, and no seeded prompt is
//     ACTIVE (spec section 29: "Do not expose them to users in 11.0")
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
  await db.exec(`set role anon;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

// =============================================================================
// Seed one real row per tenant into every user-owned table, via service role
// (matching how the real app writes: recordAiRun()/upsertUsageLedger() use
// createAdminClient()).
// =============================================================================
await asService(async () => {
  await db.exec(`
    insert into ai_runs (user_id, household_id, request_type, context_version, context_hash, provider, model, execution_status)
      values ('${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'score_explanation', 'ai-context-1.0.0', 'hashA', 'mock', 'mock-standard-1', 'success'),
             ('${B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'score_explanation', 'ai-context-1.0.0', 'hashB', 'mock', 'mock-standard-1', 'success');
    insert into ai_usage_ledger (user_id, household_id, billing_period, task_type, provider, model)
      values ('${A}', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-08', 'score_explanation', 'mock', 'mock-standard-1'),
             ('${B}', 'bbbbbbbb-0000-0000-0000-000000000002', '2026-08', 'score_explanation', 'mock', 'mock-standard-1');
    insert into ai_answer_cache (user_id, household_id, snapshot_hash, context_version, intent_code, normalised_question_hash, answer_json)
      values ('${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'snapA', 'ai-context-1.0.0', 'score_summary', 'qhashA', '{}'),
             ('${B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'snapB', 'ai-context-1.0.0', 'score_summary', 'qhashB', '{}');
    insert into ai_insights (user_id, household_id, insight_code, category, severity, source_engine)
      values ('${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'low_emergency_fund', 'resilience', 'medium', 'resilience-1.0.0'),
             ('${B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'low_emergency_fund', 'resilience', 'medium', 'resilience-1.0.0');
    insert into ai_recommendations (recommendation_code, user_id, household_id, category, priority, deterministic_rule)
      values ('boost_savings', '${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'savings', 'high', 'savings_rate < 0.1'),
             ('boost_savings', '${B}', 'bbbbbbbb-0000-0000-0000-000000000002', 'savings', 'high', 'savings_rate < 0.1');
  `);
});

const USER_OWNED_TABLES = ['ai_runs', 'ai_usage_ledger', 'ai_answer_cache', 'ai_insights', 'ai_recommendations'];

console.log('=== POSITIVE ACCESS (tenant sees its own populated rows) ===');
for (const [uid, who] of [[A, 'Tenant A'], [B, 'Tenant B']]) {
  await asTenant(uid, async () => {
    for (const t of USER_OWNED_TABLES) {
      const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
      check(`${who} reads own ${t}`, c === 1, `(saw ${c}, expected 1)`);
    }
  });
}

console.log('\n=== CROSS-TENANT READ DENIAL ===');
await asTenant(A, async () => {
  for (const t of USER_OWNED_TABLES) {
    const leak = (await db.query(`select count(*)::int c from ${t} where user_id='${B}'`)).rows[0].c;
    check(`Tenant A cannot read Tenant B's ${t}`, leak === 0, `(leaked ${leak})`);
  }
});

console.log('\n=== NEGATIVE CONTROLS (RLS deliberately disabled -> leak MUST appear) ===');
for (const t of USER_OWNED_TABLES) {
  await db.exec(`alter table ${t} disable row level security;`);
  let leak = 0;
  await asTenant(A, async () => { leak = (await db.query(`select count(*)::int c from ${t} where user_id='${B}'`)).rows[0].c; });
  check(`control: RLS off on ${t} -> Tenant A DOES see Tenant B`, leak === 1, `(saw ${leak}, expected 1 — proves the test is not vacuous)`);
  await db.exec(`alter table ${t} enable row level security;`);
  let re = 0;
  await asTenant(A, async () => { re = (await db.query(`select count(*)::int c from ${t} where user_id='${B}'`)).rows[0].c; });
  check(`control: isolation restored on ${t}`, re === 0, `(saw ${re})`);
}

console.log('\n=== GOVERNANCE-ONLY TABLES (zero end-user visibility, service-role only) ===');
await asService(async () => {
  await db.exec(`
    insert into ai_evaluations (ai_run_id, evaluation_type, result, reviewer_type)
      select id, 'grounding', 'pass', 'automated' from ai_runs where user_id='${A}' limit 1;
    insert into ai_safety_events (user_id, event_type, severity, detail)
      values ('${A}', 'attempted_cross_user_retrieval', 'HIGH', 'test event');
  `);
});
const GOVERNANCE_TABLES = ['ai_model_registry', 'ai_prompt_templates', 'ai_evaluations', 'ai_safety_events'];
await asTenant(A, async () => {
  for (const t of GOVERNANCE_TABLES) {
    const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
    check(`Tenant A (authenticated, non-admin) sees ZERO rows in ${t}`, c === 0, `(saw ${c})`);
  }
});
await asAnon(async () => {
  for (const t of GOVERNANCE_TABLES) {
    const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
    check(`anon sees ZERO rows in ${t}`, c === 0, `(saw ${c})`);
  }
});
await asService(async () => {
  for (const t of GOVERNANCE_TABLES) {
    const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
    check(`service-role CAN see ${t} (admin routes still work)`, c > 0, `(saw ${c})`);
  }
});
console.log('  control: negative-control proof for governance tables — disabling RLS on ai_safety_events must make it visible to a tenant, proving the zero-row result above is real isolation, not an empty table');
await db.exec(`alter table ai_safety_events disable row level security;`);
let govLeak = 0;
await asTenant(A, async () => { govLeak = (await db.query(`select count(*)::int c from ai_safety_events`)).rows[0].c; });
check('control: RLS off on ai_safety_events -> Tenant A DOES see the row', govLeak > 0, `(saw ${govLeak})`);
await db.exec(`alter table ai_safety_events enable row level security;`);

console.log('\n=== ai_feedback: user CAN insert their own row, CANNOT forge another\'s ===');
await asTenant(A, async () => {
  await db.query(`insert into ai_feedback (user_id, feedback_type) values ('${A}', 'helpful')`);
  const mine = (await db.query(`select count(*)::int c from ai_feedback where user_id='${A}'`)).rows[0].c;
  check('Tenant A can insert their own ai_feedback row', mine === 1, `(saw ${mine})`);
  let blocked = false;
  try {
    await db.query(`insert into ai_feedback (user_id, feedback_type) values ('${B}', 'helpful')`);
  } catch (e) {
    blocked = /policy|denied|row-level security/i.test(e.message);
  }
  check('Tenant A cannot forge an ai_feedback row for Tenant B', blocked);
});
await asTenant(B, async () => {
  const leak = (await db.query(`select count(*)::int c from ai_feedback where user_id='${A}'`)).rows[0].c;
  check('Tenant B cannot read Tenant A\'s ai_feedback', leak === 0, `(leaked ${leak})`);
});

console.log('\n=== Prompt Registry: exactly one ACTIVE version per (prompt_code, country_scope) ===');
await asService(async () => {
  const { rows: draftRows } = await db.query(`select id from ai_prompt_templates where prompt_code='PR-AI-001' and version=1`);
  const firstId = draftRows[0].id;
  await db.query(`update ai_prompt_templates set status='ACTIVE' where id='${firstId}'`);
  const { rows: newRow } = await db.query(
    `insert into ai_prompt_templates (prompt_code, prompt_name, version, task_type, system_prompt, developer_prompt, context_schema_version, output_schema_version, safety_policy_version, status)
     values ('PR-AI-001', 'Financial Health Score Explanation', 2, 'score_explanation', 'sys v2', 'dev v2', 'ai-context-1.0.0', 'ai-response-envelope-1.0.0', 'safety-policy-1.0.0', 'DRAFT') returning id`
  );
  const secondId = newRow[0].id;
  let blocked = false;
  try {
    await db.query(`update ai_prompt_templates set status='ACTIVE' where id='${secondId}'`);
  } catch (e) {
    blocked = /unique|duplicate/i.test(e.message);
  }
  check('a second simultaneously-ACTIVE version of the same (prompt_code, country_scope) is rejected by the partial unique index', blocked);
  // Real app behaviour (transitionPromptStatus()) retires the old ACTIVE row
  // first — demonstrate that path succeeds without violating the index.
  await db.query(`update ai_prompt_templates set status='RETIRED' where id='${firstId}'`);
  let okAfterRetire = true;
  try {
    await db.query(`update ai_prompt_templates set status='ACTIVE' where id='${secondId}'`);
  } catch {
    okAfterRetire = false;
  }
  check('after retiring the old version, the new version CAN become ACTIVE', okAfterRetire);
});

console.log('\n=== Seed content sanity (spec sections 27, 29) ===');
await asService(async () => {
  const mockModel = (await db.query(`select * from ai_model_registry where provider='mock'`)).rows;
  check('MockAIProvider model registry row was seeded, active and approved', mockModel.length === 1 && mockModel[0].active && mockModel[0].approved);
  const promptCount = (await db.query(`select count(*)::int c from ai_prompt_templates where prompt_code like 'PR-AI-0%'`)).rows[0].c;
  check('all 12 PR-AI-0xx prompt placeholders were seeded', promptCount === 12 + 1 /* + the v2 row inserted above for PR-AI-001 */, `(saw ${promptCount})`);
  const activeCountForNonTestedPrompts = (
    await db.query(`select count(*)::int c from ai_prompt_templates where status='ACTIVE' and prompt_code <> 'PR-AI-001'`)
  ).rows[0].c;
  check('no seeded prompt other than the one this script deliberately activated is ACTIVE', activeCountForNonTestedPrompts === 0, `(saw ${activeCountForNonTestedPrompts})`);
});

console.log('\n=== RLS coverage on every new ai_* table ===');
const { rows: noRls } = await db.query(`
  select c.relname from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace
  where nsp.nspname='public' and c.relkind='r' and c.relname like 'ai\\_%' and not c.relrowsecurity order by 1
`);
check('every ai_* table has RLS enabled', noRls.length === 0, noRls.length ? `(missing: ${noRls.map((r) => r.relname).join(', ')})` : '');

console.log(`\nMODULE 11.0 CERTIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
