import { ok, bad } from '@/lib/api';
import { enforceAieRawFileHardBackstop, findDuePurges, purgeExpiredMaskTokenMaps, runPurgeAttempt } from '@/lib/aie/services/purge';
import { sweepRealScanObjects } from '@/lib/aie/malware/scanObjectPurge';
import { enforceIiSourceDocumentRetentionBackstop } from '@/lib/services/investment-intelligence/sourceDocumentPurge';
import { releaseStaleAiCostReservations } from '@/lib/aie/cost/costAdmission';
import { createAdminClient } from '@/lib/supabase/admin';

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
 * precedent) — see migration `0149`'s own header for why the Vault SECRET
 * NAME is nonetheless kept distinct per-job.
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  const backstop = await enforceAieRawFileHardBackstop();

  // M3 (Phase 4) — the Product Owner's fixed, lifecycle-independent
  // mask-token TTL. Run FIRST and unconditionally, before any
  // document-lifecycle work, so that a failure or a slow binary purge later
  // in this handler can never delay or skip the retention guarantee. It
  // takes no input from the document sweep and gives none to it.
  const maskTokenTtl = await purgeExpiredMaskTokenMaps();

  const due = await findDuePurges();
  const results: Array<{ intakeId: string; status: string }> = [];
  for (const intake of due) {
    const result = await runPurgeAttempt(intake);
    results.push({ intakeId: intake.id, status: result.status });
  }

  // AIE-1 final completion (2026-09-25) -- three more backstops, each
  // independent of the others and of the document sweep above:
  //   1. the S3 copies made for GuardDuty (never deleted before this change)
  //      for every row with a terminal verdict, across FDH, AIE and II;
  //   2. the Investment Intelligence original-PDF retention backstop (24h);
  //   3. AI cost reservations never settled (crash / failed settle), settled
  //      conservatively at the full reservation after 60 minutes.
  // Counts only in the response; nothing identifying.
  const scanObjects = await sweepRealScanObjects();
  const iiBackstop = await enforceIiSourceDocumentRetentionBackstop(createAdminClient());
  const staleCostReservationsReleased = await releaseStaleAiCostReservations(60);

  return ok({
    real_scan_objects_attempted: scanObjects.attempted,
    real_scan_objects_purged: scanObjects.purged,
    real_scan_objects_not_purged: scanObjects.notPurged,
    real_scan_objects_not_purged_by_outcome: scanObjects.byOutcome,
    real_scan_object_table_errors: scanObjects.tableErrors.length,
    ii_retention_backstop_scanned: iiBackstop.scanned,
    ii_retention_backstop_purged: iiBackstop.purged,
    ii_retention_backstop_failed: iiBackstop.failed,
    stale_cost_reservations_released: staleCostReservationsReleased,
    mask_token_map_ttl_hours: maskTokenTtl.ttlHours,
    mask_token_map_rows_deleted: maskTokenTtl.deleted,
    hard_backstop_scanned: backstop.scanned,
    hard_backstop_forced: backstop.forcedPurgeCount,
    due_purges_attempted: due.length,
    purged: results.filter((r) => r.status === 'purged').length,
    already_purged: results.filter((r) => r.status === 'already_purged').length,
    skipped_no_object: results.filter((r) => r.status === 'skipped_no_object').length,
    failed: results.filter((r) => r.status === 'failed').length,
  });
}
