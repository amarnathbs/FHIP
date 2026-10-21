import { ok, bad } from '@/lib/api';
import { advanceNextBankImportJob } from '@/lib/financial-data-hub/services/bankImportWorker';
import { sweepStaleStaging } from '@/lib/financial-data-hub/services/bankImportJobStore';
import { BANK_IMPORT_SLICE_BUDGET_MS } from '@/lib/financial-data-hub/bankImport/jobModel';

// POST /api/financial-data-hub/bank-import-jobs/cron/advance -- the SCHEDULED BACKSTOP for bank statement import jobs.
//
// The browser normally drives a job (POST .../{jobId}/advance). This route exists for the jobs nobody is driving any more: a closed
// tab, a laptop that went to sleep, a slice the platform killed. Each call claims the most overdue unfinished job nobody holds
// (database clock, one winner) and advances it by one slice, repeating while there is time, then sweeps staging left behind by
// finished jobs. Same scheduled-job shape as every cron route in this repository: POST with the shared `x-cron-secret` header
// compared against CRON_SECRET. Idempotent and safe to run on any cadence, concurrently with browsers and with itself.
//
// NOT SCHEDULED by this change: registering the schedule is a deliberate human step (docs/reviews/po_apply_wp_g). Without it jobs
// still advance while the person has the page open; a closed page then waits for the next time it is opened.
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
      const out = await advanceNextBankImportJob({ sliceBudgetMs: Math.min(BANK_IMPORT_SLICE_BUDGET_MS, remaining - 4_000) });
      if (!out || out.kind !== 'advanced') break;
      outcomes.push({ phase: out.job.phase, status: out.job.status });
    }
    const swept = await sweepStaleStaging();
    return ok({ slices: outcomes.length, outcomes, staging_swept: swept });
  } catch (e) {
    console.error('[bank-import/cron] failed', e instanceof Error ? e.message : String(e));
    return bad('The bank import backstop failed.', 500);
  }
}
