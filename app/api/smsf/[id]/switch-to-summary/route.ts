import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { switchSmsfFundToSummary } from '@/lib/services/smsfData';
import { smsfSwitchToSummarySchema } from '@/lib/validation/smsf';

// SMSF-UI Detailed -> Summary switch-back (spec s.32-33, migration 0089).
// Unlike switch-to-detailed, this is not gated behind a reconciliation
// variance check — the user is explicitly providing a NEW Summary value
// that supersedes the Detailed figures, not reproducing them. Detailed
// holdings are preserved (never deleted) by the underlying RPC.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfSwitchToSummarySchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await switchSmsfFundToSummary(
    id,
    parsed.data.new_summary_balance,
    parsed.data.new_summary_balance_date,
    supabase
  );
  if (error) {
    const status = error.message.includes('already in summary mode') ? 409 : 400;
    return bad(error.message, status);
  }
  return ok({ summary_balance: data });
}
