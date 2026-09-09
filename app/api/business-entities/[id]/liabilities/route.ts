import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listBusinessEntityLiabilities, createBusinessEntityLiability } from '@/lib/services/businessEntityData';
import { businessEntityLiabilitySchema } from '@/lib/validation/businessEntity';

// NEG-02 "entity debt enters DTI" — this table is structurally never read
// by the personal liabilities-based DTI/DSR formulas in
// lib/engines/dashboard.ts (see migration 0134's own comment on
// business_entity_liabilities). Nothing in this route needs to enforce that
// separately; there is no shared table a runtime filter could fail to
// apply to.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listBusinessEntityLiabilities(id, user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityLiabilitySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await createBusinessEntityLiability(id, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}
