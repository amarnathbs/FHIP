import { requireCountryConfirmedUser as requireUser, ok, bad, badField, badValidation } from '@/lib/api';
import { MASKED_IDENTIFIER_MESSAGE, isMaskedIdentifierConstraintError } from '@/lib/validation/maskedIdentifier';
import { makeRegistry } from '@/lib/services/registry';
import { liabilityPatchSchema } from '@/lib/validation/liability';

const registry = makeRegistry('liabilities');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = liabilityPatchSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const { data, error } = await registry.update(user.id, id, parsed.data);
  // Defence in depth behind the schema (F24): the database rule answered in its own words before; say what to type.
  if (error && isMaskedIdentifierConstraintError(error)) return badField('masked_identifier', MASKED_IDENTIFIER_MESSAGE);
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { error } = await registry.archive(user.id, id);
  return error ? bad(error.message) : ok({ archived: true });
}
