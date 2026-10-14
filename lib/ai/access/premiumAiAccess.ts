/**
 * Premium AI access -- the ONE shared decision for "may this signed-in person
 * start a NEW chargeable AI operation right now?" (Product Owner instruction
 * 14-10-2026, replacing the two-e-mail AIE pilot restriction).
 *
 * POLICY (and nothing else)
 *   allowed  <=>  the user has an ACTIVE Premium entitlement TODAY
 *   denied   <=>  anything else: Free, never subscribed, expired or not yet
 *                 started, an unknown tier value, or an entitlement that
 *                 could not be read at all.
 *
 * WHAT "ACTIVE PREMIUM" MEANS -- there is no second subscription system.
 * This module reads the same single source every other Premium consumer reads:
 * `user_entitlements` (plan_tier + the effective_from / effective_to window),
 * evaluated by the same pure predicate (`effectivePlanTier`) that report export,
 * the recommendations page and the SQL AI functions (`ai_entitlement_state`,
 * `ai_admit_request`, migration 0115) mirror. The billing webhook
 * (`lib/services/payments/entitlementSync.ts`) is what turns a trial, a
 * past-due grace period and a cancel-at-period-end subscription into that row,
 * and admin grants / promo codes write the same row, so every one of those
 * cases is honoured here without this file knowing about any of them.
 *
 * WHAT IT NEVER DOES
 *   - It never looks at an e-mail address, a user-id list, an environment
 *     allowlist, or whether the user is in a former pilot. Pilot membership
 *     neither grants nor denies anything.
 *   - It never treats an Admin / Super Admin / Analyst role as Premium. Admin
 *     status is not an entitlement; a staff member who wants consumer Premium
 *     features needs a consumer Premium entitlement like anyone else.
 *   - It never trusts a caller-supplied Premium flag, user id or tenant: the
 *     caller passes the id of the AUTHENTICATED session user, and this reads
 *     the entitlement itself, server-side, with the service-role client.
 *   - It never caches. Every call reads the row, so an upgrade is visible on
 *     the next request and a downgrade / expiry stops NEW execution on the next
 *     request -- there is no cache to invalidate, which is the safest answer
 *     to "refresh entitlement caches on upgrade/downgrade".
 *
 * FAIL CLOSED. A read error, a missing service-role key or a malformed row is
 * `entitlement_unavailable` -- a denial that deliberately does NOT offer an
 * upgrade (an outage is not something the user can pay to fix), never an allow.
 *
 * WHAT THIS IS NOT. It is the entitlement half of the access decision. The
 * feature kill switches, the per-feature flags, quota, rate limit and the cost
 * budget are separate, unchanged controls that run after (or alongside) it; a
 * Premium user is still refused when a kill switch is off or the spend cap is
 * exhausted. Work already underway (a draft the user is reviewing, a document
 * already extracted) follows its existing lifecycle: only the START of a new
 * chargeable operation consults this.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { effectivePlanTier, utcToday, type EntitlementWindowRow } from '@/lib/services/entitlementWindow';
import { recordAiMetric } from '@/lib/ai/observability/aiMetrics';

export type PremiumAiDenyReason =
  /** Free, never subscribed, lapsed/expired, or not-yet-started window. The user may upgrade. */
  | 'premium_required'
  /** The entitlement could not be determined. Fail closed; no upgrade prompt. */
  | 'entitlement_unavailable';

export type PremiumAiDecision =
  | { allowed: true; planTier: 'premium' }
  | { allowed: false; reason: PremiumAiDenyReason; upgradeAvailable: boolean };

/** Result of reading one entitlement row. `error` set means "could not read". */
export interface EntitlementReadResult {
  row: EntitlementWindowRow | null;
  error: string | null;
}

export interface PremiumAiAccessDeps {
  /** Test seam. Defaults to the service-role read of `user_entitlements`. */
  readEntitlement?: (userId: string) => Promise<EntitlementReadResult>;
  /** Test seam. Defaults to the UTC calendar date, as the SQL functions use. */
  today?: string;
}

async function readEntitlementRow(userId: string): Promise<EntitlementReadResult> {
  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return { row: null, error: e instanceof Error ? e.message : 'service-role client unavailable' };
  }
  try {
    const { data, error } = await admin
      .from('user_entitlements')
      .select('plan_tier, effective_from, effective_to')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return { row: null, error: error.message };
    return { row: (data ?? null) as EntitlementWindowRow | null, error: null };
  } catch (e) {
    return { row: null, error: e instanceof Error ? e.message : 'entitlement read threw' };
  }
}

function deny(reason: PremiumAiDenyReason, capability: string): PremiumAiDecision {
  recordAiMetric('ai_entitlement_denied', { reason, capability });
  return { allowed: false, reason, upgradeAvailable: reason === 'premium_required' };
}

/**
 * The shared decision. `userId` MUST be the authenticated session user's id --
 * never a value taken from a request body, query string or header.
 *
 * @param capability a short, non-identifying label for metrics only
 *        (e.g. 'aie_fallback_bank_statement'); it never changes the decision.
 */
export async function resolvePremiumAiAccess(
  userId: string,
  capability: string,
  deps: PremiumAiAccessDeps = {},
): Promise<PremiumAiDecision> {
  if (typeof userId !== 'string' || userId.trim().length === 0) return deny('entitlement_unavailable', capability);

  let read: EntitlementReadResult;
  try {
    read = await (deps.readEntitlement ?? readEntitlementRow)(userId);
  } catch {
    // A reader that throws is an unreadable entitlement: deny, never allow.
    return deny('entitlement_unavailable', capability);
  }
  if (read.error) return deny('entitlement_unavailable', capability);

  // effectivePlanTier already resolves a missing row, an unknown tier value and
  // an expired / not-yet-started window to 'free' (the fail-closed direction).
  const tier = effectivePlanTier(read.row, deps.today ?? utcToday());
  if (tier !== 'premium') return deny('premium_required', capability);

  recordAiMetric('ai_entitlement_allowed', { capability });
  return { allowed: true, planTier: 'premium' };
}

/** Plain-English, user-facing wording for a denial. Contains no internal flag, provider or limit. */
export function premiumAiDeniedMessage(reason: PremiumAiDenyReason): string {
  return reason === 'premium_required'
    ? 'AI-assisted document reading is a Premium feature. You can still enter this information manually, or upgrade to Premium to have it read for you.'
    : 'We could not confirm your plan just now, so AI-assisted reading is unavailable. Please try again in a moment, or enter this information manually.';
}

/**
 * The denial a protected API route returns. 403 for "not entitled", 503 for "we
 * could not tell" -- both explicit denials, never an empty success. The body
 * shape matches `requireAIEntitlement()`'s so clients handle one shape.
 */
export function premiumAiDeniedResponse(decision: Extract<PremiumAiDecision, { allowed: false }>): Response {
  return Response.json(
    {
      error: premiumAiDeniedMessage(decision.reason),
      data: {
        allowed: false,
        reason: decision.reason,
        upgrade_available: decision.upgradeAvailable,
      },
    },
    { status: decision.reason === 'premium_required' ? 403 : 503 },
  );
}

/**
 * Route convenience: returns a Response to send back when the user may not
 * start a new AI operation, or null when they may.
 */
export async function refuseUnlessPremiumAi(
  userId: string,
  capability: string,
  deps: PremiumAiAccessDeps = {},
): Promise<Response | null> {
  const decision = await resolvePremiumAiAccess(userId, capability, deps);
  return decision.allowed ? null : premiumAiDeniedResponse(decision);
}
