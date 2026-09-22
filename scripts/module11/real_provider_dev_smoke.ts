#!/usr/bin/env -S npx tsx --env-file=.env.local
// Module 11 remediation R2 — REAL PROVIDER DEV SMOKE TEST (brief section 18).
//
// Runs the REAL AIPersonalisedInsightPackService with the REAL DEV DB client
// (lib/ai/insightPack/insightPackDbClient.ts), the REAL DB-backed
// entitlement gate (ai_admit_request() on DEV), the REAL provider factory
// (lib/ai/providers/providerFactory.ts -> OpenAIProviderAdapter) and the
// REAL AIModelGateway, against the DEV project, with ONE real OpenAI request.
//
// DATA. The FinancialContextObject is a SYNTHETIC, NON-IDENTIFYING fixture
// (the same shape as tests/unit/support/financialContextFixture.ts —
// duplicated here so this live script has no dependency on test-only code);
// it carries no name, email, account number or free text. The subject is
// one of the standing 50-user synthetic E2E fixture accounts (an
// @test.fhip.invalid address) whose Premium entitlement makes the REAL
// entitlement gate admit the request — its real household data is NOT read.
//
// SPEND. Exactly one chat completion (plus the R2 zero-token health probe).
// Tokens and cost are printed from the pack row and the ai_runs row as the
// DB recorded them.
//
// CONFIG. Requires in the process environment (never printed):
//   OPENAI_API_KEY          — Module 11's credential
//   MODULE11_AI_PROVIDER=openai
//   MODULE11_AI_MODEL=gpt-4o-mini (default)
// and DEV activated by scripts/module11/dev_activate_real_provider.mjs.
//
// CLEANUP. --keep leaves the pack for inspection; default removes the pack
// (+ blocks, cascade) and the ai_insights rows it wrote, and reports zero
// residue. ai_runs / ai_usage_ledger / ai_admission_events rows are
// deliberately RETAINED: they are the spend audit trail.
//
// Run: npx tsx --env-file=.env.local scripts/module11/real_provider_dev_smoke.ts [--keep]

process.on('unhandledRejection', (e) => { console.error('REJECTED:', (e as Error)?.stack ?? e); process.exit(9); });

import { createClient } from '@supabase/supabase-js';
import { AIPersonalisedInsightPackService } from '@/lib/ai/insightPack/insightPackService';
import { realInsightPackDbClient } from '@/lib/ai/insightPack/insightPackDbClient';
import { resolvePackProvider, resolveHealthProvider } from '@/lib/ai/providers/providerFactory';
import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';
import { describeModule11AiConfig } from '@/lib/ai/config';
import type { FinancialContextObject, ContextDomain, DomainCertificationMap } from '@/lib/ai/context/types';

const KEEP = process.argv.includes('--keep');
const SUBJECT = '29ef9177-b035-4d23-b0a1-cc6c2a6967c2'; // fhip.e2e.tc049@test.fhip.invalid — synthetic Premium fixture
const RUN_ID = `r2-smoke-${Date.now()}`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (new URL(url).host !== 'vqycarelcoijzwlpkpcz.supabase.co') { console.error('Refusing: not the DEV project'); process.exit(2); }
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

function cert(status: 'CERTIFIED' | 'UNAVAILABLE') { return { status, reason: null, model_versions: ['smoke-1.0.0'], data_as_of: '2026-09-01' }; }
function syntheticContext(snapshotId: string): FinancialContextObject {
  const domains: ContextDomain[] = ['cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments', 'retirement', 'insurance', 'goals', 'forecasts', 'financial_twin', 'reports', 'cross_border'];
  const domainCert = Object.fromEntries(domains.map((d) => [d, cert('CERTIFIED')])) as DomainCertificationMap;
  return {
    meta: { context_version: 'ai-context-1.0.0', generated_at: new Date().toISOString(), user_scope_identifier: 'usr_synthetic', household_scope_identifier: 'usr_synthetic', reporting_currency: 'AUD', country_of_residence: 'AU', data_as_of: '2026-09-01', snapshot_id: snapshotId, source_snapshot_version: 'dashboard-1.0.0', calculation_status: 'complete', integrity_status: 'CERTIFIED', currency_integrity_status: 'CERTIFIED', data_completeness: null, certification_status: 'CERTIFIED', request_scope: 'FULL' },
    household: { country_of_residence: 'AU', reporting_currency: 'AUD', household_type: 'couple', life_stage: null, number_of_adults: 2, number_of_dependants: 1, employment_status_summary: 'employed', housing_tenure_category: null, cross_border_indicator: false },
    cash_flow: { monthly_gross_income: 11000, monthly_net_income: 8400, monthly_expenses: 6100, essential_monthly_expenses: 4100, discretionary_monthly_expenses: 2000, debt_repayments: 900, insurance_premiums: 120, monthly_surplus_or_deficit: 1400, savings_rate: 0.1667, income_concentration: 0.6, fixed_commitment_ratio: null, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    balance_sheet: { total_assets: 820000, total_liabilities: 410000, net_worth: 410000, liquid_assets: 18000, property_assets: 700000, investment_assets: 60000, retirement_assets: 42000, property_concentration: 0.85, investment_concentration: 0.5, debt_breakdown: [{ debt_type: 'mortgage', balance: 410000 }], country_breakdown: [{ country_code: 'AU', value: 820000 }], currency_breakdown: [{ currency_code: 'AUD', value: 410000 }], data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    health_score: { overall_score: 58, score_band: 'fair', pillar_scores: [{ code: 'liquidity', score: 40, weight: 0.2 }, { code: 'debt', score: 55, weight: 0.2 }], principal_drivers: ['liquidity', 'debt'], prior_valid_score: 61, score_movement: -3, confidence: 0.9, calculation_date: '2026-09-01', model_version: 'score-1.0.0' },
    financial_dna: { primary_profile: 'BUILDER', secondary_profile: 'SPENDER', driver_metrics: ['savings_rate'], confidence: 0.8, classification_date: '2026-09-01', model_version: 'dna-1.0.0' },
    resilience: { resilience_score: 47, resilience_status: 'vulnerable', emergency_fund_months: 2.1, liquidity_position: '2% liquid', income_concentration: 0.6, debt_pressure: 'DSR 11%', insurance_protection_status: 'has_cover_recorded', active_risks: [{ code: 'low_emergency_fund', category: 'liquidity', severity: 'high' }, { code: 'property_concentration', category: 'concentration', severity: 'high' }], stress_test_outputs: [], confidence: 0.85, model_version: 'resilience-1.0.0' },
    investments: { total_investment_value: 60000, contribution_rate: 0.05, diversification_score: 0.5, institution_concentration: 0.5, country_allocation: [{ country_code: 'AU', value: 60000 }], dividend_monthly_income: 90, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    retirement: { retirement_balance: 42000, account_categories: ['superannuation'], employer_contribution_rate: 0.115, personal_contribution_rate: 0, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    insurance: { data_status: 'complete', active_cover_categories: ['life', 'home'], confirmed_no_cover_categories: [], missing_or_unknown_categories: [], premium_burden: 1440, confidence: 0.7 },
    goals: [{ goal_reference: 'g-synthetic-1', goal_type: 'emergency_fund', goal_status: 'active', target_amount: 25000, current_funding: 18000, contribution: 300, target_date: '2027-06-01', track_status: 'at_risk', required_contribution: 420, forecast_completion_date: null, confidence: null, calculation_version: 'goals-1.0.0' }],
    forecasts: [{ scenario_code: 'base', horizon_years: 10, major_projected_metrics: {}, assumption_set_id: null, model_version: 'forecast-1.0.0', calculation_date: '2026-09-01', confidence: null, disclaimer: 'Modelled estimate, not guaranteed.' }],
    financial_twin: { peer_cohort_description: 'Dual-income couple, 30-40, AU', cohort_tier: 'mid', metrics: [], benchmark_source: null, benchmark_period: null, benchmark_version: null, benchmark_confidence: 0.75, status: 'confirmed' },
    risks: [], recommendations: [],
    reports: [],
    cross_border: null,
    data_quality: { complete_domains: domains, incomplete_domains: [], missing_fields: [], confirmed_zero_fields: [], stale_fields: [], rejected_records: [], excluded_duplicates: [], valuation_date_issues: [], unsupported_calculations: [], unavailable_modules: [], confidence_limitations: [] },
    domain_certification: domainCert,
    source_references: [
      { source_type: 'health_score', source_id: 'usr_synthetic', model_version: 'score-1.0.0', data_as_of: null },
      { source_type: 'resilience', source_id: 'usr_synthetic', model_version: 'resilience-1.0.0', data_as_of: null },
      { source_type: 'financial_snapshot', source_id: snapshotId, model_version: 'dashboard-1.0.0', data_as_of: '2026-09-01' },
    ],
  };
}

async function main() {
  console.log(`=== R2 real-provider DEV smoke test ${RUN_ID} ===`);
  console.log('config (secret-free):', JSON.stringify(describeModule11AiConfig()));
  if (describeModule11AiConfig().provider !== 'openai' || !describeModule11AiConfig().credential_configured) {
    console.error('MODULE11_AI_PROVIDER=openai and OPENAI_API_KEY must be set in the process environment.'); process.exit(2);
  }

  // 0. Zero-token health probe through the same factory the health route uses.
  const health = await new AIModelGateway(resolveHealthProvider()).validateProviderHealth();
  console.log('health probe:', JSON.stringify(health));
  if (!health.healthy) { console.error('Provider unhealthy — stopping before any spend.'); process.exit(3); }

  // 1. Quota before.
  const quotaBefore = await admin.rpc('ai_entitlement_state', { p_user_id: SUBJECT }).then((r) => (r.data as { custom_questions?: { remaining?: number } } | null)?.custom_questions?.remaining ?? null);
  console.log('custom-question quota remaining BEFORE:', quotaBefore);

  // 2. ONE real generation through the real service (real gate, real client, real provider).
  const snapshotId = `${RUN_ID}-snap`;
  const service = new AIPersonalisedInsightPackService(realInsightPackDbClient, resolvePackProvider);
  const started = Date.now();
  const outcome = await service.generateOrGetPack({ userId: SUBJECT, householdId: null, context: syntheticContext(snapshotId), bypassRegenerationCooldown: true });
  console.log(`outcome after ${Date.now() - started}ms:`, outcome.status, 'failureCode' in outcome ? outcome.failureCode : '');

  const packId = 'pack' in outcome && outcome.pack ? outcome.pack.id : null;
  if (!packId) { console.error('No pack row — see outcome above.'); process.exit(4); }

  // 3. Independent re-read from the DB (not the returned object).
  const { data: pack } = await admin.from('ai_insight_packs').select('id, status, provider, model, model_version, grounding_status, critical_safety_failure, input_tokens, output_tokens, estimated_cost_usd, ai_run_id, generated_at, validated_at, ready_at, prompt_version, pack_schema_version').eq('id', packId).single();
  console.log('pack row:', JSON.stringify(pack, null, 1));
  const { data: blocks } = await admin.from('ai_insight_pack_blocks').select('block_code, status, safety_classification, confidence, violations_json').eq('pack_id', packId).order('block_order');
  console.log('blocks:', JSON.stringify(blocks, null, 1));
  const { data: run } = pack?.ai_run_id ? await admin.from('ai_runs').select('id, provider, model, model_version, input_token_count, output_token_count, cached_input_token_count, estimated_cost_usd, latency_ms, execution_status, grounding_status, prompt_version, created_at').eq('id', pack.ai_run_id).single() : { data: null };
  console.log('ai_run row:', JSON.stringify(run, null, 1));
  const { data: insights } = await admin.from('ai_insights').select('metric_code, confidence, created_at').eq('user_id', SUBJECT).gte('created_at', new Date(started - 5000).toISOString());
  console.log(`ai_insights rows written this run: ${insights?.length ?? 0} ->`, (insights ?? []).map((i) => i.metric_code).join(', '));

  const quotaAfter = await admin.rpc('ai_entitlement_state', { p_user_id: SUBJECT }).then((r) => (r.data as { custom_questions?: { remaining?: number } } | null)?.custom_questions?.remaining ?? null);
  console.log('custom-question quota remaining AFTER:', quotaAfter);

  const grounded = (blocks ?? []).filter((b) => b.status === 'GROUNDED').length;
  const ungrounded = (blocks ?? []).filter((b) => b.status === 'UNGROUNDED');
  console.log(`\nSUMMARY: status=${pack?.status} grounding=${pack?.grounding_status} safety_failure=${pack?.critical_safety_failure} blocks=${blocks?.length} grounded=${grounded} ungrounded=${ungrounded.length} tokens=${pack?.input_tokens}+${pack?.output_tokens} cost_usd=${pack?.estimated_cost_usd} quota ${quotaBefore}->${quotaAfter}`);
  for (const u of ungrounded) console.log('  UNGROUNDED', u.block_code, JSON.stringify(u.violations_json));

  // 4. Cleanup (pack + blocks cascade + this run's ai_insights rows). ai_runs/ledger retained as the spend audit trail.
  if (!KEEP) {
    await admin.from('ai_insights').delete().eq('user_id', SUBJECT).gte('created_at', new Date(started - 5000).toISOString());
    await admin.from('ai_insight_packs').delete().eq('id', packId);
    const { count } = await admin.from('ai_insight_packs').select('id', { count: 'exact', head: true }).eq('id', packId);
    const { count: blockCount } = await admin.from('ai_insight_pack_blocks').select('id', { count: 'exact', head: true }).eq('pack_id', packId);
    console.log(`cleanup: pack rows remaining=${count} block rows remaining=${blockCount} (ai_runs ${pack?.ai_run_id} retained as audit)`);
  } else console.log('--keep: pack retained for inspection');
}

main().catch((e) => { console.error('FAILED:', e?.stack ?? e); process.exit(1); });
