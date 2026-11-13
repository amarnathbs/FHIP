import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { stepFetchPolicy } from '@/lib/engines/nav2/riskFreeRefreshGate';
import { NAV2_JOB_KEYS, readNav2Flag } from '@/lib/services/investment-intelligence/nav2/nav2Flags';
import { createGatewayAiReader } from '@/lib/services/investment-intelligence/nav2/rbiAiReader';
import { liveFetcherDeps, PoliteRbiFetcher } from '@/lib/services/investment-intelligence/nav2/rbiFetcher';
import { createLiveRbiSource } from '@/lib/services/investment-intelligence/nav2/rbiSource';
import { createSupabaseStageStore, runRefreshStep } from '@/lib/services/investment-intelligence/nav2/riskFreeRefreshSteps';
import { createResendMailer } from '@/lib/services/premiumReminderMailer';

/**
 * NAV2 Stage 2 -- the weekly RBI risk-free refresh (PO decision 03-10-2026: automated, default OFF with a dry run).
 *
 * Same scheduled-job shape as every other cron route here: POST with the shared `x-cron-secret` header compared against CRON_SECRET.
 *
 * ONE STEP PER CALL (09-11-2026). Amplify ends every request at 28 seconds whatever `maxDuration` says, and the whole read (robots.txt, the month
 * listing, the release, the weekly page, paced politely) did not fit: the first production dry run came back as HTTP 504. So each call does the
 * NEXT of three short steps -- listing, release, decide -- and remembers what it read in ii_risk_free_refresh_stage; the schedule calls the route a
 * few times, five minutes apart. A call with nothing to do (the week is done, or RBI refused and the job is cooling off) makes no request to RBI.
 * See lib/services/investment-intelligence/nav2/riskFreeRefreshSteps.ts.
 *
 * TWO INDEPENDENT SAFETY LAYERS, both fail closed:
 *   1. KILL SWITCH: the row nav2_risk_free_weekly_refresh in ii_reference_job_control (migration 0260 ships it DISABLED; a missing row or an
 *      unreadable switch is OFF). Off = the job makes NO request to RBI and writes nothing; the answer says so.
 *   2. DRY RUN BY DEFAULT: the job writes a rate or a review item only when the body says `"dryRun": false` explicitly. Anything else (no body, true,
 *      a string) is a dry run: it reads RBI, decides, reports what it WOULD do, and writes no rate. (A dry run's only write is the scratch row in the
 *      stage table, which is how the three steps hand their readings on.)
 * The AI second opinion needs the AIE gateway switch AND a person to attribute the call to; the cron has no person, so the cron run is the fixed
 * reader plus the weekly-page cross-check, and a changed layout becomes an administrator review item rather than a guess.
 *
 * CATCH-UP AND ALERT (PO decision 13-11-2026). Each call first works out which of the last four weekly auctions has no stored row and works on the
 * current week, then on a missed earlier one. A case that needs a person (RBI refused a page, a result was not published, the week is still not loaded
 * after the Saturday retry) is recorded once as a review item and e-mailed once, to RISK_FREE_ALERT_TO_EMAIL through the existing Resend path. Without
 * that setting nothing is sent and everything else is unchanged. A dry run never sends.
 *
 * The answer is sanitised: counts, outcomes and reasons only, never a page body, URL query or credential.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 28;

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
  const flag = await readNav2Flag(admin, NAV2_JOB_KEYS.riskFreeWeeklyRefresh);
  const now = new Date();
  const alertTo = (process.env.RISK_FREE_ALERT_TO_EMAIL ?? '').trim();
  try {
    const { report, attempt } = await runRefreshStep({
      admin,
      store: createSupabaseStageStore(admin),
      makeSource: (step, robots) => createLiveRbiSource(new PoliteRbiFetcher(liveFetcherDeps, stepFetchPolicy(step), robots)),
      ai: createGatewayAiReader(),
      enabled: flag.on,
      dryRun,
      todayIso: now.toISOString().slice(0, 10),
      nowIso: now.toISOString(),
      nowMs: () => Date.now(),
      alert: alertTo ? { mailer: createResendMailer(), to: alertTo } : null,
    });
    if (attempt) {
      const nowIso = new Date().toISOString();
      // One row per LIVE week-ending or failed call (migration 0263): what robots.txt did and whether RBI blocked a content page. Best effort: the
      // run's own result never depends on it, and an unapplied migration only means the monitoring page shows "not available".
      const { failed, ...row } = attempt;
      const logged = await admin.from('ii_risk_free_refresh_attempts').insert(row);
      if (logged.error) console.error('[nav2] refresh attempt record failed', logged.error.message);
      if (failed) {
        const { data } = await admin.from('ii_reference_job_control').select('consecutive_failures').eq('job_key', NAV2_JOB_KEYS.riskFreeWeeklyRefresh).maybeSingle();
        await admin.from('ii_reference_job_control').update({ last_failure_at: nowIso, consecutive_failures: ((data as { consecutive_failures?: number } | null)?.consecutive_failures ?? 0) + 1, updated_at: nowIso }).eq('job_key', NAV2_JOB_KEYS.riskFreeWeeklyRefresh);
      } else {
        await admin.from('ii_reference_job_control').update({ last_success_at: nowIso, consecutive_failures: 0, updated_at: nowIso }).eq('job_key', NAV2_JOB_KEYS.riskFreeWeeklyRefresh);
      }
    }
    // The answer says WHY the switch read as it did: a failed read of the switch (an unreachable or restricted database) is reported as OFF, fail
    // closed, and must not look like a job that was switched off on purpose.
    return ok({ ...report, switchRead: flag });
  } catch (e) {
    console.error('[nav2] risk-free refresh failed', e instanceof Error ? e.message : e);
    return bad('The risk-free refresh failed.', 500);
  }
}
