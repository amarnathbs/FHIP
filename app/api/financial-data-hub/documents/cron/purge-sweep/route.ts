import { ok, bad } from '@/lib/api';
import {
  enforceRawFileHardBackstop,
  findDuePurges,
  runPurgeAttempt,
  sweepAbandonedUploadSessions,
} from '@/lib/financial-data-hub/services/purge';

/**
 * LR-1 (Upload Security, Strict Raw-File Deletion & Document Lifecycle) —
 * the raw-document purge janitor. FDH-3 built the entire purge machinery
 * (`services/purge.ts`) but shipped it with no scheduled invocation path at
 * all (see that file's header). This is the single scheduled entry point
 * for every FDH ingestion pipeline (bank-csv, bank-pdf, payslip,
 * investment-statement, retirement-statement, liability-statement) — none
 * of them need their own cron wiring, because this sweep acts on
 * `fdh_statement_uploads` generically.
 *
 * Reuses the EXACT auth pattern already established by
 * `app/api/reports/cron/monthly-generate/route.ts`: a shared secret header,
 * no user session (there is none in a scheduled context). Never wired to
 * `pg_cron` directly (a purge attempt calls the Storage HTTP API, which SQL
 * cannot do) — invoked by an external scheduler (or manually for DEV
 * verification) via `pg_net`/a hosted cron trigger, same as the existing
 * reports cron.
 *
 * Order matters: abandoned sessions and the hard backstop must both run
 * BEFORE `findDuePurges`, since either one can newly mark a document
 * purge-due; running them first means a single sweep call catches
 * everything due in that pass rather than needing two round trips.
 *
 * Logging/response discipline (LR-1 threat table: "log leakage" /
 * "DB raw-content leakage"): the response and any server log here carry only
 * counts and document ids — never a storage key, a signed URL, a filename,
 * or a raw purge-attempt error message beyond what `runPurgeAttempt` has
 * already sanitised and capped.
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  const abandonedSessionsSwept = await sweepAbandonedUploadSessions();
  const backstop = await enforceRawFileHardBackstop();

  const due = await findDuePurges();
  const results: Array<{ documentId: string; status: string }> = [];
  for (const document of due) {
    const result = await runPurgeAttempt(document);
    results.push({ documentId: document.id, status: result.status });
  }

  return ok({
    abandoned_sessions_swept: abandonedSessionsSwept,
    hard_backstop_scanned: backstop.scanned,
    hard_backstop_forced: backstop.forcedPurgeCount,
    due_purges_attempted: due.length,
    purged: results.filter((r) => r.status === 'purged').length,
    already_purged: results.filter((r) => r.status === 'already_purged').length,
    skipped_no_object: results.filter((r) => r.status === 'skipped_no_object').length,
    failed: results.filter((r) => r.status === 'failed').length,
  });
}
