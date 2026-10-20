import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getSmsfFund, updateSmsfFundSummary } from '@/lib/services/smsfData';
import { smsfFundUpdateSchema } from '@/lib/validation/smsf';
import { smsfRpcError } from '@/lib/services/smsfErrors';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await getSmsfFund(id, supabase);
  if (error || !data || data.user_id !== user.id) return bad('not found', 404);
  return ok(data);
}

// Summary Mode edits only — mode itself never changes here (see
// smsfFundUpdateSchema comment). Always allowed regardless of the caller's
// CURRENT country_of_residence: maintaining an already-existing fund's
// figures is preservation/upkeep of a legitimate historical holding, not
// "creating a new country-specific product" (spec s.8, s.34-35), and the
// underlying retirement_accounts row backing it was already gated at
// creation time.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfFundUpdateSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();
  const { data, error } = await updateSmsfFundSummary(id, user.id, parsed.data, supabase);
  if (error) {
    // An itemised fund refuses a typed net value (ENTITY_BOTH_REPRESENTATIONS, migration 0290): 409 with a plain message.
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}
