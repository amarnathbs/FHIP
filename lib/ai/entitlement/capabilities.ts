// Module 11.1 — AI feature entitlement codes (spec section 6).
//
// WHY THIS EXISTS RATHER THAN `plan_tier === 'premium'` AT EVERY CALL SITE.
// Section 6 asks for an explicit feature entitlement, AI_COACH_PREMIUM, with
// named sub-capabilities that can be turned on independently later:
//
//     Subscription / Plan  ->  Feature Entitlement  ->  AI_COACH_PREMIUM
//                                                   ->  specific AI capability
//
// WHAT THIS CODEBASE ACTUALLY HAS (verified, not assumed — see
// MODULE_11_1_REUSE_AND_GAP_AUDIT.md section 1, re-verified against
// origin/main @ 2ade18b for this pass): exactly one entitlement concept,
// `user_entitlements.plan_tier`, constrained to 'free' | 'premium'. There is
// NO feature-capability table, no plan_features table, no entitlement-code
// column anywhere in 101 migrations, and no billing provider of any kind.
//
// Section 6 says: "Do not infer personalised AI access merely from
// plan_name === 'premium' IF the app already supports explicit feature
// capabilities." It does not. Inventing a second entitlement store to satisfy
// the letter of the hierarchy would create exactly the parallel subscription
// truth source section 4 forbids.
//
// So the hierarchy is implemented HERE, in one place, as a resolution from the
// single real plan tier to named capability codes. `AI_COACH_PREMIUM` is a
// real, named, checkable entitlement that every AI path asks for; it simply
// resolves from plan_tier today. When a genuine feature-entitlement table
// arrives, `resolveAICapabilities()` is the one function that changes, and no
// call site does.

import type { PlanTier } from '@/lib/services/entitlements';

/** The umbrella feature entitlement gating all personalised AI (spec section 6). */
export const AI_COACH_PREMIUM = 'AI_COACH_PREMIUM' as const;

/**
 * The sub-capabilities named in spec section 6. Section 6 is explicit that
 * "not all need enabling in 11.1; architecture should allow independent future
 * control" — so they are declared, resolvable and individually checkable now,
 * and the ones whose features do not exist yet resolve to DISABLED rather than
 * being quietly granted.
 */
export type AISubCapability =
  | 'AI_PERSONALISED_EXPLANATIONS'
  | 'AI_STANDARD_QUESTIONS'
  | 'AI_CUSTOM_QUESTIONS'
  | 'AI_SCENARIO_NARRATION'
  | 'AI_REPORT_EXPLANATION'
  | 'AI_TWIN_EXPLANATION'
  | 'AI_INSIGHT_PACK'
  // Module 11.5 — contextual Explain / Why? controls embedded in existing
  // FHIP modules. Additive: an eighth named sub-capability, resolved through
  // the same one function as every other.
  | 'AI_CONTEXTUAL_EXPLANATIONS';

export const AI_SUB_CAPABILITIES: readonly AISubCapability[] = [
  'AI_PERSONALISED_EXPLANATIONS',
  'AI_STANDARD_QUESTIONS',
  'AI_CUSTOM_QUESTIONS',
  'AI_SCENARIO_NARRATION',
  'AI_REPORT_EXPLANATION',
  'AI_TWIN_EXPLANATION',
  'AI_INSIGHT_PACK',
  'AI_CONTEXTUAL_EXPLANATIONS',
] as const;

/**
 * Which sub-capabilities have a real implementation behind them in Module
 * 11.1. This is NOT a policy switch (that is ai_platform_controls, in the
 * database, admin-controllable). It is a statement of what has been BUILT, so
 * that a capability check can never return true for a feature that does not
 * exist — which would let a future caller believe it had been authorised to do
 * something no code implements.
 *
 * Everything here is false except the two the enforcement layer genuinely
 * governs today, because spec sections 44/45/46 forbid building the rest in
 * this phase.
 */
export const AI_CAPABILITY_IMPLEMENTED: Record<AISubCapability, boolean> = {
  // The two the Module 11.1 admission gate actually governs.
  AI_CUSTOM_QUESTIONS: true,
  AI_PERSONALISED_EXPLANATIONS: true,

  // Module 11.4 — the 25-question zero-cost standard-question library
  // (lib/ai/standardQuestions/service.ts) now genuinely exists and is
  // Premium-gated through this exact flag, the same way AI_INSIGHT_PACK was
  // flipped true in Module 11.3. Flipping this does NOT go through the
  // ai_admit_request() admission gate at all — AIStandardQuestionService
  // never calls it — it only gates whether the standard-question endpoints
  // treat the caller as entitled (spec sections 22-25).
  AI_STANDARD_QUESTIONS: true,

  // Module 11.5 — the contextual Explain / Why? estate
  // (lib/ai/contextualExplanations/service.ts) is genuinely built and
  // Premium-gated through this flag. Like AI_STANDARD_QUESTIONS, it never
  // goes through the ai_admit_request() admission gate — the contextual
  // service never calls it — it only gates whether the contextual endpoint
  // treats the caller as entitled (spec sections 20-21).
  AI_CONTEXTUAL_EXPLANATIONS: true,

  // Module 11.5 wires the report and Twin explanation surfaces these two
  // flags name. Both were false with the comment "not wired to any report/
  // twin surface" — that statement is no longer true: the contextual target
  // registry now declares REPORT_OVERVIEW/REPORT_SCORE/REPORT_CASH_FLOW
  // against the on-screen report and TWIN_COMPARISON/TWIN_CONFIDENCE against
  // the Financial Twin view, and both are served zero-cost through the same
  // Premium-gated contextual service. Flipped for the same reason
  // AI_INSIGHT_PACK and AI_STANDARD_QUESTIONS were flipped in 11.3/11.4: the
  // feature the flag names now exists.
  AI_REPORT_EXPLANATION: true,
  AI_TWIN_EXPLANATION: true,

  // Declared, not built. Spec section 1/50 defers this one to a later phase.
  AI_SCENARIO_NARRATION: false,   // Scenario Coach — deferred
  // Module 11.3 — the Monthly Insight Pack generation service now exists
  // (lib/ai/insightPack/insightPackService.ts) and is Premium-gated through
  // this exact flag. Flipped true here, not because "Premium" changed
  // meaning, but because the feature this flag names is genuinely built now.
  AI_INSIGHT_PACK: true,
};

export interface AICapabilitySet {
  /** True when the subject holds the umbrella AI_COACH_PREMIUM entitlement. */
  [AI_COACH_PREMIUM]: boolean;
  capabilities: Record<AISubCapability, boolean>;
}

/**
 * Resolves plan tier -> feature entitlement -> sub-capabilities.
 *
 * FAIL CLOSED (spec section 62): the tier is `PlanTier | null`, and null means
 * "could not be determined", which grants nothing. It is deliberately NOT
 * coerced to 'free', because a free user and an unreadable entitlement are
 * different facts that must stay distinguishable in logs and in the API
 * response (a free user should be offered an upgrade; an outage should not be).
 */
export function resolveAICapabilities(planTier: PlanTier | null): AICapabilitySet {
  const premium = planTier === 'premium';
  const capabilities = Object.fromEntries(
    AI_SUB_CAPABILITIES.map((c) => [c, premium && AI_CAPABILITY_IMPLEMENTED[c]])
  ) as Record<AISubCapability, boolean>;
  return { [AI_COACH_PREMIUM]: premium, capabilities };
}

/** Single-capability check. Both the umbrella entitlement and the specific capability must hold. */
export function hasAICapability(planTier: PlanTier | null, capability: AISubCapability): boolean {
  const set = resolveAICapabilities(planTier);
  return set[AI_COACH_PREMIUM] && set.capabilities[capability];
}
