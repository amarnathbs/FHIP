// Module 11.1 — entitlement/quota/cost-control contract types.

import type { AITaskType } from '@/lib/ai/providers/types';
import type { ModelTier } from '@/lib/ai/modelRegistry';

/**
 * The two request classes the enforcement layer distinguishes.
 *
 *  'custom'   — a user-initiated custom AI question. Premium-only, and
 *               metered against the monthly allowance (unless served from
 *               cache). This is the class the kill switch stops.
 *  'standard' — system-generated personalised content (a score explanation
 *               rendered on a dashboard, a monthly summary produced on a
 *               schedule). NOT metered against the allowance. Still subject
 *               to rate limits, cost ceilings and the global AI switch.
 *
 * A future consumer MUST declare which it is making; there is no default,
 * because guessing wrong in either direction is a real failure (silently
 * burning a user's allowance, or silently giving away unmetered custom AI).
 */
export type AIRequestClass = 'custom' | 'standard';

/**
 * Every reason the enforcement layer can refuse a request. Kept as a closed
 * union so a new denial path cannot be added without the type system
 * noticing, and mirrored exactly by the deny_reason strings produced by
 * ai_admit_request().
 */
export type AdmissionDenyReason =
  // input / integrity — the fail-closed cases
  | 'invalid_request'
  | 'invalid_request_class'
  | 'invalid_usage_outcome'
  | 'cost_estimate_unavailable'
  | 'controls_unavailable'
  | 'entitlement_unknown'
  | 'model_tier_unknown'
  | 'model_unknown'
  | 'token_budget_unavailable'
  | 'enforcement_unavailable'
  // kill switches (spec section 29/30/31/32)
  | 'ai_disabled'
  | 'kill_switch_active'
  | 'live_provider_disabled'
  | 'batch_disabled'
  | 'scenario_disabled'
  | 'provider_disabled'
  | 'model_disabled'
  // commercial
  | 'not_premium'
  | 'quota_exhausted'
  // abuse / spend
  | 'rate_limited'
  | 'request_in_progress'
  | 'idempotency_conflict'
  | 'token_budget_exceeded'
  | 'request_cost_limit'
  | 'model_tier_exceeds_task_limit'
  | 'task_monthly_cost_limit'
  | 'provider_cost_limit'
  | 'daily_cost_limit'
  | 'user_cost_ceiling'
  | 'platform_cost_ceiling';

/**
 * Spec section 16 — how an answer was (or would have been) served. Declared
 * now, before semantic caching exists (phase 11.8) and before the
 * deterministic router exists (phase 11.2), so that the usage-accounting
 * contract those phases depend on is fixed rather than retrofitted.
 *
 * Only LIVE_AI can consume the monthly allowance. That is enforced in the
 * database by a CHECK constraint on ai_admission_events, not merely by the
 * convention below, and BATCH_AI carries a second CHECK making it structurally
 * incapable of consuming quota (spec section 16: "BATCH_AI must never consume
 * it").
 */
export type AIUsageOutcome =
  | 'DETERMINISTIC'
  | 'KNOWLEDGE_BASE'
  | 'STANDARD_PERSONALISED'
  | 'EXACT_CACHE'
  | 'SEMANTIC_CACHE'
  | 'LIVE_AI'
  | 'BATCH_AI'
  | 'ADMIN_EVALUATION';

export const AI_USAGE_OUTCOMES: readonly AIUsageOutcome[] = [
  'DETERMINISTIC', 'KNOWLEDGE_BASE', 'STANDARD_PERSONALISED',
  'EXACT_CACHE', 'SEMANTIC_CACHE', 'LIVE_AI', 'BATCH_AI', 'ADMIN_EVALUATION',
] as const;

/** Spec section 16: exactly one outcome consumes the user's allowance. */
export function outcomeConsumesQuota(outcome: AIUsageOutcome, requestClass: AIRequestClass): boolean {
  return outcome === 'LIVE_AI' && requestClass === 'custom';
}

/** Outcomes that cause a provider to be invoked, and therefore cost real money. */
export function outcomeReachesProvider(outcome: AIUsageOutcome): boolean {
  return outcome === 'LIVE_AI' || outcome === 'STANDARD_PERSONALISED'
    || outcome === 'BATCH_AI' || outcome === 'ADMIN_EVALUATION';
}

/** Spec section 14: the reservation lifecycle state of one admission. */
export type AdmissionExecutionState = 'reserved' | 'finalised' | 'released';

export interface AdmissionRequest {
  userId: string;
  householdId: string | null;
  requestClass: AIRequestClass;
  taskType: AITaskType;
  provider: string;
  model: string;
  /** The model's ai_model_registry.internal_tier. Required wherever a task tier cap applies; a missing tier denies rather than defaults. */
  internalTier: ModelTier | null;
  /** Pre-flight cost projection in USD. Must come from the cost estimator, never from a client. */
  estimatedCostUsd: number;
  /**
   * True only when the answer is being served from ai_answer_cache. MUST be
   * derived server-side (see lib/ai/cache/answerCache.ts) and must never be
   * taken from a request body — it is the one input that suppresses quota
   * consumption.
   */
  cacheHit: boolean;
  /**
   * Spec section 16. Optional: when omitted the RPC DERIVES it from
   * requestClass + cacheHit rather than defaulting to the cheapest or the most
   * permissive value. Supplying it explicitly is preferred for any caller that
   * knows (e.g. a batch job declaring BATCH_AI).
   */
  usageOutcome?: AIUsageOutcome;
  /**
   * Spec section 15. A caller-supplied retry key. Two requests with the same
   * key from the same subject are the SAME logical request: the second
   * replays the first's verdict and consumes nothing further.
   */
  idempotencyKey?: string | null;
  /**
   * Spec section 15. A hash of the request body. Stored with the idempotency
   * key so a key reused with a DIFFERENT body is detected as a collision
   * rather than answered with the wrong request's verdict.
   */
  requestHash?: string | null;
  /** Spec section 20 — projected total context/input tokens. Required for any provider-bound request; absent means "unverifiable", which denies. */
  contextTokens?: number | null;
  /** Spec section 20 — tokens attributable to free-form user input specifically. */
  userInputTokens?: number | null;
  /** Spec section 21 — the output token cap this request will impose on the provider. */
  outputTokens?: number | null;
}

export interface AdmissionResult {
  allowed: boolean;
  denyReason: AdmissionDenyReason | null;
  /** Null when the decision could not be recorded (i.e. enforcement itself failed). Needed to refund. */
  admissionId: string | null;
  billingPeriod: string | null;
  planTier: string | null;
  quotaConsumed: boolean;
  quotaAllowance: number | null;
  quotaUsed: number | null;
  quotaRemaining: number | null;
  rateLimitUsed: number | null;
  rateLimitMax: number | null;
  rateLimitWindowSeconds: number | null;
  userCostUsedUsd: number | null;
  userCostCeilingUsd: number | null;
  platformCostUsedUsd: number | null;
  platformCostCeilingUsd: number | null;
  estimatedCostUsd: number | null;
  /** Spec section 16 — the accounting outcome the decision was made under. */
  usageOutcome: AIUsageOutcome | null;
  /** Spec section 14 — 'reserved' means a provider call is expected to follow and must be finalised or released. */
  executionState: AdmissionExecutionState | null;
  /**
   * Spec section 15 — true when this verdict is a REPLAY of an earlier
   * admission with the same idempotency key. A replayed `allowed: true` means
   * "your earlier execution already holds this credit", NOT "start a second
   * provider call", so the gateway must not execute against it.
   */
  idempotencyReuse: boolean;
  concurrencyActive: number | null;
  concurrencyMax: number | null;
  /** Spec section 27 — soft thresholds crossed by this (still-allowed) request. Operational signal only. */
  softThresholdsCrossed: string[];
  /** Populated only when enforcement itself failed (denyReason 'enforcement_unavailable'). */
  enforcementError: string | null;
}

/**
 * The seam the gateway depends on. Production uses the DB-backed
 * implementation; tests inject a stub. Deliberately narrow: the gateway must
 * not be able to inspect or reinterpret the decision, only obey it.
 */
export interface EntitlementGate {
  admit(request: AdmissionRequest): Promise<AdmissionResult>;
  /** Returns a consumed allowance unit when the call it paid for produced no answer, and releases the reservation. */
  refund(admissionId: string): Promise<boolean>;
  /**
   * Spec section 14 — closes the reservation after a valid answer was
   * delivered. Consumed quota stands; the concurrency lease is released so the
   * subject is not blocked until their lease expires.
   */
  finalise(admissionId: string): Promise<boolean>;
}

/** Human-readable text safe to surface to an end user. Never leaks ceilings, platform totals, or other users' data. */
export const DENY_REASON_MESSAGES: Record<AdmissionDenyReason, string> = {
  invalid_request: 'This AI request was malformed and could not be processed.',
  invalid_request_class: 'This AI request did not declare a valid request type.',
  invalid_usage_outcome: 'This AI request did not declare a valid response type.',
  cost_estimate_unavailable: 'AI is temporarily unavailable because the cost of this request could not be determined.',
  controls_unavailable: 'AI is temporarily unavailable.',
  entitlement_unknown: 'Your plan could not be confirmed, so AI features are unavailable right now.',
  model_tier_unknown: 'AI is temporarily unavailable because no approved model could be confirmed for this request.',
  model_unknown: 'AI is temporarily unavailable because no approved model could be confirmed for this request.',
  token_budget_unavailable: 'AI is temporarily unavailable because the size of this request could not be determined.',
  enforcement_unavailable: 'AI is temporarily unavailable.',
  ai_disabled: 'AI features are temporarily switched off.',
  kill_switch_active: 'Custom AI questions are temporarily switched off.',
  live_provider_disabled: 'AI features are temporarily switched off.',
  batch_disabled: 'AI features are temporarily switched off.',
  scenario_disabled: 'AI features are temporarily switched off.',
  provider_disabled: 'AI features are temporarily unavailable. Please try again later.',
  model_disabled: 'AI is temporarily unavailable for this request type.',
  not_premium: 'Custom AI questions are a Premium feature.',
  quota_exhausted: 'You have used all of your custom AI questions for this billing month. Your allowance resets at the start of the next month.',
  rate_limited: 'You are sending AI requests too quickly. Please wait a little while and try again.',
  request_in_progress: 'You already have an AI request in progress. Please wait for it to finish.',
  idempotency_conflict: 'This request could not be retried because it did not match the original request.',
  token_budget_exceeded: 'This request was too large to process.',
  request_cost_limit: 'This request was too large to process.',
  model_tier_exceeds_task_limit: 'AI is temporarily unavailable for this request type.',
  task_monthly_cost_limit: 'AI is temporarily unavailable for this request type.',
  provider_cost_limit: 'AI features are temporarily unavailable. Please try again later.',
  daily_cost_limit: 'AI features are temporarily unavailable. Please try again later.',
  user_cost_ceiling: 'You have reached your AI usage limit for this billing month.',
  platform_cost_ceiling: 'AI features are temporarily unavailable. Please try again later.',
};

/**
 * Spec section 19 — the closed set of structured error codes an API surface
 * may return. The INTERNAL deny reasons above are deliberately more granular
 * than this; mapping through here is what stops an API response from telling a
 * caller which specific ceiling, provider, model or kill switch stopped them
 * (spec sections 7, 19 and 61 all forbid exposing that).
 */
export type PublicAIErrorCode =
  | 'premium_required'
  | 'custom_question_limit_reached'
  | 'rate_limit_reached'
  | 'request_in_progress'
  | 'ai_temporarily_disabled'
  | 'cost_limit_reached'
  | 'provider_unavailable'
  | 'invalid_request';

export const PUBLIC_ERROR_CODE: Record<AdmissionDenyReason, PublicAIErrorCode> = {
  // Anything the caller could fix by changing their request.
  invalid_request: 'invalid_request',
  invalid_request_class: 'invalid_request',
  invalid_usage_outcome: 'invalid_request',
  idempotency_conflict: 'invalid_request',
  token_budget_exceeded: 'invalid_request',
  request_cost_limit: 'invalid_request',

  // Commercial.
  not_premium: 'premium_required',
  quota_exhausted: 'custom_question_limit_reached',

  // Abuse controls.
  rate_limited: 'rate_limit_reached',
  request_in_progress: 'request_in_progress',

  // Every kill switch collapses to one code. A user learning WHICH switch is
  // off (global? custom-only? this provider? this model?) is a map of our
  // operational posture, and section 7 forbids exposing kill-switch reasons.
  ai_disabled: 'ai_temporarily_disabled',
  kill_switch_active: 'ai_temporarily_disabled',
  live_provider_disabled: 'ai_temporarily_disabled',
  batch_disabled: 'ai_temporarily_disabled',
  scenario_disabled: 'ai_temporarily_disabled',

  // Every cost ceiling collapses to one code, for the same reason: which
  // ceiling was hit (theirs? a task's? a provider's? the platform's?) reveals
  // internal cost configuration.
  user_cost_ceiling: 'cost_limit_reached',
  task_monthly_cost_limit: 'cost_limit_reached',
  provider_cost_limit: 'cost_limit_reached',
  daily_cost_limit: 'cost_limit_reached',
  platform_cost_ceiling: 'cost_limit_reached',

  // Infrastructure/config problems the user can neither see nor fix.
  provider_disabled: 'provider_unavailable',
  model_disabled: 'provider_unavailable',
  model_unknown: 'provider_unavailable',
  model_tier_unknown: 'provider_unavailable',
  model_tier_exceeds_task_limit: 'provider_unavailable',
  controls_unavailable: 'ai_temporarily_disabled',
  cost_estimate_unavailable: 'ai_temporarily_disabled',
  token_budget_unavailable: 'ai_temporarily_disabled',
  enforcement_unavailable: 'ai_temporarily_disabled',

  // Section 62: an entitlement we could not determine denies, and it denies as
  // "temporarily disabled" rather than "premium_required" — telling a user to
  // upgrade because our own database was unreachable would be a false upsell.
  entitlement_unknown: 'ai_temporarily_disabled',
};

/**
 * Spec section 19: "Retry timing only where safe/meaningful." A retry hint is
 * meaningful for a rolling-window rate limit and for an in-flight request. It
 * is NOT given for quota exhaustion (the wait is up to a month and the real
 * answer is "next billing period"), and never for a cost ceiling or a kill
 * switch, where the hint would leak how long an operational problem is
 * expected to last.
 */
export function retryAfterSecondsFor(reason: AdmissionDenyReason, rateLimitWindowSeconds: number | null): number | null {
  if (reason === 'rate_limited') return rateLimitWindowSeconds && rateLimitWindowSeconds > 0 ? rateLimitWindowSeconds : null;
  if (reason === 'request_in_progress') return 5;
  return null;
}
