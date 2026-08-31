import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { updateSmsfHolding, archiveSmsfHolding } from '@/lib/services/smsfData';
import { smsfHoldingUpdateSchema } from '@/lib/validation/smsf';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; holdingId: string }> }) {
  const { holdingId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfHoldingUpdateSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await updateSmsfHolding(holdingId, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; holdingId: string }> }) {
  const { holdingId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await archiveSmsfHolding(holdingId, user.id, supabase);
  return error ? bad(error.message) : ok({ archived: true });
}
