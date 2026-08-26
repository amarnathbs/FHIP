import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listSmsfMembers, upsertSmsfMember } from '@/lib/services/smsfData';
import { smsfMemberSchema } from '@/lib/validation/smsf';

// Reuses the certified retirement_members table for member identity (spec
// s.19-20) — no parallel member concept. member_interest_amount is
// informational attribution only (see migration 0084's comment on
// smsf_fund_members): the fund's own summary_balance/detailed_net_value is
// what reaches Net Worth, exactly once, regardless of how many members are
// attached here or what their individual interests sum to.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listSmsfMembers(id, user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfMemberSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await upsertSmsfMember(id, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}
