import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { incomeSchema } from '@/lib/validation/income';

const registry = makeRegistry('income_sources');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = incomeSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
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
