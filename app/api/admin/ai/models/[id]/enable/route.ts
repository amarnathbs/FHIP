// Module 11.1 — POST /api/admin/ai/models/{id}/enable  (spec sections 32, 40).
//
// Section 40 prefers specific actions over broad generic mutation APIs. The
// generic PUT /api/admin/ai/models/{id} already exists and can set any field;
// this is the narrow, unambiguous "turn this model back on" action.
//
// Enabling sets `active` only. It deliberately does NOT set `approved`:
// approval is a governance decision about whether a model may ever be used,
// and re-enabling an operationally-disabled model must not silently grant it.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { updateModelRegistryEntry } from '@/lib/ai/modelRegistry';

export const POST = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  try {
    return ok(await updateModelRegistryEntry(id, { active: true }, user!.id));
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to enable the model.', 500);
  }
});
