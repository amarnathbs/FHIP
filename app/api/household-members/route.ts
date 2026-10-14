import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { householdMemberSchema } from '@/lib/validation/householdMember';
import { isDuplicateSelfMemberError, SELF_ALREADY_EXISTS_MESSAGE } from '@/lib/services/household/selfMemberUnique';

const registry = makeRegistry('household_members');

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await registry.list(user.id);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = householdMemberSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const { data, error } = await registry.create(user.id, parsed.data);
  if (isDuplicateSelfMemberError(error)) return bad(SELF_ALREADY_EXISTS_MESSAGE, 409, 'self_member_exists');
  return error ? bad(error.message) : ok(data);
}
