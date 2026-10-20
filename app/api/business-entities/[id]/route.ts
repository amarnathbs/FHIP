import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getBusinessEntity, updateBusinessEntity, archiveBusinessEntity } from '@/lib/services/businessEntityData';
import { businessEntityUpdateSchema } from '@/lib/validation/businessEntity';
import { smsfRpcError } from '@/lib/services/smsfErrors';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await getBusinessEntity(id, user.id, supabase);
  if (error || !data) return bad('not found', 404);
  // The net of an itemised entity is DERIVED by the database out of its active lines (migration 0297), never typed. Fail soft: an unreadable net is
  // null, never zero.
  let derivedNet: number | null = null;
  if (data.valuation_mode === 'detailed') {
    const rpc = await supabase.rpc('business_entity_derived_net', { p_entity_id: id });
    if (!rpc.error && rpc.data !== null && rpc.data !== undefined) derivedNet = Number(rpc.data);
  }
  return ok({ ...data, derived_net: derivedNet });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();
  const { data, error } = await updateBusinessEntity(id, user.id, parsed.data, supabase);
  if (error) {
    // The database owns the itemised-or-net-only rule (migration 0297): answer it in plain words with its stable code.
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}

// Soft-delete (is_active=false) — matches every financial-data-grid
// register's own convention, never a hard delete of a financial record.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await archiveBusinessEntity(id, user.id, supabase);
  return error ? bad(error.message) : ok(data);
}
