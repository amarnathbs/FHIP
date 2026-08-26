import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { resolvePriceFreshness } from '@/lib/engines/investment-intelligence/valuation/priceFreshness';

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
  // R6-P0 pagination closure: this read was unbounded, and PostgREST silently
  // caps an unbounded select at 1000 rows with no error. Because the rows are
  // ordered newest-first and then collapsed to latest-per-position below, a
  // truncated read does not merely shorten the list — a position whose most
  // recent snapshot falls past row 1000 (a dormant or fully-redeemed holding
  // in a household with dense recent history) DISAPPEARS from the user's
  // positions entirely. `id` is added as a unique tie-breaker because
  // ii_holding_snapshots is unique on (account_id, instrument_id, as_of_date),
  // so as_of_date alone repeats freely across positions.
  interface SnapshotRow {
    id: string;
    account_id: string;
    instrument_id: string;
    as_of_date: string;
    units: number;
    value: number;
    currency_code: string;
    quality_status: string;
    created_at: string;
    price_source: string | null;
  }
  let data: SnapshotRow[];
  try {
    data = await fetchAllRows<SnapshotRow>(() =>
      supabase
        .from('ii_holding_snapshots')
        .select('id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, created_at, price_source')
        .eq('user_id', user.id)
        .order('as_of_date', { ascending: false })
        .order('id', { ascending: true })
    );
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }

  // Collapse to latest-per-(account_id, instrument_id) in application code
  // — no window-function view exists yet in R1 (a reasonable future
  // optimisation, not required for the R1 acceptance gate's data volumes).
  const latestByPosition = new Map<string, (typeof data)[number]>();
  for (const row of data ?? []) {
    const key = `${row.account_id}:${row.instrument_id}`;
    if (!latestByPosition.has(key)) latestByPosition.set(key, row);
  }

  // R12 (spec sections 38-39): a manually-entered listed-security valuation
  // is never presented as today's price once it is stale. Only computed for
  // manual_entry-sourced rows — CAS-statement-derived mutual fund rows are
  // untouched (their NAV freshness is a different, T+1-disclosure concept
  // this module does not govern; leaving priceFreshness null for them is a
  // deliberate no-behaviour-change decision, not an oversight).
  const todayIso = new Date().toISOString().slice(0, 10);
  const positions = [...latestByPosition.values()].map((row) => ({
    ...row,
    priceFreshness: row.price_source === 'manual_entry' ? resolvePriceFreshness(row.as_of_date, todayIso) : null,
  }));
  return ok(positions);
}
