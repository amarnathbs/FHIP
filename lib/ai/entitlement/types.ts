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
  | 'cost_estimate_unavailable'
  | 'controls_unavailable'
  | 'entitlement_unknown'
  | 'model_tier_unknown'
  | 'enforcement_unavailable'
  // kill switches
  | 'ai_disabled'
  | 'kill_switch_active'
  // commercial
  | 'not_premium'
  | 'quota_exhausted'
  // abuse / spend
  | 'rate_limited'
  | 'request_cost_limit'
  | 'model_tier_exceeds_task_limit'
  | 'task_monthly_cost_limit'
  | 'user_cost_ceiling'
  | 'platform_cost_ceiling';

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
  /** Returns a consumed allowance unit when the call it paid for produced no answer. */
  refund(admissionId: string): Promise<boolean>;
}

/** Human-readable text safe to surface to an end user. Never leaks ceilings, platform totals, or other users' data. */
export const DENY_REASON_MESSAGES: Record<AdmissionDenyReason, string> = {
  invalid_request: 'This AI request was malformed and could not be processed.',
  invalid_request_class: 'This AI request did not declare a valid request type.',
  cost_estimate_unavailable: 'AI is temporarily unavailable because the cost of this request could not be determined.',
  controls_unavailable: 'AI is temporarily unavailable.',
  entitlement_unknown: 'Your plan could not be confirmed, so AI features are unavailable right now.',
  model_tier_unknown: 'AI is temporarily unavailable because no approved model could be confirmed for this request.',
  enforcement_unavailable: 'AI is temporarily unavailable.',
  ai_disabled: 'AI features are temporarily switched off.',
  kill_switch_active: 'Custom AI questions are temporarily switched off.',
  not_premium: 'Custom AI questions are a Premium feature.',
  quota_exhausted: 'You have used all of your custom AI questions for this billing month. Your allowance resets at the start of the next month.',
  rate_limited: 'You are sending AI requests too quickly. Please wait a little while and try again.',
  request_cost_limit: 'This request was too large to process.',
  model_tier_exceeds_task_limit: 'AI is temporarily unavailable for this request type.',
  task_monthly_cost_limit: 'AI is temporarily unavailable for this request type.',
  user_cost_ceiling: 'You have reached your AI usage limit for this billing month.',
  platform_cost_ceiling: 'AI features are temporarily unavailable. Please try again later.',
};
