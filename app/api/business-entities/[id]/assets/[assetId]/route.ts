import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { updateBusinessEntityAsset, deleteBusinessEntityAsset } from '@/lib/services/businessEntityData';
import { businessEntityLineItemUpdateSchema } from '@/lib/validation/businessEntity';

export async function PATCH(req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityLineItemUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await updateBusinessEntityAsset(assetId, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}

// Hard delete — a mis-entered line item, not a canonical financial record
// with its own history (unlike the household grid registers, which soft-
// delete). Scoped to the caller's own row via .eq('user_id', ...) in the
// service layer.
export async function DELETE(_req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await deleteBusinessEntityAsset(assetId, user.id, supabase);
  return error ? bad(error.message) : ok({ deleted: true });
}
