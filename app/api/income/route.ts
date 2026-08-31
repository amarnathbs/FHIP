import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { incomeSchema } from '@/lib/validation/income';
import { assertItemCreationAllowedForUser } from '@/lib/services/jurisdiction';
import { createClient } from '@/lib/supabase/server';

const registry = makeRegistry('income_sources');

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await registry.list(user.id);
  return error ? bad(error.message) : ok(data);
}

// G0-JA-1 Wave 2 (spec s.6-7, s.33, JUR-03 pattern): app-layer half of
// defence-in-depth for jurisdiction-restricted income catalogue items
// (age_pension, family_tax_benefit — both HOME_OR_CROSS_BORDER_COUNTRY(AU),
// migration 0102). Same pattern already established by
// app/api/retirement/route.ts for 'smsf'; income has no DB-trigger backstop
// today, so this app-layer gate is the only enforcement layer for these two
// items — a forged direct API/PostgREST request bypassing the UI is still
// rejected because assertItemCreationAllowedForUser() re-resolves the
// caller's own home country server-side and never trusts a client value.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = incomeSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const gate = await assertItemCreationAllowedForUser({
    userId: user.id,
    supabase,
    category: 'income',
    itemKey: parsed.data.master_item_key,
  });
  if (!gate.allowed) return bad(gate.reason, 403);

  const { data, error } = await registry.save(user.id, parsed.data);
  return error ? bad(error.message) : ok(data);
}
