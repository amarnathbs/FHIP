import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { advanceNextStatementJob } from '@/lib/services/investment-intelligence/statementJob/worker';
import { sweepStaleStaging } from '@/lib/services/investment-intelligence/statementJob/store';
import { closeAllDeadParseRuns } from '@/lib/services/investment-intelligence/statementJob/deadRuns';
import { STATEMENT_JOB_SLICE_BUDGET_MS } from '@/lib/services/investment-intelligence/statementJob/model';

// POST /api/investment-intelligence/statement-jobs/cron/advance -- the SCHEDULED BACKSTOP for statement jobs.
//
// The browser normally drives a job (POST .../{jobId}/advance). This route exists for the jobs nobody is driving any more: a closed tab, a
// laptop that went to sleep, a slice the platform killed. Each call claims the most overdue unfinished job nobody holds (database clock,
// one winner) and advances it by one slice, repeating while there is time; then it closes parse runs that are dead (a run is alive only
// while a live job or a very recent synchronous request stands behind it) and sweeps staging left behind by ended jobs. Same
// scheduled-job shape as every cron route in this repository: POST with the shared x-cron-secret header compared against CRON_SECRET.
// Idempotent and safe on any cadence, concurrently with browsers and with itself.
//
// A protected statement that is still to be read cannot be opened here (the password is never stored): it waits for the person.
//
// NOT SCHEDULED by this change: registering the schedule is a deliberate human step (docs/reviews/po_apply_wp_j).
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const CALL_BUDGET_MS = 22_000;
const MAX_SLICES_PER_CALL = 6;

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) return bad('Unauthorized', 401);

  const started = Date.now();
  const outcomes: Array<{ phase: string; status: string }> = [];
  try {
    for (let i = 0; i < MAX_SLICES_PER_CALL; i += 1) {
      const remaining = CALL_BUDGET_MS - (Date.now() - started);
      if (remaining < 6_000) break;
      const out = await advanceNextStatementJob({ sliceBudgetMs: Math.min(STATEMENT_JOB_SLICE_BUDGET_MS, remaining - 4_000) });
      if (!out || out.kind !== 'advanced') break;
      outcomes.push({ phase: out.job.phase, status: out.job.status });
    }
    const closedRuns = await closeAllDeadParseRuns(createAdminClient());
    const swept = await sweepStaleStaging();
    return ok({ slices: outcomes.length, outcomes, dead_runs_closed: closedRuns, staging_swept: swept });
  } catch (e) {
    console.error('[statement-job/cron] failed', e instanceof Error ? e.message : String(e));
    return bad('The statement backstop failed.', 500);
  }
}
