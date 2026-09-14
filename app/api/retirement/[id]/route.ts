import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { retirementPatchSchema } from '@/lib/validation/retirement';

const registry = makeRegistry('retirement_accounts');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = retirementPatchSchema.safeParse(await req.json());
  // App Review 2026-09-14, item 1: this used to be `bad(parsed.error.message, 422)`,
  // leaking ZodError's raw issue dump straight to the client. See lib/api.ts's
  // badValidation() comment for the full history.
  if (!parsed.success) return badValidation(parsed.error);
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
