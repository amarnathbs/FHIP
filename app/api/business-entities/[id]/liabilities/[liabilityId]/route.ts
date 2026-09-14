import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { updateBusinessEntityLiability, deleteBusinessEntityLiability } from '@/lib/services/businessEntityData';
import { businessEntityLineItemUpdateSchema } from '@/lib/validation/businessEntity';

export async function PATCH(req: Request, { params }: { params: Promise<{ liabilityId: string }> }) {
  const { liabilityId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityLineItemUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();
  const { data, error } = await updateBusinessEntityLiability(liabilityId, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ liabilityId: string }> }) {
  const { liabilityId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await deleteBusinessEntityLiability(liabilityId, user.id, supabase);
  return error ? bad(error.message) : ok({ deleted: true });
}
