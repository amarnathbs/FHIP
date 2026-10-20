import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { liabilityPatchSchema } from '@/lib/validation/liability';
import { createClient } from '@/lib/supabase/server';
import { entityOwnerRefusal } from '@/lib/services/entityOwnerGuard';

const registry = makeRegistry('liabilities');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = liabilityPatchSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  if (parsed.data.owner !== undefined) {
    // Only a CHANGE of owner to an entity value is refused; an existing entity-tagged row stays editable in its other fields.
    const { data: current } = await (await createClient()).from('liabilities').select('owner').eq('id', id).eq('user_id', user.id).maybeSingle();
    const refused = entityOwnerRefusal('liabilities', parsed.data.owner, (current as { owner?: string | null } | null)?.owner ?? null);
    if (refused) return refused;
  }
  const { data, error } = await registry.update(user.id, id, parsed.data);
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { error } = await registry.archive(user.id, id);
  return error ? bad(error.message) : ok({ archived: true });
}
