import { ok, bad } from '@/lib/api';
import { runReferenceIngest } from '@/lib/services/investment-intelligence/pc6/referenceIngestJob';
import { PC6_REFERENCE_SOURCES } from '@/lib/config/investment-intelligence/pc6ReferenceSources';

/**
 * PC6 (M6) — the scheduled reference-market-data ingest endpoint (N.15).
 *
 * Follows the repository's one established scheduled-job shape exactly: the
 * shared `x-cron-secret` header compared against `process.env.CRON_SECRET`,
 * same as `app/api/aie/cron/purge-sweep/route.ts` (migration 0149) and
 * `app/api/financial-data-hub/documents/cron/purge-sweep/route.ts` (0135).
 * No new auth mechanism is invented for PC6.
 *
 * WHAT PC6 ADDS THAT NEITHER PREDECESSOR HAD:
 *   * A KILL SWITCH. Neither existing sweep has one — the only way to stop
 *     them is `cron.unschedule()` or rotating the Vault secret. This job reads
 *     `ii_reference_job_control` first and returns `skipped_kill_switch`
 *     without touching the source when it is off, and FAILS CLOSED when the
 *     control row is missing entirely.
 *   * A JOB-RUN LEDGER. Neither predecessor records its own invocations (they
 *     write per-item audit events, so "did the job run at all" was answerable
 *     only from pg_cron's internals). Every attempt here opens and closes a
 *     row in `ii_reference_import_batches`, which is what N.11's "failed
 *     import batches" and "last successful job" panels read.
 *
 * NOT SCHEDULED IN PRODUCTION. Migration 0155 registers no pg_cron job and
 * both control rows ship disabled, per this mission's binding override: an
 * autonomous agent may not activate a production job. The exact activation
 * steps live in docs/investment-intelligence/PC6_OPERATOR_RUNBOOK.md and are a
 * deferred human-present task.
 *
 * SAFE FAILURE. An unknown source id is a 422, not a silent no-op, and a
 * disabled source is refused by buildUrl() before any network call — so a
 * licence-blocked feed cannot be fetched even by a correctly-authenticated
 * caller.
 *
 * Body (all optional): { sourceConfigId, jobKey, asOfDate, fromDate, toDate,
 * dryRun, chunkSize }.
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
    body = {}; // an empty body is valid — the defaults below are the daily run
  }

  const sourceConfigId = typeof body.sourceConfigId === 'string' ? body.sourceConfigId : 'amfi_nav_daily';
  if (!(sourceConfigId in PC6_REFERENCE_SOURCES)) {
    return bad(`Unknown PC6 source '${sourceConfigId}'. Allowed: ${Object.keys(PC6_REFERENCE_SOURCES).join(', ')}`, 422);
  }

  const jobKey = typeof body.jobKey === 'string' ? body.jobKey : 'pc6_amfi_daily_nav';
  // Never defaulted to the machine clock inside the parser; supplied here,
  // once, so a clock-skewed host produces a visibly wrong as-of rather than a
  // silently admitted future NAV.
  const asOfDate = typeof body.asOfDate === 'string' ? body.asOfDate : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return bad('asOfDate must be ISO yyyy-mm-dd', 422);

  try {
    const result = await runReferenceIngest({
      jobKey,
      sourceConfigId,
      asOfDate,
      fromDate: typeof body.fromDate === 'string' ? body.fromDate : undefined,
      toDate: typeof body.toDate === 'string' ? body.toDate : undefined,
      chunkSize: typeof body.chunkSize === 'number' ? body.chunkSize : undefined,
      dryRun: body.dryRun === true,
    });
    // Counts and alert codes only. No source URL, no credential, no row
    // content — the same sanitised-output discipline the existing sweeps use.
    return ok({
      job_key: result.jobKey,
      status: result.status,
      batch_id: result.batchId,
      detail: result.detail,
      runner_version: result.runnerVersion,
      source_sha256: result.sourceSha256,
      counts: result.counts,
      alerts: result.alerts.map((a) => ({ severity: a.severity, code: a.code })),
    });
  } catch (err) {
    // Never an empty-body 500: on Amplify that reaches the browser as a
    // CloudFront error page with no diagnosis (the reason adminRoute exists).
    console.error('PC6 reference ingest error:', err);
    return bad(err instanceof Error ? err.message : 'Unexpected ingest error', 500);
  }
}
