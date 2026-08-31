// Module 11.1 — reusable server-side AI entitlement enforcement (spec section 41).
//
// "Do not rely on UI route guards alone. Create reusable server enforcement
//  e.g. requireAIEntitlement()."
//
// This is the guard a future protected AI route composes with, in the same
// shape as this codebase's existing requireUser() / requireAdmin() helpers
// (lib/api.ts, lib/services/adminAuth.ts): it returns either a `forbidden`
// Response to return immediately, or the resolved subject to proceed with.
//
// WHAT IT DOES AND DOES NOT DO. It performs the cheap, information-preserving
// half of section 42's ordering — authenticate, then confirm the AI feature
// entitlement — so that a Free user is refused before any financial context is
// built, any model is resolved, or any cost is estimated. It does NOT consume
// quota and is NOT the admission decision: the authority remains
// ai_admit_request(), invoked from inside AIModelGateway immediately before
// the provider call. A route that called only this and then reached a provider
// would be unenforced, which is why the gateway gate is unconditional and this
// helper cannot switch it off.
//
// ORDER (spec section 42, the part that is implementable in 11.1):
//   AUTHENTICATE -> AUTHORISE SUBJECT -> GLOBAL AI ENABLED? -> FEATURE
//   ENABLED? -> PREMIUM ENTITLED?  ... then the caller continues to
//   certification, quota, rate limit, concurrency, cost budget and provider,
//   all of which happen inside the gateway's single admission RPC.

import { requireUser } from '@/lib/api';
import { AIEntitlementService, type AIPlanEntitlement } from '@/lib/ai/entitlement/aiEntitlementService';
import { AI_CAPABILITY_IMPLEMENTED, type AISubCapability } from '@/lib/ai/entitlement/capabilities';
import { recordAiMetric } from '@/lib/ai/observability/aiMetrics';

export interface AIEntitlementContext {
  userId: string;
  entitlement: AIPlanEntitlement;
}

export interface RequireAIEntitlementResult {
  context: AIEntitlementContext | null;
  forbidden: Response | null;
}

/**
 * Section 7's exact denial shape. Note what is absent: no internal cost
 * config, no provider name, no model name, no quota implementation detail, no
 * kill-switch reason, no raw feature-flag state. `reason` is drawn from the
 * four coarse values AIEntitlementService produces, none of which distinguish
 * which switch or which ceiling was responsible.
 */
function entitlementDenied(state: AIPlanEntitlement): Response {
  return Response.json(
    {
      error: 'AI is not available for this account.',
      data: {
        allowed: false,
        reason: state.reason ?? 'ai_unavailable',
        upgrade_available: state.upgradeAvailable,
      },
    },
    { status: 403 }
  );
}

/**
 * @param capability the specific sub-capability the route needs. A capability
 * with no implementation behind it (spec sections 44/45/46 defer most of them)
 * is refused even for a Premium subject — an entitlement to a feature that
 * does not exist must not read as permission to invoke one.
 */
export async function requireAIEntitlement(
  capability: AISubCapability = 'AI_CUSTOM_QUESTIONS'
): Promise<RequireAIEntitlementResult> {
  const { user, unauthenticated } = await requireUser();
  if (unauthenticated || !user) {
    return { context: null, forbidden: unauthenticated ?? Response.json({ error: 'unauthenticated' }, { status: 401 }) };
  }

  const entitlement = await AIEntitlementService.getAIPlanEntitlement(user.id);

  if (!entitlement.eligible) {
    recordAiMetric('ai_entitlement_denied', { reason: entitlement.reason ?? 'ai_unavailable', capability });
    return { context: null, forbidden: entitlementDenied(entitlement) };
  }

  if (!AI_CAPABILITY_IMPLEMENTED[capability]) {
    recordAiMetric('ai_entitlement_denied', { reason: 'capability_not_available', capability });
    // Reported as unavailable rather than as an entitlement failure, because
    // it is not one: the subject IS entitled, the feature simply is not built.
    // Telling them to upgrade would be false.
    return {
      context: null,
      forbidden: Response.json(
        { error: 'This AI capability is not available yet.', data: { allowed: false, reason: 'ai_unavailable', upgrade_available: false } },
        { status: 403 }
      ),
    };
  }

  recordAiMetric('ai_entitlement_allowed', { capability });
  return { context: { userId: user.id, entitlement }, forbidden: null };
}
