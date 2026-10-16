import { ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { incomeSchema, incomeTaxProblem } from '@/lib/validation/income';
import { requireModuleCapability } from '@/lib/services/appCapability';

const registry = makeRegistry('income_sources');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, blocked } = await requireModuleCapability('INCOME', req);
  if (!user) return blocked!;
  const parsed = incomeSchema.partial().safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const taxProblem = incomeTaxProblem(parsed.data);
  if (taxProblem) return bad(taxProblem, 422);
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
