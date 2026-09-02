import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery } from '@/lib/resources/permissions';
import { updateContextMapping, deleteContextMapping } from '@/lib/resources/context/queries';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// PATCH /api/admin/resources/context/[id] — activate/deactivate, reorder, edit metric_or_feature (spec §57).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Context Mapping.", 403);

  const body = await request.json().catch(() => ({}));
  const patch: { sort_order?: number; is_active?: boolean; metric_or_feature?: string | null } = {};
  if (typeof body?.sort_order === 'number') patch.sort_order = body.sort_order;
  if (typeof body?.is_active === 'boolean') patch.is_active = body.is_active;
  if (typeof body?.metric_or_feature === 'string' || body?.metric_or_feature === null) patch.metric_or_feature = body.metric_or_feature;

  try {
    await updateContextMapping(supabase, id, patch);
    return ok({ id });
  } catch (err) {
    console.error('Resources context mapping update error:', err);
    return bad('Could not update this mapping.', 500);
  }
}

// DELETE /api/admin/resources/context/[id]
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Context Mapping.", 403);

  try {
    // Admin A0.2 Wave 4 (PO4-4 / DEF4-10): canonical single-resource DELETE
    // contract — first successful deletion -> 200; unknown/already-gone id
    // -> 404, never a false 200.
    const { deleted } = await deleteContextMapping(supabase, id);
    if (!deleted) return bad('This mapping no longer exists.', 404);
    return ok({ id });
  } catch (err) {
    console.error('Resources context mapping delete error:', err);
    return bad('Could not remove this mapping.', 500);
  }
}
