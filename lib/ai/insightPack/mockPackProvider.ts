// Module 11.3 — MockInsightPackProvider. Deterministic, zero-network,
// zero-cost provider for Insight Pack generation tests, mirroring Module
// 11.0's MockAIProvider but emitting the pack-shaped envelope
// (lib/ai/insightPack/types.ts) instead of the single ai_response_envelope.
// A dedicated provider was chosen over extending MockAIProvider because the
// two envelope shapes are unrelated contracts (spec section 37) — this
// keeps Module 11.0's certified mock untouched.

import type { AIGenerateRequest, AIGenerateResult, AIProvider, CostEstimate, ProviderHealth } from '@/lib/ai/providers/types';
import { ProviderError } from '@/lib/ai/providers/types';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { PACK_SCHEMA_VERSION } from '@/lib/ai/insightPack/types';

export type MockPackBehavior =
  | 'valid'
  | 'malformed_json'
  | 'schema_invalid'
  | 'missing_mandatory_block'
  | 'unsupported_source'
  | 'fabricated_monetary_value'
  | 'fabricated_percentage'
  | 'wrong_currency'
  | 'invented_dna'
  | 'invented_resilience'
  | 'invented_benchmark'
  | 'invented_forecast_certainty'
  | 'unsupported_causality'
  | 'fake_trend'
  | 'first_baseline_false_improvement'
  | 'stale_value_no_caveat'
  | 'invalid_fx_aggregation'
  | 'product_recommendation'
  | 'tax_advice'
  | 'legal_advice'
  | 'missing_treated_as_zero_insurance'
  | 'safe_limitation_wording'
  | 'timeout'
  | 'provider_unavailable';

const MOCK_PACK_MODEL_VERSION = 'mock-pack-1.0.0';

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Builds a genuinely valid, fully grounded pack envelope FROM the real
 * context supplied — every metric_claims source_value is read straight off
 * `ctx`, so a test that mutates ctx automatically gets a self-consistent
 * "valid" baseline (spec section 80: negative controls need a working
 * positive control to be non-vacuous against).
 */
function buildValidEnvelope(ctx: FinancialContextObject): Record<string, unknown> {
  const scoreClaims = ctx.health_score
    ? [{ metric_code: 'overall_score', source_value: ctx.health_score.overall_score, display_value: String(ctx.health_score.overall_score) }]
    : [];
  const surplusClaims = ctx.cash_flow
    ? [{ metric_code: 'monthly_surplus', source_value: ctx.cash_flow.monthly_surplus_or_deficit, display_value: `$${ctx.cash_flow.monthly_surplus_or_deficit}` }]
    : [];
  const netWorthClaims = ctx.balance_sheet
    ? [{ metric_code: 'net_worth', source_value: ctx.balance_sheet.net_worth, display_value: `$${ctx.balance_sheet.net_worth}` }]
    : [];

  const knownSourceId = ctx.source_references[0]?.source_id ?? null;

  const blocks: Record<string, unknown> = {
    overall_financial_summary: {
      block_code: 'overall_financial_summary',
      status: 'POPULATED',
      headline: 'Your current financial summary',
      short_answer: 'Your recorded financial position is summarised below.',
      explanation: ctx.cash_flow ? `Your recorded monthly surplus is $${ctx.cash_flow.monthly_surplus_or_deficit}.` : 'Cash flow data is not currently available.',
      why_it_matters: 'This baseline is used to track changes over time.',
      metric_claims: surplusClaims,
      source_refs: knownSourceId ? [{ source_type: ctx.source_references[0].source_type, source_id: knownSourceId }] : [],
      limitations: [],
      confidence: 'HIGH',
      data_as_of: ctx.meta.data_as_of,
      related_module: 'dashboard',
      action_route: '/dashboard',
    },
    score_explanation: ctx.health_score
      ? {
          block_code: 'score_explanation',
          status: 'POPULATED',
          headline: `Your Financial Health Score is ${ctx.health_score.overall_score}`,
          short_answer: `Your recorded Financial Health Score is ${ctx.health_score.overall_score}.`,
          explanation: `Your recorded Financial Health Score is ${ctx.health_score.overall_score}, in the ${ctx.health_score.score_band} band.`,
          why_it_matters: 'This score summarises your certified financial health position.',
          metric_claims: scoreClaims,
          source_refs: [],
          limitations: [],
          confidence: 'HIGH',
          data_as_of: ctx.health_score.calculation_date,
          related_module: 'score',
          action_route: '/dashboard/score',
        }
      : { block_code: 'score_explanation', status: 'UNAVAILABLE' },
    net_worth_explanation: ctx.balance_sheet
      ? {
          block_code: 'net_worth_explanation',
          status: 'POPULATED',
          headline: 'Your net worth',
          short_answer: `Your recorded net worth is $${ctx.balance_sheet.net_worth}.`,
          explanation: `Your recorded net worth is $${ctx.balance_sheet.net_worth}, based on total assets of $${ctx.balance_sheet.total_assets} and total liabilities of $${ctx.balance_sheet.total_liabilities}.`,
          why_it_matters: 'Net worth tracks your overall financial position.',
          metric_claims: netWorthClaims,
          source_refs: [],
          limitations: [],
          confidence: 'HIGH',
          data_as_of: ctx.balance_sheet.data_as_of,
          related_module: 'assets',
          action_route: '/dashboard/net-worth',
        }
      : { block_code: 'net_worth_explanation', status: 'UNAVAILABLE' },
    insurance_explanation: ctx.insurance && ctx.insurance.data_status !== 'missing'
      ? { block_code: 'insurance_explanation', status: 'POPULATED', headline: 'Insurance', short_answer: 'Insurance information reviewed.', explanation: 'Your insurance information has been reviewed.', why_it_matters: '', metric_claims: [], source_refs: [], limitations: [], confidence: 'MEDIUM', data_as_of: null, related_module: 'insurance', action_route: '/dashboard/insurance' }
      : { block_code: 'insurance_explanation', status: 'POPULATED', headline: 'Insurance information incomplete', short_answer: 'FHIP cannot assess your insurance position because the information is incomplete.', explanation: 'FHIP cannot assess your insurance position because the information is incomplete.', why_it_matters: 'Completing this lets FHIP assess your protection position.', metric_claims: [], source_refs: [], limitations: ['Insurance data is incomplete.'], confidence: 'LOW', data_as_of: null, related_module: 'insurance', action_route: '/insurance' },
    twin_summary: ctx.financial_twin
      ? { block_code: 'twin_summary', status: 'POPULATED', headline: 'Peer comparison', short_answer: 'A peer comparison is available.', explanation: 'A peer comparison is available for your household.', why_it_matters: '', metric_claims: [], source_refs: [], limitations: [], confidence: 'MEDIUM', data_as_of: null, related_module: 'twin', action_route: '/twin' }
      : { block_code: 'twin_summary', status: 'UNAVAILABLE' },
    data_quality_summary: {
      block_code: 'data_quality_summary',
      status: 'POPULATED',
      headline: 'Data quality',
      short_answer: `${ctx.data_quality.complete_domains.length} of your data domains are complete.`,
      explanation: `${ctx.data_quality.complete_domains.length} domains are complete; ${ctx.data_quality.incomplete_domains.length} are incomplete.`,
      why_it_matters: 'More complete data improves the accuracy of your explanations.',
      metric_claims: [],
      source_refs: [],
      limitations: [],
      confidence: 'HIGH',
      data_as_of: ctx.meta.data_as_of,
      related_module: null,
      action_route: null,
    },
  };

  return {
    pack_version: PACK_SCHEMA_VERSION,
    snapshot_id: ctx.meta.snapshot_id ?? 'unknown-snapshot',
    data_as_of: ctx.meta.data_as_of,
    reporting_currency: ctx.meta.reporting_currency,
    overall_confidence: 'HIGH',
    blocks,
    top_strengths: ctx.cash_flow && ctx.cash_flow.monthly_surplus_or_deficit > 0 ? ['Your recorded monthly cash flow is positive.'] : [],
    top_risks: [],
    priority_review_areas: [],
    limitations: [],
  };
}

export class MockInsightPackProvider implements AIProvider {
  readonly providerName = 'mock';
  private behavior: MockPackBehavior;
  private ctx: FinancialContextObject;

  constructor(ctx: FinancialContextObject, behavior: MockPackBehavior = 'valid') {
    this.ctx = ctx;
    this.behavior = behavior;
  }

  async generateStructured(req: AIGenerateRequest): Promise<AIGenerateResult> {
    const start = Date.now();
    if (this.behavior === 'timeout') throw new ProviderError('TIMEOUT', 'Mock pack provider simulated a timeout.');
    if (this.behavior === 'provider_unavailable') throw new ProviderError('PROVIDER_UNAVAILABLE', 'Mock pack provider simulated an outage.');

    const inputTokens = estimateTokens(req.systemPrompt + req.userPrompt);
    let rawText: string;

    const valid = buildValidEnvelope(this.ctx) as any;

    switch (this.behavior) {
      case 'malformed_json':
        rawText = '{ this is not valid pack json ';
        break;
      case 'schema_invalid':
        rawText = JSON.stringify({ headline: 'missing required top-level fields' });
        break;
      case 'missing_mandatory_block': {
        const { data_quality_summary: _omit, ...rest } = valid.blocks;
        rawText = JSON.stringify({ ...valid, blocks: rest });
        break;
      }
      case 'unsupported_source':
        valid.blocks.overall_financial_summary.source_refs = [{ source_type: 'health_score', source_id: 'DOES_NOT_EXIST' }];
        rawText = JSON.stringify(valid);
        break;
      case 'fabricated_monetary_value':
        valid.blocks.net_worth_explanation.explanation = 'Your recorded net worth is $750000000, much higher than expected.';
        valid.blocks.net_worth_explanation.metric_claims = [{ metric_code: 'net_worth', source_value: 750000000, display_value: '$750,000,000' }];
        rawText = JSON.stringify(valid);
        break;
      case 'fabricated_percentage':
        valid.blocks.overall_financial_summary.explanation = 'Your savings rate is approximately 85%, far above typical households.';
        valid.blocks.overall_financial_summary.metric_claims = [{ metric_code: 'savings_rate', source_value: 85, display_value: '85%' }];
        rawText = JSON.stringify(valid);
        break;
      case 'wrong_currency':
        valid.blocks.net_worth_explanation.metric_claims = [{ metric_code: 'net_worth', source_value: this.ctx.balance_sheet?.net_worth ?? 0, display_value: 'value', currency: this.ctx.meta.reporting_currency === 'AUD' ? 'INR' : 'AUD' }];
        rawText = JSON.stringify(valid);
        break;
      case 'invented_dna':
        valid.blocks.score_explanation.explanation = 'Your Financial DNA profile is "Aggressive Growth Maximiser", a fabricated label.';
        rawText = JSON.stringify(valid);
        break;
      case 'invented_resilience':
        valid.blocks.score_explanation.explanation = 'Your resilience status is "Bulletproof", which was never certified.';
        rawText = JSON.stringify(valid);
        break;
      case 'invented_benchmark':
        valid.blocks.twin_summary = { block_code: 'twin_summary', status: 'POPULATED', headline: 'Peer comparison', short_answer: 'You are in the 99th percentile of households, an invented benchmark.', explanation: 'You are in the 99th percentile of households, an invented benchmark not present in the supplied context.', why_it_matters: '', metric_claims: [], source_refs: [], limitations: [], confidence: 'HIGH', data_as_of: null, related_module: 'twin', action_route: '/twin' };
        rawText = JSON.stringify(valid);
        break;
      case 'invented_forecast_certainty':
        valid.blocks.overall_financial_summary.explanation = 'Your net worth will be $1,200,000 in ten years.';
        rawText = JSON.stringify(valid);
        break;
      case 'unsupported_causality':
        valid.blocks.score_explanation.explanation = `Your score is ${this.ctx.health_score?.overall_score ?? 0} because your liquidity is extremely poor, a driver not in the supplied context.`;
        rawText = JSON.stringify(valid);
        break;
      case 'fake_trend':
        valid.blocks.overall_financial_summary.explanation = 'Your financial health improved significantly this month compared to last month.';
        rawText = JSON.stringify(valid);
        break;
      case 'first_baseline_false_improvement':
        valid.blocks.score_explanation.explanation = 'Your score has increased since last month.';
        rawText = JSON.stringify(valid);
        break;
      case 'stale_value_no_caveat':
        valid.blocks.net_worth_explanation.explanation = 'Your property is currently worth $900,000 and this value is currently accurate.';
        rawText = JSON.stringify(valid);
        break;
      case 'invalid_fx_aggregation':
        valid.blocks.overall_financial_summary.explanation = 'Your total wealth is AUD 500000 + INR 4000000, combined directly.';
        rawText = JSON.stringify(valid);
        break;
      case 'product_recommendation':
        valid.blocks.overall_financial_summary.explanation = 'You should refinance your mortgage with a different lender immediately.';
        rawText = JSON.stringify(valid);
        break;
      case 'tax_advice':
        valid.blocks.overall_financial_summary.explanation = 'You should claim additional deductions to reduce your tax liability.';
        rawText = JSON.stringify(valid);
        break;
      case 'legal_advice':
        valid.blocks.overall_financial_summary.explanation = 'You should consult a lawyer about suing your former employer.';
        rawText = JSON.stringify(valid);
        break;
      case 'missing_treated_as_zero_insurance':
        valid.blocks.insurance_explanation = { block_code: 'insurance_explanation', status: 'POPULATED', headline: 'Insurance', short_answer: 'You have no insurance.', explanation: 'You have no insurance cover at all.', why_it_matters: '', metric_claims: [], source_refs: [], limitations: [], confidence: 'HIGH', data_as_of: null, related_module: 'insurance', action_route: '/insurance' };
        rawText = JSON.stringify(valid);
        break;
      case 'safe_limitation_wording':
        valid.blocks.insurance_explanation = { block_code: 'insurance_explanation', status: 'POPULATED', headline: 'Insurance', short_answer: 'FHIP cannot assess your insurance position because the information is incomplete.', explanation: 'FHIP cannot assess your insurance position because the information is incomplete.', why_it_matters: 'Completing insurance data enables an assessment.', metric_claims: [], source_refs: [], limitations: ['Insurance data incomplete.'], confidence: 'LOW', data_as_of: null, related_module: 'insurance', action_route: '/insurance' };
        rawText = JSON.stringify(valid);
        break;
      case 'valid':
      default:
        rawText = JSON.stringify(valid);
        break;
    }

    return {
      rawText,
      inputTokens,
      outputTokens: estimateTokens(rawText),
      cachedInputTokens: 0,
      latencyMs: Date.now() - start,
      modelVersion: MOCK_PACK_MODEL_VERSION,
      finishReason: 'stop',
    };
  }

  async validateProviderHealth(): Promise<ProviderHealth> {
    return { healthy: true, checkedAt: new Date().toISOString(), detail: null };
  }

  estimateCost(inputTokens: number, outputTokens: number): CostEstimate {
    return { inputTokens, outputTokens, estimatedCostUsd: (inputTokens / 1000) * 0.001 + (outputTokens / 1000) * 0.002 };
  }
}
