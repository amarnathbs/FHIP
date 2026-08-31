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
  // Spec section 29 — the remaining three named feature switches.
  live_provider_enabled: boolean;
  batch_generation_enabled: boolean;
  scenario_ai_enabled: boolean;
  // Spec section 18.
  max_concurrent_requests_per_subject: number;
  concurrency_lease_seconds: number;
  // Spec sections 20/21.
  max_context_tokens: number;
  max_user_input_tokens: number;
  max_output_tokens: number;
  // Spec section 27.
  platform_soft_cost_threshold_usd: number | null;
  per_user_soft_cost_threshold_usd: number | null;
  // Spec section 26.
  daily_live_ai_cost_limit_usd: number | null;
  updated_at: string;
  updated_by: string | null;
}

/** Spec sections 31/26 — per-provider kill switch and monthly spend limit. */
export interface AiProviderControl {
  provider: string;
  enabled: boolean;
  disabled_reason: string | null;
  monthly_cost_limit_usd: number | null;
  notes: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Spec sections 33/59 — one append-only row per changed configuration field. */
export interface AiConfigAuditRow {
  id: string;
  config_table: string;
  config_id: string;
  field: string;
  previous_value: string | null;
  new_value: string | null;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  changed_by: string | null;
  changed_at: string;
  reason: string | null;
}

/** Spec sections 27/38/60 — an operational event with risk-appropriate severity. */
export interface AiOperationalEvent {
  id: string;
  event_type: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  user_id: string | null;
  billing_period: string | null;
  task_type: string | null;
  provider: string | null;
  model: string | null;
  admission_id: string | null;
  detail: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
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
    | 'live_provider_enabled'
    | 'batch_generation_enabled'
    | 'scenario_ai_enabled'
    | 'max_concurrent_requests_per_subject'
    | 'concurrency_lease_seconds'
    | 'max_context_tokens'
    | 'max_user_input_tokens'
    | 'max_output_tokens'
    | 'platform_soft_cost_threshold_usd'
    | 'per_user_soft_cost_threshold_usd'
    | 'daily_live_ai_cost_limit_usd'
  >
>;

/**
 * Spec section 58 — reject unsafe administrative configuration BEFORE it is
 * written, with a specific message rather than a database constraint error.
 *
 * The database enforces the same soft-below-hard rule as a CHECK, so this
 * function is not the only line of defence — it exists so an admin gets an
 * explanation instead of a constraint violation, and so a combination that is
 * only invalid when two fields are considered TOGETHER is caught even when
 * one of them is not part of this patch.
 *
 * Returns null when the resulting configuration is safe, or a message when it
 * is not. Deliberately validates the MERGED result, not the patch: a patch
 * that lowers a hard ceiling below an already-stored soft threshold is exactly
 * as unsafe as one that raises the soft threshold.
 */
export function validateControlsPatch(
  current: AiPlatformControls,
  patch: PlatformControlsPatch
): string | null {
  const merged = { ...current, ...patch };

  if (merged.monthly_custom_question_allowance < 0) {
    return 'monthly_custom_question_allowance must be >= 0';
  }
  if (merged.rate_limit_max_requests <= 0) {
    // A rate limit of zero would refuse every request while the feature reads
    // as enabled — an unsafe state that looks like a working one. Section 58
    // requires rejecting exactly this rather than "interpreting" it.
    return 'rate_limit_max_requests must be > 0; use the kill switch to stop AI, not a zero rate limit';
  }
  if (merged.rate_limit_window_seconds <= 0) return 'rate_limit_window_seconds must be > 0';
  if (merged.max_concurrent_requests_per_subject <= 0) return 'max_concurrent_requests_per_subject must be > 0';
  if (merged.concurrency_lease_seconds <= 0) return 'concurrency_lease_seconds must be > 0';
  if (merged.max_context_tokens <= 0 || merged.max_user_input_tokens <= 0 || merged.max_output_tokens <= 0) {
    return 'token budgets must all be > 0';
  }
  if (merged.max_user_input_tokens > merged.max_context_tokens) {
    return 'max_user_input_tokens cannot exceed max_context_tokens';
  }
  if (merged.platform_soft_cost_threshold_usd !== null
      && merged.platform_soft_cost_threshold_usd > merged.platform_monthly_cost_ceiling_usd) {
    return 'platform_soft_cost_threshold_usd cannot exceed platform_monthly_cost_ceiling_usd — a soft threshold above its hard ceiling can never fire';
  }
  if (merged.per_user_soft_cost_threshold_usd !== null
      && merged.per_user_soft_cost_threshold_usd > merged.per_user_monthly_cost_ceiling_usd) {
    return 'per_user_soft_cost_threshold_usd cannot exceed per_user_monthly_cost_ceiling_usd — a soft threshold above its hard ceiling can never fire';
  }
  if (merged.per_user_monthly_cost_ceiling_usd > merged.platform_monthly_cost_ceiling_usd) {
    return 'per_user_monthly_cost_ceiling_usd cannot exceed platform_monthly_cost_ceiling_usd — a single subject would be permitted to exhaust the whole platform budget';
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// Provider controls (spec sections 31, 26)
// ---------------------------------------------------------------------------

export async function listProviderControls(): Promise<AiProviderControl[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('ai_provider_controls').select('*').order('provider', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AiProviderControl[];
}

export type ProviderControlPatch = Partial<Pick<AiProviderControl, 'enabled' | 'disabled_reason' | 'monthly_cost_limit_usd' | 'notes'>>;

/**
 * Admin-only write path — callers MUST have already passed requireAdmin().
 *
 * Upserts rather than updates: a provider absent from the table is treated as
 * ENABLED by the admission RPC, so "disable a provider that has no row yet"
 * must create the row rather than silently succeeding against zero rows and
 * leaving the provider enabled.
 */
export async function upsertProviderControl(provider: string, patch: ProviderControlPatch, adminUserId: string): Promise<AiProviderControl> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_provider_controls')
    .upsert({ provider, ...patch, updated_at: new Date().toISOString(), updated_by: adminUserId }, { onConflict: 'provider' })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as AiProviderControl;
}

// ---------------------------------------------------------------------------
// Audit + operational event reads (spec sections 33, 38, 59)
// ---------------------------------------------------------------------------

export async function listConfigAudit(limit = 200): Promise<AiConfigAuditRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_config_audit')
    .select('*')
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as AiConfigAuditRow[];
}

export async function listOperationalEvents(limit = 200, minSeverity?: string): Promise<AiOperationalEvent[]> {
  const admin = createAdminClient();
  let q = admin.from('ai_operational_events').select('*').order('created_at', { ascending: false }).limit(limit);
  if (minSeverity) {
    const order = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const idx = order.indexOf(minSeverity);
    if (idx >= 0) q = q.in('severity', order.slice(idx));
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as AiOperationalEvent[];
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

// ---------------------------------------------------------------------------
// Admin usage dashboard aggregate (spec section 37)
//
// Section 37: "Functional and accurate beats decorative — no elaborate visual
// redesign needed." This is therefore a data function, not a UI. It returns
// every metric section 37 names, each derived from a table that is written by
// the enforcement path itself, so a figure here cannot drift from what the
// gate actually did.
//
// PRIVACY. This is admin-only data reached exclusively through requireAdmin()
// + the service-role client. It aggregates AI usage and spend; it never reads,
// joins to, or returns any user's financial records (spec section 61).
// ---------------------------------------------------------------------------

export interface AiUsageDashboard {
  billing_period: string;
  entitled_subjects: number;
  subjects_with_usage: number;
  subjects_at_quota: number;
  custom_questions_used: number;
  custom_questions_refunded: number;
  cached_answers_served: number;
  live_calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  average_cost_per_entitled_subject_usd: number;
  projected_period_end_cost_usd: number;
  denials_by_reason: Record<string, number>;
  events_by_severity: Record<string, number>;
  provider_executions: number;
  provider_failures: number;
  kill_switch_state: {
    ai_globally_enabled: boolean;
    custom_ai_enabled: boolean;
    live_provider_enabled: boolean;
    batch_generation_enabled: boolean;
    scenario_ai_enabled: boolean;
  } | null;
}

/**
 * `projected_period_end_cost_usd` is a LINEAR extrapolation of spend so far
 * across the whole month, and nothing more. It assumes usage continues at the
 * same daily rate, which it may well not. It is presented as a projection
 * rather than a forecast for exactly that reason; inventing a smarter model
 * on one month of no real usage would be false precision.
 */
export async function buildUsageDashboard(billingPeriod: string): Promise<AiUsageDashboard> {
  const admin = createAdminClient();

  const [ledgerRes, controlsRes, entitledRes, admissionsRes, eventsRes, runsRes] = await Promise.all([
    admin.from('ai_usage_ledger').select('*').eq('billing_period', billingPeriod),
    getPlatformControls(),
    admin.from('user_entitlements').select('user_id', { count: 'exact', head: true }).eq('plan_tier', 'premium'),
    admin.from('ai_admission_events').select('deny_reason, decision').eq('billing_period', billingPeriod),
    admin.from('ai_operational_events').select('severity').gte('created_at', `${billingPeriod}-01T00:00:00Z`),
    admin.from('ai_runs').select('execution_status').gte('created_at', `${billingPeriod}-01T00:00:00Z`),
  ]);

  if (ledgerRes.error) throw new Error(ledgerRes.error.message);

  const rows = (ledgerRes.data ?? []) as Record<string, unknown>[];
  const n = (v: unknown) => Number(v ?? 0) || 0;

  const perUser = new Map<string, number>();
  const agg = {
    custom_questions_used: 0, custom_questions_refunded: 0, cached_answers_served: 0,
    live_calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
    estimated_cost_usd: 0, actual_cost_usd: 0,
  };
  let anyActualCost = false;

  for (const r of rows) {
    agg.custom_questions_used += n(r.custom_question_count);
    agg.custom_questions_refunded += n(r.refunded_question_count);
    agg.cached_answers_served += n(r.cached_answer_count);
    agg.live_calls += n(r.live_call_count);
    agg.input_tokens += n(r.input_tokens);
    agg.cached_input_tokens += n(r.cached_tokens);
    agg.output_tokens += n(r.output_tokens);
    agg.estimated_cost_usd += n(r.estimated_cost_usd);
    if (r.actual_cost_usd !== null && r.actual_cost_usd !== undefined) { anyActualCost = true; agg.actual_cost_usd += n(r.actual_cost_usd); }
    const uid = String(r.user_id);
    perUser.set(uid, (perUser.get(uid) ?? 0) + n(r.custom_question_count));
  }

  const controls = controlsRes;
  const allowance = controls?.monthly_custom_question_allowance ?? 0;
  const entitledSubjects = entitledRes.count ?? 0;

  const denials_by_reason: Record<string, number> = {};
  for (const a of ((admissionsRes.data ?? []) as Record<string, unknown>[])) {
    if (a.decision !== 'denied') continue;
    const reason = String(a.deny_reason ?? 'unknown');
    denials_by_reason[reason] = (denials_by_reason[reason] ?? 0) + 1;
  }

  const events_by_severity: Record<string, number> = {};
  for (const e of ((eventsRes.data ?? []) as Record<string, unknown>[])) {
    const s = String(e.severity ?? 'INFO');
    events_by_severity[s] = (events_by_severity[s] ?? 0) + 1;
  }

  let provider_executions = 0, provider_failures = 0;
  for (const r of ((runsRes.data ?? []) as Record<string, unknown>[])) {
    const st = String(r.execution_status ?? '');
    // A run rejected before the provider was reached is not a provider
    // execution and must not be counted as one, or the failure rate would be
    // diluted by requests that never left the building.
    if (st === 'rejected_entitlement' || st === 'rejected_certification') continue;
    provider_executions += 1;
    if (st !== 'success') provider_failures += 1;
  }

  // Linear projection: spend-so-far scaled by (days in month / days elapsed).
  const [y, m] = billingPeriod.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = new Date();
  const sameMonth = now.getUTCFullYear() === y && now.getUTCMonth() + 1 === m;
  const daysElapsed = sameMonth ? Math.max(now.getUTCDate(), 1) : daysInMonth;

  return {
    billing_period: billingPeriod,
    entitled_subjects: entitledSubjects,
    subjects_with_usage: perUser.size,
    subjects_at_quota: allowance > 0 ? [...perUser.values()].filter((v) => v >= allowance).length : 0,
    ...agg,
    // Null, not zero: no provider reconciliation exists yet, and reporting an
    // unmeasured actual cost as $0.00 would read as "AI is free".
    actual_cost_usd: anyActualCost ? agg.actual_cost_usd : null,
    average_cost_per_entitled_subject_usd: entitledSubjects > 0 ? agg.estimated_cost_usd / entitledSubjects : 0,
    projected_period_end_cost_usd: agg.estimated_cost_usd * (daysInMonth / daysElapsed),
    denials_by_reason,
    events_by_severity,
    provider_executions,
    provider_failures,
    kill_switch_state: controls
      ? {
          ai_globally_enabled: controls.ai_globally_enabled,
          custom_ai_enabled: controls.custom_ai_enabled,
          live_provider_enabled: controls.live_provider_enabled,
          batch_generation_enabled: controls.batch_generation_enabled,
          scenario_ai_enabled: controls.scenario_ai_enabled,
        }
      : null,
  };
}
