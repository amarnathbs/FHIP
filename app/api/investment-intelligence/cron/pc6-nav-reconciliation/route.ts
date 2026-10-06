import { ok, bad } from '@/lib/api';
import { runNavReconciliationSweep } from '@/lib/services/investment-intelligence/pc6/navReconciliationSweep';
import { PC6_REFERENCE_SOURCES } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import { PC6_INGEST_MAX_HTTP_BUDGET_MS } from '@/lib/services/investment-intelligence/pc6/ingestBudget';

function httpBudgetMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(v, PC6_INGEST_MAX_HTTP_BUDGET_MS);
}

/**
 * PC6/NAV 1 — the reconciliation-sweep endpoint (PO decision #1, 27 Sep 2026).
 *
 * Same auth/shape discipline as app/api/investment-intelligence/cron/
 * pc6-reference-ingest/route.ts: the shared x-cron-secret header, a kill
 * switch checked first (ii_reference_job_control, via runNavReconciliationSweep's
 * own decideStart()), a job-run ledger row for every attempt that actually
 * does work.
 *
 * WHAT THIS ROUTE ADDS OVER THE MAIN INGEST ROUTE: it fetches only when its
 * own coverage precheck finds a real gap for the publication date (never a
 * full-universe rewrite — see navReconciliationSweep.ts), and it marks the
 * publication date "complete" in ii_reference_publication_coverage plus
 * raises/resolves a queryable ii_reference_coverage_alerts row — there is no
 * external alerting system in this repository.
 *
 * ALSO USED FOR THE ONE-OFF BACKFILL (docs/nav1/po_run_2026-09-27b/): the same
 * job/job-control row, called with sourceConfigId 'amfi_nav_history' and a
 * past publicationDate, since the history endpoint genuinely serves any past
 * date (unlike NAVAll.txt, which carries only each scheme's latest NAV).
 *
 * Body (all optional): { sourceConfigId, jobKey, publicationDate, dryRun,
 * chunkSize, budgetMs }. publicationDate defaults to the server clock's
 * current UTC date — the scheduled call never supplies one, so "the current
 * publication date" is always read from the clock at call time, never from a
 * cron-body constant that would go stale.
 */
export async function POST(req: Request) {
  const startedAtMs = Date.now();
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const sourceConfigId = typeof body.sourceConfigId === 'string' ? body.sourceConfigId : 'amfi_nav_daily';
  if (!(sourceConfigId in PC6_REFERENCE_SOURCES)) {
    return bad(`Unknown PC6 source '${sourceConfigId}'. Allowed: ${Object.keys(PC6_REFERENCE_SOURCES).join(', ')}`, 422);
  }

  const jobKey = typeof body.jobKey === 'string' ? body.jobKey : 'pc6_amfi_daily_nav_reconciliation';
  const publicationDate = typeof body.publicationDate === 'string' ? body.publicationDate : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)) return bad('publicationDate must be an ISO 8601 calendar date', 422);

  try {
    const result = await runNavReconciliationSweep({
      jobKey,
      sourceConfigId,
      publicationDate,
      chunkSize: typeof body.chunkSize === 'number' ? body.chunkSize : undefined,
      dryRun: body.dryRun === true,
      startedAtMs,
      budgetMs: httpBudgetMs(body.budgetMs),
    });
    return ok({
      job_key: result.jobKey,
      status: result.status,
      detail: result.detail,
      batch_id: result.batchId,
      publication_date: result.publicationDate,
      source_config_id: result.sourceConfigId,
      coverage: result.coverage,
      alert: result.alert,
      counts: result.counts,
    });
  } catch (err) {
    console.error('PC6 NAV reconciliation error:', err);
    return bad(err instanceof Error ? err.message : 'Unexpected reconciliation error', 500);
  }
}
