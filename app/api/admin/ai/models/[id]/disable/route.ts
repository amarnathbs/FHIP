// Module 11.1 — POST /api/admin/ai/models/{id}/disable  (spec sections 32, 40).
//
// Section 32: "A disabled model receives no new executions. If it was the
// configured default, use approved fallback only, otherwise return
// unavailable."
//
// Both halves are structural rather than enforced by this route:
//   * ai_admit_request() refuses any request bound to a model whose registry
//     row is inactive or unapproved, and refuses outright a model that is not
//     in the registry at all — so disabling here stops executions everywhere,
//     including for a caller holding a stale model row.
//   * resolveModelForTask() only ever returns active+approved rows and returns
//     NULL rather than guessing when none exists, so "otherwise return
//     unavailable" is the existing default and no unapproved fallback can be
//     selected silently.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { updateModelRegistryEntry } from '@/lib/ai/modelRegistry';
import { recordProviderOrModelDisabled } from '@/lib/ai/observability/operationalEvents';

export const POST = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason = typeof (body as Record<string, unknown>)?.reason === 'string'
    ? ((body as Record<string, unknown>).reason as string)
    : null;
  if (!reason) return bad('reason is required when disabling a model', 422);
  try {
    const updated = await updateModelRegistryEntry(id, { active: false }, user!.id);
    await recordProviderOrModelDisabled('model', updated.model_identifier, reason, user!.id);
    return ok(updated);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to disable the model.', 500);
  }
});
