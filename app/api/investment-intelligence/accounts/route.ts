import { requireUser, ok, bad } from '@/lib/api';
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
  if (!parsed.success) return bad(parsed.error.message, 422);
  const { data, error } = await createIiAccount(user.id, parsed.data);
  return error ? bad(error.message) : ok(data);
}
