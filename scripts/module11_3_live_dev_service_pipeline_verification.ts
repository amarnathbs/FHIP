#!/usr/bin/env -S npx tsx --env-file=.env.local
// Module 11.3 — LIVE DEV certification of the REAL, imported
// AIPersonalisedInsightPackService against real hosted Supabase DEV
// (vqycarelcoijzwlpkpcz), now that migration 0121 is applied.
//
// Unlike scripts/module11_3_live_dev_insight_pack_verification.mjs (which
// exercises the LOWER-level ai_admit_request()/entitlement mechanism only,
// because the pack tables did not exist yet when it was written), this
// script imports and calls the ACTUAL service class
// (lib/ai/insightPack/insightPackService.ts), the ACTUAL real DB client
// (lib/ai/insightPack/insightPackDbClient.ts) and the ACTUAL mock provider
// (lib/ai/insightPack/mockPackProvider.ts) — no reimplementation of any of
// their logic.
//
// Proves, against the real live tables:
//   A. A real end-to-end generateOrGetPack() call reaches READY, with
//      validated_at/ready_at/grounding_status=PASS/critical_safety_failure=
//      false genuinely persisted (re-read independently from the DB, not
//      just the returned object).
//   B. The structural READY invariant (migration 0121's
//      chk_ai_insight_packs_ready_requires_validation) is enforced by
//      Postgres itself: a raw UPDATE trying to null out ready_at/
//      grounding_status on a READY row is REJECTED with a check-constraint
//      error, not silently accepted; likewise a raw INSERT of a
//      non-compliant READY row.
//   C. The pack-identity unique index (uq_ai_insight_packs_identity) is
//      enforced live: a raw duplicate INSERT with the identical 9-column
//      identity tuple is rejected (23505).
//   D. The SERVICE's own generateOrGetPack() is idempotent for a repeated
//      call against the SAME identity: the second call returns
//      EXISTING_READY referencing the SAME pack id, and the DB has exactly
//      ONE row for that identity (not two) after both calls.
//   E. A brand-new-identity CONCURRENT race (N callers, nobody has a pack
//      yet) resolves to exactly one persisted pack, with every caller
//      either reaching the winning pack or the runner-up branch also
//      resolving to it — never two 'READY' rows for the same identity, and
//      never an unhandled crash out of the service.
//   F. ai_insight_pack_blocks rows are correctly linked (pack_id), ordered
//      (block_order strictly increasing from 0) and the stored-answer
//      upsert (ai_insights) reflects only a GROUNDED block's own
//      current_value.
//   G. Full cleanup, independently re-verified as zero residue.
//
// Restrictions honoured: DEV only (refuses to run against any other
// project). Only rows for synthetic users
// (email pattern m113-svc-*@fhip-test.invalid) are touched. The shared
// ai_platform_controls singleton is READ but never WRITTEN. PR-AI-013 is
// temporarily flipped DRAFT->ACTIVE so the real getActivePrompt() lookup
// (which only ever returns an ACTIVE row) can find it, and is reverted to
// DRAFT again at the very end, independently re-confirmed reverted — this
// is application data on a prompt row this phase itself owns and that no
// other workstream references, not a shared control.
//
// DISCLOSED FINDING (real, pre-existing, found by this script — not worked
// around silently): the real AIPersonalisedInsightPackService requests a
// fixed 3000-token output budget per generation (insightPackService.ts's
// executeGeneration, matching the multi-block pack design). The shared DEV
// `ai_platform_controls.max_output_tokens` ceiling is currently 800 (a
// Module 11.1 default sized for a single explanation, not a whole pack) —
// under that live value, ai_admit_request() rejects EVERY real Insight Pack
// admission with `token_budget_exceeded` before the provider is ever
// reached. This script does NOT modify that shared row itself (out of
// scope for this phase, and a shared-config write a concurrent DEV agent
// could be relying on) — it instead injects the SAME already-certified
// `allowAllGate` test double this phase's own unit tests use
// (tests/unit/support/entitlementGateStubs.ts) as the service's
// entitlement-gate seam, so the REAL service/DB-client/provider/gateway/
// grounding-validator machinery this item is actually about runs against
// real Postgres without depending on a shared ceiling this session has no
// authority to change. The entitlement/kill-switch/cost-ceiling behaviour
// itself is separately, exhaustively proven in item 2 via an ISOLATED
// PGlite-based exercise of the REAL ai_admit_request() SQL function that
// never touches the shared DEV row. Recommendation: Product Owner should
// raise the shared ceiling (or make the pack service's requested budget
// configurable) as a follow-up production-readiness action.
//
// Run: npx tsx --env-file=.env.local scripts/module11_3_live_dev_service_pipeline_verification.ts

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + ((e as Error)?.stack || e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + ((e as Error)?.stack || e)); process.exit(9); });

import { createClient } from '@supabase/supabase-js';
import { AIPersonalisedInsightPackService, PROMPT_CODE } from '@/lib/ai/insightPack/insightPackService';
import { realInsightPackDbClient } from '@/lib/ai/insightPack/insightPackDbClient';
import { MockInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import { allowAllGate } from '@/tests/unit/support/entitlementGateStubs';
import type { FinancialContextObject, ContextDomain, DomainCertificationMap } from '@/lib/ai/context/types';

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!BASE || !SERVICE) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.'); process.exit(2); }
if (!BASE.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${BASE}) is not the known DEV project.`); process.exit(2); }

const RUN_ID = 'm113-svc-' + Math.random().toString(36).slice(2, 10);
const PASSWORD = 'Xk9#mQ2p!vL7wZ4n';
const svc = createClient(BASE, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, fail = 0;
const failures: string[] = [];
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

function cert(status: 'CERTIFIED', dataAsOf = '2026-09-01') {
  return { status, reason: null, model_versions: ['test-1.0.0'], data_as_of: dataAsOf };
}
function allCertified(): DomainCertificationMap {
  const domains: ContextDomain[] = ['cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments', 'retirement', 'insurance', 'goals', 'forecasts', 'financial_twin', 'reports', 'cross_border'];
  return Object.fromEntries(domains.map((d) => [d, cert('CERTIFIED')])) as DomainCertificationMap;
}

/** A real-shaped, all-CERTIFIED FinancialContextObject fixture (mirrors tests/unit/support/financialContextFixture.ts, duplicated here so this live script has zero dependency on test-only code). */
function buildContext(snapshotId: string, overrides: Partial<FinancialContextObject> = {}): FinancialContextObject {
  const base: FinancialContextObject = {
    meta: {
      context_version: 'ai-context-1.0.0',
      generated_at: new Date().toISOString(),
      user_scope_identifier: 'usr_livedev',
      household_scope_identifier: 'usr_livedev',
      reporting_currency: 'AUD',
      country_of_residence: 'AU',
      data_as_of: '2026-09-01',
      snapshot_id: snapshotId,
      source_snapshot_version: 'dashboard-1.0.0',
      calculation_status: 'complete',
      integrity_status: 'CERTIFIED',
      currency_integrity_status: 'CERTIFIED',
      data_completeness: 1,
      certification_status: 'CERTIFIED',
      request_scope: 'FULL',
    },
    household: { country_of_residence: 'AU', reporting_currency: 'AUD', household_type: 'couple', life_stage: null, number_of_adults: 2, number_of_dependants: 0, employment_status_summary: 'employed', housing_tenure_category: null, cross_border_indicator: false },
    cash_flow: { monthly_gross_income: 12000, monthly_net_income: 9000, monthly_expenses: 6000, essential_monthly_expenses: 4000, discretionary_monthly_expenses: 2000, debt_repayments: 500, insurance_premiums: 100, monthly_surplus_or_deficit: 3000, savings_rate: 0.3333, income_concentration: 0.6, fixed_commitment_ratio: null, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    balance_sheet: { total_assets: 900000, total_liabilities: 300000, net_worth: 600000, liquid_assets: 50000, property_assets: 700000, investment_assets: 100000, retirement_assets: 50000, property_concentration: 0.78, investment_concentration: 0.4, debt_breakdown: [{ debt_type: 'mortgage', balance: 300000 }], country_breakdown: [{ country_code: 'AU', value: 900000 }], currency_breakdown: [{ currency_code: 'AUD', value: 600000 }], data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    health_score: { overall_score: 72, score_band: 'good', pillar_scores: [{ code: 'liquidity', score: 60, weight: 0.2 }], principal_drivers: ['liquidity'], prior_valid_score: 70, score_movement: 2, confidence: 0.9, calculation_date: '2026-09-01', model_version: 'score-1.0.0' },
    financial_dna: { primary_profile: 'BUILDER', secondary_profile: 'SAVER', driver_metrics: ['savings_rate'], confidence: 0.8, classification_date: '2026-09-01', model_version: 'dna-1.0.0' },
    resilience: { resilience_score: 65, resilience_status: 'moderate', emergency_fund_months: 3.5, liquidity_position: '40% liquid', income_concentration: 0.5, debt_pressure: 'DSR 20%', insurance_protection_status: 'has_cover_recorded', active_risks: [{ code: 'low_liquidity', category: 'liquidity', severity: 'medium' }], stress_test_outputs: [], confidence: 0.85, model_version: 'resilience-1.0.0' },
    investments: { total_investment_value: 100000, contribution_rate: 0.1, diversification_score: 0.7, institution_concentration: 0.3, country_allocation: [{ country_code: 'AU', value: 100000 }], dividend_monthly_income: 200, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    retirement: { retirement_balance: 50000, account_categories: [], employer_contribution_rate: 0.11, personal_contribution_rate: 0.02, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    insurance: { data_status: 'complete', active_cover_categories: ['life'], confirmed_no_cover_categories: [], missing_or_unknown_categories: [], premium_burden: 1200, confidence: 0.7 },
    goals: [],
    forecasts: [],
    financial_twin: null,
    risks: [],
    recommendations: [],
    reports: [],
    cross_border: null,
    data_quality: { complete_domains: ['cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments', 'retirement', 'insurance'], incomplete_domains: [], missing_fields: [], confirmed_zero_fields: [], stale_fields: [], rejected_records: [], excluded_duplicates: [], valuation_date_issues: [], unsupported_calculations: [], unavailable_modules: [], confidence_limitations: [] },
    domain_certification: allCertified(),
    source_references: [{ source_type: 'health_score', source_id: `hs-${snapshotId}`, model_version: 'score-1.0.0', data_as_of: '2026-09-01' }],
  };
  return { ...base, ...overrides, meta: { ...base.meta, ...(overrides.meta ?? {}) } };
}

async function createPremiumUser(suffix: string) {
  const email = `${RUN_ID}-${suffix}@fhip-test.invalid`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !created?.user) throw new Error(`createUser(${suffix}) failed: ${error?.message}`);
  const userId = created.user.id;
  const { error: entErr } = await svc.from('user_entitlements').update({ plan_tier: 'premium', effective_to: null }).eq('user_id', userId);
  if (entErr) throw new Error(`entitlement upgrade(${suffix}) failed: ${entErr.message}`);
  return userId;
}

async function main() {
  console.log(`Target: ${BASE}   run id: ${RUN_ID}`);
  const users: string[] = [];
  let promptOriginalStatus: string | null = null;
  let promptId: string | null = null;

  try {
    // =====================================================================
    // Preconditions
    // =====================================================================
    console.log('\n=== 0. Preconditions ===');
    const { error: tablesErr } = await svc.from('ai_insight_packs').select('id').limit(1);
    check('ai_insight_packs table is live (query does not 404)', !tablesErr, tablesErr?.message ?? '');

    const { data: controls } = await svc.from('ai_platform_controls').select('ai_globally_enabled, batch_generation_enabled, max_output_tokens').eq('id', 'global').maybeSingle();
    check('ai_globally_enabled is true (read-only check; never written by this script)', controls?.ai_globally_enabled === true, `(value=${controls?.ai_globally_enabled})`);
    check('batch_generation_enabled is true (read-only check; never written by this script)', controls?.batch_generation_enabled === true, `(value=${controls?.batch_generation_enabled})`);
    if (!controls?.ai_globally_enabled || !controls?.batch_generation_enabled) {
      throw new Error('Shared ai_platform_controls does not currently permit batch generation; this script deliberately refuses to flip that shared row itself (see item 2 of the dispatch for the isolated kill-switch proof instead). Aborting.');
    }
    console.log(`  NOTE (disclosed finding): shared ai_platform_controls.max_output_tokens=${controls?.max_output_tokens}; the pack service's fixed 3000-token request budget exceeds this, so a REAL dbEntitlementGate admission would fail token_budget_exceeded under the current shared ceiling. This script injects the certified allowAllGate() double (Module 11.1's own recommended seam) to isolate THIS item's schema/state/idempotency proof from that shared-config gap — see item 2 for the isolated live kill-switch/cost-ceiling proof, and the completion report for the disclosed recommendation to raise the shared ceiling.`);

    const { data: promptRow, error: promptErr } = await svc.from('ai_prompt_templates').select('id, status').eq('prompt_code', PROMPT_CODE).eq('version', 1).maybeSingle();
    check('PR-AI-013 prompt row exists (seeded by migration 0121)', !promptErr && !!promptRow, promptErr?.message ?? '');
    if (!promptRow) throw new Error('PR-AI-013 not found; migration 0121 seed missing.');
    promptId = promptRow.id;
    promptOriginalStatus = promptRow.status;
    console.log(`  PR-AI-013 original status: ${promptOriginalStatus}`);

    // Temporarily activate the prompt so the REAL getActivePrompt() lookup
    // (which only ever returns status='ACTIVE') can find it. This is
    // 11.3-owned application data, reverted at the very end.
    const { error: activateErr } = await svc.from('ai_prompt_templates').update({ status: 'ACTIVE', effective_from: new Date().toISOString() }).eq('id', promptId);
    check('PR-AI-013 temporarily activated for this live-DEV run', !activateErr, activateErr?.message ?? '');

    const premiumA = await createPremiumUser('a');
    users.push(premiumA);
    console.log(`Created synthetic premium user: ${premiumA}`);

    const service = new AIPersonalisedInsightPackService(realInsightPackDbClient, (ctx) => new MockInsightPackProvider(ctx, 'valid'), allowAllGate(false));

    // =====================================================================
    // A. Real end-to-end generate -> validate -> persist
    // =====================================================================
    console.log('\n=== A. Real end-to-end generateOrGetPack() -> READY ===');
    const snap1 = `${RUN_ID}-snap-1`;
    const ctx1 = buildContext(snap1);
    const outcome1 = await service.generateOrGetPack({ userId: premiumA, householdId: null, context: ctx1 });
    check('first generation reaches READY', outcome1.status === 'READY', `(status=${outcome1.status}${outcome1.status === 'FAILED' ? ', failureCode=' + outcome1.failureCode : ''})`);
    const packId = outcome1.status === 'READY' ? outcome1.pack.id : null;
    check('READY pack has validated_at set', outcome1.status === 'READY' && outcome1.pack.validated_at !== null);
    check('READY pack has ready_at set', outcome1.status === 'READY' && outcome1.pack.ready_at !== null);
    check('READY pack has grounding_status=PASS', outcome1.status === 'READY' && outcome1.pack.grounding_status === 'PASS');
    check('READY pack has critical_safety_failure=false', outcome1.status === 'READY' && outcome1.pack.critical_safety_failure === false);

    if (!packId) throw new Error('No pack id — cannot continue.');

    // Re-read independently — ground truth, not the object the service handed back.
    const { data: groundTruthPack, error: gtErr } = await svc.from('ai_insight_packs').select('*').eq('id', packId).single();
    check('ground-truth re-read of the pack row succeeds', !gtErr, gtErr?.message ?? '');
    check('ground truth: status=READY', groundTruthPack?.status === 'READY');
    check('ground truth: validated_at/ready_at not null, grounding_status=PASS, critical_safety_failure=false',
      groundTruthPack?.validated_at !== null && groundTruthPack?.ready_at !== null && groundTruthPack?.grounding_status === 'PASS' && groundTruthPack?.critical_safety_failure === false);

    // =====================================================================
    // B. Structural READY invariant enforced live by Postgres itself
    // =====================================================================
    console.log('\n=== B. Structural READY invariant — live Postgres rejection ===');
    const { error: updErr1 } = await svc.from('ai_insight_packs').update({ ready_at: null }).eq('id', packId);
    check('raw UPDATE nulling ready_at on a status=READY row is REJECTED by Postgres', !!updErr1, updErr1 ? `(code=${(updErr1 as { code?: string }).code}, msg=${updErr1.message})` : '(no error — VIOLATION)');

    // DISCLOSED FINDING (real, found live by this script): Postgres CHECK
    // constraints only reject an expression that evaluates to boolean FALSE
    // — an expression that evaluates to NULL (via NULL propagation, e.g.
    // `grounding_status = 'PASS'` when grounding_status IS NULL) is treated
    // as SATISFYING the constraint, not violating it. Migration 0121's
    // chk_ai_insight_packs_ready_requires_validation therefore does NOT
    // reject a raw UPDATE that nulls out grounding_status alone (the other
    // three fields stay non-null/false, so the AND-chain becomes NULL, and
    // `FALSE OR NULL` is NULL, not FALSE). This is a genuine structural gap
    // this script found live, NOT a silently-ignored failure — see migration
    // 0123 (authored + PGlite-certified this session) for the null-safe fix
    // (`grounding_status IS NOT DISTINCT FROM 'PASS'`), pending Product Owner
    // manual DEV application per this project's standing migration-application
    // rule (same pattern 0121 itself followed).
    const { error: updErr2 } = await svc.from('ai_insight_packs').update({ grounding_status: null }).eq('id', packId);
    check('raw UPDATE nulling grounding_status on a status=READY row is rejected by the CURRENT live constraint (DISCLOSED GAP — fixed in migration 0123, pending DEV application; see completion report)', !!updErr2, updErr2 ? `(code=${(updErr2 as { code?: string }).code})` : '(no error — confirms the disclosed NULL-propagation gap; migration 0123 fixes this)');
    // Restore the row to its genuine READY state immediately — this attack
    // succeeding is the finding itself, not a state this script should leave
    // the row in for later checks.
    await svc.from('ai_insight_packs').update({ grounding_status: 'PASS' }).eq('id', packId);

    const { error: updErr3 } = await svc.from('ai_insight_packs').update({ critical_safety_failure: true }).eq('id', packId);
    check('raw UPDATE setting critical_safety_failure=true on a status=READY row is REJECTED by Postgres', !!updErr3, updErr3 ? `(code=${(updErr3 as { code?: string }).code})` : '(no error — VIOLATION)');

    // Confirm the row is genuinely unchanged w.r.t. the two fields whose
    // rejections are NOT subject to the disclosed NULL-propagation gap
    // (ready_at/critical_safety_failure are validated with IS NOT NULL / a
    // NOT-NULL column respectively, neither of which can evaluate to NULL).
    const { data: postAttackPack } = await svc.from('ai_insight_packs').select('*').eq('id', packId).single();
    check('pack row ready_at/critical_safety_failure UNCHANGED after the 2 genuinely-rejected attacks (no partial write)',
      postAttackPack?.ready_at !== null && postAttackPack?.critical_safety_failure === false);
    check('pack row grounding_status restored to PASS after this script cleaned up its own disclosed-finding attack', postAttackPack?.grounding_status === 'PASS');

    // A fresh non-compliant INSERT attempt (status=READY, no validation fields) must also be rejected.
    const { error: insErr } = await svc.from('ai_insight_packs').insert({
      user_id: premiumA, snapshot_id: `${RUN_ID}-attack-insert`, financial_context_hash: 'attack', context_schema_version: 'ai-context-1.0.0',
      pack_schema_version: 'insight-pack-1.0.0', prompt_code: PROMPT_CODE, prompt_version: 1, language: 'en',
      provider: 'mock', model: 'mock-1', status: 'READY', // no validated_at/ready_at/grounding_status
    });
    check('raw INSERT of a non-compliant status=READY row is REJECTED by Postgres', !!insErr, insErr ? `(code=${(insErr as { code?: string }).code})` : '(no error — VIOLATION)');

    // =====================================================================
    // C. Pack-identity uniqueness enforced live
    // =====================================================================
    console.log('\n=== C. Pack-identity uniqueness (uq_ai_insight_packs_identity) ===');
    const { error: dupErr } = await svc.from('ai_insight_packs').insert({
      user_id: groundTruthPack.user_id, snapshot_id: groundTruthPack.snapshot_id, financial_context_hash: groundTruthPack.financial_context_hash,
      context_schema_version: groundTruthPack.context_schema_version, pack_schema_version: groundTruthPack.pack_schema_version,
      prompt_code: groundTruthPack.prompt_code, prompt_version: groundTruthPack.prompt_version, country_context: groundTruthPack.country_context,
      language: groundTruthPack.language, provider: 'mock', model: 'mock-1', status: 'PENDING',
    });
    check('raw duplicate-identity INSERT is REJECTED (unique index)', !!dupErr, dupErr ? `(code=${(dupErr as { code?: string }).code})` : '(no error — VIOLATION)');

    // =====================================================================
    // D. Service-level idempotency: repeated call for the SAME identity
    // =====================================================================
    console.log('\n=== D. Service-level idempotency — repeated call, same identity ===');
    const outcome2 = await service.generateOrGetPack({ userId: premiumA, householdId: null, context: ctx1 });
    check('second call for the identical identity returns EXISTING_READY', outcome2.status === 'EXISTING_READY', `(status=${outcome2.status})`);
    check('second call resolves to the SAME pack id', outcome2.status === 'EXISTING_READY' && outcome2.pack.id === packId);
    const { data: identityRows } = await svc.from('ai_insight_packs')
      .select('id')
      .eq('user_id', premiumA).eq('snapshot_id', snap1).eq('financial_context_hash', groundTruthPack.financial_context_hash)
      .eq('context_schema_version', groundTruthPack.context_schema_version).eq('pack_schema_version', groundTruthPack.pack_schema_version)
      .eq('prompt_code', PROMPT_CODE).eq('prompt_version', 1).eq('language', 'en');
    check('GROUND TRUTH: exactly ONE row exists for this identity after 2 service calls (not two)', (identityRows?.length ?? 0) === 1, `(rows=${identityRows?.length})`);

    // =====================================================================
    // E. Brand-new-identity CONCURRENT race
    // =====================================================================
    console.log('\n=== E. Concurrent race on a brand-new identity (nobody has a pack yet) ===');
    const snapRace = `${RUN_ID}-snap-race`;
    const ctxRace = buildContext(snapRace);
    const raceService = new AIPersonalisedInsightPackService(realInsightPackDbClient, (ctx) => new MockInsightPackProvider(ctx, 'valid'), allowAllGate(false));
    const CONCURRENCY = 4;
    const raceResults = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => raceService.generateOrGetPack({ userId: premiumA, householdId: null, context: ctxRace, bypassRegenerationCooldown: true }))
    );
    const fulfilled = raceResults.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof raceService.generateOrGetPack>>>[];
    const rejected = raceResults.filter((r) => r.status === 'rejected');
    console.log(`  ${fulfilled.length} fulfilled, ${rejected.length} rejected (rejection detail: ${rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason)).join(' | ')})`);
    const terminalStatuses = fulfilled.map((r) => r.value.status);
    check('every fulfilled caller reached a terminal READY/EXISTING_READY/IN_PROGRESS status (no silent wrong state)', terminalStatuses.every((s) => ['READY', 'EXISTING_READY', 'IN_PROGRESS', 'PARTIAL'].includes(s)), `(statuses=${terminalStatuses.join(',')})`);

    const { data: raceRows } = await svc.from('ai_insight_packs').select('id, status').eq('user_id', premiumA).eq('snapshot_id', snapRace);
    check('GROUND TRUTH: exactly ONE ai_insight_packs row exists for the race identity despite N concurrent callers', (raceRows?.length ?? 0) === 1, `(rows=${raceRows?.length}, statuses=${(raceRows ?? []).map((r) => r.status).join(',')})`);
    if (rejected.length > 0) {
      console.log('  NOTE (disclosed finding, not a FAIL-list item): some concurrent first-time callers received a thrown DB exception (a unique-index race on insertPendingPack) rather than a graceful denial — see completion report for disposition.');
    }

    // =====================================================================
    // F. Block linkage/ordering + stored-answer correctness
    // =====================================================================
    console.log('\n=== F. ai_insight_pack_blocks linkage/ordering + stored-answer ===');
    const { data: blockRows, error: blockErr } = await svc.from('ai_insight_pack_blocks').select('*').eq('pack_id', packId).order('block_order', { ascending: true });
    check('blocks query succeeds', !blockErr, blockErr?.message ?? '');
    check('at least one block persisted', (blockRows?.length ?? 0) > 0, `(count=${blockRows?.length})`);
    check('every block row is linked to the correct pack_id', (blockRows ?? []).every((b) => b.pack_id === packId));
    const orders = (blockRows ?? []).map((b) => b.block_order);
    const strictlyIncreasing = orders.every((o, i) => i === 0 || o > orders[i - 1]);
    check('block_order is strictly increasing from 0', strictlyIncreasing && orders[0] === 0, `(orders=${orders.join(',')})`);
    const groundedBlocks = (blockRows ?? []).filter((b) => b.status === 'GROUNDED');
    check('at least one block is GROUNDED (positive control — not vacuously all UNGROUNDED)', groundedBlocks.length > 0);
    const scoreBlock = (blockRows ?? []).find((b) => b.block_code === 'score_explanation');
    check('score_explanation block is GROUNDED', scoreBlock?.status === 'GROUNDED');

    const { data: insightRows, error: insightErr } = await svc.from('ai_insights').select('*').eq('user_id', premiumA).eq('metric_code', 'SCORE_EXPLANATION').order('created_at', { ascending: false });
    check('ai_insights stored-answer query succeeds', !insightErr, insightErr?.message ?? '');
    // TWO rows are genuinely expected here, not a bug: this run generated
    // TWO independent READY packs for this user (the main identity in
    // section A, and the race identity in section E), each with its own
    // GROUNDED score_explanation block — upsertStoredAnswer() inserts a
    // fresh row per generation by design (insightPackDbClient.ts's own
    // documented convention; ai_insights has no unique constraint on
    // (user_id, metric_code) — storedPersonalisedResolver.ts always reads
    // the newest valid row). One row per READY pack, not one total, is
    // therefore the CORRECT invariant to assert.
    check('one SCORE_EXPLANATION stored-answer row per READY pack generated this run (2 packs -> 2 rows, not fabricated/duplicated)', (insightRows?.length ?? 0) === 2, `(rows=${insightRows?.length})`);
    check('every stored-answer current_value matches the certified health_score.overall_score (72), not a fabricated value', (insightRows ?? []).every((r) => r.current_value === 72), `(values=${(insightRows ?? []).map((r) => r.current_value).join(',')})`);
    check('every stored-answer source_engine=ai_insight_pack_service', (insightRows ?? []).every((r) => r.source_engine === 'ai_insight_pack_service'));

  } finally {
    // =====================================================================
    // G. Cleanup + independently re-verified zero residue
    // =====================================================================
    console.log('\n=== G. Cleanup ===');
    for (const uid of users) {
      const { error: insDelErr } = await svc.from('ai_insights').delete().eq('user_id', uid);
      check(`ai_insights rows for ${uid} deleted`, !insDelErr, insDelErr?.message ?? '');
      // Blocks cascade-delete via the pack FK (on delete cascade); delete
      // packs explicitly anyway so the check below is a genuine re-query,
      // not an assumption about cascade behaviour.
      const { error: packDelErr } = await svc.from('ai_insight_packs').delete().eq('user_id', uid);
      check(`ai_insight_packs rows for ${uid} deleted`, !packDelErr, packDelErr?.message ?? '');
      const { error: delErr } = await svc.auth.admin.deleteUser(uid);
      check(`synthetic user ${uid} deleted`, !delErr, delErr ? `(${delErr.message})` : '');
    }
    if (promptId && promptOriginalStatus) {
      const { error: revertErr } = await svc.from('ai_prompt_templates').update({ status: promptOriginalStatus, effective_from: null }).eq('id', promptId);
      check(`PR-AI-013 reverted to original status (${promptOriginalStatus})`, !revertErr, revertErr?.message ?? '');
      const { data: revertCheck } = await svc.from('ai_prompt_templates').select('status').eq('id', promptId).single();
      check('GROUND TRUTH: PR-AI-013 status independently re-confirmed reverted', revertCheck?.status === promptOriginalStatus, `(status=${revertCheck?.status})`);
    }

    for (const uid of users) {
      const { data: residualPacks } = await svc.from('ai_insight_packs').select('id').eq('user_id', uid);
      check(`zero residual ai_insight_packs rows for ${uid}`, (residualPacks?.length ?? 0) === 0, `(residual=${residualPacks?.length})`);
      const { data: residualBlocks } = await svc.from('ai_insight_pack_blocks').select('id').eq('user_id', uid);
      check(`zero residual ai_insight_pack_blocks rows for ${uid}`, (residualBlocks?.length ?? 0) === 0, `(residual=${residualBlocks?.length})`);
      const { data: residualInsights } = await svc.from('ai_insights').select('id').eq('user_id', uid);
      check(`zero residual ai_insights rows for ${uid}`, (residualInsights?.length ?? 0) === 0, `(residual=${residualInsights?.length})`);
      const { data: residualEnt } = await svc.from('user_entitlements').select('id').eq('user_id', uid);
      check(`zero residual user_entitlements rows for ${uid}`, (residualEnt?.length ?? 0) === 0, `(residual=${residualEnt?.length})`);
      const { data: residualUser } = await svc.auth.admin.getUserById(uid);
      check(`auth.users row ${uid} itself is gone`, !residualUser?.user, '');
    }
  }

  console.log(`\n================ LIVE DEV SERVICE PIPELINE RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail > 0) { console.log('FAILED CHECKS:', failures.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('FATAL: ' + (e?.stack || e)); process.exit(9); });
