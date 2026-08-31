#!/usr/bin/env node
// Module 11.1 (migration 0115) — LIVE DEV concurrency verification, real
// hosted Supabase (vqycarelcoijzwlpkpcz), NOT PGlite.
//
// The certifying agent's PGlite pass (379/379) is real Postgres-under-WASM,
// but WASM PGlite is a SINGLE CONNECTION: it cannot demonstrate two genuinely
// concurrent sessions racing for the same resource. ai_admit_request()'s
// entire safety argument for the monthly quota rests on
// `pg_advisory_xact_lock` serialising concurrent admissions for the same
// user — a claim PGlite structurally cannot test. This script fires real
// concurrent HTTP requests (via supabase-js, each its own connection) at the
// real RPC on the real hosted database and checks the committed result.
//
// Restrictions honoured: DEV only (vqycarelcoijzwlpkpcz, via
// NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — NEVER
// PRODUCTION_SUPABASE_SERVICE_ROLE_KEY). Only rows for one synthetic user
// (email pattern m111-livedev-*@fhip-test.invalid) are touched; the synthetic
// user is deleted at the end, cascading (auth.users FK, ON DELETE CASCADE) to
// user_entitlements, ai_usage_ledger and ai_admission_events. No migrations
// applied. No global ai_platform_controls row is modified.
//
// Run: node scripts/module11_1_live_dev_concurrency_verification.mjs

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
if (!BASE || !SERVICE) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(2); }
if (!BASE.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${BASE}) is not the known DEV project. This script must only ever target DEV.`); process.exit(2); }

const RUN_ID = 'm111-livedev-' + Math.random().toString(36).slice(2, 10);
const EMAIL = `${RUN_ID}@fhip-test.invalid`;
const PASSWORD = 'Xk9#mQ2p!vL7wZ4n';

var pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

const svc = createClient(BASE, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const TASK_TYPE = 'score_explanation'; // STANDARD cap, cost 0.05 — comfortably under every ceiling
const PROVIDER = 'mock';
const MODEL = 'mock-standard-1'; // seeded active+approved in Module 11.0, cost 0
const EST_COST = 0.01;
const CONCURRENCY = 6;

async function main() {
  console.log(`Target: ${BASE}   run id: ${RUN_ID}`);

  // ---- Setup: one synthetic Premium user ----
  const { data: created, error: createErr } = await svc.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
  });
  if (createErr) throw new Error(`createUser failed: ${createErr.message}`);
  const userId = created.user.id;
  console.log(`Created synthetic user ${userId}`);

  try {
    const { error: entErr } = await svc
      .from('user_entitlements')
      .update({ plan_tier: 'premium', effective_to: null })
      .eq('user_id', userId);
    if (entErr) throw new Error(`entitlement upgrade failed: ${entErr.message}`);

    const { data: controls, error: ctrlErr } = await svc
      .from('ai_platform_controls').select('monthly_custom_question_allowance').eq('id', 'global').single();
    if (ctrlErr) throw new Error(`reading ai_platform_controls failed: ${ctrlErr.message}`);
    const allowance = controls.monthly_custom_question_allowance;
    console.log(`Live global monthly_custom_question_allowance = ${allowance}`);

    const billingPeriod = new Date().toISOString().slice(0, 7); // UTC 'YYYY-MM', matches ai_billing_period_for()

    // ---- Pre-seed usage so exactly ONE slot of allowance remains ----
    const preUsed = allowance - 1;
    if (preUsed > 0) {
      const { error: seedErr } = await svc.from('ai_usage_ledger').insert({
        user_id: userId, household_id: null, billing_period: billingPeriod,
        task_type: TASK_TYPE, provider: PROVIDER, model: MODEL,
        custom_question_count: preUsed,
      });
      if (seedErr) throw new Error(`usage seed failed: ${seedErr.message}`);
    }
    console.log(`Pre-seeded custom_question_count=${preUsed} for ${billingPeriod} — exactly 1 slot should remain`);

    // =========================================================================
    // TEST 1 — REAL CONCURRENCY: N simultaneous admissions, only 1 slot free.
    // Advisory-xact-lock claim: pg_advisory_xact_lock(user) serialises these,
    // so exactly one must be admitted with quota_consumed=true and the rest
    // must be denied 'quota_exhausted' — never 0, never more than 1.
    // =========================================================================
    console.log(`\n=== TEST 1: ${CONCURRENCY} concurrent ai_admit_request calls, 1 slot remaining ===`);
    const admitOnce = () => svc.rpc('ai_admit_request', {
      p_user_id: userId, p_household_id: null,
      p_request_class: 'custom', p_task_type: TASK_TYPE,
      p_provider: PROVIDER, p_model: MODEL, p_internal_tier: 'STANDARD',
      p_estimated_cost_usd: EST_COST, p_cache_hit: false,
      p_usage_outcome: null, p_idempotency_key: null, p_request_hash: null,
      p_context_tokens: 100, p_user_input_tokens: 50, p_output_tokens: 100,
    });
    const results = await Promise.all(Array.from({ length: CONCURRENCY }, admitOnce));

    const errors = results.filter(r => r.error);
    check('no server faults across all concurrent calls', errors.length === 0,
      errors.length ? `(${errors.length} errored: ${errors[0].error.message})` : '');

    const decisions = results.map(r => r.data);
    const allowed = decisions.filter(d => d && d.allowed === true);
    const denied = decisions.filter(d => d && d.allowed === false);
    check('exactly ONE admission allowed (never 0, never >1)', allowed.length === 1,
      `(allowed=${allowed.length}, denied=${denied.length})`);
    check('the allowed admission actually consumed quota', allowed[0]?.quota_consumed === true,
      `(quota_consumed=${allowed[0]?.quota_consumed})`);
    const wrongDenyReason = denied.filter(d => d.deny_reason !== 'quota_exhausted');
    check('every denied admission carries deny_reason=quota_exhausted (not some other refusal)',
      denied.length === CONCURRENCY - 1 && wrongDenyReason.length === 0,
      wrongDenyReason.length ? `(saw: ${wrongDenyReason.map(d => d.deny_reason).join(',')})` : '');

    // ---- Ground truth: exactly ONE unit actually committed to the ledger ----
    const { data: ledgerRows, error: ledgerErr } = await svc
      .from('ai_usage_ledger').select('custom_question_count')
      .eq('user_id', userId).eq('billing_period', billingPeriod)
      .eq('task_type', TASK_TYPE).eq('provider', PROVIDER).eq('model', MODEL);
    if (ledgerErr) throw new Error(`ledger readback failed: ${ledgerErr.message}`);
    check('ground truth: ai_usage_ledger shows exactly allowance consumed (no double-count, no lost update)',
      ledgerRows.length === 1 && ledgerRows[0].custom_question_count === allowance,
      `(rows=${ledgerRows.length}, custom_question_count=${ledgerRows[0]?.custom_question_count}, expected=${allowance})`);

    // ---- A NEGATIVE CONTROL for this harness itself: a further call must
    // now be denied too (quota fully exhausted, not just "won the race") ----
    const followUp = await admitOnce();
    check('NEGATIVE CONTROL: a further request after the race is denied quota_exhausted (not silently allowed)',
      followUp.data?.allowed === false && followUp.data?.deny_reason === 'quota_exhausted',
      `(allowed=${followUp.data?.allowed}, deny_reason=${followUp.data?.deny_reason})`);

    // =========================================================================
    // TEST 2 — REAL CONCURRENCY, idempotency replay under contention: N
    // simultaneous calls carrying the SAME idempotency key must produce
    // exactly one execution and N identical replayed verdicts, never two
    // separate admissions racing past the idempotency check.
    // =========================================================================
    console.log('\n=== TEST 2: concurrent idempotent replay (same key, fresh billing period slot) ===');
    // Give this probe fresh room so its own admission isn't itself denied by
    // Test 1's exhaustion (would make the replay claim untestable).
    const { error: resetErr } = await svc.from('ai_usage_ledger')
      .update({ custom_question_count: 0 })
      .eq('user_id', userId).eq('billing_period', billingPeriod)
      .eq('task_type', TASK_TYPE).eq('provider', PROVIDER).eq('model', MODEL);
    if (resetErr) throw new Error(`quota reset for Test 2 failed: ${resetErr.message}`);
    // Test 1 made 7 admission events (1 allowed + 5 quota_exhausted +
    // 1 follow-up), all counting toward the rolling rate-limit window
    // (rate_limit_max_requests default 12) since only a 'rate_limited'
    // deny_reason itself is exempted from counting. Left in place, Test 2's
    // own 6 concurrent calls would push this synthetic user over that
    // separate ceiling and be denied 'rate_limited' instead of exercising
    // the idempotency path this test targets. Clearing this user's own
    // admission-event history (synthetic, cascades away at cleanup either
    // way) isolates the two concerns; it does not touch the rate limiter's
    // logic, only this probe's own prior audit rows.
    const { error: rateResetErr } = await svc.from('ai_admission_events').delete().eq('user_id', userId);
    if (rateResetErr) throw new Error(`rate-limit-window reset for Test 2 failed: ${rateResetErr.message}`);

    const idemKey = `${RUN_ID}-idem-1`;
    const admitIdem = () => svc.rpc('ai_admit_request', {
      p_user_id: userId, p_household_id: null,
      p_request_class: 'custom', p_task_type: TASK_TYPE,
      p_provider: PROVIDER, p_model: MODEL, p_internal_tier: 'STANDARD',
      p_estimated_cost_usd: EST_COST, p_cache_hit: false,
      p_usage_outcome: null, p_idempotency_key: idemKey, p_request_hash: 'fixed-hash-1',
      p_context_tokens: 100, p_user_input_tokens: 50, p_output_tokens: 100,
    });
    const idemResults = await Promise.all(Array.from({ length: CONCURRENCY }, admitIdem));
    const idemErrors = idemResults.filter(r => r.error);
    check('no server faults across concurrent idempotent replays', idemErrors.length === 0,
      idemErrors.length ? `(${idemErrors[0].error.message})` : '');
    const idemAdmissionIds = new Set(idemResults.map(r => r.data?.admission_id).filter(Boolean));
    check('all concurrent replays resolved to the SAME admission_id (one execution, not a race)',
      idemAdmissionIds.size === 1, `(distinct admission_ids=${idemAdmissionIds.size})`);
    const idemAllowedCount = idemResults.filter(r => r.data?.allowed === true).length;
    check('all concurrent replays report the same allowed verdict', idemAllowedCount === CONCURRENCY || idemAllowedCount === 0,
      `(allowed=${idemAllowedCount}/${CONCURRENCY})`);

    const { data: idemLedgerRows } = await svc
      .from('ai_usage_ledger').select('custom_question_count')
      .eq('user_id', userId).eq('billing_period', billingPeriod)
      .eq('task_type', TASK_TYPE).eq('provider', PROVIDER).eq('model', MODEL);
    check('ground truth: idempotent replay consumed exactly ONE unit despite N concurrent callers',
      idemLedgerRows[0]?.custom_question_count === 1, `(custom_question_count=${idemLedgerRows[0]?.custom_question_count})`);

    const { data: idemEvents } = await svc
      .from('ai_admission_events').select('id').eq('user_id', userId).eq('idempotency_key', idemKey);
    check('ground truth: exactly ONE ai_admission_events row for this idempotency key (no duplicate audit rows)',
      idemEvents?.length === 1, `(rows=${idemEvents?.length})`);

  } finally {
    // =========================================================================
    // CLEANUP — delete the synthetic user; auth.users ON DELETE CASCADE
    // removes user_entitlements, ai_usage_ledger and ai_admission_events rows
    // for it. Verified, not assumed.
    // =========================================================================
    console.log('\n=== Cleanup ===');
    const { error: delErr } = await svc.auth.admin.deleteUser(userId);
    check('synthetic user deleted', !delErr, delErr ? `(${delErr.message})` : '');

    const { data: residualLedger } = await svc.from('ai_usage_ledger').select('id').eq('user_id', userId);
    check('zero residual ai_usage_ledger rows after cascade', (residualLedger?.length ?? 0) === 0,
      `(residual=${residualLedger?.length})`);
    const { data: residualEvents } = await svc.from('ai_admission_events').select('id').eq('user_id', userId);
    check('zero residual ai_admission_events rows after cascade', (residualEvents?.length ?? 0) === 0,
      `(residual=${residualEvents?.length})`);
    const { data: residualEnt } = await svc.from('user_entitlements').select('id').eq('user_id', userId);
    check('zero residual user_entitlements rows after cascade', (residualEnt?.length ?? 0) === 0,
      `(residual=${residualEnt?.length})`);
    const { data: residualUser } = await svc.auth.admin.getUserById(userId);
    check('auth.users row itself is gone', !residualUser?.user, '');
  }

  console.log(`\n================ LIVE DEV RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail > 0) { console.log('FAILED CHECKS:', failures.join(' | ')); process.exit(1); }
}

main().catch(e => { console.error('FATAL: ' + (e?.stack || e)); process.exit(9); });
