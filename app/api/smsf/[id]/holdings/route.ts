import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listSmsfHoldings, createSmsfHolding } from '@/lib/services/smsfData';
import { smsfHoldingSchema } from '@/lib/validation/smsf';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listSmsfHoldings(id, user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

// Holdings can be added to any of the caller's own funds regardless of
// their CURRENT country_of_residence (spec s.8: maintaining/detailing an
// already-existing, already-gated fund is not "new SMSF creation" — only
// the fund itself was gated, at POST /api/smsf). RLS's cross-referenced
// WITH CHECK (migration 0084) still guarantees smsf_fund_id must be one of
// the caller's own funds.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfHoldingSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await createSmsfHolding(id, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}
