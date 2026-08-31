// Module 11.1 — AIEntitlementService (spec section 5).
//
// The server-authoritative READ model for "what is this subject entitled to".
// Deliberately separate from entitlementService.ts, which owns the WRITE-side
// admission decision (check-and-consume). Keeping them apart matters:
//
//   * this module answers questions and never consumes anything, so it is
//     safe to call from a GET route; and
//   * nothing here is ever the authority for whether a request may proceed.
//     Every protected AI path calls ai_admit_request() and obeys THAT, even
//     if it has already called this service. Section 5: "Client never
//     authoritative; frontend display informational only; every protected
//     future AI endpoint independently verifies entitlement server-side."
//
// A stale or optimistic read here can therefore never admit a request. The
// worst it can do is display a number that a subsequent admission decision
// disagrees with — which is exactly the "informational only" contract.
//
// SUBJECT OWNERSHIP (spec section 11) — verified against the real schema, not
// assumed. `user_entitlements.user_id` is UNIQUE, so entitlement is per USER.
// `households.user_id` means a household is OWNED by exactly one user, and
// `household_members` rows are name/relationship records, NOT authenticated
// accounts — there is no mechanism in this codebase for two authenticated
// adults to share one household. The entitlement subject is therefore the
// USER, and quota cannot be multiplied by switching household_id: the RPC
// keys the ledger, the rate-limit window and the concurrency lease on
// user_id, and takes household_id only as a descriptive attribute it never
// makes a decision from.

import { createAdminClient } from '@/lib/supabase/admin';
import { AI_COACH_PREMIUM, resolveAICapabilities, type AICapabilitySet } from '@/lib/ai/entitlement/capabilities';
import type { PlanTier } from '@/lib/services/entitlements';

export type AIEligibilityReason =
  | 'premium_required'
  | 'entitlement_unknown'
  | 'ai_temporarily_disabled'
  | 'ai_unavailable';

export interface AIAllowancePeriod {
  billingPeriod: string;
  periodStart: string;
  periodEnd: string;
}

export interface AIPlanEntitlement {
  eligible: boolean;
  reason: AIEligibilityReason | null;
  upgradeAvailable: boolean;
  planFeature: typeof AI_COACH_PREMIUM;
  period: AIAllowancePeriod;
  customQuestions: { limit: number; used: number; remaining: number };
}

/**
 * The fail-closed denial returned whenever entitlement genuinely cannot be
 * determined. Note it reports `upgradeAvailable: false`: a database we could
 * not read is not a problem the user can pay to fix, and prompting an upgrade
 * on our own outage would be a false upsell.
 */
function unavailable(reason: AIEligibilityReason, period: AIAllowancePeriod): AIPlanEntitlement {
  return {
    eligible: false,
    reason,
    upgradeAvailable: false,
    planFeature: AI_COACH_PREMIUM,
    period,
    customQuestions: { limit: 0, used: 0, remaining: 0 },
  };
}

function periodFromString(billingPeriod: string): AIAllowancePeriod {
  const [y, m] = billingPeriod.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return {
    billingPeriod,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

/**
 * The one DB round trip. Everything below is derived from it, so the five
 * section-5 methods cannot disagree with each other about the same subject —
 * which they could if each ran its own query at its own moment.
 *
 * The billing period comes from the DATABASE (ai_entitlement_state calls
 * ai_billing_period_for), never from the application server's clock. Spec
 * section 73 requires exactly that: server/DB time is authoritative, not the
 * browser's and not the web server's timezone.
 */
async function loadEntitlementState(userId: string): Promise<AIPlanEntitlement> {
  // Fallback period only for the paths where the DB never answered at all.
  const now = new Date();
  const fallbackPeriod = periodFromString(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);

  if (!userId) return unavailable('entitlement_unknown', fallbackPeriod);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return unavailable('ai_unavailable', fallbackPeriod);
  }

  let payload: Record<string, unknown> | null = null;
  try {
    const { data, error } = await admin.rpc('ai_entitlement_state', { p_user_id: userId });
    if (error) return unavailable('ai_unavailable', fallbackPeriod);
    payload = (data ?? null) as Record<string, unknown> | null;
  } catch {
    return unavailable('ai_unavailable', fallbackPeriod);
  }
  if (!payload || typeof payload !== 'object') return unavailable('ai_unavailable', fallbackPeriod);

  const billingPeriod = typeof payload.billing_period === 'string' ? payload.billing_period : fallbackPeriod.billingPeriod;
  const period: AIAllowancePeriod = {
    billingPeriod,
    periodStart: typeof payload.period_start === 'string' ? payload.period_start : periodFromString(billingPeriod).periodStart,
    periodEnd: typeof payload.period_end === 'string' ? payload.period_end : periodFromString(billingPeriod).periodEnd,
  };

  const q = (payload.custom_questions ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

  // An `eligible` that is not literally true is treated as false. A truthy-but
  // -not-true value (a string, a 1) would mean the RPC and this module
  // disagree about the shape of the contract, and the safe reading of a
  // disagreement about entitlement is "not entitled".
  const eligible = payload.eligible === true;
  const rawReason = typeof payload.reason === 'string' ? payload.reason : null;
  const reason: AIEligibilityReason | null = eligible
    ? null
    : rawReason === 'premium_required' || rawReason === 'entitlement_unknown'
        || rawReason === 'ai_temporarily_disabled' || rawReason === 'ai_unavailable'
      ? rawReason
      : 'ai_unavailable';

  return {
    eligible,
    reason,
    upgradeAvailable: payload.upgrade_available === true,
    planFeature: AI_COACH_PREMIUM,
    period,
    customQuestions: { limit: n(q.limit), used: n(q.used), remaining: n(q.remaining) },
  };
}

/**
 * Spec section 5's five required questions. `household` is accepted on every
 * signature because the section names it, and is deliberately NOT used in the
 * decision: see the subject-ownership note at the top of this file. Accepting
 * and ignoring it is the honest encoding of "quota cannot be multiplied by
 * switching household IDs" (section 11) — a caller cannot influence the answer
 * by passing a different one.
 *
 * The unused-parameter warnings below are suppressed deliberately and only
 * here. The parameters are NOT dead code to be deleted: keeping them means a
 * caller that has a household id passes it and is visibly ignored, rather than
 * discovering there is no place to put it and wondering whether the service is
 * household-unaware by oversight. Removing them would also silently change
 * five public signatures the specification names. (This project's ESLint
 * configuration has no argsIgnorePattern for a leading underscore, so the
 * convention alone does not quiet it.)
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
export const AIEntitlementService = {
  async getAIPlanEntitlement(userId: string, _householdId?: string | null): Promise<AIPlanEntitlement> {
    return loadEntitlementState(userId);
  },

  async isPersonalisedAIEligible(userId: string, _householdId?: string | null): Promise<boolean> {
    return (await loadEntitlementState(userId)).eligible;
  },

  async getCurrentAllowancePeriod(userId: string, _householdId?: string | null): Promise<AIAllowancePeriod> {
    return (await loadEntitlementState(userId)).period;
  },

  async getRemainingCustomQuestions(userId: string, _householdId?: string | null): Promise<number> {
    return (await loadEntitlementState(userId)).customQuestions.remaining;
  },

  /**
   * ADVISORY ONLY, and named to say so nowhere near strongly enough on its
   * own — so it says so here. This answers "would a custom question be
   * admitted right now, as far as a read can tell". It is a check-then-act
   * read and MUST NOT be used to decide whether to call a provider: between
   * this returning true and a caller acting on it, another request can consume
   * the last credit. The authority is ai_admit_request(), which checks and
   * consumes in one transaction under a per-subject lock.
   */
  async canConsumeCustomQuestion(userId: string, _householdId?: string | null): Promise<boolean> {
    const state = await loadEntitlementState(userId);
    return state.eligible && state.customQuestions.remaining > 0;
  },

  /** Spec section 6 — the capability set, resolved from the one real plan tier. */
  resolveCapabilities(planTier: PlanTier | null): AICapabilitySet {
    return resolveAICapabilities(planTier);
  },
};
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Spec section 8 — the ONLY shape a Premium subject's entitlement may be
 * serialised into for a user-facing response. Written as an explicit
 * allowlist-shaped builder rather than a "strip these fields" filter, because
 * a new internal field added later would silently leak through a denylist and
 * cannot leak through this.
 *
 * Excluded on purpose, per sections 8 and 61: the per-user dollar ceiling,
 * the provider budget, model routing, the global spend threshold, the
 * kill-switch reason, rate-limit internals, and every other subject's data.
 */
export function toPublicEntitlementResponse(state: AIPlanEntitlement) {
  if (!state.eligible) {
    // Section 7's exact shape for a denied subject.
    return {
      eligible: false as const,
      reason: state.reason,
      upgrade_available: state.upgradeAvailable,
    };
  }
  return {
    eligible: true as const,
    plan_feature: state.planFeature,
    personalised_ai_enabled: true as const,
    custom_questions: {
      limit: state.customQuestions.limit,
      used: state.customQuestions.used,
      remaining: state.customQuestions.remaining,
      period_start: state.period.periodStart,
      period_end: state.period.periodEnd,
    },
  };
}
