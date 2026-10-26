import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { updateSmsfLiability, archiveSmsfLiability } from '@/lib/services/smsfData';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfLiabilityUpdateSchema } from '@/lib/validation/smsf';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; liabilityId: string }> }) {
  const { liabilityId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfLiabilityUpdateSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const { data, error } = await updateSmsfLiability(liabilityId, user.id, parsed.data, supabase);
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

// Soft retire (is_active = false), matching holdings: a financial record is never hard-deleted.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; liabilityId: string }> }) {
  const { liabilityId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await archiveSmsfLiability(liabilityId, user.id, supabase);
  return error ? bad(error.message) : ok({ archived: true });
}
