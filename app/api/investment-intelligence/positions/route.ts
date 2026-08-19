import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

// Lists canonical positions for the user — the latest certified/observed
// ii_holding_snapshots row per (account_id, instrument_id), per
// R0_CANONICAL_IDENTIFIER_STRATEGY.md's "stable cross-time identity" note
// (each snapshot is a new immutable row; "current" is resolved by picking
// the latest one). Reads only through the RLS-respecting client — no
// service-role use on this user-facing path (R0_SECURITY_RLS_ARCHITECTURE.md).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('ii_holding_snapshots')
    .select('id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, created_at')
    .eq('user_id', user.id)
    .order('as_of_date', { ascending: false });
  if (error) return bad(error.message);

  // Collapse to latest-per-(account_id, instrument_id) in application code
  // — no window-function view exists yet in R1 (a reasonable future
  // optimisation, not required for the R1 acceptance gate's data volumes).
  const latestByPosition = new Map<string, (typeof data)[number]>();
  for (const row of data ?? []) {
    const key = `${row.account_id}:${row.instrument_id}`;
    if (!latestByPosition.has(key)) latestByPosition.set(key, row);
  }
  return ok([...latestByPosition.values()]);
}
