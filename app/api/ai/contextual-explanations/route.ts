// Module 11.5 — GET /api/ai/contextual-explanations (spec sections 12, 58).
//
// Returns the enabled contextual target registry plus this household's
// entitlement, so a module screen can decide whether to render an Explain
// control at all. Deliberately CHEAP: it reads the code/DB registry and the
// platform switches, and does NOT build a FinancialContextObject or resolve
// anything (spec section 73 — context minimisation). Per-target availability
// is answered by /resolve, on click.
//
// Spec section 58 — when AI_CONTEXTUAL_EXPLANATIONS_ENABLED is off (or the
// global AI switch is off) this returns feature_enabled:false and an empty
// target list, so every Explain control disappears from every module while
// the financial modules themselves keep working normally.
//
// This endpoint returns NO financial data of any kind — only target codes,
// labels and two booleans.

import { ok, bad } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { AIEntitlementService } from '@/lib/ai/entitlement/aiEntitlementService';
import { AI_CAPABILITY_IMPLEMENTED } from '@/lib/ai/entitlement/capabilities';
import { getPlatformControls } from '@/lib/ai/entitlement/platformControls';
import { loadContextualTargetRegistry } from '@/lib/ai/contextualExplanations/registryDb';
import { recordContextualExplanationMetric } from '@/lib/ai/observability/aiMetrics';

export async function GET() {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;

  try {
    const controls = await getPlatformControls().catch(() => null);
    const featureEnabled = !controls || (controls.ai_globally_enabled && controls.contextual_explanations_enabled !== false);

    if (!featureEnabled) {
      return ok({ feature_enabled: false, entitled: false, targets: [] });
    }

    const [eligible, targets] = await Promise.all([
      AIEntitlementService.isPersonalisedAIEligible(scope.userId, scope.householdId ?? undefined),
      loadContextualTargetRegistry(),
    ]);
    const entitled = eligible && AI_CAPABILITY_IMPLEMENTED.AI_CONTEXTUAL_EXPLANATIONS;

    const offered = targets.filter((t) => t.enabled);

    // Spec sections 60-61 — an IMPRESSION is a control that was actually
    // offered to a user on a page load. Counted here, on a different endpoint
    // from resolution, so that displaying a button can never contribute to
    // contextual_provider_calls_avoided.
    for (const t of offered) {
      recordContextualExplanationMetric({ event: 'impression', module: t.module_code, targetCode: t.target_code });
    }

    return ok({
      feature_enabled: true,
      entitled,
      note: 'Contextual explanations do not use your custom AI question allowance.',
      targets: offered
        .map((t) => ({
          target_code: t.target_code,
          module: t.module_code,
          display_label: t.display_label,
          display_question: t.display_question,
          target_entity_type: t.target_entity_type,
          premium_required: t.premium_required,
        })),
    });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to load contextual explanation targets.', 500);
  }
}
