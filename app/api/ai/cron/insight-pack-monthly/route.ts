// Module 11 remediation R3 — the scheduled Monthly Insight Pack endpoint
// (brief sections 22-33; ADR-M11-002).
//
// Follows the repository's ONE established scheduled-job shape exactly (the
// same one app/api/reports/cron/monthly-generate, the FDH/AIE purge sweeps
// and the PC6 jobs use): a Supabase pg_cron + pg_net schedule POSTs here
// with the shared `x-cron-secret` header, compared against CRON_SECRET. No
// new auth mechanism, no in-process cron (Amplify's Next.js runtime is
// ephemeral — ADR decision 1).
//
// KILL SWITCHES (read fresh, never cached, inside the service):
//   ai_globally_enabled=false        -> both phases refuse.
//   batch_generation_enabled=false   -> submit refuses; reconcile still
//                                       collects already-paid-for batches.
//   scheduler_enabled=false          -> a CRON-triggered submit refuses
//                                       (ships false; migration 0176).
//   plus every per-household admission gate (ai_admit_request()).
//
// NOT SCHEDULED BY ANY MIGRATION (binding override: an autonomous agent
// does not activate a scheduled job). The cron.schedule statement an
// operator runs is in the ADR's runbook section.
//
// Body (all optional): { phase: 'submit'|'reconcile'|'both' (default 'both'),
//   dryRun: boolean, maxHouseholds: number, maxBatches: number, billingPeriod: 'YYYY-MM' }

import { ok, bad } from '@/lib/api';
import { createSchedulerService, getModule11SchedulerMaxHouseholdsPerRun } from '@/lib/ai/insightPack/scheduler';

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || !process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }
  const phase = body.phase === 'submit' || body.phase === 'reconcile' ? body.phase : 'both';
  const dryRun = body.dryRun === true;
  const maxHouseholds = typeof body.maxHouseholds === 'number' ? body.maxHouseholds : getModule11SchedulerMaxHouseholdsPerRun();
  const maxBatches = typeof body.maxBatches === 'number' ? body.maxBatches : undefined;
  const billingPeriod = typeof body.billingPeriod === 'string' && /^\d{4}-\d{2}$/.test(body.billingPeriod) ? body.billingPeriod : undefined;

  try {
    const service = createSchedulerService();
    // Reconcile FIRST so a batch submitted by the previous tick is collected
    // before this tick discovers more work.
    const reconcile = phase === 'submit' ? null : await service.runReconcilePhase({ triggeredBy: 'cron', maxBatches, billingPeriod });
    const submit = phase === 'reconcile' ? null : await service.runSubmitPhase({ triggeredBy: 'cron', dryRun, maxHouseholds, billingPeriod });
    return ok({ phase, reconcile, submit });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Scheduler run failed.', 500);
  }
}
