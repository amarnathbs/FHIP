import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { switchSmsfFundToDetailed } from '@/lib/services/smsfData';

// SMSF-6 hard financial-integrity gate (spec s.24 steps 5-7). The
// smsf_switch_to_detailed() RPC (migration 0084) computes the Detailed net
// value server-side and REQUIRES it to equal the Summary balance to the
// cent before flipping mode — this is not a client-trust check. On a
// variance, the DB raises and this surfaces it as a 409 with the exact
// unresolved amount so the UI can tell the user what to fix; the fund stays
// in Summary mode, current_balance is untouched.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data, error } = await switchSmsfFundToDetailed(id, supabase);
  if (error) {
    const status = error.message.includes('unresolved Net Worth variance') ? 409 : 400;
    return bad(error.message, status);
  }
  return ok({ detailed_net_value: data });
}
