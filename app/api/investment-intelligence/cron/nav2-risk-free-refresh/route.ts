import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { isNav2FlagOn, NAV2_JOB_KEYS } from '@/lib/services/investment-intelligence/nav2/nav2Flags';
import { createGatewayAiReader } from '@/lib/services/investment-intelligence/nav2/rbiAiReader';
import { createLiveRbiSource } from '@/lib/services/investment-intelligence/nav2/rbiSource';
import { runRiskFreeRefresh } from '@/lib/services/investment-intelligence/nav2/riskFreeRefreshJob';

/**
 * NAV2 Stage 2 -- the weekly RBI risk-free refresh (PO decision 03-10-2026: automated, AI-assisted, default OFF with a dry run).
 *
 * Same scheduled-job shape as every other cron route here: POST with the shared `x-cron-secret` header compared against CRON_SECRET.
 *
 * TWO INDEPENDENT SAFETY LAYERS, both fail closed:
 *   1. KILL SWITCH: the row nav2_risk_free_weekly_refresh in ii_reference_job_control (migration 0260 ships it DISABLED; a missing row or an
 *      unreadable switch is OFF). Off = the job makes NO request to RBI and writes nothing; the answer says so.
 *   2. DRY RUN BY DEFAULT: the job writes only when the body says `"dryRun": false` explicitly. Anything else (no body, true, a string) is a
 *      dry run: it reads RBI, decides, reports what it WOULD do, and writes nothing.
 * The AI second opinion additionally needs the AIE gateway switch (AIE_AI_FALLBACK_ENABLED) ON; with it off the job runs on the parser
 * alone and a changed layout becomes an admin review item rather than a guess.
 *
 * NOT SCHEDULED by this change: registering the weekly schedule, switching the row on, and the first live run are deliberate human steps
 * after a DEV dry run (Stage 3). The answer is sanitised: counts, outcomes and reasons only, never a page body, URL query or credential.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) return bad('Unauthorized', 401);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const dryRun = body.dryRun !== false;

  const admin = createAdminClient();
  const enabled = await isNav2FlagOn(admin, NAV2_JOB_KEYS.riskFreeWeeklyRefresh);
  const todayIso = new Date().toISOString().slice(0, 10);
  try {
    const report = await runRiskFreeRefresh({ admin, source: createLiveRbiSource(), ai: createGatewayAiReader(), enabled, dryRun, todayIso });
    if (report.mode === 'live') {
      const nowIso = new Date().toISOString();
      const failed = report.fetchProblem !== null;
      if (failed) {
        const { data } = await admin.from('ii_reference_job_control').select('consecutive_failures').eq('job_key', NAV2_JOB_KEYS.riskFreeWeeklyRefresh).maybeSingle();
        await admin.from('ii_reference_job_control').update({ last_failure_at: nowIso, consecutive_failures: ((data as { consecutive_failures?: number } | null)?.consecutive_failures ?? 0) + 1, updated_at: nowIso }).eq('job_key', NAV2_JOB_KEYS.riskFreeWeeklyRefresh);
      } else {
        await admin.from('ii_reference_job_control').update({ last_success_at: nowIso, consecutive_failures: 0, updated_at: nowIso }).eq('job_key', NAV2_JOB_KEYS.riskFreeWeeklyRefresh);
      }
    }
    return ok(report);
  } catch (e) {
    console.error('[nav2] risk-free refresh failed', e instanceof Error ? e.message : e);
    return bad('The risk-free refresh failed.', 500);
  }
}
