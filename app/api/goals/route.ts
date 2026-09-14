import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { goalSchema } from '@/lib/validation/goal';
import { loadGoalsPage } from '@/lib/services/goalsData';

const registry = makeRegistry('user_goals');

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const payload = await loadGoalsPage(user.id);
    return ok(payload);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load goals');
  }
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = goalSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const { data, error } = await registry.create(user.id, { ...parsed.data, status: 'active' });
  return error ? bad(error.message) : ok(data);
}
