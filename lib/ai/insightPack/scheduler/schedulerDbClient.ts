// Module 11 remediation R3 — the real (supabase-js, service-role) SchedulerDbClient.
// Every table it touches is governance-only (RLS, zero policies) — this
// module must only ever be reached from the CRON_SECRET route or an
// admin-gated route, never from a user session.

import '@/lib/serverOnly';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SchedulerControls, SchedulerDbClient, SchedulerJobRow, SchedulerPhase, SchedulerTrigger } from '@/lib/ai/insightPack/scheduler/types';

export const realSchedulerDbClient: SchedulerDbClient = {
  async getControls(): Promise<SchedulerControls | null> {
    const admin = createAdminClient();
    const { data, error } = await admin.from('ai_platform_controls').select('ai_globally_enabled, batch_generation_enabled, scheduler_enabled').eq('id', 'global').maybeSingle();
    if (error) throw new Error(`getControls failed: ${error.message}`);
    return (data as SchedulerControls | null) ?? null;
  },

  async claimRun(phase: SchedulerPhase, triggeredBy: SchedulerTrigger, billingPeriod: string, leaseSeconds: number, dryRun: boolean): Promise<string | null> {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('ai_insight_pack_scheduler_claim', { p_phase: phase, p_triggered_by: triggeredBy, p_billing_period: billingPeriod, p_lease_seconds: leaseSeconds, p_dry_run: dryRun });
    if (error) throw new Error(`claimRun failed: ${error.message}`);
    return (data as string | null) ?? null;
  },

  async releaseRun(runId, status, counts, error, batchId): Promise<void> {
    const admin = createAdminClient();
    const { error: err } = await admin.rpc('ai_insight_pack_scheduler_release', { p_run_id: runId, p_status: status, p_counts: counts, p_error: error, p_batch_id: batchId });
    if (err) throw new Error(`releaseRun failed: ${err.message}`);
  },

  async listPremiumSubjects(limit: number) {
    const admin = createAdminClient();
    const { data, error } = await admin.from('user_entitlements').select('user_id').eq('plan_tier', 'premium').order('user_id', { ascending: true }).limit(limit);
    if (error) throw new Error(`listPremiumSubjects failed: ${error.message}`);
    // household_id: the Module 11 pipeline treats the subject's own user id
    // as the household scope (households.user_id = auth user) — the same
    // convention the admin generate route uses (householdId: null).
    return (data ?? []).map((r) => ({ userId: String((r as { user_id: string }).user_id), householdId: null }));
  },

  async listJobSubjectsForPeriod(billingPeriod: string): Promise<Set<string>> {
    const admin = createAdminClient();
    const { data, error } = await admin.from('ai_insight_pack_scheduler_jobs').select('user_id').eq('billing_period', billingPeriod);
    if (error) throw new Error(`listJobSubjectsForPeriod failed: ${error.message}`);
    return new Set((data ?? []).map((r) => String((r as { user_id: string }).user_id)));
  },

  async insertJob(input): Promise<SchedulerJobRow | null> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_pack_scheduler_jobs')
      .insert({ billing_period: input.billingPeriod, user_id: input.userId, household_id: input.householdId, run_id: input.runId, status: input.status, skip_reason: input.skipReason ?? null })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') return null; // unique (billing_period, user_id): a concurrent discovery already ledgered this subject
      throw new Error(`insertJob failed: ${error.message}`);
    }
    return data as SchedulerJobRow;
  },

  async updateJob(id: string, patch: Partial<Pick<SchedulerJobRow, 'status' | 'skip_reason' | 'failure_code' | 'pack_id' | 'batch_id' | 'attempt_count'>>): Promise<void> {
    const admin = createAdminClient();
    const { error } = await admin.from('ai_insight_pack_scheduler_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new Error(`updateJob failed: ${error.message}`);
  },

  async listJobsForBatch(batchId: string): Promise<SchedulerJobRow[]> {
    const admin = createAdminClient();
    const { data, error } = await admin.from('ai_insight_pack_scheduler_jobs').select('*').eq('batch_id', batchId);
    if (error) throw new Error(`listJobsForBatch failed: ${error.message}`);
    return (data ?? []) as SchedulerJobRow[];
  },

  async findCurrentPack(userId: string) {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_packs')
      .select('id, status, snapshot_id, financial_context_hash, pack_schema_version, prompt_version')
      .eq('user_id', userId)
      .in('status', ['READY', 'PARTIAL'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findCurrentPack failed: ${error.message}`);
    return (data as { id: string; status: string; snapshot_id: string; financial_context_hash: string; pack_schema_version: string; prompt_version: number } | null) ?? null;
  },
};
