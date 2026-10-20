import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listSmsfLiabilities, createSmsfLiability, getSmsfFund } from '@/lib/services/smsfData';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfLiabilitySchema } from '@/lib/validation/smsf';

// The fund's own debts (migration 0289). Entity-level, never part of the personal liabilities register.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listSmsfLiabilities(id, user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

// A liability can only be added while the fund is recorded as itemised: the database refuses it on a net-value-only fund
// (ENTITY_BOTH_REPRESENTATIONS, mapped to 409), so the rule holds even if a client skips the screen.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfLiabilitySchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  // A fund of another household answers exactly like a fund that does not exist (404, non-enumerating), never a revealing policy error.
  const { data: fund } = await getSmsfFund(id, supabase);
  if (!fund || fund.user_id !== user.id) return bad('Not found', 404);
  const { data, error } = await createSmsfLiability(id, user.id, parsed.data, supabase);
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}
