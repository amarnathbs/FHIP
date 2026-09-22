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
import { resolvePackProvider } from '@/lib/ai/providers/providerFactory';
import type { FinancialContextObject } from '@/lib/ai/context/types';

// R2 (2026-09-22): the provider is resolved by lib/ai/providers/
// providerFactory.ts from the registry row AND the server configuration
// (MODULE11_AI_PROVIDER). The pre-R2 local resolveProvider() that hard-wired
// 'mock' and threw for everything else (source audit PH-02) is gone; a
// provider/config mismatch still fails closed inside the factory.

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const userId = typeof body.user_id === 'string' ? body.user_id : null;
  if (!userId) return bad('user_id is required', 422);
  // Spec section 75 — forcing past the 24h regeneration cooldown (spec
  // section 34's "admin-approved forced regeneration" carve-out) requires an
  // explicit reason, not just a boolean flag, so the audit trail says WHY.
  const force = body.force === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (force && !reason) return bad('reason is required when force=true', 422);

  let context: FinancialContextObject;
  try {
    context = await buildFinancialContextObject(userId, { mode: 'FULL' });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to build financial context.', 502);
  }

  const service = new AIPersonalisedInsightPackService(realInsightPackDbClient, resolvePackProvider);
  const outcome = await service.generateOrGetPack({ userId, householdId: null, context, bypassRegenerationCooldown: force });
  return ok({ ...outcome, forced: force, reason: force ? reason : null });
});
