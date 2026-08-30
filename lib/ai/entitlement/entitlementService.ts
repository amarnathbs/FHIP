// Module 11.1 — server-side AI entitlement enforcement.
//
// This module is the ONLY application-side entry point to the admission
// decision, and it does almost nothing itself on purpose: every actual check
// (kill switch, Premium tier, rate limit, cost ceilings, monthly allowance)
// and the consumption of quota happen inside ONE SECURITY DEFINER RPC,
// ai_admit_request(), in a single transaction under advisory locks.
//
// Why not do the checks here. A check in application code followed by a write
// in application code is a check-then-act race: two concurrent requests can
// both read "1 question remaining" and both proceed. This codebase has already
// established the alternative discipline (Admin A0.2's
// admin_upsert_recommendation_atomic, FDH-12's compare-and-swap apply
// function), and Module 11.1 follows it.
//
// SERVER-SIDE ONLY. Every call runs through the service-role client, which is
// unreachable from a browser. No part of the decision is ever supplied by, or
// negotiable with, a client: the caller identity comes from the server
// session, the cost estimate from the cost estimator, and the cache-hit flag
// from a server-side ai_answer_cache lookup. The RPC additionally refuses to
// admit a request for anyone other than auth.uid() if it is ever reached from
// an authenticated session.
//
// FAIL CLOSED. If the RPC errors, is unreachable, or returns anything this
// module cannot interpret, the result is a denial ('enforcement_unavailable'),
// never an allow. An enforcement layer that opens when it breaks is not an
// enforcement layer.

import { createAdminClient } from '@/lib/supabase/admin';
import type {
  AdmissionRequest,
  AdmissionResult,
  AdmissionDenyReason,
  EntitlementGate,
} from '@/lib/ai/entitlement/types';

const KNOWN_DENY_REASONS: ReadonlySet<string> = new Set<AdmissionDenyReason>([
  'invalid_request',
  'invalid_request_class',
  'cost_estimate_unavailable',
  'controls_unavailable',
  'entitlement_unknown',
  'model_tier_unknown',
  'enforcement_unavailable',
  'ai_disabled',
  'kill_switch_active',
  'not_premium',
  'quota_exhausted',
  'rate_limited',
  'request_cost_limit',
  'model_tier_exceeds_task_limit',
  'task_monthly_cost_limit',
  'user_cost_ceiling',
  'platform_cost_ceiling',
]);

function denied(reason: AdmissionDenyReason, enforcementError: string | null = null): AdmissionResult {
  return {
    allowed: false,
    denyReason: reason,
    admissionId: null,
    billingPeriod: null,
    planTier: null,
    quotaConsumed: false,
    quotaAllowance: null,
    quotaUsed: null,
    quotaRemaining: null,
    rateLimitUsed: null,
    rateLimitMax: null,
    rateLimitWindowSeconds: null,
    userCostUsedUsd: null,
    userCostCeilingUsd: null,
    platformCostUsedUsd: null,
    platformCostCeilingUsd: null,
    estimatedCostUsd: null,
    enforcementError,
  };
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Translates the RPC's JSON verdict into the typed result. Anything
 * unrecognised is treated as a denial rather than coerced into an allow —
 * including an `allowed: true` carrying a deny reason, which would mean the
 * two layers disagree about what happened.
 */
export function interpretAdmissionPayload(payload: unknown): AdmissionResult {
  if (!payload || typeof payload !== 'object') {
    return denied('enforcement_unavailable', 'Admission RPC returned no verdict.');
  }
  const row = payload as Record<string, unknown>;

  if (row.allowed !== true && row.allowed !== false) {
    return denied('enforcement_unavailable', 'Admission RPC returned a verdict with no boolean `allowed` field.');
  }

  const rawReason = typeof row.deny_reason === 'string' ? row.deny_reason : null;
  if (rawReason !== null && !KNOWN_DENY_REASONS.has(rawReason)) {
    return denied('enforcement_unavailable', `Admission RPC returned an unrecognised deny_reason: ${rawReason}`);
  }
  if (row.allowed === true && rawReason !== null) {
    return denied('enforcement_unavailable', 'Admission RPC returned allowed=true with a deny reason set.');
  }
  if (row.allowed === false && rawReason === null) {
    return denied('enforcement_unavailable', 'Admission RPC returned allowed=false with no deny reason.');
  }

  return {
    allowed: row.allowed === true,
    denyReason: rawReason as AdmissionDenyReason | null,
    admissionId: typeof row.admission_id === 'string' ? row.admission_id : null,
    billingPeriod: typeof row.billing_period === 'string' ? row.billing_period : null,
    planTier: typeof row.plan_tier === 'string' ? row.plan_tier : null,
    quotaConsumed: row.quota_consumed === true,
    quotaAllowance: num(row.quota_allowance),
    quotaUsed: num(row.quota_used),
    quotaRemaining: num(row.quota_remaining),
    rateLimitUsed: num(row.rate_limit_used),
    rateLimitMax: num(row.rate_limit_max),
    rateLimitWindowSeconds: num(row.rate_limit_window_seconds),
    userCostUsedUsd: num(row.user_cost_used_usd),
    userCostCeilingUsd: num(row.user_cost_ceiling_usd),
    platformCostUsedUsd: num(row.platform_cost_used_usd),
    platformCostCeilingUsd: num(row.platform_cost_ceiling_usd),
    estimatedCostUsd: num(row.estimated_cost_usd),
    enforcementError: null,
  };
}

/**
 * Runs the atomic admission decision. Consumes one unit of the monthly
 * allowance if and only if the request is class 'custom', is not a cache hit,
 * and passes every check.
 */
export async function admitAiRequest(request: AdmissionRequest): Promise<AdmissionResult> {
  // Local validation only rejects — it never approves anything, and it never
  // substitutes a default. Every one of these is re-checked in the RPC, which
  // remains the authority.
  if (!request.userId) return denied('invalid_request', 'No user id supplied to the entitlement gate.');
  if (request.requestClass !== 'custom' && request.requestClass !== 'standard') {
    return denied('invalid_request_class', 'Request class must be declared as "custom" or "standard".');
  }
  if (typeof request.estimatedCostUsd !== 'number' || !Number.isFinite(request.estimatedCostUsd) || request.estimatedCostUsd < 0) {
    return denied('cost_estimate_unavailable', 'No usable cost estimate was available for this request.');
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    // Misconfigured environment (missing service-role key). Deny.
    return denied('enforcement_unavailable', err instanceof Error ? err.message : 'Service-role client unavailable.');
  }

  try {
    const { data, error } = await admin.rpc('ai_admit_request', {
      p_user_id: request.userId,
      p_household_id: request.householdId,
      p_request_class: request.requestClass,
      p_task_type: request.taskType,
      p_provider: request.provider,
      p_model: request.model,
      p_internal_tier: request.internalTier,
      p_estimated_cost_usd: request.estimatedCostUsd,
      p_cache_hit: request.cacheHit,
    });
    if (error) return denied('enforcement_unavailable', error.message);
    return interpretAdmissionPayload(data);
  } catch (err) {
    return denied('enforcement_unavailable', err instanceof Error ? err.message : 'Admission RPC threw.');
  }
}

/**
 * Returns one consumed allowance unit after a provider call produced no
 * usable answer. Best-effort by design: a failed refund must never turn a
 * provider failure into a thrown error on an already-failing path, so it
 * reports false rather than throwing. The question stays consumed in that
 * case — the conservative direction, since the alternative (assuming a refund
 * that did not happen) would over-grant allowance.
 */
export async function refundAiAdmission(admissionId: string): Promise<boolean> {
  if (!admissionId) return false;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('ai_refund_admission', { p_admission_id: admissionId });
    if (error) return false;
    return Boolean((data as { refunded?: boolean } | null)?.refunded);
  } catch {
    return false;
  }
}

/** The production gate. Used by AIModelGateway unless a test injects its own. */
export const dbEntitlementGate: EntitlementGate = {
  admit: admitAiRequest,
  refund: refundAiAdmission,
};
