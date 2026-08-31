import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { liabilitySchema } from '@/lib/validation/liability';
import { assertItemCreationAllowedForUser } from '@/lib/services/jurisdiction';
import { createClient } from '@/lib/supabase/server';

const registry = makeRegistry('liabilities');

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await registry.list(user.id);
  return error ? bad(error.message) : ok(data);
}

// G0-JA-1 Wave 2: app-layer gate for the three liability items reclassified
// HOME_OR_CROSS_BORDER_COUNTRY(AU) by migration 0102 (smsf_property_loan,
// hecs_help, ato_payment_plan). Same pattern as app/api/retirement/route.ts.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = liabilitySchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const gate = await assertItemCreationAllowedForUser({
    userId: user.id,
    supabase,
    category: 'liability',
    itemKey: parsed.data.master_item_key,
  });
  if (!gate.allowed) return bad(gate.reason, 403);

  const { data, error } = await registry.save(user.id, parsed.data);
  return error ? bad(error.message) : ok(data);
}
