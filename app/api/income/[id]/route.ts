import { ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { incomeSchema } from '@/lib/validation/income';
import { requireModuleCapability } from '@/lib/services/appCapability';

const registry = makeRegistry('income_sources');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, blocked } = await requireModuleCapability('INCOME', req);
  if (!user) return blocked!;
  const parsed = incomeSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const { data, error } = await registry.update(user.id, id, parsed.data);
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, blocked } = await requireModuleCapability('INCOME', req);
  if (!user) return blocked!;
  const { error } = await registry.archive(user.id, id);
  return error ? bad(error.message) : ok({ archived: true });
}
