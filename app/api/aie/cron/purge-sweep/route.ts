import { ok, bad } from '@/lib/api';
import { enforceAieRawFileHardBackstop, findDuePurges, runPurgeAttempt } from '@/lib/aie/services/purge';

/**
 * AIE-1 closure mission (sections 4 & 9) — the AIE temporary-document purge
 * janitor. Mirrors `app/api/financial-data-hub/documents/cron/purge-sweep/
 * route.ts` exactly (same shared-secret auth pattern, same "backstop before
 * find-due" ordering, same sanitised-output-only discipline) — AIE had this
 * machinery entirely missing before this mission (see
 * `lib/aie/services/purge.ts`'s own header).
 *
 * This is the BACKSTOP path only. The PRIMARY deletion path is immediate,
 * called directly by each intake route right after its pipeline run
 * concludes (`finalizeDocumentBinaryAfterRun`) — this sweep exists to catch
 * what that primary path missed (a crash before it ran, a transient storage
 * failure, or a stuck/abandoned intake past the 24-hour hard maximum age).
 *
 * Reuses the SAME `CRON_SECRET` env var as the FDH purge-sweep route (one
 * shared platform secret, matching this app's one existing scheduled-job
 * precedent) — see migration `0147`'s own header for why the Vault SECRET
 * NAME is nonetheless kept distinct per-job.
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  const backstop = await enforceAieRawFileHardBackstop();

  const due = await findDuePurges();
  const results: Array<{ intakeId: string; status: string }> = [];
  for (const intake of due) {
    const result = await runPurgeAttempt(intake);
    results.push({ intakeId: intake.id, status: result.status });
  }

  return ok({
    hard_backstop_scanned: backstop.scanned,
    hard_backstop_forced: backstop.forcedPurgeCount,
    due_purges_attempted: due.length,
    purged: results.filter((r) => r.status === 'purged').length,
    already_purged: results.filter((r) => r.status === 'already_purged').length,
    skipped_no_object: results.filter((r) => r.status === 'skipped_no_object').length,
    failed: results.filter((r) => r.status === 'failed').length,
  });
}
