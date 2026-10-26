import { requireCountryConfirmedUser as requireUser, ok, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { entityErrorResponse } from '@/lib/services/entityCashFlowRoutes';
import { updateBusinessEntityAsset, deleteBusinessEntityAsset } from '@/lib/services/businessEntityData';
import { businessEntityAssetUpdateSchema } from '@/lib/validation/businessEntity';

export async function PATCH(req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityAssetUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();
  const { data, error } = await updateBusinessEntityAsset(assetId, user.id, parsed.data, supabase);
  return error ? entityErrorResponse(error) : ok(data);
}

// Soft retire (migration 0297): a line is never hard deleted, the change log keeps it, exactly like every household register.
// Scoped to the caller's own row via .eq('user_id', ...) in the service layer.
export async function DELETE(_req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await deleteBusinessEntityAsset(assetId, user.id, supabase);
  return error ? entityErrorResponse(error) : ok({ archived: true });
}
