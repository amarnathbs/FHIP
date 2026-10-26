import { ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { expenseSchema } from '@/lib/validation/expense';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import { entityOwnerRefusal, introducesEntityOwner } from '@/lib/services/entityOwnerGuard';

const registry = makeRegistry('expense_items');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, blocked } = await requireModuleCapability('EXPENSES', req);
  if (!user) return blocked!;
  const parsed = expenseSchema.partial().safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  if (introducesEntityOwner(parsed.data.owner)) {
    // Only a CHANGE of owner to an entity value is refused; an existing entity-tagged row stays editable in its other fields.
    const { data: current } = await (await createClient()).from('expense_items').select('owner').eq('id', id).eq('user_id', user.id).maybeSingle();
    const refused = entityOwnerRefusal('expenses', parsed.data.owner, (current as { owner?: string | null } | null)?.owner ?? null);
    if (refused) return refused;
  }
  const { data, error } = await registry.update(user.id, id, parsed.data);
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, blocked } = await requireModuleCapability('EXPENSES', req);
  if (!user) return blocked!;
  const { error } = await registry.archive(user.id, id);
  return error ? bad(error.message) : ok({ archived: true });
}
