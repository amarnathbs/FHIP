import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { retirementSchema } from '@/lib/validation/retirement';
import { assertItemCreationAllowedForUser } from '@/lib/services/jurisdiction';
import { createClient } from '@/lib/supabase/server';

const registry = makeRegistry('retirement_accounts');

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await registry.list(user.id);
  return error ? bad(error.message) : ok(data);
}

// GEO-2 (spec s.6-7, s.33, JUR-03): app-layer half of defence-in-depth for
// jurisdiction-restricted catalogue items (today, only 'smsf'). This gives
// a friendly, well-typed rejection for the app's own UI; the DB-level
// backstop (trg_retirement_accounts_smsf_au_gate, migration 0084) still
// rejects a forged direct PostgREST request even if this check were ever
// bypassed, removed, or a future code path forgot to call it — a non-AU
// user cannot create an SMSF through this API OR by going around it.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = retirementSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const gate = await assertItemCreationAllowedForUser({
    userId: user.id,
    supabase,
    category: 'retirement',
    itemKey: parsed.data.master_item_key,
  });
  if (!gate.allowed) return bad(gate.reason, 403);

  const { data, error } = await registry.save(user.id, parsed.data);
  return error ? bad(error.message) : ok(data);
}
