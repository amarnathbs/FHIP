import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { recertifyPosition } from '@/lib/services/investment-intelligence/documentProcessing';
import { z } from 'zod';

// R2 — "certify/re-certify portfolio" (spec section 51). Ownership is
// verified here (the account must belong to the caller) BEFORE calling
// the service-role-backed recertifyPosition() — the service function
// re-checks ownership again internally too (defence in depth, matching
// the pattern every other R1/R2 service-role call site in this codebase
// already uses).
const certifySchema = z.object({
  accountId: z.string().uuid(),
  instrumentId: z.string().uuid(),
});

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = certifySchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data: account } = await supabase.from('ii_accounts').select('id').eq('id', parsed.data.accountId).eq('user_id', user.id).maybeSingle();
  if (!account) return bad('Account not found.', 404);

  const result = await recertifyPosition(user.id, parsed.data.accountId, parsed.data.instrumentId);
  if (!result.ok) return bad(result.error ?? 'Certification evaluation failed.', 500);

  const { data: status, error } = await supabase
    .from('ii_portfolio_truth_status')
    .select('*')
    .eq('user_id', user.id)
    .eq('account_id', parsed.data.accountId)
    .eq('instrument_id', parsed.data.instrumentId)
    .maybeSingle();
  if (error) return bad(error.message);
  return ok(status);
}
