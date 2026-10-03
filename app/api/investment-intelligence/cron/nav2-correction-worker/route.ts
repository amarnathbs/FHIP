import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { isNav2FlagOn, NAV2_JOB_KEYS } from '@/lib/services/investment-intelligence/nav2/nav2Flags';
import { processNav2CorrectionEvents } from '@/lib/services/investment-intelligence/nav2/nav2ResultCacheStore';

/**
 * NAV2 Stage 2 -- the correction worker. Reads the unprocessed rows of nav2_correction_events (raised by the database
 * triggers of migration 0262 when a NAV, benchmark or risk-free value is corrected) and marks EXACTLY the shared-cache entries
 * a correction can affect as invalidated. It never edits a pinned report (an issued report is immutable; a later correction
 * means a new version) and never deletes a cache row.
 *
 * Same scheduled-job shape as every other cron route in this repository: POST with the shared `x-cron-secret` header compared
 * against CRON_SECRET. KILL SWITCH: the row nav2_correction_worker in ii_reference_job_control (migration 0260 ships it
 * DISABLED; a missing row or an unreadable switch is OFF). With the switch off nothing is read or written and the answer says so.
 * NOT SCHEDULED by this change: registering the schedule is a deliberate human step.
 *
 * Body (optional): { limit } (1 to 500, default 200).
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) return bad('Unauthorized', 401);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 500 ? body.limit : 200;

  const admin = createAdminClient();
  if (!(await isNav2FlagOn(admin, NAV2_JOB_KEYS.correctionWorker))) {
    return ok({ status: 'skipped_kill_switch', detail: 'The NAV2 correction worker is switched off; nothing was read or written.' });
  }
  try {
    const result = await processNav2CorrectionEvents(admin, limit);
    return ok({ status: 'completed', ...result });
  } catch (e) {
    console.error('[nav2] correction worker failed', e instanceof Error ? e.message : e);
    return bad('The correction worker failed.', 500);
  }
}
