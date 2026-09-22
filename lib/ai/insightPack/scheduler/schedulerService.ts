// Module 11 remediation R3 — AIInsightPackSchedulerService (brief sections
// 22-33; ADR-M11-002). Makes the Monthly Personalised Insight Pack genuinely
// monthly, asynchronous, cost-controlled, resumable and idempotent — on top
// of the EXISTING AIInsightPackBatchOrchestrator (submit/reconcile phases)
// and the EXISTING per-household admission/grounding/persistence pipeline.
// Nothing here talks to a provider; nothing here relaxes a gate.
//
// TWO PHASES, EACH A SEPARATE, LEASE-LOCKED, IDEMPOTENT INVOCATION:
//
//   submit    discover eligible subjects for the current billing period ->
//             record one job row per subject (unique per period: the
//             duplicate-suppression ledger) -> build each subject's certified
//             context WITHOUT a user session -> apply the section 25 rules
//             (Premium; certified current snapshot; no equivalent current
//             pack; batch switch on; cost budget via admission) -> ONE
//             provider batch submission via the orchestrator -> jobs
//             SUBMITTED / SKIPPED / FAILED.
//
//   reconcile poll every SUBMITTED batch whose next_poll_at has passed ->
//             the orchestrator rebuilds + hash-verifies each context, applies
//             results by requestId, finalises/refunds reservations -> jobs
//             READY / PARTIAL / FAILED. Pending batches stay for next tick.
//
// NO CALENDAR-ONLY GENERATION (section 26): "it is a new month" only opens
// a new billing-period ledger; a subject with no certified snapshot is
// SKIPPED, not generated. Being discovered is not being generated.
//
// COST CONTROL: every admission still goes through ai_admit_request() with
// its per-request / per-user / platform / daily / task ceilings; in
// addition maxHouseholdsPerRun bounds the blast radius of one tick, and
// dryRun performs discovery + skip classification with NO job rows and NO
// submission — the section 33 DEV proof path.

import { AIInsightPackBatchOrchestrator, type BatchHouseholdInput, type HouseholdBatchOutcome } from '@/lib/ai/insightPack/batchOrchestrator';
import type { InsightPackBatchDbClient } from '@/lib/ai/insightPack/batchTypes';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { hashContext } from '@/lib/ai/audit/aiRuns';
import { PACK_SCHEMA_VERSION } from '@/lib/ai/insightPack/types';
import type { ReconcilePhaseResult, SchedulerContextBuilder, SchedulerDbClient, SchedulerTrigger, SubmitPhaseResult } from '@/lib/ai/insightPack/scheduler/types';

export const SCHEDULER_LEASE_SECONDS = 900;
export const DEFAULT_MAX_HOUSEHOLDS_PER_RUN = 50;
export const DEFAULT_MAX_BATCHES_PER_RECONCILE = 10;

/** UTC calendar month, matching ai_usage_ledger.billing_period / ai_billing_period_for(). */
export function currentBillingPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type SkipReason =
  | 'not_premium'
  | 'context_uncertified'
  | 'no_certified_snapshot'
  | 'context_build_failed'
  | 'current_pack_exists'
  | 'run_bound_reached';

export class AIInsightPackSchedulerService {
  constructor(
    private readonly db: SchedulerDbClient,
    private readonly batchDb: InsightPackBatchDbClient,
    private readonly orchestrator: AIInsightPackBatchOrchestrator,
    private readonly buildContext: SchedulerContextBuilder,
    private readonly isPremiumEligible: (userId: string, householdId: string | null) => Promise<boolean>,
    private readonly promptVersionResolver: () => Promise<number | null>
  ) {}

  async runSubmitPhase(input: { triggeredBy: SchedulerTrigger; dryRun?: boolean; maxHouseholds?: number; billingPeriod?: string; now?: Date }): Promise<SubmitPhaseResult> {
    const billingPeriod = input.billingPeriod ?? currentBillingPeriod(input.now);
    const dryRun = input.dryRun === true;
    const maxHouseholds = Math.max(1, Math.min(input.maxHouseholds ?? DEFAULT_MAX_HOUSEHOLDS_PER_RUN, 500));
    const base: SubmitPhaseResult = { runId: null, status: 'SKIPPED', reason: null, billingPeriod, dryRun, discovered: 0, skipped: 0, submitted: 0, failed: 0, batchId: null, providerBatchId: null, skipReasons: {} };

    // ---- Switches (fail closed on a missing controls row) ----
    const controls = await this.db.getControls();
    if (!controls) return { ...base, reason: 'controls_unavailable' };
    if (!controls.ai_globally_enabled) return { ...base, reason: 'ai_disabled' };
    if (!controls.batch_generation_enabled) return { ...base, reason: 'batch_disabled' };
    if (!controls.scheduler_enabled && input.triggeredBy === 'cron') return { ...base, reason: 'scheduler_disabled' };

    // ---- Lease claim (the DB is the lock) ----
    const runId = await this.db.claimRun('submit', input.triggeredBy, billingPeriod, SCHEDULER_LEASE_SECONDS, dryRun);
    if (!runId) return { ...base, reason: 'lease_held_by_another_run' };
    const result: SubmitPhaseResult = { ...base, runId, status: 'COMPLETED' };

    try {
      // ---- Discovery (section 25) ----
      const alreadyProcessed = await this.db.listJobSubjectsForPeriod(billingPeriod);
      const universe = await this.db.listPremiumSubjects(maxHouseholds * 4);
      const candidates = universe.filter((s) => !alreadyProcessed.has(s.userId));
      const promptVersion = await this.promptVersionResolver();

      const items: BatchHouseholdInput[] = [];
      const jobIdByUser = new Map<string, string>();
      const skip = (reason: SkipReason) => { result.skipped += 1; result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + 1; };

      for (const subject of candidates) {
        if (items.length >= maxHouseholds) { skip('run_bound_reached'); continue; } // not recorded as a job — picked up next tick
        result.discovered += 1;

        let skipReason: SkipReason | null = null;
        let context: FinancialContextObject | null = null;
        if (!(await this.isPremiumEligible(subject.userId, subject.householdId))) skipReason = 'not_premium';
        if (!skipReason) {
          try {
            context = await this.buildContext(subject.userId);
          } catch {
            skipReason = 'context_build_failed';
          }
        }
        if (!skipReason && context) {
          if (context.meta.certification_status === 'UNAVAILABLE' || context.meta.certification_status === 'INVALID') skipReason = 'context_uncertified';
          else if (!context.meta.snapshot_id) skipReason = 'no_certified_snapshot';
        }
        if (!skipReason && context) {
          // "No equivalent READY/current pack": same snapshot + same context
          // hash + same pack schema + same prompt version already READY or
          // PARTIAL means there is nothing new to generate this month.
          const current = await this.db.findCurrentPack(subject.userId);
          if (current && current.snapshot_id === context.meta.snapshot_id && current.financial_context_hash === hashContext(context)
            && current.pack_schema_version === PACK_SCHEMA_VERSION && (promptVersion === null || current.prompt_version === promptVersion)) {
            skipReason = 'current_pack_exists';
          }
        }

        if (dryRun) {
          if (skipReason) skip(skipReason); else result.submitted += 1; // "would submit"
          continue;
        }

        const job = await this.db.insertJob({ billingPeriod, userId: subject.userId, householdId: subject.householdId, runId, status: skipReason ? 'SKIPPED' : 'DISCOVERED', skipReason });
        if (!job) { skip('current_pack_exists'); continue; } // lost a concurrent-discovery race for this subject: already ledgered
        if (skipReason) { skip(skipReason); continue; }
        jobIdByUser.set(subject.userId, job.id);
        items.push({ userId: subject.userId, householdId: subject.householdId, context: context! });
      }

      if (dryRun) {
        // In a dry run `submitted` reports how many WOULD have been submitted; nothing was.
        await this.db.releaseRun(runId, 'COMPLETED', { discovered: result.discovered, skipped: result.skipped, submitted: 0 }, `dry_run: ${result.submitted} would be submitted`, null);
        result.reason = 'dry_run';
        return result;
      }
      if (items.length === 0) {
        await this.db.releaseRun(runId, 'COMPLETED', { discovered: result.discovered, skipped: result.skipped, submitted: 0 }, null, null);
        result.reason = 'nothing_to_submit';
        return result;
      }

      // ---- ONE batch submission through the existing orchestrator ----
      const submission = await this.orchestrator.submitBatch(items);
      result.batchId = submission.batch.id;
      result.providerBatchId = submission.providerBatchId;
      for (const outcome of submission.households) await this.applyOutcomeToJob(jobIdByUser, outcome, submission.batch.id, result);
      for (const a of submission.admitted) {
        const jobId = jobIdByUser.get(a.userId);
        if (jobId) await this.db.updateJob(jobId, { status: 'SUBMITTED', pack_id: a.packId, batch_id: submission.batch.id, attempt_count: a.existingRetryCount + 1 });
        result.submitted += 1;
      }
      // Sync fan-out (section 28 fallback): the results exist only in THIS
      // process, so reconcile now rather than leaving the batch for a later
      // reconcile tick that could never see them.
      if (this.orchestrator.providerCompletesSynchronously && submission.admitted.length > 0) {
        const completed = await this.orchestrator.completeSubmissionInProcess(submission);
        for (const outcome of completed.households) {
          const jobId = jobIdByUser.get(outcome.userId);
          if (!jobId) continue;
          if (outcome.status === 'READY' || outcome.status === 'PARTIAL') { result.reconciledInProcess = (result.reconciledInProcess ?? 0) + 1; await this.db.updateJob(jobId, { status: outcome.status, pack_id: outcome.pack.id }); }
          else if (outcome.status === 'FAILED') { result.failed += 1; await this.db.updateJob(jobId, { status: 'FAILED', failure_code: outcome.failureCode, pack_id: outcome.pack?.id ?? null }); }
        }
      }
      await this.db.releaseRun(runId, 'COMPLETED', { discovered: result.discovered, skipped: result.skipped, submitted: result.submitted, failed: result.failed, reconciled: result.reconciledInProcess ?? 0 }, null, submission.batch.id);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'submit phase failed';
      await this.db.releaseRun(runId, 'FAILED', { discovered: result.discovered, skipped: result.skipped, submitted: result.submitted, failed: result.failed }, message.slice(0, 500), result.batchId);
      return { ...result, status: 'FAILED', reason: message };
    }
  }

  async runReconcilePhase(input: { triggeredBy: SchedulerTrigger; maxBatches?: number; billingPeriod?: string; now?: Date }): Promise<ReconcilePhaseResult> {
    const billingPeriod = input.billingPeriod ?? currentBillingPeriod(input.now);
    const base: ReconcilePhaseResult = { runId: null, status: 'SKIPPED', reason: null, batchesPolled: 0, batchesStillPending: 0, reconciled: 0, failed: 0, outcomes: [] };
    const controls = await this.db.getControls();
    if (!controls) return { ...base, reason: 'controls_unavailable' };
    if (!controls.ai_globally_enabled) return { ...base, reason: 'ai_disabled' };
    // Reconcile is allowed even when scheduler_enabled is later switched off:
    // a batch already submitted (and paid for) must still be collected and
    // its reservations released. batch_generation_enabled=false likewise
    // does not strand in-flight work.

    const runId = await this.db.claimRun('reconcile', input.triggeredBy, billingPeriod, SCHEDULER_LEASE_SECONDS, false);
    if (!runId) return { ...base, reason: 'lease_held_by_another_run' };
    const result: ReconcilePhaseResult = { ...base, runId, status: 'COMPLETED' };
    try {
      const open = await this.batchDb.listOpenBatches(Math.max(1, Math.min(input.maxBatches ?? DEFAULT_MAX_BATCHES_PER_RECONCILE, 50)));
      for (const batch of open) {
        result.batchesPolled += 1;
        const reconciled = await this.orchestrator.reconcileBatchFromDb(batch, this.buildContext);
        if (reconciled.pending) { result.batchesStillPending += 1; result.outcomes.push({ batchId: batch.id, pending: true, households: [] }); continue; }
        const jobs = await this.db.listJobsForBatch(batch.id);
        const jobIdByUser = new Map(jobs.map((j) => [j.user_id, j.id]));
        const summary: { userId: string; status: string; failureCode?: string }[] = [];
        for (const outcome of reconciled.households) {
          const jobId = jobIdByUser.get(outcome.userId);
          if (outcome.status === 'READY' || outcome.status === 'PARTIAL') {
            result.reconciled += 1;
            if (jobId) await this.db.updateJob(jobId, { status: outcome.status, pack_id: outcome.pack.id });
            summary.push({ userId: outcome.userId, status: outcome.status });
          } else if (outcome.status === 'FAILED') {
            result.failed += 1;
            if (jobId) await this.db.updateJob(jobId, { status: 'FAILED', failure_code: outcome.failureCode, pack_id: outcome.pack?.id ?? null });
            summary.push({ userId: outcome.userId, status: 'FAILED', failureCode: outcome.failureCode });
          } else {
            summary.push({ userId: outcome.userId, status: outcome.status });
          }
        }
        result.outcomes.push({ batchId: batch.id, pending: false, households: summary });
      }
      if (open.length === 0) result.reason = 'no_open_batches';
      await this.db.releaseRun(runId, 'COMPLETED', { reconciled: result.reconciled, failed: result.failed }, null, null);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'reconcile phase failed';
      await this.db.releaseRun(runId, 'FAILED', { reconciled: result.reconciled, failed: result.failed }, message.slice(0, 500), null);
      return { ...result, status: 'FAILED', reason: message };
    }
  }

  private async applyOutcomeToJob(jobIdByUser: Map<string, string>, outcome: HouseholdBatchOutcome, batchId: string, result: SubmitPhaseResult): Promise<void> {
    const jobId = jobIdByUser.get(outcome.userId);
    switch (outcome.status) {
      case 'EXISTING_READY':
      case 'PARTIAL':
        if (jobId) await this.db.updateJob(jobId, { status: outcome.status === 'EXISTING_READY' ? 'READY' : 'PARTIAL', pack_id: outcome.pack.id, skip_reason: 'existing_pack' });
        result.skipped += 1; result.skipReasons.existing_pack = (result.skipReasons.existing_pack ?? 0) + 1;
        break;
      case 'IN_PROGRESS':
        if (jobId) await this.db.updateJob(jobId, { status: 'SUBMITTED', pack_id: outcome.pack.id, skip_reason: 'already_in_progress' });
        result.skipped += 1; result.skipReasons.already_in_progress = (result.skipReasons.already_in_progress ?? 0) + 1;
        break;
      case 'REGENERATION_RATE_LIMITED':
        if (jobId) await this.db.updateJob(jobId, { status: 'SKIPPED', skip_reason: 'regeneration_cooldown' });
        result.skipped += 1; result.skipReasons.regeneration_cooldown = (result.skipReasons.regeneration_cooldown ?? 0) + 1;
        break;
      case 'COST_BLOCKED':
        if (jobId) await this.db.updateJob(jobId, { status: 'FAILED', failure_code: outcome.denyReason ?? 'cost_blocked', batch_id: batchId });
        result.failed += 1;
        break;
      case 'FAILED':
        if (jobId) await this.db.updateJob(jobId, { status: 'FAILED', failure_code: outcome.failureCode, pack_id: outcome.pack?.id ?? null, batch_id: batchId });
        result.failed += 1;
        break;
      case 'NOT_ELIGIBLE':
      case 'CONTEXT_UNAVAILABLE':
        if (jobId) await this.db.updateJob(jobId, { status: 'SKIPPED', skip_reason: outcome.status.toLowerCase() });
        result.skipped += 1; result.skipReasons[outcome.status.toLowerCase()] = (result.skipReasons[outcome.status.toLowerCase()] ?? 0) + 1;
        break;
      case 'BATCH_ABORTED_KILL_SWITCH':
      case 'BATCH_ABORTED_NO_PROMPT_OR_MODEL':
        if (jobId) await this.db.updateJob(jobId, { status: 'FAILED', failure_code: outcome.status.toLowerCase() });
        result.failed += 1;
        break;
      default:
        break;
    }
  }
}
