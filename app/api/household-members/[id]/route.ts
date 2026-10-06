import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { householdMemberSchema } from '@/lib/validation/householdMember';
import { isDuplicateSelfMemberError, SELF_ALREADY_EXISTS_MESSAGE } from '@/lib/services/household/selfMemberUnique';

const registry = makeRegistry('household_members');

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = householdMemberSchema.partial().safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const { data, error } = await registry.update(user.id, id, parsed.data);
  if (isDuplicateSelfMemberError(error)) return bad(SELF_ALREADY_EXISTS_MESSAGE, 409, 'self_member_exists');
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { error } = await registry.archive(user.id, id);
  return error ? bad(error.message) : ok({ archived: true });
}
