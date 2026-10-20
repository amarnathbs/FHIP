import { requireCountryConfirmedUser as requireUser, ok, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { entityErrorResponse } from '@/lib/services/entityCashFlowRoutes';
import { updateBusinessEntityLiability, deleteBusinessEntityLiability } from '@/lib/services/businessEntityData';
import { businessEntityLiabilityUpdateSchema } from '@/lib/validation/businessEntity';

export async function PATCH(req: Request, { params }: { params: Promise<{ liabilityId: string }> }) {
  const { liabilityId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityLiabilityUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();
  const { data, error } = await updateBusinessEntityLiability(liabilityId, user.id, parsed.data, supabase);
  return error ? entityErrorResponse(error) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ liabilityId: string }> }) {
  const { liabilityId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await deleteBusinessEntityLiability(liabilityId, user.id, supabase);
  return error ? entityErrorResponse(error) : ok({ archived: true });
}
