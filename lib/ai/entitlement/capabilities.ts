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
  | 'AI_INSIGHT_PACK';

export const AI_SUB_CAPABILITIES: readonly AISubCapability[] = [
  'AI_PERSONALISED_EXPLANATIONS',
  'AI_STANDARD_QUESTIONS',
  'AI_CUSTOM_QUESTIONS',
  'AI_SCENARIO_NARRATION',
  'AI_REPORT_EXPLANATION',
  'AI_TWIN_EXPLANATION',
  'AI_INSIGHT_PACK',
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

  // Declared, not built. Spec section 1/44/45 defer every one of these.
  AI_STANDARD_QUESTIONS: false,   // the 20-25 question library — phase 11.3
  AI_SCENARIO_NARRATION: false,   // Scenario Coach — deferred
  AI_REPORT_EXPLANATION: false,   // not wired to any report surface
  AI_TWIN_EXPLANATION: false,     // not wired to any twin surface
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
