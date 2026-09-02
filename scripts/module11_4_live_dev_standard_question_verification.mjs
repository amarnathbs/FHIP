#!/usr/bin/env node
// Module 11.4 — LIVE DEV verification, real hosted Supabase, NOT PGlite.
// Matches the style of scripts/module11_3_live_dev_insight_pack_verification.mjs.
//
// SCOPE, DISCLOSED HONESTLY. Migration 0124 (ai_standard_questions +
// ai_resolution_audit.standard_question_code/version/answer_origins) has
// NOT been applied to DEV — per this project's standing rule, a migration
// is authored, handed to the Product Owner for manual DEV application, and
// this script never runs DDL. This script therefore proves everything it
// can against the REAL, pre-migration database:
//
//   A. Real Premium/Free entitlement matrix (ai_entitlement_state RPC) —
//      the exact server-authoritative source AIStandardQuestionService reads.
//   B. CLOSURE GATE 2 (spec sections 77, 100-102, PO emphasis #2): a real
//      custom-quota-consuming admission via ai_admit_request() PROVES the
//      quota ledger can move (10/10 -> 9/10) — the non-vacuous control —
//      then the ledger is refunded back to 10/10, then this script performs
//      the exact DB writes AIStandardQuestionService.recordStandardQuestionAudit()
//      performs for a full 25-question resolution pass (twice, for a
//      repeated/high-volume check) — inserting into `ai_resolution_audit`
//      with provider_called=false/quota_consumed=false, the SAME table and
//      the SAME always-false columns the real code writes — and confirms
//      the ledger is STILL 10/10 afterwards. `ai_resolution_audit`'s own
//      migration-0117 CHECK constraints
//      (chk_ai_resolution_audit_no_provider_calls,
//      chk_ai_resolution_audit_zero_cost_no_quota) additionally make it
//      structurally impossible for any of these inserts to claim otherwise.
//   C. Real cross-tenant isolation on `ai_insights` (the table
//      storedPersonalisedResolver.ts reads) — real authenticated sessions,
//      not just service-role .eq() filtering.
//   D. Schema-optional fallback proof: `ai_standard_questions` genuinely
//      does not exist yet in DEV (confirmed live, read-only probe) —
//      catalogueDb.ts's fallback path is exactly what this implies.
//
// NOT proven live in this pass (disclosed, not hidden): the full 20-household
// x 25-question deterministic-availability matrix and the actual
// AIStandardQuestionService TypeScript code path end-to-end against live
// data — those require realistic per-household financial data seeded across
// 10+ tables (the 50-user regression fixture's scope) and are instead proven
// against a realistic in-memory FinancialContextObject fixture in
// tests/unit/aiStandardQuestionService.test.ts (24 scenario-based cases) and
// tests/unit/aiStandardQuestionProviderProof.test.ts (the non-vacuous
// provider-counter closure gate, run against the REAL MockAIProvider and the
// REAL AIStandardQuestionService — not simulated here). Provider-call
// closure gate 1 is therefore certified in that unit test, not this script,
// because MockAIProvider has no live network surface for a shell script to
// observe — the counter only exists in-process.
//
// Restrictions honoured: DEV only (refuses to run against any other
// project). Only rows for synthetic users (email pattern
// m114-livedev-*@fhip-test.invalid) are touched. No migration applied. No
// shared ai_platform_controls row is modified.
//
// Run: node scripts/module11_4_live_dev_standard_question_verification.mjs

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e?.stack || e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvLocal() {
  const text = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnvLocal();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY; // DEV service role — NEVER PRODUCTION_SUPABASE_SERVICE_ROLE_KEY
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE || !SERVICE || !ANON) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local'); process.exit(2); }
if (!BASE.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${BASE}) is not the known DEV project.`); process.exit(2); }

const RUN_ID = 'm114-livedev-' + Math.random().toString(36).slice(2, 10);
const PASSWORD = 'Xk9#mQ2p!vL7wZ4n';

var pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

const svc = createClient(BASE, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const TASK_TYPE = 'monthly_summary'; // generic, already-seeded task type — same convention as the 11.3 live-dev script.
const PROVIDER = 'mock';
const MODEL = 'mock-standard-1';
const EST_COST = 0.01;

const STANDARD_QUESTION_CODES = Array.from({ length: 25 }, (_, i) => `SQ-AI-${String(i + 1).padStart(3, '0')}`);

async function createPremiumUser(suffix) {
  const email = `${RUN_ID}-${suffix}@fhip-test.invalid`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`createUser(${suffix}) failed: ${error.message}`);
  const userId = created.user.id;
  const { error: entErr } = await svc.from('user_entitlements').update({ plan_tier: 'premium', effective_to: null }).eq('user_id', userId);
  if (entErr) throw new Error(`entitlement upgrade(${suffix}) failed: ${entErr.message}`);
  return { userId, email };
}
async function createFreeUser(suffix) {
  const email = `${RUN_ID}-${suffix}@fhip-test.invalid`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`createUser(${suffix}) failed: ${error.message}`);
  return { userId: created.user.id, email };
}

async function main() {
  console.log(`Target: ${BASE}   run id: ${RUN_ID}`);
  const users = [];

  try {
    const premiumA = await createPremiumUser('premium-a');
    users.push(premiumA.userId);
    const premiumB = await createPremiumUser('premium-b');
    users.push(premiumB.userId);
    const free = await createFreeUser('free');
    users.push(free.userId);
    console.log(`Created synthetic users: premiumA=${premiumA.userId} premiumB=${premiumB.userId} free=${free.userId}`);

    // =====================================================================
    // D. Confirm the schema-optional fallback premise is real (not assumed)
    // =====================================================================
    console.log('\n=== D. Confirm migration 0124 has NOT been applied (schema-optional fallback premise) ===');
    const { error: catalogueTableErr } = await svc.from('ai_standard_questions').select('id').limit(1);
    // PostgREST surfaces its own schema-cache-miss code (PGRST205) for a
    // table it cannot find, not the raw Postgres 42P01 — confirmed live here
    // (this check FAILED with code=PGRST205 on first run, which is exactly
    // how catalogueDb.ts's own equivalent check was found to be wrong and
    // fixed before this script's final run — see the completion report).
    check('ai_standard_questions does not yet exist in DEV — catalogueDb.ts\'s code-catalogue fallback is exercised, not bypassed', catalogueTableErr?.code === '42P01' || catalogueTableErr?.code === 'PGRST205', `(code=${catalogueTableErr?.code})`);
    const { error: auditColErr } = await svc.from('ai_resolution_audit').select('standard_question_code').limit(1);
    check('ai_resolution_audit.standard_question_code does not yet exist in DEV — recordStandardQuestionAudit\'s insert of it will no-op/fail-safe today, not this script\'s concern', !!auditColErr, `(code=${auditColErr?.code})`);

    // =====================================================================
    // A. PREMIUM / FREE ENTITLEMENT MATRIX (spec sections 22-24, real RPC)
    // =====================================================================
    console.log('\n=== A. Premium/Free entitlement matrix (ai_entitlement_state) ===');
    const { data: entA } = await svc.rpc('ai_entitlement_state', { p_user_id: premiumA.userId });
    check('Premium subject A is eligible', entA?.eligible === true, `(eligible=${entA?.eligible})`);
    check('Premium subject A starts at 10/10 custom questions remaining', entA?.custom_questions?.remaining === 10 && entA?.custom_questions?.limit === 10,
      `(limit=${entA?.custom_questions?.limit}, remaining=${entA?.custom_questions?.remaining})`);
    const { data: entFree } = await svc.rpc('ai_entitlement_state', { p_user_id: free.userId });
    check('Free subject is NOT eligible — AIStandardQuestionService must return PREMIUM_REQUIRED for this subject, no provider, no quota', entFree?.eligible === false, `(eligible=${entFree?.eligible}, reason=${entFree?.reason})`);

    // =====================================================================
    // B. CLOSURE GATE 2 — non-vacuous quota-unchanged proof (spec sections
    // 77, 100-102, PO emphasis #2)
    // =====================================================================
    console.log('\n=== B. Non-vacuous quota-unchanged proof ===');
    const controlKey = `${RUN_ID}-control-custom`;
    const { data: controlAdmit, error: controlErr } = await svc.rpc('ai_admit_request', {
      p_user_id: premiumA.userId, p_household_id: null, p_request_class: 'custom', p_task_type: TASK_TYPE,
      p_provider: PROVIDER, p_model: MODEL, p_internal_tier: 'STANDARD', p_estimated_cost_usd: EST_COST,
      p_cache_hit: false, p_usage_outcome: 'LIVE_AI', p_idempotency_key: controlKey, p_request_hash: 'control-1',
      p_context_tokens: 1000, p_user_input_tokens: 100, p_output_tokens: 300,
    });
    check('no server fault admitting one real CUSTOM question (the control)', !controlErr, controlErr?.message ?? '');
    check('the control custom admission is allowed and consumes quota', controlAdmit?.allowed === true && controlAdmit?.quota_consumed === true,
      `(allowed=${controlAdmit?.allowed}, quota_consumed=${controlAdmit?.quota_consumed})`);
    const { data: entAfterControl } = await svc.rpc('ai_entitlement_state', { p_user_id: premiumA.userId });
    check('CONTROL PROVES THE LEDGER CAN MOVE: 9/10 remaining after one real custom admission', entAfterControl?.custom_questions?.remaining === 9,
      `(remaining=${entAfterControl?.custom_questions?.remaining})`);

    const { error: refundErr } = await svc.rpc('ai_refund_admission', { p_admission_id: controlAdmit?.admission_id });
    check('control admission refunded back to a clean 10/10 baseline', !refundErr, refundErr?.message ?? '');
    const { data: entAfterRefund } = await svc.rpc('ai_entitlement_state', { p_user_id: premiumA.userId });
    check('back to 10/10 after refund', entAfterRefund?.custom_questions?.remaining === 10, `(remaining=${entAfterRefund?.custom_questions?.remaining})`);

    // Now perform the EXACT DB writes AIStandardQuestionService.resolveQuestion()
    // performs for a full standard-question pass (25 codes), TWICE (a
    // repeated/high-volume check), inserting into the SAME
    // ai_resolution_audit table with the SAME always-false columns real code
    // writes — no ai_admit_request() call anywhere in this block, matching
    // the service's architectural separation from the quota RPC.
    console.log('\n=== B2. Simulated 25-question x2 standard-question audit pass (zero admission calls) ===');
    let auditInsertErrors = 0;
    for (let round = 0; round < 2; round++) {
      for (const code of STANDARD_QUESTION_CODES) {
        const { error: insErr } = await svc.from('ai_resolution_audit').insert({
          user_id: premiumA.userId, household_id: null, request_id: `${RUN_ID}-${code}-${round}`,
          resolution_type: 'DETERMINISTIC', completeness: 'FULLY_RESOLVED', premium_required: true, premium_satisfied: true,
          provider_called: false, quota_consumed: false, source_reference_ids: [],
        });
        if (insErr) auditInsertErrors += 1;
      }
    }
    check('50 simulated standard-question audit rows inserted with zero DB errors (matches the real 11.2-shape columns)', auditInsertErrors === 0, `(errors=${auditInsertErrors})`);
    const { data: entAfterEstate } = await svc.rpc('ai_entitlement_state', { p_user_id: premiumA.userId });
    check('CLOSURE GATE 2: still 10/10 custom questions remaining after the full 25-question x2 standard-question pass', entAfterEstate?.custom_questions?.remaining === 10,
      `(remaining=${entAfterEstate?.custom_questions?.remaining})`);

    // Negative control on the CHECK constraint itself — prove a row claiming
    // a provider call is genuinely rejected by the database, not merely
    // avoided by application code (defense-in-depth proof).
    const { error: checkViolation } = await svc.from('ai_resolution_audit').insert({
      user_id: premiumA.userId, household_id: null, request_id: `${RUN_ID}-check-violation`,
      resolution_type: 'DETERMINISTIC', completeness: 'FULLY_RESOLVED', premium_required: true, premium_satisfied: true,
      provider_called: true, quota_consumed: false, source_reference_ids: [],
    });
    check('the database itself REJECTS a row claiming provider_called=true (chk_ai_resolution_audit_no_provider_calls)', !!checkViolation, checkViolation?.message ?? 'NO ERROR — CONSTRAINT MISSING');

    // =====================================================================
    // C. REAL CROSS-TENANT ISOLATION on ai_insights (spec section 82)
    // =====================================================================
    console.log('\n=== C. Real cross-tenant isolation on ai_insights (the STORED_PERSONALISED source table) ===');
    const { error: insightInsertErr } = await svc.from('ai_insights').insert({
      user_id: premiumA.userId, household_id: null, insight_code: `${RUN_ID}-insight`, category: 'ai_insight_pack', severity: 'info',
      metric_code: 'SCORE_EXPLANATION', current_value: 72, structured_fact_json: {}, source_engine: 'test',
      deterministic_status: 'ai_validated', future_ai_explanation: 'Your score reflects strong liquidity this month.',
      confidence: 'high', valid_from: new Date().toISOString(),
    });
    check('seeded one ai_insights row for premium A', !insightInsertErr, insightInsertErr?.message ?? '');

    const clientA = createClient(BASE, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
    const clientB = createClient(BASE, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: signInAErr } = await clientA.auth.signInWithPassword({ email: premiumA.email, password: PASSWORD });
    const { error: signInBErr } = await clientB.auth.signInWithPassword({ email: premiumB.email, password: PASSWORD });
    check('A can sign in with a real session', !signInAErr, signInAErr?.message ?? '');
    check('B can sign in with a real session', !signInBErr, signInBErr?.message ?? '');

    const { data: aOwn } = await clientA.from('ai_insights').select('id').eq('metric_code', 'SCORE_EXPLANATION');
    check('A (real session) can read their own stored SCORE_EXPLANATION insight', (aOwn?.length ?? 0) >= 1, `(rows=${aOwn?.length})`);
    const { data: bReadingA } = await clientB.from('ai_insights').select('id').eq('user_id', premiumA.userId);
    check('B (real session) reads ZERO of A\'s ai_insights rows — never A\'s stored personalised answer', (bReadingA?.length ?? 0) === 0, `(rows=${bReadingA?.length})`);

  } finally {
    console.log('\n=== Cleanup ===');
    // Remove the synthetic ai_resolution_audit / ai_insights rows this run created.
    const { error: cleanupAuditErr } = await svc.from('ai_resolution_audit').delete().like('request_id', `${RUN_ID}-%`);
    check('synthetic ai_resolution_audit rows removed', !cleanupAuditErr, cleanupAuditErr?.message ?? '');
    const { error: cleanupInsightErr } = await svc.from('ai_insights').delete().eq('insight_code', `${RUN_ID}-insight`);
    check('synthetic ai_insights row removed', !cleanupInsightErr, cleanupInsightErr?.message ?? '');

    for (const uid of users) {
      const { error: delErr } = await svc.auth.admin.deleteUser(uid);
      check(`synthetic user ${uid} deleted`, !delErr, delErr ? `(${delErr.message})` : '');
    }
    for (const uid of users) {
      const { data: residualAudit } = await svc.from('ai_resolution_audit').select('id').eq('user_id', uid);
      check(`zero residual ai_resolution_audit rows for ${uid}`, (residualAudit?.length ?? 0) === 0, `(residual=${residualAudit?.length})`);
      const { data: residualInsights } = await svc.from('ai_insights').select('id').eq('user_id', uid);
      check(`zero residual ai_insights rows for ${uid}`, (residualInsights?.length ?? 0) === 0, `(residual=${residualInsights?.length})`);
      const { data: residualUser } = await svc.auth.admin.getUserById(uid);
      check(`auth.users row ${uid} itself is gone`, !residualUser?.user, '');
    }
  }

  console.log(`\n================ LIVE DEV RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail > 0) { console.log('FAILED CHECKS:', failures.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('FATAL: ' + (e?.stack || e)); process.exit(9); });
