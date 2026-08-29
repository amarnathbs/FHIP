import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// R2 — "retrieve certified holdings/transactions for R2 view" (spec
// section 51): lists every ii_portfolio_truth_status row (one per
// account+instrument position) for the requesting user. RLS-respecting
// client only.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('ii_portfolio_truth_status')
    .select(
      'id, account_id, instrument_id, status, history_completeness, reconciled_opening_units, reconciled_closing_units, statement_closing_units, unit_variance, unit_variance_within_tolerance, blocking_reasons, warning_reasons, certified_at, last_evaluated_at, latest_holding_snapshot_id, latest_source_document_id'
    )
    .eq('user_id', user.id)
    .order('last_evaluated_at', { ascending: false });
  if (error) return bad(error.message);
  return ok(data);
}
