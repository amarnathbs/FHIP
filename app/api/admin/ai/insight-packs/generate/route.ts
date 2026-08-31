// Module 11.3 — admin-triggered Insight Pack generation (spec sections 66,
// 75, 91). Capability-gated (requireAdmin(), same pattern as every other
// /api/admin/ai/* route), auditable (every outcome is an ai_insight_packs
// row + an ai_runs row via the gateway), respects the same cost/entitlement/
// kill-switch controls as any other generation path, and never touches a
// user's custom-question quota (BATCH_AI is structurally incapable of that
// — migration 0115's own CHECK constraint).
//
// No consumer-facing "Regenerate AI" button exists anywhere in this phase
// (spec section 91) — this route is DEV/admin-only.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { bad, ok } from '@/lib/api';
import { buildFinancialContextObject } from '@/lib/ai/context/financialContextObject';
import { AIPersonalisedInsightPackService } from '@/lib/ai/insightPack/insightPackService';
import { realInsightPackDbClient } from '@/lib/ai/insightPack/insightPackDbClient';
import { MockInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';

/**
 * Resolves a real AIProvider for the pack's model. Only 'mock' is wired to a
 * usable provider today (Module 11.0's OpenAIProviderAdapter throws
 * PROVIDER_UNAVAILABLE unconditionally by design — no live external call
 * exists anywhere in this codebase, spec section 104). A model registered
 * against any other provider therefore fails closed here rather than
 * silently falling back.
 */
function resolveProvider(ctx: FinancialContextObject, model: ModelRegistryRow) {
  if (model.provider === 'mock') return new MockInsightPackProvider(ctx, 'valid');
  throw new Error(`No live provider adapter is wired for provider "${model.provider}" in Module 11.3 (spec section 104: no live external call).`);
}

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const userId = typeof body.user_id === 'string' ? body.user_id : null;
  if (!userId) return bad('user_id is required', 422);

  let context: FinancialContextObject;
  try {
    context = await buildFinancialContextObject(userId, { mode: 'FULL' });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to build financial context.', 502);
  }

  const service = new AIPersonalisedInsightPackService(realInsightPackDbClient, resolveProvider);
  const outcome = await service.generateOrGetPack({ userId, householdId: null, context });
  return ok(outcome);
});
