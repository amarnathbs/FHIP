// Module 11.1 — platform control plane (kill switch + every tunable ceiling).
//
// Read/write access to ai_platform_controls and ai_task_cost_limits. Both
// tables are governance-only (RLS enabled, zero policies), so every call here
// goes through the service-role client and every route calling it must have
// passed requireAdmin() first — the same defence-in-depth pattern Module 11.0
// uses for the model and prompt registries.
//
// NOTHING HERE IS CACHED, and the enforcement path does not use this module
// at all: ai_admit_request() reads the controls row itself, inside the request
// transaction. That is deliberate. A kill switch is only worth having if it is
// immediate, so there is no memoisation and no TTL anywhere between an admin
// flipping the switch and the next request being refused.

import { createAdminClient } from '@/lib/supabase/admin';
import type { AITaskType } from '@/lib/ai/providers/types';
import type { ModelTier } from '@/lib/ai/modelRegistry';

export const PLATFORM_CONTROLS_ID = 'global';

export interface AiPlatformControls {
  id: string;
  ai_globally_enabled: boolean;
  custom_ai_enabled: boolean;
  kill_switch_reason: string | null;
  standard_requires_premium: boolean;
  monthly_custom_question_allowance: number;
  rate_limit_max_requests: number;
  rate_limit_window_seconds: number;
  per_user_monthly_cost_ceiling_usd: number;
  platform_monthly_cost_ceiling_usd: number;
  max_cost_per_request_usd: number;
  updated_at: string;
  updated_by: string | null;
}

export interface AiTaskCostLimit {
  id: string;
  task_type: AITaskType;
  model_identifier: string | null;
  max_cost_per_request_usd: number;
  max_internal_tier: ModelTier;
  max_monthly_cost_usd: number | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

/** The fields an admin may change. `id` is not among them — the row is a singleton. */
export type PlatformControlsPatch = Partial<
  Pick<
    AiPlatformControls,
    | 'ai_globally_enabled'
    | 'custom_ai_enabled'
    | 'kill_switch_reason'
    | 'standard_requires_premium'
    | 'monthly_custom_question_allowance'
    | 'rate_limit_max_requests'
    | 'rate_limit_window_seconds'
    | 'per_user_monthly_cost_ceiling_usd'
    | 'platform_monthly_cost_ceiling_usd'
    | 'max_cost_per_request_usd'
  >
>;

export async function getPlatformControls(): Promise<AiPlatformControls | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('ai_platform_controls').select('*').eq('id', PLATFORM_CONTROLS_ID).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AiPlatformControls | null) ?? null;
}

/** Admin-only write path — callers MUST have already passed requireAdmin(). */
export async function updatePlatformControls(patch: PlatformControlsPatch, adminUserId: string): Promise<AiPlatformControls> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_platform_controls')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: adminUserId })
    .eq('id', PLATFORM_CONTROLS_ID)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as AiPlatformControls;
}

export async function listTaskCostLimits(): Promise<AiTaskCostLimit[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('ai_task_cost_limits').select('*').order('task_type', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AiTaskCostLimit[];
}

export type TaskCostLimitPatch = Partial<
  Pick<AiTaskCostLimit, 'max_cost_per_request_usd' | 'max_internal_tier' | 'max_monthly_cost_usd' | 'active' | 'notes'>
>;

/** Admin-only write path — callers MUST have already passed requireAdmin(). */
export async function updateTaskCostLimit(id: string, patch: TaskCostLimitPatch, adminUserId: string): Promise<AiTaskCostLimit> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_task_cost_limits')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: adminUserId })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as AiTaskCostLimit;
}

export interface AiUsageSummaryRow {
  user_id: string;
  billing_period: string;
  custom_question_count: number;
  refunded_question_count: number;
  cached_answer_count: number;
  live_call_count: number;
  estimated_cost_usd: number;
}

/**
 * Read-only spend/usage roll-up for the current billing period, so an admin
 * can see how close the platform is to its ceiling. Aggregated in-process
 * from the ledger rather than in SQL because the ledger is keyed per
 * (user, period, task, provider, model) and the useful admin view is per-user.
 */
export async function summariseUsageForPeriod(billingPeriod: string): Promise<{
  perUser: AiUsageSummaryRow[];
  platformEstimatedCostUsd: number;
  platformCustomQuestionCount: number;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_usage_ledger')
    .select('user_id, billing_period, custom_question_count, refunded_question_count, cached_answer_count, live_call_count, estimated_cost_usd')
    .eq('billing_period', billingPeriod);
  if (error) throw new Error(error.message);

  const byUser = new Map<string, AiUsageSummaryRow>();
  let platformEstimatedCostUsd = 0;
  let platformCustomQuestionCount = 0;

  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const userId = String(raw.user_id);
    const existing = byUser.get(userId) ?? {
      user_id: userId,
      billing_period: billingPeriod,
      custom_question_count: 0,
      refunded_question_count: 0,
      cached_answer_count: 0,
      live_call_count: 0,
      estimated_cost_usd: 0,
    };
    existing.custom_question_count += Number(raw.custom_question_count ?? 0);
    existing.refunded_question_count += Number(raw.refunded_question_count ?? 0);
    existing.cached_answer_count += Number(raw.cached_answer_count ?? 0);
    existing.live_call_count += Number(raw.live_call_count ?? 0);
    existing.estimated_cost_usd += Number(raw.estimated_cost_usd ?? 0);
    byUser.set(userId, existing);

    platformEstimatedCostUsd += Number(raw.estimated_cost_usd ?? 0);
    platformCustomQuestionCount += Number(raw.custom_question_count ?? 0);
  }

  return {
    perUser: [...byUser.values()].sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd),
    platformEstimatedCostUsd,
    platformCustomQuestionCount,
  };
}
