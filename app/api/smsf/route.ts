import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listSmsfFunds, createSmsfFund } from '@/lib/services/smsfData';
import { smsfFundCreateSchema } from '@/lib/validation/smsf';

// GET: never jurisdiction-filtered — an existing SMSF fund (created while
// the user's home jurisdiction was AU, or before this release) must stay
// visible/readable regardless of the caller's CURRENT country_of_residence
// (spec s.8, s.34-35: preserve, never fabricate that it no longer exists).
// Only *creation* (POST, below) is gated.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listSmsfFunds(user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

// POST: new SMSF Fund creation. Gated by the smsf_create_fund() RPC's own
// underlying trg_retirement_accounts_smsf_au_gate trigger (migration 0084)
// — an IN (or other non-AU) resident's request is rejected here with the
// same DB-level error a forged direct request would get (JUR-01/03).
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfFundCreateSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await createSmsfFund(parsed.data, supabase);
  if (error) {
    // 42501 = insufficient_privilege, raised by trg_retirement_accounts_smsf_au_gate.
    const status = error.code === '42501' ? 403 : 400;
    return bad(error.message, status);
  }
  return ok(data);
}
