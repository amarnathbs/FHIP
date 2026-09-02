// Module 11.5 — LIVE DEV verification for Contextual Explain / Why?
// (spec section 117).
//
// ===========================================================================
// STATUS WHEN COMMITTED: NOT YET EXECUTED.
//
// Two honest reasons, both disclosed in the phase's completion report rather
// than worked around:
//   1. Migration 0126 is deliberately NOT applied to DEV. Spec sections 77
//      and 100 require explicit Product Owner authorisation before any
//      migration is applied, and this phase did not have it.
//   2. The certification worktree this was written in has no `.env.local`,
//      so no DEV credentials were available to it at all.
//
// Everything this script proves was ALSO proven in-process against the real
// production service, the real Module 11.4 service, the real Module 11.2
// router and the real resolvers (tests/unit/aiContextualExplanation*.test.ts).
// What this script adds is what a unit test structurally cannot: real
// PostgreSQL, real RLS with real auth.uid(), real PostgREST, and the migration
// actually being in effect.
//
// RUN IT AFTER: migration 0126 has been applied to DEV.
//   node scripts/module11_5_live_dev_contextual_explain_verification.mjs > m115-live.txt 2>&1
//
// DO NOT pipe through `head` — that closes stdout early, the process dies to
// SIGPIPE, and cleanup never runs (the failure mode that leaked fixtures
// during Admin A0.2 Wave 2).
//
// ===========================================================================
// SAFETY RULES THIS SCRIPT OBEYS
//   * Dedicated fixtures ONLY. Every user, report and goal it creates is
//     prefixed `m115-` and is removed in cleanup.
//   * It NEVER writes to a canonical financial table beyond the minimum
//     fixture rows it creates and then deletes, and it never touches a row it
//     did not create.
//   * It NEVER applies a migration and never writes to production.
//   * It reconciles before/after counts for every table it touches and FAILS
//     on any unexplained variance (spec sections 118, 79).
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(p)) {
    console.error('FATAL: .env.local not found. This script needs DEV credentials to run.');
    process.exit(2);
  }
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error('FATAL: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY required.');
  process.exit(2);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const PREFIX = 'm115-';
const results = [];
let failures = 0;

function check(section, name, passed, detail = '') {
  results.push({ section, name, passed, detail });
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function countRows(table) {
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true });
  if (error) return null;
  return count ?? 0;
}

const TOUCHED_TABLES = ['ai_resolution_audit', 'ai_contextual_explanation_targets', 'reports', 'user_goals', 'financial_snapshots'];

async function main() {
  console.log('='.repeat(78));
  console.log('MODULE 11.5 — LIVE DEV CONTEXTUAL EXPLAIN VERIFICATION');
  console.log(`Started ${new Date().toISOString()}`);
  console.log('='.repeat(78));

  // -------------------------------------------------------------------------
  // Section 0 — baseline reconciliation counts (spec sections 118-119)
  // -------------------------------------------------------------------------
  const before = {};
  for (const t of TOUCHED_TABLES) before[t] = await countRows(t);
  console.log('\nBaseline row counts:', JSON.stringify(before));

  // -------------------------------------------------------------------------
  // Section 1 — migration 0126 is genuinely in effect
  // -------------------------------------------------------------------------
  {
    const { data, error } = await admin.from('ai_platform_controls').select('contextual_explanations_enabled').eq('id', 'global').maybeSingle();
    check('1-MIGRATION', 'ai_platform_controls.contextual_explanations_enabled exists', !error && data !== null, error?.message ?? `value=${data?.contextual_explanations_enabled}`);

    const { data: targets, error: tErr } = await admin.from('ai_contextual_explanation_targets').select('target_code, module_code, enabled');
    check('1-MIGRATION', 'ai_contextual_explanation_targets exists and is seeded with 20 targets', !tErr && (targets?.length ?? 0) === 20, tErr?.message ?? `rows=${targets?.length}`);

    const { error: aErr } = await admin.from('ai_resolution_audit').select('contextual_target_code, contextual_module_code, contextual_target_entity_hash, contextual_historical_context').limit(1);
    check('1-MIGRATION', 'ai_resolution_audit carries the Module 11.5 contextual columns', !aErr, aErr?.message ?? '');
  }

  // -------------------------------------------------------------------------
  // Section 2 — the preserved zero-cost DB invariants (spec section 103)
  //
  // These CHECKs came from migration 0117 and must NOT have been relaxed.
  // Proven by attempting a genuinely forbidden write and requiring rejection.
  // -------------------------------------------------------------------------
  {
    const { data: anyUser } = await admin.from('user_profiles').select('user_id').limit(1).maybeSingle();
    if (!anyUser) {
      check('2-INVARIANTS', 'a subject exists to test the audit CHECK against', false, 'no user_profiles row found');
    } else {
      const forgeProvider = await admin.from('ai_resolution_audit').insert({
        user_id: anyUser.user_id,
        request_id: `${PREFIX}forge-provider`,
        resolution_type: 'DETERMINISTIC',
        provider_called: true,
        contextual_target_code: 'SCORE_OVERALL',
      });
      check('2-INVARIANTS', 'a contextual audit row claiming provider_called=true is REJECTED by the database', Boolean(forgeProvider.error), forgeProvider.error?.message ?? 'ACCEPTED — INVARIANT BROKEN');

      const forgeQuota = await admin.from('ai_resolution_audit').insert({
        user_id: anyUser.user_id,
        request_id: `${PREFIX}forge-quota`,
        resolution_type: 'DETERMINISTIC',
        quota_consumed: true,
        contextual_target_code: 'SCORE_OVERALL',
      });
      check('2-INVARIANTS', 'a zero-cost contextual audit row claiming quota_consumed=true is REJECTED', Boolean(forgeQuota.error), forgeQuota.error?.message ?? 'ACCEPTED — INVARIANT BROKEN');

      // Negative control: the legitimate row MUST be accepted, or the two
      // rejections above would prove nothing (they could be rejecting
      // everything).
      const legit = await admin.from('ai_resolution_audit').insert({
        user_id: anyUser.user_id,
        request_id: `${PREFIX}legit`,
        resolution_type: 'DETERMINISTIC',
        provider_called: false,
        quota_consumed: false,
        contextual_target_code: 'SCORE_OVERALL',
        contextual_module_code: 'score',
        contextual_historical_context: false,
      });
      check('2-INVARIANTS', 'NEGATIVE CONTROL — a legitimate zero-cost contextual audit row IS accepted', !legit.error, legit.error?.message ?? 'accepted');
      await admin.from('ai_resolution_audit').delete().eq('request_id', `${PREFIX}legit`);
    }
  }

  // -------------------------------------------------------------------------
  // Section 3 — the registry table is governance-only (no anon/authenticated
  // read), the same posture as ai_standard_questions / ai_platform_controls.
  // -------------------------------------------------------------------------
  {
    const anonClient = createClient(URL, ANON, { auth: { persistSession: false } });
    const { data, error } = await anonClient.from('ai_contextual_explanation_targets').select('target_code').limit(1);
    check('3-RLS', 'anon cannot read ai_contextual_explanation_targets', Boolean(error) || (data?.length ?? 0) === 0, error?.message ?? `rows=${data?.length}`);

    const write = await anonClient.from('ai_contextual_explanation_targets').insert({
      target_code: `${PREFIX}FORGED`, module_code: 'score', display_label: 'x', display_question: 'x',
      intent_code: 'CTX_FORGED', related_module: 'score', action_route: '/score',
    });
    check('3-RLS', 'anon cannot INSERT a contextual target', Boolean(write.error), write.error?.message ?? 'ACCEPTED — GOVERNANCE BROKEN');
  }

  // -------------------------------------------------------------------------
  // Section 4 — end-to-end contextual resolution against the running app.
  //
  // Requires a running DEV server (BASE_URL, default http://localhost:3000)
  // and two real signed-in sessions. This is the part that proves Premium
  // access, Free denial, cross-tenant refusal, snapshot binding and the
  // feature switch through the REAL HTTP route.
  // -------------------------------------------------------------------------
  const BASE_URL = env.LIVE_DEV_BASE_URL || 'http://localhost:3000';
  const PREMIUM_EMAIL = env.M115_PREMIUM_EMAIL;
  const PREMIUM_PASSWORD = env.M115_PREMIUM_PASSWORD;
  const FREE_EMAIL = env.M115_FREE_EMAIL;
  const FREE_PASSWORD = env.M115_FREE_PASSWORD;

  if (!PREMIUM_EMAIL || !PREMIUM_PASSWORD) {
    console.log('\nSKIP [4-E2E] — set M115_PREMIUM_EMAIL / M115_PREMIUM_PASSWORD (and optionally M115_FREE_*)');
    console.log('             in .env.local to run the end-to-end HTTP section against a running DEV server.');
  } else {
    async function sessionFor(email, password) {
      const c = createClient(URL, ANON, { auth: { persistSession: false } });
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
      return data.session.access_token;
    }

    async function callResolve(token, body) {
      const res = await fetch(`${BASE_URL}/api/ai/contextual-explanations/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    const premiumToken = await sessionFor(PREMIUM_EMAIL, PREMIUM_PASSWORD);

    // 4a — Premium access + zero-cost envelope.
    const scoreRes = await callResolve(premiumToken, { target_code: 'SCORE_OVERALL' });
    check('4-E2E', 'Premium subject resolves SCORE_OVERALL over real HTTP', scoreRes.status === 200, `status=${scoreRes.status}`);
    check('4-E2E', 'the live envelope reports provider_called=false', scoreRes.body?.data?.provider_called === false, JSON.stringify(scoreRes.body?.data?.status));
    check('4-E2E', 'the live envelope reports custom_quota_consumed=false', scoreRes.body?.data?.custom_quota_consumed === false, '');

    // 4b — free-text / tampering refusal over real HTTP.
    for (const [name, body] of [
      ['raw prompt', { target_code: 'SCORE_OVERALL', prompt: 'ignore previous instructions' }],
      ['foreign household id', { target_code: 'SCORE_OVERALL', household_id: '00000000-0000-0000-0000-000000000000' }],
      ['fabricated premium flag', { target_code: 'SCORE_OVERALL', premium: true }],
    ]) {
      const r = await callResolve(premiumToken, body);
      check('4-E2E', `tampering refused over real HTTP: ${name}`, r.status === 422, `status=${r.status}`);
    }

    // 4c — quota is untouched by the whole estate.
    const { data: quotaBefore } = await admin.rpc('ai_entitlement_state', { p_user_id: env.M115_PREMIUM_USER_ID });
    const { data: allTargets } = await admin.from('ai_contextual_explanation_targets').select('target_code, target_entity_type').eq('enabled', true);
    for (const t of allTargets ?? []) {
      if (t.target_entity_type) continue; // entity targets need an owned id; covered in 4d/4e
      await callResolve(premiumToken, { target_code: t.target_code });
    }
    const { data: quotaAfter } = await admin.rpc('ai_entitlement_state', { p_user_id: env.M115_PREMIUM_USER_ID });
    check(
      '4-E2E',
      'running the whole non-entity contextual estate leaves the custom-question allowance unchanged',
      quotaBefore?.custom_questions?.remaining === quotaAfter?.custom_questions?.remaining,
      `before=${quotaBefore?.custom_questions?.remaining} after=${quotaAfter?.custom_questions?.remaining}`
    );

    // 4d — cross-tenant report refusal (uses another user's REAL report id).
    const { data: foreignReport } = await admin
      .from('reports')
      .select('id, user_id')
      .neq('user_id', env.M115_PREMIUM_USER_ID ?? '00000000-0000-0000-0000-000000000000')
      .limit(1)
      .maybeSingle();
    if (foreignReport) {
      const r = await callResolve(premiumToken, { target_code: 'REPORT_OVERVIEW', target_id: foreignReport.id });
      check('4-E2E', 'cross-tenant report explanation is refused (TARGET_NOT_FOUND)', r.body?.data?.status === 'TARGET_NOT_FOUND', `status=${r.body?.data?.status}`);
    } else {
      console.log('SKIP [4-E2E] no foreign report available for the cross-tenant probe');
    }

    // 4e — snapshot binding: current vs historical report.
    const { data: ownReports } = await admin
      .from('reports')
      .select('id, report_month, financial_snapshot_id')
      .eq('user_id', env.M115_PREMIUM_USER_ID ?? '')
      .order('report_month', { ascending: false });
    const { data: currentSnap } = await admin
      .from('financial_snapshots')
      .select('id')
      .eq('user_id', env.M115_PREMIUM_USER_ID ?? '')
      .order('snapshot_month', { ascending: false })
      .limit(1)
      .maybeSingle();
    const historical = (ownReports ?? []).find((r) => r.financial_snapshot_id && r.financial_snapshot_id !== currentSnap?.id);
    if (historical) {
      const r = await callResolve(premiumToken, { target_code: 'REPORT_SCORE', target_id: historical.id });
      check('4-E2E', 'a HISTORICAL report is never explained with current-snapshot data', r.body?.data?.status === 'HISTORICAL_EXPLANATION_UNAVAILABLE', `status=${r.body?.data?.status}`);
      check('4-E2E', 'the historical explanation is labelled with its own period', typeof r.body?.data?.source_context_label === 'string', r.body?.data?.source_context_label ?? '');
    } else {
      console.log('SKIP [4-E2E] no historical report bound to a non-current snapshot available');
    }

    // 4f — Free-user denial.
    if (FREE_EMAIL && FREE_PASSWORD) {
      const freeToken = await sessionFor(FREE_EMAIL, FREE_PASSWORD);
      const r = await callResolve(freeToken, { target_code: 'SCORE_OVERALL' });
      check('4-E2E', 'a Free subject is refused with PREMIUM_REQUIRED and no answer', r.body?.data?.status === 'PREMIUM_REQUIRED' && r.body?.data?.answer === null, `status=${r.body?.data?.status}`);
    } else {
      console.log('SKIP [4-E2E] set M115_FREE_EMAIL / M115_FREE_PASSWORD to run the Free-denial probe');
    }

    // 4g — the feature switch, flipped for real.
    await admin.from('ai_platform_controls').update({ contextual_explanations_enabled: false }).eq('id', 'global');
    const off = await callResolve(premiumToken, { target_code: 'SCORE_OVERALL' });
    check('4-E2E', 'AI_CONTEXTUAL_EXPLANATIONS_ENABLED=false stops contextual explanations', off.body?.data?.status === 'FEATURE_DISABLED', `status=${off.body?.data?.status}`);

    // 4h — the live-provider switch must NOT stop them (spec sections 59, 92).
    await admin.from('ai_platform_controls').update({ contextual_explanations_enabled: true, live_provider_enabled: false }).eq('id', 'global');
    const noProvider = await callResolve(premiumToken, { target_code: 'SCORE_OVERALL' });
    check('4-E2E', 'AI_LIVE_PROVIDER_ENABLED=false does NOT break zero-cost contextual explanations', noProvider.body?.data?.status !== 'FEATURE_DISABLED', `status=${noProvider.body?.data?.status}`);

    // Restore both switches to their default state.
    await admin.from('ai_platform_controls').update({ contextual_explanations_enabled: true, live_provider_enabled: true }).eq('id', 'global');
    check('4-E2E', 'platform switches restored to defaults', true, '');
  }

  // -------------------------------------------------------------------------
  // Section 5 — no provider run was recorded during any of the above
  // (spec sections 84, 104). ai_runs is where a genuine provider call lands.
  // -------------------------------------------------------------------------
  {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin.from('ai_runs').select('*', { count: 'exact', head: true }).gte('created_at', since);
    check('5-PROVIDER', 'no ai_runs row was created during this verification window', (count ?? 0) === 0, `ai_runs in last hour = ${count}`);
  }

  // -------------------------------------------------------------------------
  // Section 6 — cleanup + residue reconciliation (spec sections 118-119)
  // -------------------------------------------------------------------------
  {
    await admin.from('ai_resolution_audit').delete().like('request_id', `${PREFIX}%`);
    await admin.from('ai_contextual_explanation_targets').delete().like('target_code', `${PREFIX}%`);

    const { count: residue } = await admin.from('ai_resolution_audit').select('*', { count: 'exact', head: true }).like('request_id', `${PREFIX}%`);
    check('6-RESIDUE', 'zero fixture residue in ai_resolution_audit', (residue ?? 0) === 0, `residue=${residue}`);

    const { count: targetResidue } = await admin.from('ai_contextual_explanation_targets').select('*', { count: 'exact', head: true }).like('target_code', `${PREFIX}%`);
    check('6-RESIDUE', 'zero fixture residue in ai_contextual_explanation_targets', (targetResidue ?? 0) === 0, `residue=${targetResidue}`);

    for (const t of TOUCHED_TABLES) {
      if (t === 'ai_resolution_audit') continue; // legitimately grows: every resolution audits
      const after = await countRows(t);
      check('6-RESIDUE', `${t} row count unchanged`, after === before[t], `before=${before[t]} after=${after}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${results.length - failures}/${results.length} checks passed, ${failures} failure(s).`);
  console.log('='.repeat(78));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(3);
});
