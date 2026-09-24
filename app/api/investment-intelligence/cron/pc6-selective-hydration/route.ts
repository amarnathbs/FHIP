import { ok, bad } from '@/lib/api';
import { runSelectiveHistoricalHydration } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { createLiveHydrationDeps } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';
import { AmfiHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/amfiHistoricalAdapter';
import { FallbackHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/fallbackHistoricalAdapter';

/**
 * NAV 1.23/1.26 — the scheduled selective-historical-hydration endpoint.
 *
 * Follows the repository's ONE established scheduled-job shape exactly, the
 * same one `app/api/investment-intelligence/cron/pc6-reference-ingest/route.ts`
 * (PC6's own daily/scheme-master job) already uses: the shared
 * `x-cron-secret` header compared against `process.env.CRON_SECRET`. No new
 * auth mechanism is invented for NAV 1.
 *
 * KILL SWITCH. `runSelectiveHistoricalHydration()` itself reads
 * `ii_reference_job_control.pc6_selective_historical_hydration` FIRST and
 * returns `skipped_kill_switch` without calling any adapter or writing
 * anything when it is off, and fails closed when the control row is
 * missing entirely — same discipline as every other PC6 job. Migration
 * `0166` ships that row DISABLED; this route existing does not itself
 * activate anything.
 *
 * NOT SCHEDULED IN PRODUCTION OR DEV BY THIS DISPATCH. No pg_cron job is
 * registered by any NAV 1 migration, per this mission's binding override
 * (an autonomous agent may not activate a production or scheduled job).
 * The exact `cron.schedule(...)` statement for a human operator to run is
 * documented in docs/investment-intelligence/PC6_OPERATOR_RUNBOOK.md
 * alongside the existing pc6-reference-ingest entry.
 *
 * BLAST-RADIUS BOUND. `maxInstruments` defaults to 50 per invocation
 * (mirrors the CHUNK_SIZE discipline used throughout PC6) so a single cron
 * tick cannot fan out into an unbounded number of TIGZIG requests.
 *
 * Body (all optional): { dryRun, maxInstruments, changeoverDate }.
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {}; // an empty body is valid — the defaults below are the standard run
  }

  const changeoverDate = typeof body.changeoverDate === 'string' ? body.changeoverDate : undefined;
  if (!changeoverDate) {
    // Never defaulted to the machine clock: the changeover date is a policy
    // constant (this programme's PO decision, 2026-09-21), not a moving
    // "today". A caller must supply it explicitly, exactly like asOfDate on
    // the sibling ingest route is supplied rather than assumed.
    return bad('changeoverDate is required (ISO yyyy-mm-dd) — the NAV 1 policy changeover date, not "today".', 422);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(changeoverDate)) return bad('changeoverDate must be ISO yyyy-mm-dd', 422);

  try {
    const result = await runSelectiveHistoricalHydration({
      changeoverDate,
      // NAV 1 Stage D (D.3, PO 2026-09-24): AMFI primary, TIGZIG fallback.
      adapter: new FallbackHistoricalAdapter(new AmfiHistoricalAdapter(), new TigzigHistoricalAdapter()),
      deps: createLiveHydrationDeps(),
      dryRun: body.dryRun === true,
      maxInstruments: typeof body.maxInstruments === 'number' ? body.maxInstruments : undefined,
    });
    // Sanitised output: counts and per-instrument outcomes only, never a
    // provider request URL, credential, or raw response body.
    return ok({
      status: result.status,
      detail: result.detail,
      instruments_considered: result.instrumentsConsidered,
      instruments_needing_hydration: result.instrumentsNeedingHydration,
      instruments_already_covered: result.instrumentsAlreadyCovered,
      instruments_hydrated: result.instrumentsHydrated,
      instruments_failed: result.instrumentsFailed,
      total_rows_inserted: result.totalRowsInserted,
      per_instrument: result.perInstrument.map((p) => ({
        instrument_id: p.instrumentId,
        reasons: p.reasons,
        required_from_date: p.requiredFromDate,
        outcome: p.outcome,
        rows_inserted: p.rowsInserted,
      })),
    });
  } catch (err) {
    console.error('NAV 1 selective hydration error:', err);
    return bad(err instanceof Error ? err.message : 'Unexpected hydration error', 500);
  }
}
