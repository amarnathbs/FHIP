// Module 11 remediation R3 — scheduler contracts (ADR-M11-002).

import type { FinancialContextObject } from '@/lib/ai/context/types';

export type SchedulerPhase = 'submit' | 'reconcile';
export type SchedulerTrigger = 'cron' | 'admin' | 'dev';

export interface SchedulerRunRow {
  id: string;
  phase: SchedulerPhase;
  triggered_by: SchedulerTrigger;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'LEASE_EXPIRED';
  dry_run: boolean;
  billing_period: string;
  started_at: string;
  lease_until: string;
  finished_at: string | null;
  discovered_count: number;
  skipped_count: number;
  submitted_count: number;
  reconciled_count: number;
  failed_count: number;
  batch_id: string | null;
  error_summary: string | null;
}

export type SchedulerJobStatus = 'DISCOVERED' | 'SKIPPED' | 'SUBMITTED' | 'READY' | 'PARTIAL' | 'FAILED';

export interface SchedulerJobRow {
  id: string;
  billing_period: string;
  user_id: string;
  household_id: string | null;
  status: SchedulerJobStatus;
  skip_reason: string | null;
  failure_code: string | null;
  pack_id: string | null;
  batch_id: string | null;
  run_id: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

export interface SchedulerControls {
  ai_globally_enabled: boolean;
  batch_generation_enabled: boolean;
  scheduler_enabled: boolean;
}

/**
 * Everything the scheduler needs from the database, as a narrow interface
 * so the PGlite certification harness and the real supabase-js client both
 * implement it without the service knowing which it has.
 */
export interface SchedulerDbClient {
  getControls(): Promise<SchedulerControls | null>;
  /** Atomic lease claim (ai_insight_pack_scheduler_claim). NULL = another run holds this phase. */
  claimRun(phase: SchedulerPhase, triggeredBy: SchedulerTrigger, billingPeriod: string, leaseSeconds: number, dryRun: boolean): Promise<string | null>;
  releaseRun(runId: string, status: 'COMPLETED' | 'FAILED' | 'SKIPPED', counts: Partial<Record<'discovered' | 'skipped' | 'submitted' | 'reconciled' | 'failed', number>>, error: string | null, batchId: string | null): Promise<void>;
  /** Premium-entitled subjects (user ids) — the discovery universe. Bounded. */
  listPremiumSubjects(limit: number): Promise<{ userId: string; householdId: string | null }[]>;
  /** Subjects that already have a job row for this billing period (any status) — the duplicate-suppression ledger. */
  listJobSubjectsForPeriod(billingPeriod: string): Promise<Set<string>>;
  /** Inserts a job row; returns false if (period, user) already exists (unique violation) — a concurrent discovery lost the race. */
  insertJob(input: { billingPeriod: string; userId: string; householdId: string | null; runId: string; status: SchedulerJobStatus; skipReason?: string | null }): Promise<SchedulerJobRow | null>;
  updateJob(id: string, patch: Partial<Pick<SchedulerJobRow, 'status' | 'skip_reason' | 'failure_code' | 'pack_id' | 'batch_id' | 'attempt_count'>>): Promise<void>;
  listJobsForBatch(batchId: string): Promise<SchedulerJobRow[]>;
  /** The most recent READY/PARTIAL pack for a subject, for "no equivalent current pack" (brief section 25). */
  findCurrentPack(userId: string): Promise<{ id: string; status: string; snapshot_id: string; financial_context_hash: string; pack_schema_version: string; prompt_version: number } | null>;
}

/** Builds a subject's certified context with NO request session (service-role base client). */
export type SchedulerContextBuilder = (userId: string) => Promise<FinancialContextObject>;

export interface SubmitPhaseResult {
  runId: string | null;
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  reason: string | null;
  billingPeriod: string;
  dryRun: boolean;
  discovered: number;
  skipped: number;
  submitted: number;
  failed: number;
  batchId: string | null;
  providerBatchId: string | null;
  skipReasons: Record<string, number>;
  /** Set only in sync fan-out mode: households reconciled in the same invocation. */
  reconciledInProcess?: number;
}

export interface ReconcilePhaseResult {
  runId: string | null;
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  reason: string | null;
  batchesPolled: number;
  batchesStillPending: number;
  reconciled: number;
  failed: number;
  outcomes: { batchId: string; pending: boolean; households: { userId: string; status: string; failureCode?: string }[] }[];
}
