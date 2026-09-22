#!/usr/bin/env -S npx tsx --env-file=.env.local
// Module 11 remediation R3 — REAL OpenAI Batch API probe (brief section 28).
//
// Submits ONE real batch item (the same synthetic, non-identifying pack
// prompt the R2 smoke test used) through the REAL OpenAIBatchProvider, then
// polls with a bounded wait. Proves: file upload accepted, batch created
// with a provider batch id, status transitions observed, and — if the
// provider completes within the wait — the output line is matched by
// custom_id and validates against the pack schema. If it does not complete
// in time, the batch id is printed for a later `--poll <id>` and the
// section-28 claim is reported as "submitted, not yet reconciled", never as
// complete.
//
// DEV DB is NOT touched (migration 0176 is DDL and has no path to DEV from
// this environment); persistence/reconciliation is certified under PGlite
// by tests/unit/aiR3SchedulerPglite.test.ts.
//
// Run: OPENAI_API_KEY=... MODULE11_AI_PROVIDER=openai npx tsx --env-file=.env.local scripts/module11/real_batch_dev_probe.ts [--poll batch_id] [--wait-seconds 300]

import { OpenAIBatchProvider } from '@/lib/ai/providers/openaiBatchProvider';
import { buildPackUserPrompt } from '@/lib/ai/insightPack/packComposition';
import { validateProviderPackResponse } from '@/lib/ai/insightPack/types';
import { summarisePackGrounding } from '@/lib/ai/insightPack/groundingValidation';
import { mandatoryBlocksApplicableFor } from '@/lib/ai/insightPack/insightPackService';
import { describeModule11AiConfig } from '@/lib/ai/config';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type { FinancialContextObject, ContextDomain, DomainCertificationMap } from '@/lib/ai/context/types';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const pollId = args.includes('--poll') ? args[args.indexOf('--poll') + 1] : null;
const waitSeconds = args.includes('--wait-seconds') ? Number(args[args.indexOf('--wait-seconds') + 1]) : 300;

function cert(status: 'CERTIFIED') { return { status, reason: null, model_versions: ['smoke-1.0.0'], data_as_of: '2026-09-01' }; }
function syntheticContext(snapshotId: string): FinancialContextObject {
  const domains: ContextDomain[] = ['cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments', 'retirement', 'insurance', 'goals', 'forecasts', 'financial_twin', 'reports', 'cross_border'];
  return {
    meta: { context_version: 'ai-context-1.0.0', generated_at: new Date().toISOString(), user_scope_identifier: 'usr_synthetic', household_scope_identifier: 'usr_synthetic', reporting_currency: 'AUD', country_of_residence: 'AU', data_as_of: '2026-09-01', snapshot_id: snapshotId, source_snapshot_version: 'dashboard-1.0.0', calculation_status: 'complete', integrity_status: 'CERTIFIED', currency_integrity_status: 'CERTIFIED', data_completeness: null, certification_status: 'CERTIFIED', request_scope: 'FULL' },
    household: { country_of_residence: 'AU', reporting_currency: 'AUD', household_type: 'couple', life_stage: null, number_of_adults: 2, number_of_dependants: 1, employment_status_summary: 'employed', housing_tenure_category: null, cross_border_indicator: false },
    cash_flow: { monthly_gross_income: 11000, monthly_net_income: 8400, monthly_expenses: 6100, essential_monthly_expenses: 4100, discretionary_monthly_expenses: 2000, debt_repayments: 900, insurance_premiums: 120, monthly_surplus_or_deficit: 1400, savings_rate: 0.1667, income_concentration: 0.6, fixed_commitment_ratio: null, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    balance_sheet: { total_assets: 820000, total_liabilities: 410000, net_worth: 410000, liquid_assets: 18000, property_assets: 700000, investment_assets: 60000, retirement_assets: 42000, property_concentration: 0.85, investment_concentration: 0.5, debt_breakdown: [{ debt_type: 'mortgage', balance: 410000 }], country_breakdown: [{ country_code: 'AU', value: 820000 }], currency_breakdown: [{ currency_code: 'AUD', value: 410000 }], data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    health_score: { overall_score: 58, score_band: 'fair', pillar_scores: [{ code: 'liquidity', score: 40, weight: 0.2 }], principal_drivers: ['liquidity'], prior_valid_score: 61, score_movement: -3, confidence: 0.9, calculation_date: '2026-09-01', model_version: 'score-1.0.0' },
    financial_dna: { primary_profile: 'BUILDER', secondary_profile: null, driver_metrics: [], confidence: 0.8, classification_date: '2026-09-01', model_version: 'dna-1.0.0' },
    resilience: { resilience_score: 47, resilience_status: 'vulnerable', emergency_fund_months: 2.1, liquidity_position: '2% liquid', income_concentration: 0.6, debt_pressure: 'DSR 11%', insurance_protection_status: 'has_cover_recorded', active_risks: [{ code: 'low_emergency_fund', category: 'liquidity', severity: 'high' }], stress_test_outputs: [], confidence: 0.85, model_version: 'resilience-1.0.0' },
    investments: { total_investment_value: 60000, contribution_rate: 0.05, diversification_score: 0.5, institution_concentration: 0.5, country_allocation: [{ country_code: 'AU', value: 60000 }], dividend_monthly_income: 90, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    retirement: { retirement_balance: 42000, account_categories: ['superannuation'], employer_contribution_rate: 0.115, personal_contribution_rate: 0, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    insurance: { data_status: 'complete', active_cover_categories: ['life'], confirmed_no_cover_categories: [], missing_or_unknown_categories: [], premium_burden: 1440, confidence: 0.7 },
    goals: [], forecasts: [], financial_twin: null, risks: [], recommendations: [], reports: [], cross_border: null,
    data_quality: { complete_domains: domains, incomplete_domains: [], missing_fields: [], confirmed_zero_fields: [], stale_fields: [], rejected_records: [], excluded_duplicates: [], valuation_date_issues: [], unsupported_calculations: [], unavailable_modules: [], confidence_limitations: [] },
    domain_certification: Object.fromEntries(domains.map((d) => [d, cert('CERTIFIED')])) as DomainCertificationMap,
    source_references: [{ source_type: 'financial_snapshot', source_id: snapshotId, model_version: 'dashboard-1.0.0', data_as_of: '2026-09-01' }],
  };
}

async function main() {
  console.log('config (secret-free):', JSON.stringify(describeModule11AiConfig()));
  const provider = new OpenAIBatchProvider();
  const ctx = syntheticContext('r3-batch-probe-snap');

  let providerBatchId = pollId;
  if (!providerBatchId) {
    // Use the ACTIVE PR-AI-013 v2 template text from DEV so the probe exercises the real prompt.
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: prompt } = await admin.from('ai_prompt_templates').select('*').eq('prompt_code', 'PR-AI-013').eq('status', 'ACTIVE').maybeSingle();
    if (!prompt) { console.error('No ACTIVE PR-AI-013 on DEV'); process.exit(2); }
    const item = { requestId: `r3-probe-${Date.now()}`, systemPrompt: (prompt as PromptTemplateRow).system_prompt, userPrompt: buildPackUserPrompt(prompt as PromptTemplateRow, ctx, []), model: 'gpt-4o-mini', maxOutputTokens: 3000 };
    const submitted = await provider.submitBatch([item]);
    console.log('SUBMITTED:', JSON.stringify({ ...submitted, inputFileId: provider.lastInputFileId, providerStatus: provider.lastProviderStatus, customId: item.requestId }));
    providerBatchId = submitted.providerBatchId;
  }

  const deadline = Date.now() + waitSeconds * 1000;
  let poll = await provider.pollBatch(providerBatchId);
  console.log(`poll #1: status=${poll.status} provider=${provider.lastProviderStatus}`);
  let n = 1;
  while (poll.status !== 'COMPLETED' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    poll = await provider.pollBatch(providerBatchId);
    n += 1;
    console.log(`poll #${n}: status=${poll.status} provider=${provider.lastProviderStatus}`);
  }
  if (poll.status !== 'COMPLETED') {
    console.log(`NOT YET COMPLETE after ${waitSeconds}s. Provider batch id ${providerBatchId} — re-run with --poll ${providerBatchId} later.`);
    process.exit(0);
  }
  console.log('COMPLETED:', JSON.stringify({ batchFailure: poll.batchFailure ?? null, outputFileId: provider.lastOutputFileId, results: poll.results.map((r) => (r.ok ? { requestId: r.requestId, ok: true, inputTokens: r.inputTokens, outputTokens: r.outputTokens, rawLen: r.rawText.length } : r)) }));
  for (const r of poll.results) {
    if (!r.ok) continue;
    const v = validateProviderPackResponse(r.rawText);
    console.log(`schema: ${v.ok ? 'PASS' : 'FAIL ' + v.reason}`);
    if (v.ok) {
      const provided = new Map(Object.entries(v.envelope.blocks).map(([k, b]) => [k, b!]) as never);
      const g = summarisePackGrounding(provided as never, ctx, new Set(ctx.source_references.map((s) => s.source_id)), mandatoryBlocksApplicableFor(ctx), { canonical: [], provided: v.envelope.priority_review_areas });
      console.log(`grounding: ${g.overallStatus} blocks=${provided.size} ranking=${g.rankingProvenance.status}`);
      const cost = (r.inputTokens / 1000) * 0.00015 * 0.5 + (r.outputTokens / 1000) * 0.0006 * 0.5;
      console.log(`batch-rate cost USD: ${cost.toFixed(6)} (standard-rate would be ${(cost * 2).toFixed(6)})`);
    }
  }
}
main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
