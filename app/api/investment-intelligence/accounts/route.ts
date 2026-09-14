import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { listIiAccounts, createIiAccount } from '@/lib/services/investment-intelligence/accounts';
import { iiAccountSchema } from '@/lib/validation/investment-intelligence';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await listIiAccounts(user.id);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = iiAccountSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const { data, error } = await createIiAccount(user.id, parsed.data);
  return error ? bad(error.message) : ok(data);
}
