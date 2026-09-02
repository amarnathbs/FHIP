// Module 11.3 — Monthly Personalised AI Insight Pack: schema, block codes,
// state machine and identity types (spec sections 7, 9, 20-23, 27-28).
//
// This file defines the CONTRACT the provider's structured output must
// satisfy (validated at runtime, spec section 21) and the persisted shape
// the service writes. Nothing here calls a provider or touches the DB.

import { z } from 'zod';

export const PACK_SCHEMA_VERSION = 'insight-pack-1.0.0';
export const CONTEXT_SCHEMA_VERSION_FOR_PACK = 'ai-context-1.0.0';

// ---------------------------------------------------------------------------
// Pack state machine (spec section 7).
// ---------------------------------------------------------------------------
export const PACK_STATUSES = [
  'PENDING', 'QUEUED', 'GENERATING', 'PROVIDER_COMPLETE', 'VALIDATING',
  'READY', 'PARTIAL', 'FAILED', 'STALE', 'SUPERSEDED', 'CANCELLED',
] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

/**
 * Legal transitions (spec section 7: "Do not allow arbitrary direct
 * transitions"). Enforced in insightPackService.ts's own state-transition
 * helper; the DB additionally enforces the READY/PARTIAL invariants
 * structurally (migration 0121, spec section 107) regardless of what this
 * map allows.
 */
export const LEGAL_PACK_TRANSITIONS: Record<PackStatus, PackStatus[]> = {
  PENDING: ['QUEUED', 'CANCELLED', 'FAILED'],
  QUEUED: ['GENERATING', 'CANCELLED', 'FAILED'],
  GENERATING: ['PROVIDER_COMPLETE', 'FAILED'],
  PROVIDER_COMPLETE: ['VALIDATING', 'FAILED'],
  VALIDATING: ['READY', 'PARTIAL', 'FAILED'],
  READY: ['STALE', 'SUPERSEDED'],
  PARTIAL: ['STALE', 'SUPERSEDED', 'FAILED'],
  FAILED: ['QUEUED'], // one controlled retry (spec section 35)
  STALE: ['SUPERSEDED'],
  SUPERSEDED: [],
  CANCELLED: [],
};

export function isLegalTransition(from: PackStatus, to: PackStatus): boolean {
  return LEGAL_PACK_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Block codes (spec section 20). Every block is OPTIONAL at the schema
// level — "only populate a block when supported by certified source data"
// (spec section 21) — but a small mandatory subset (spec section 51) must
// be present (possibly as a status:'NOT_APPLICABLE'/limitation block, never
// omitted silently) for a pack to reach READY.
// ---------------------------------------------------------------------------
export const PACK_BLOCK_CODES = [
  'overall_financial_summary',
  'score_explanation',
  'score_change_explanation',
  'cash_flow_explanation',
  'savings_explanation',
  'expense_explanation',
  'net_worth_explanation',
  'liquidity_explanation',
  'debt_explanation',
  'asset_concentration_explanation',
  'investment_explanation',
  'retirement_explanation',
  'insurance_explanation',
  'goals_summary',
  'goal_risk_summary',
  'forecast_summary',
  'twin_summary',
  'cross_border_summary',
  'data_quality_summary',
  'strengths',
  'risks',
  'priority_review_areas',
  'monthly_changes',
  'report_reading_summary',
] as const;
export type PackBlockCode = (typeof PACK_BLOCK_CODES)[number];

/** Spec section 51 — required whenever adequate certified inputs exist for them. */
export const MANDATORY_BLOCK_CODES: readonly PackBlockCode[] = [
  'overall_financial_summary',
  'data_quality_summary',
  'strengths',
  'risks',
];

/**
 * Spec section 59 — the initial, deliberately small mapping from a pack
 * block to a Module 11.2 WHY-explanation intent code. Only three intents
 * currently declare STORED_PERSONALISED in their allowed_resolvers
 * (lib/ai/resolution/intentTaxonomy.ts): SCORE_EXPLANATION, DNA_EXPLANATION,
 * RESILIENCE_EXPLANATION. Of those, only `score_explanation` has both a
 * natural pack-block counterpart AND a numeric current_value the stored
 * resolver's snapshot-compatibility check can compare
 * (storedPersonalisedResolver.ts's extractLiveValueForIntent() reads
 * health_score.overall_score for SCORE_EXPLANATION). Wiring DNA/RESILIENCE
 * to an unrelated block (e.g. debt_explanation) would be a dishonest
 * mapping the numeric check was never designed to validate, so only the one
 * genuine, exact mapping is wired here. The full 20-25 question catalogue
 * that would map every remaining block is explicitly Module 11.4 (spec
 * sections 59, 100).
 *
 * MODULE 11.4 UPDATE: the full mapping is now wired, using the additive
 * STANDARD_QUESTION_EXPLANATION_INTENTS declared in
 * lib/ai/resolution/intentTaxonomy.ts (none of which existed when the
 * comment above was written). Nothing about HOW a block reaches
 * ai_insights changes — insightPackService.ts still only feeds this table
 * from a GROUNDED block (spec section 29/59), unchanged — this only adds
 * more (block -> intent) pairs to the same existing loop.
 */
export const BLOCK_INTENT_MAP: ReadonlyMap<PackBlockCode, string> = new Map([
  ['score_explanation', 'SCORE_EXPLANATION'],
  ['overall_financial_summary', 'OVERALL_FINANCIAL_SUMMARY_EXPLANATION'],
  ['strengths', 'STRENGTHS_EXPLANATION'],
  ['priority_review_areas', 'PRIORITY_REVIEW_AREAS_EXPLANATION'],
  ['score_change_explanation', 'SCORE_CHANGE_EXPLANATION'],
  ['cash_flow_explanation', 'CASH_FLOW_EXPLANATION'],
  ['savings_explanation', 'SAVINGS_EXPLANATION'],
  ['expense_explanation', 'EXPENSE_EXPLANATION'],
  ['net_worth_explanation', 'NET_WORTH_EXPLANATION'],
  ['asset_concentration_explanation', 'ASSET_CONCENTRATION_EXPLANATION'],
  ['liquidity_explanation', 'LIQUIDITY_EXPLANATION'],
  ['debt_explanation', 'DEBT_EXPLANATION'],
  ['investment_explanation', 'INVESTMENT_EXPLANATION'],
  ['retirement_explanation', 'RETIREMENT_EXPLANATION'],
  ['insurance_explanation', 'INSURANCE_EXPLANATION'],
  ['goal_risk_summary', 'GOAL_RISK_EXPLANATION'],
  ['forecast_summary', 'FORECAST_SUMMARY_EXPLANATION'],
  ['twin_summary', 'TWIN_SUMMARY_EXPLANATION'],
  ['cross_border_summary', 'CROSS_BORDER_SUMMARY_EXPLANATION'],
  ['data_quality_summary', 'DATA_QUALITY_SUMMARY_EXPLANATION'],
]);

// ---------------------------------------------------------------------------
// Grounding / confidence vocab (spec sections 48, 23).
// ---------------------------------------------------------------------------
export const GROUNDING_STATUSES = ['GROUNDED', 'PARTIALLY_GROUNDED', 'UNGROUNDED', 'NOT_APPLICABLE'] as const;
export type GroundingStatus = (typeof GROUNDING_STATUSES)[number];

export const PACK_CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type PackConfidence = (typeof PACK_CONFIDENCE_LEVELS)[number];

// ---------------------------------------------------------------------------
// Provider output contract (spec sections 22-23, 37, 40) — strict runtime
// schema. A metric_claims entry is the structured hook the grounding
// validator uses instead of scanning prose (spec section 40).
// ---------------------------------------------------------------------------
export const metricClaimSchema = z.object({
  metric_code: z.string().min(1),
  source_value: z.number().nullable(),
  display_value: z.string().min(1).max(200),
  currency: z.string().length(3).nullable().optional(),
});
export type MetricClaim = z.infer<typeof metricClaimSchema>;

export const sourceRefClaimSchema = z.object({
  source_type: z.string().min(1),
  source_id: z.string().min(1),
});

export const packBlockSchema = z
  .object({
    block_code: z.enum(PACK_BLOCK_CODES),
    status: z.enum(['POPULATED', 'UNAVAILABLE', 'PARTIAL']),
    headline: z.string().max(200).optional().default(''),
    short_answer: z.string().max(400).optional().default(''),
    explanation: z.string().max(1200).optional().default(''),
    why_it_matters: z.string().max(500).optional().default(''),
    metric_claims: z.array(metricClaimSchema).max(20).optional().default([]),
    source_refs: z.array(sourceRefClaimSchema).max(20).optional().default([]),
    limitations: z.array(z.string().max(300)).max(10).optional().default([]),
    confidence: z.enum(PACK_CONFIDENCE_LEVELS).optional().default('MEDIUM'),
    data_as_of: z.string().nullable().optional().default(null),
    related_module: z.string().nullable().optional().default(null),
    action_route: z.string().nullable().optional().default(null),
  })
  .strict();
export type ProviderPackBlock = z.infer<typeof packBlockSchema>;

export const packEnvelopeSchema = z
  .object({
    pack_version: z.literal(PACK_SCHEMA_VERSION),
    snapshot_id: z.string().min(1),
    data_as_of: z.string().nullable(),
    reporting_currency: z.enum(['AUD', 'INR']),
    overall_confidence: z.enum(PACK_CONFIDENCE_LEVELS),
    blocks: z.record(z.enum(PACK_BLOCK_CODES), packBlockSchema),
    top_strengths: z.array(z.string().max(300)).max(3),
    top_risks: z.array(z.string().max(300)).max(3),
    priority_review_areas: z.array(z.string().max(300)).max(3),
    limitations: z.array(z.string().max(300)).max(20),
  })
  .strict();
export type ProviderPackEnvelope = z.infer<typeof packEnvelopeSchema>;

export type PackValidationOutcome =
  | { ok: true; envelope: ProviderPackEnvelope }
  | { ok: false; reason: string };

/** Spec sections 37/79 — reject invalid JSON / wrong schema before any grounding check runs. */
export function validateProviderPackResponse(rawText: string): PackValidationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'Provider pack response was not valid JSON.' };
  }
  const result = packEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `Pack schema validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  return { ok: true, envelope: result.data };
}

// ---------------------------------------------------------------------------
// Persisted block (what the service actually writes to
// ai_insight_pack_blocks, after grounding validation — spec section 58:
// "Persist ONLY validated output").
// ---------------------------------------------------------------------------
export interface PersistedPackBlock {
  block_code: PackBlockCode;
  status: GroundingStatus;
  headline: string | null;
  short_answer: string | null;
  explanation: string | null;
  why_it_matters: string | null;
  source_refs_json: { source_type: string; source_id: string }[];
  source_metric_codes: string[];
  confidence: PackConfidence | null;
  data_as_of: string | null;
  limitations_json: string[];
  related_module: string | null;
  action_route: string | null;
  safety_classification: string | null;
  block_order: number;
  violations_json: string[];
}

// ---------------------------------------------------------------------------
// Pack identity (spec section 9).
// ---------------------------------------------------------------------------
export interface PackIdentity {
  userId: string;
  snapshotId: string;
  financialContextHash: string;
  contextSchemaVersion: string;
  packSchemaVersion: string;
  promptCode: string;
  promptVersion: number;
  countryContext: string | null;
  language: string;
}
