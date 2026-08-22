import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

// PostgREST caps an unbounded select at 1000 rows and reports the
// truncation ONLY in the Content-Range header — the response body is a
// perfectly well-formed array with no error. Confirmed live against DEV
// during Investment Intelligence R4/R5 work. A user with many accounts/
// instruments accumulating snapshots over time can exceed 1000 total
// ii_holding_snapshots rows; a plain select then silently drops the
// oldest of them, which can make a position whose most recent snapshot
// falls outside that window vanish from this list entirely — not merely
// stale. Same pagination pattern as analyticsRepository.ts's fetchAllRows.
type SnapshotRow = {
  id: string;
  account_id: string;
  instrument_id: string;
  as_of_date: string;
  units: number;
  value: number;
  currency_code: string;
  quality_status: string;
  created_at: string;
};

const PAGE_SIZE = 1000;

async function fetchAllSnapshots(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<SnapshotRow[]> {
  const out: SnapshotRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('ii_holding_snapshots')
      .select('id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, created_at')
      .eq('user_id', userId)
      .order('as_of_date', { ascending: false })
      // Secondary order on id: as_of_date alone is not unique across a
      // user's accounts/instruments, and an unstable tie-break across page
      // boundaries can silently drop or duplicate rows.
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as SnapshotRow[];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    // Defensive ceiling so a pathological dataset cannot spin forever.
    if (out.length > 500_000) break;
  }
  return out;
}

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

  let data: SnapshotRow[];
  try {
    data = await fetchAllSnapshots(supabase, user.id);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Failed to load holding snapshots');
  }

  // Collapse to latest-per-(account_id, instrument_id) in application code
  // — no window-function view exists yet in R1 (a reasonable future
  // optimisation, not required for the R1 acceptance gate's data volumes).
  const latestByPosition = new Map<string, SnapshotRow>();
  for (const row of data) {
    const key = `${row.account_id}:${row.instrument_id}`;
    if (!latestByPosition.has(key)) latestByPosition.set(key, row);
  }
  return ok([...latestByPosition.values()]);
}
