import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getBusinessEntity, updateBusinessEntity, archiveBusinessEntity } from '@/lib/services/businessEntityData';
import { businessEntityUpdateSchema } from '@/lib/validation/businessEntity';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await getBusinessEntity(id, user.id, supabase);
  if (error || !data) return bad('not found', 404);
  return ok(data);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await updateBusinessEntity(id, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
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
