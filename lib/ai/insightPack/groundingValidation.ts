// Module 11.3 — AIGroundingValidationService (spec sections 38-51, 80-87,
// 148). The core control of this module: determines whether the provider's
// structured pack output is genuinely grounded in the supplied certified
// FinancialContextObject, or must be rejected.
//
// DESIGN PRINCIPLE (spec section 40): prefer the STRUCTURED metric_claims
// array over scanning prose. Every numeric/currency/source check below is
// structural. Causality/trend/forecast-certainty/missing-vs-zero/product-
// advice checks are necessarily prose-pattern based, because the pack's own
// free-text explanation is exactly where those violations would appear —
// this mirrors lib/ai/safety/classification.ts's own rule-based-first-pass
// approach (Module 11.0 spec section 30), applied here to AI OUTPUT rather
// than user input.

import type { FinancialContextObject } from '@/lib/ai/context/types';
import { classifyRequest } from '@/lib/ai/safety/classification';
import type { GroundingStatus, MetricClaim, ProviderPackBlock, PackBlockCode } from '@/lib/ai/insightPack/types';

export interface BlockViolation {
  code: string;
  detail: string;
}

export interface BlockGroundingResult {
  status: GroundingStatus;
  violations: BlockViolation[];
  safetyClassification: string | null;
  criticalSafetyFailure: boolean;
}

const NUMERIC_TOLERANCE = 0.5; // half a currency unit — rounding-safe, not "approximately" loose

// ---------------------------------------------------------------------------
// Metric extraction — the canonical mapping from a metric_code the prompt
// asks the provider to cite, to the certified value it must match exactly
// (spec section 39-40). Deliberately explicit and closed: an unrecognised
// metric_code is a violation (spec section 29/47), never silently accepted.
// ---------------------------------------------------------------------------
export function extractCertifiedMetricValue(metricCode: string, ctx: FinancialContextObject): number | null | undefined {
  switch (metricCode) {
    case 'monthly_gross_income': return ctx.cash_flow?.monthly_gross_income ?? null;
    case 'monthly_net_income': return ctx.cash_flow?.monthly_net_income ?? null;
    case 'monthly_expenses': return ctx.cash_flow?.monthly_expenses ?? null;
    case 'monthly_surplus': return ctx.cash_flow?.monthly_surplus_or_deficit ?? null;
    case 'savings_rate': return ctx.cash_flow?.savings_rate ?? null;
    case 'total_assets': return ctx.balance_sheet?.total_assets ?? null;
    case 'total_liabilities': return ctx.balance_sheet?.total_liabilities ?? null;
    case 'net_worth': return ctx.balance_sheet?.net_worth ?? null;
    case 'liquid_assets': return ctx.balance_sheet?.liquid_assets ?? null;
    case 'property_concentration': return ctx.balance_sheet?.property_concentration ?? null;
    case 'investment_concentration': return ctx.balance_sheet?.investment_concentration ?? null;
    case 'overall_score': return ctx.health_score?.overall_score ?? null;
    case 'prior_valid_score': return ctx.health_score?.prior_valid_score ?? null;
    case 'score_movement': return ctx.health_score?.score_movement ?? null;
    case 'resilience_score': return ctx.resilience?.resilience_score ?? null;
    case 'emergency_fund_months': return ctx.resilience?.emergency_fund_months ?? null;
    case 'total_investment_value': return ctx.investments?.total_investment_value ?? null;
    case 'diversification_score': return ctx.investments?.diversification_score ?? null;
    case 'retirement_balance': return ctx.retirement?.retirement_balance ?? null;
    case 'insurance_premium_burden': return ctx.insurance?.premium_burden ?? null;
    default: return undefined; // unrecognised — caller treats as a violation
  }
}

/** Spec section 41 — the only two closed-vocabulary classification claims a pack may make verbatim. */
function extractCertifiedClassification(kind: 'dna' | 'resilience_status', ctx: FinancialContextObject): string | null {
  if (kind === 'dna') return ctx.financial_dna?.primary_profile ?? null;
  return ctx.resilience?.resilience_status ?? null;
}

function metricClaimViolations(claims: MetricClaim[], ctx: FinancialContextObject): BlockViolation[] {
  const violations: BlockViolation[] = [];
  for (const claim of claims) {
    const certified = extractCertifiedMetricValue(claim.metric_code, ctx);
    if (certified === undefined) {
      violations.push({ code: 'unsupported_metric_code', detail: `metric_code "${claim.metric_code}" is not a recognised certified metric.` });
      continue;
    }
    if (certified === null) {
      // The metric is genuinely absent/UNAVAILABLE in the certified context.
      // A claim citing it (any source_value) is a fabrication — spec
      // section 23 "missing != zero" applies to metric_claims exactly as it
      // does to prose.
      violations.push({ code: 'metric_not_available', detail: `metric_code "${claim.metric_code}" has no certified value in this context; claim rejected.` });
      continue;
    }
    if (claim.source_value === null) {
      violations.push({ code: 'metric_value_missing', detail: `metric_code "${claim.metric_code}" claim carried no source_value.` });
      continue;
    }
    if (Math.abs(claim.source_value - certified) > NUMERIC_TOLERANCE) {
      violations.push({
        code: 'fabricated_numeric_value',
        detail: `metric_code "${claim.metric_code}" claimed ${claim.source_value} but the certified value is ${certified}.`,
      });
    }
    if (claim.currency && ctx.meta.reporting_currency !== claim.currency) {
      violations.push({
        code: 'unsupported_currency_claim',
        detail: `metric_code "${claim.metric_code}" claimed currency ${claim.currency} but reporting currency is ${ctx.meta.reporting_currency}.`,
      });
    }
  }
  return violations;
}

function sourceRefViolations(refs: { source_type: string; source_id: string }[], knownSourceIds: ReadonlySet<string>): BlockViolation[] {
  return refs
    .filter((r) => !knownSourceIds.has(r.source_id))
    .map((r) => ({ code: 'unsupported_source_ref', detail: `source_id "${r.source_id}" is not present in the supplied context's source_references.` }));
}

// ---------------------------------------------------------------------------
// Prose-pattern checks (spec sections 41-50, 80-87).
// ---------------------------------------------------------------------------
const CAUSAL_PATTERN = /\b(because|due to|driven by|caused by|is being (reduced|lowered|dragged down) by|is being (boosted|lifted) by)\b/i;
const TREND_PATTERN = /\b(increased|decreased|improved|declined|worse than|better than|higher than last|lower than last|up from|down from|has grown|has fallen)\b/i;
const FORECAST_CERTAINTY_PATTERN = /\b(will be worth|will reach|will have|is guaranteed|guaranteed to)\b/i;
const FORECAST_HEDGE_PATTERN = /\b(projects?|projected|modelled|under (the|this|a) .*assumptions?|base[- ]case|forecast(s|ed)? to)\b/i;
const NO_INSURANCE_CLAIM_PATTERN = /\byou have no insurance\b|\bno insurance cover\b|\byou are not insured\b/i;
const SAFE_LIMITATION_PATTERN = /\bcannot assess\b|\bincomplete\b|\bunavailable\b|\bcould not be (determined|assessed)\b|\bnot enough (data|information)\b/i;
const NO_DEBT_CLAIM_PATTERN = /\byou have no (debt|liabilities)\b|\bdebt-free\b/i;
const PRODUCT_RECOMMENDATION_PATTERN = /\byou should (refinance|switch (to|your)|buy|sell|invest in|open an?)\b|\bwe recommend (switching|buying|selling|refinancing)\b|\bconsider switching to\b/i;
const TAX_ADVICE_OUTPUT_PATTERN = /\byou should (claim|deduct)\b|\bfile your tax return\b|\byour tax liability (is|will be)\b/i;
const LEGAL_ADVICE_OUTPUT_PATTERN = /\byou should (sue|consult a lawyer about)\b|\blegally (required|obligated) to\b/i;
const STALE_VALUE_NO_CAVEAT_PATTERN = /\bis currently worth\b|\bcurrent value is\b|\bcurrently valued at\b/i;
const STALE_CAVEAT_PATTERN = /\bdated\b|\bvaluation date\b|\bas of\b|\brecorded (value|valuation)\b/i;
const RAW_CURRENCY_SUM_PATTERN = /\b(aud|inr|₹|\$)\s?[\d,.]+\s*(\+|plus|and)\s*(aud|inr|₹|\$)\s?[\d,.]+/i;

function blockText(block: ProviderPackBlock): string {
  return [block.headline, block.short_answer, block.explanation, block.why_it_matters].filter(Boolean).join(' ');
}

function classificationViolations(text: string, ctx: FinancialContextObject): BlockViolation[] {
  const violations: BlockViolation[] = [];
  const certifiedDna = extractCertifiedClassification('dna', ctx);
  const certifiedResilience = extractCertifiedClassification('resilience_status', ctx);

  // A DNA/resilience label mentioned in prose must exactly equal the
  // certified value — checked by "does the text contain a DNA/resilience-
  // sounding label that ISN'T the certified one". A perfect closed-vocabulary
  // check would require the full label taxonomy; the practical, testable
  // proxy here is: if the text asserts "Financial DNA is X" / "resilience
  // (status )?is X", X must match the certified label.
  const dnaClaim = text.match(/financial dna (profile )?is\s+"?([a-z0-9 \-]+?)"?[.\s]/i);
  if (dnaClaim) {
    const claimed = dnaClaim[2].trim().toLowerCase();
    if (!certifiedDna || claimed !== certifiedDna.toLowerCase()) {
      violations.push({ code: 'invented_dna_classification', detail: `Text claimed Financial DNA "${dnaClaim[2].trim()}"; certified value is "${certifiedDna ?? 'UNAVAILABLE'}".` });
    }
  }
  const resilienceClaim = text.match(/resilience (status )?is\s+"?([a-z0-9 \-]+?)"?[.\s]/i);
  if (resilienceClaim) {
    const claimed = resilienceClaim[2].trim().toLowerCase();
    if (!certifiedResilience || claimed !== certifiedResilience.toLowerCase()) {
      violations.push({ code: 'invented_resilience_classification', detail: `Text claimed resilience status "${resilienceClaim[2].trim()}"; certified value is "${certifiedResilience ?? 'UNAVAILABLE'}".` });
    }
  }
  return violations;
}

function causalViolations(text: string, ctx: FinancialContextObject): BlockViolation[] {
  if (!CAUSAL_PATTERN.test(text)) return [];
  const approvedDrivers = [
    ...(ctx.health_score?.principal_drivers ?? []),
    ...(ctx.resilience?.active_risks?.map((r) => r.code) ?? []),
    ctx.resilience?.debt_pressure ?? null,
    ctx.resilience?.liquidity_position ?? null,
  ].filter((d): d is string => Boolean(d)).map((d) => d.toLowerCase());
  const mentionsApprovedDriver = approvedDrivers.some((d) => text.toLowerCase().includes(d));
  if (!mentionsApprovedDriver) {
    return [{ code: 'unsupported_causal_claim', detail: 'Text asserts a causal driver not present in the certified driver list (health_score.principal_drivers / resilience active_risks/debt_pressure/liquidity_position).' }];
  }
  return [];
}

function trendViolations(text: string, ctx: FinancialContextObject): BlockViolation[] {
  if (!TREND_PATTERN.test(text)) return [];
  const hasPriorComparable = ctx.health_score?.prior_valid_score !== null && ctx.health_score?.prior_valid_score !== undefined
    && ctx.health_score?.score_movement !== null && ctx.health_score?.score_movement !== undefined;
  if (!hasPriorComparable) {
    return [{ code: 'unsupported_trend_claim', detail: 'Text asserts a change/trend but no prior comparable snapshot exists (health_score.prior_valid_score is null) — first-baseline wording required instead.' }];
  }
  return [];
}

function forecastViolations(text: string): BlockViolation[] {
  if (FORECAST_CERTAINTY_PATTERN.test(text) && !FORECAST_HEDGE_PATTERN.test(text)) {
    return [{ code: 'unsupported_forecast_certainty', detail: 'Text states a forecast as a certain fact rather than a modelled projection (spec section 44).' }];
  }
  return [];
}

function missingVsZeroViolations(text: string, ctx: FinancialContextObject): BlockViolation[] {
  const violations: BlockViolation[] = [];
  if (ctx.insurance && ctx.insurance.data_status === 'missing' && NO_INSURANCE_CLAIM_PATTERN.test(text) && !SAFE_LIMITATION_PATTERN.test(text)) {
    violations.push({ code: 'missing_treated_as_zero_insurance', detail: 'Text states "no insurance" when insurance data is MISSING, not confirmed none (spec section 46).' });
  }
  const liabilitiesUnavailable = ctx.balance_sheet === null;
  if (liabilitiesUnavailable && NO_DEBT_CLAIM_PATTERN.test(text)) {
    violations.push({ code: 'missing_treated_as_zero_debt', detail: 'Text asserts debt-free when balance sheet data is unavailable, not confirmed zero.' });
  }
  return violations;
}

function crossBorderViolations(text: string, ctx: FinancialContextObject): BlockViolation[] {
  const crossBorderCert = ctx.domain_certification.cross_border?.status;
  const invalid = crossBorderCert === 'INVALID' || crossBorderCert === 'UNAVAILABLE';
  if (invalid && RAW_CURRENCY_SUM_PATTERN.test(text)) {
    return [{ code: 'unsupported_raw_currency_aggregation', detail: 'Text sums raw multi-currency nominal amounts while cross-border currency certification is not usable (spec section 85).' }];
  }
  return [];
}

function staleValueViolations(text: string, ctx: FinancialContextObject): BlockViolation[] {
  const balanceSheetStale = ctx.domain_certification.balance_sheet?.status === 'STALE';
  if (balanceSheetStale && STALE_VALUE_NO_CAVEAT_PATTERN.test(text) && !STALE_CAVEAT_PATTERN.test(text)) {
    return [{ code: 'stale_value_without_caveat', detail: 'Text states a stale valuation as current without a date caveat (spec section 87).' }];
  }
  return [];
}

/**
 * Spec sections 53-55 — product/tax/legal advice and money-movement
 * instruction boundary, applied to the AI's OWN generated text (not user
 * input, which lib/ai/safety/classification.ts already covers). Distinct,
 * output-directed patterns are needed because the model would phrase advice
 * as a statement ("you should refinance"), not a question.
 */
function safetyBoundaryViolations(text: string): { violations: BlockViolation[]; classification: string | null; critical: boolean } {
  if (PRODUCT_RECOMMENDATION_PATTERN.test(text)) {
    return { violations: [{ code: 'unsupported_product_recommendation', detail: 'Text recommends a specific financial product/action (spec section 53).' }], classification: 'PRODUCT_ADVICE', critical: true };
  }
  if (TAX_ADVICE_OUTPUT_PATTERN.test(text)) {
    return { violations: [{ code: 'unsupported_tax_advice', detail: 'Text gives personalised tax advice (spec section 54).' }], classification: 'TAX_ADVICE', critical: true };
  }
  if (LEGAL_ADVICE_OUTPUT_PATTERN.test(text)) {
    return { violations: [{ code: 'unsupported_legal_advice', detail: 'Text gives personalised legal advice (spec section 54).' }], classification: 'LEGAL_ADVICE', critical: true };
  }
  // Reuse the existing Module 11.0 classifier as a second, independent pass
  // (money-movement / data-write phrasing especially) — harmless if it
  // agrees with GENERAL_EDUCATION/FHIP_EXPLANATION, load-bearing if the AI's
  // own output happens to contain one of those already-approved patterns.
  const reused = classifyRequest(text, 'user_question');
  if (reused.blocked && (reused.classification === 'MONEY_MOVEMENT' || reused.classification === 'DATA_WRITE')) {
    return { violations: [{ code: `unsupported_${reused.classification.toLowerCase()}`, detail: reused.blockReason ?? 'Blocked by safety classifier.' }], classification: reused.classification, critical: true };
  }
  return { violations: [], classification: 'FHIP_EXPLANATION', critical: false };
}

// ---------------------------------------------------------------------------
// Per-block composition (spec section 48).
// ---------------------------------------------------------------------------
export function validateBlockGrounding(
  block: ProviderPackBlock,
  ctx: FinancialContextObject,
  knownSourceIds: ReadonlySet<string>
): BlockGroundingResult {
  if (block.status === 'UNAVAILABLE') {
    return { status: 'NOT_APPLICABLE', violations: [], safetyClassification: null, criticalSafetyFailure: false };
  }

  const text = blockText(block);
  const violations: BlockViolation[] = [
    ...metricClaimViolations(block.metric_claims, ctx),
    ...sourceRefViolations(block.source_refs, knownSourceIds),
    ...classificationViolations(text, ctx),
    ...causalViolations(text, ctx),
    ...trendViolations(text, ctx),
    ...forecastViolations(text),
    ...missingVsZeroViolations(text, ctx),
    ...crossBorderViolations(text, ctx),
    ...staleValueViolations(text, ctx),
  ];

  const safety = safetyBoundaryViolations(text);
  violations.push(...safety.violations);

  if (safety.critical) {
    return { status: 'UNGROUNDED', violations, safetyClassification: safety.classification, criticalSafetyFailure: true };
  }
  if (violations.length === 0) {
    return { status: 'GROUNDED', violations: [], safetyClassification: safety.classification, criticalSafetyFailure: false };
  }
  // Any financial-fact violation (numeric/currency/classification/causal/
  // trend/forecast/missing-as-zero/cross-border) fails the WHOLE block
  // closed (spec section 49: "Do not silently accept 'mostly correct'
  // financial prose") — there is no partial-credit numeric grounding.
  return { status: 'UNGROUNDED', violations, safetyClassification: safety.classification, criticalSafetyFailure: false };
}

export interface PackGroundingSummary {
  blockResults: Map<PackBlockCode, BlockGroundingResult>;
  overallStatus: 'PASS' | 'PARTIAL' | 'FAIL';
  criticalSafetyFailure: boolean;
  mandatoryBlockFailed: PackBlockCode | null;
}

/**
 * Spec sections 50-51: an optional block failing grounding is isolated
 * (pack may still be READY/PARTIAL); a MANDATORY block failing, or ANY
 * critical safety failure anywhere in the pack, fails the whole pack closed.
 */
export function summarisePackGrounding(
  blocks: Map<PackBlockCode, ProviderPackBlock>,
  ctx: FinancialContextObject,
  knownSourceIds: ReadonlySet<string>,
  mandatoryBlockCodes: readonly PackBlockCode[]
): PackGroundingSummary {
  const blockResults = new Map<PackBlockCode, BlockGroundingResult>();
  let anyUngrounded = false;
  let criticalSafetyFailure = false;
  let mandatoryBlockFailed: PackBlockCode | null = null;

  for (const [code, block] of blocks) {
    const result = validateBlockGrounding(block, ctx, knownSourceIds);
    blockResults.set(code, result);
    if (result.criticalSafetyFailure) criticalSafetyFailure = true;
    if (result.status === 'UNGROUNDED') {
      anyUngrounded = true;
      if (mandatoryBlockCodes.includes(code)) mandatoryBlockFailed = code;
    }
  }

  const overallStatus: 'PASS' | 'PARTIAL' | 'FAIL' = criticalSafetyFailure || mandatoryBlockFailed
    ? 'FAIL'
    : anyUngrounded
      ? 'PARTIAL'
      : 'PASS';

  return { blockResults, overallStatus, criticalSafetyFailure, mandatoryBlockFailed };
}
