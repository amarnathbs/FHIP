// Module 11 remediation R4 — the Admin AI Operations overview (brief
// sections 36, 39; Admin Standard §8, §9, §12, §13).
//
// ONE read that composes the ALREADY-EXISTING data layer — buildUsageDashboard(),
// getPlatformControls(), listProviderControls(), the model/prompt registries,
// the Insight Pack tables, the R3 scheduler ledger, operational events and
// the config audit — into the sections the brief names. No number here is
// invented, sampled or cached: every panel is derived from a table the
// enforcement path itself writes.
//
// RESULT-STATE DISCIPLINE (§8). Every panel is `ok` / `unavailable` /
// `suppressed`; a source that cannot be read (e.g. migration 0176/0177 not
// applied, so a table does not exist) renders `unavailable` WITH the reason,
// never as a healthy zero. Genuine zeros are `ok` with value 0.
//
// PRIVACY (§9). Nothing here carries a user_id, identifier, financial record
// or context payload. The per-subject spend view is a DISTRIBUTION with
// primary suppression (min 10 distinct subjects, min cell 5) — never a
// ranked list of subjects. Cost projection is labelled a linear projection
// (buildUsageDashboard()'s own semantics), never a forecast.
//
// This module is service-role only and must only be reached behind
// requireAiOperationsViewer().

import '@/lib/serverOnly';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildUsageDashboard, getPlatformControls, listProviderControls, listTaskCostLimits, listConfigAudit, listOperationalEvents, summariseUsageForPeriod, type AiUsageDashboard, type AiPlatformControls, type AiProviderControl, type AiTaskCostLimit, type AiConfigAuditRow, type AiOperationalEvent } from '@/lib/ai/entitlement/platformControls';
import { listModelRegistry, type ModelRegistryRow } from '@/lib/ai/modelRegistry';
import { listPromptTemplates } from '@/lib/ai/promptRegistry';
import { describeModule11AiConfig } from '@/lib/ai/config';
import { currentBillingPeriod } from '@/lib/ai/insightPack/scheduler/schedulerService';

export type PanelState = 'ok' | 'unavailable' | 'suppressed';
export interface Panel<T> { state: PanelState; data: T | null; reason: string | null }

function ok<T>(data: T): Panel<T> { return { state: 'ok', data, reason: null }; }
function unavailable<T>(reason: string): Panel<T> { return { state: 'unavailable', data: null, reason }; }
function suppressed<T>(reason: string): Panel<T> { return { state: 'suppressed', data: null, reason: `Insufficient data to display safely. ${reason}` }; }

/** Admin Standard §7.2 provisional thresholds. */
export const MIN_DISTINCT_SUBJECTS = 10;
export const MIN_CELL_COUNT = 5;

async function panel<T>(fn: () => Promise<T>): Promise<Panel<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return unavailable(e instanceof Error ? e.message : 'read failed');
  }
}

export interface ModelSummary { id: string; provider: string; model_identifier: string; internal_tier: string; active: boolean; approved: boolean; task_types: string[]; cost_input_per_1k_usd: number | null; cost_output_per_1k_usd: number | null; effective_from: string | null; supports_batch: boolean; max_input_tokens: number; max_output_tokens: number }
export interface PromptSummary { id: string; prompt_code: string; prompt_name: string; version: number; task_type: string; status: string; output_schema_version: string; country_scope: string | null; effective_from: string | null }
export interface InsightPackSummary { by_status: Record<string, number>; total: number; ready: number; partial: number; failed: number; stale: number; grounding_failures: number; safety_failures: number; queued_or_generating: number; last_generated_at: string | null }
export interface SchedulerSummary { scheduler_enabled: boolean; billing_period: string; jobs_by_status: Record<string, number>; open_batches: number; recent_runs: { id: string; phase: string; triggered_by: string; status: string; dry_run: boolean; started_at: string; finished_at: string | null; discovered_count: number; skipped_count: number; submitted_count: number; reconciled_count: number; failed_count: number; error_summary: string | null }[] }
/** No maximum is reported: the max is one subject's own spend (§7 dominance). */
export interface SpendDistribution { subjects_with_spend: number; bands: { label: string; count: number }[]; median_subject_spend_usd: number }
export interface SafetySummary { events_by_severity: Record<string, number>; recent_high: { event_type: string; severity: string; task_type: string | null; provider: string | null; created_at: string; detail: string | null }[]; provider_failures_by_status: Record<string, number> }

export interface AiOperationsOverview {
  generated_at: string;
  billing_period: string;
  configuration: Panel<ReturnType<typeof describeModule11AiConfig>>;
  controls: Panel<AiPlatformControls & { scheduler_enabled?: boolean; next_best_action_enabled?: boolean }>;
  providers: Panel<AiProviderControl[]>;
  models: Panel<ModelSummary[]>;
  prompts: Panel<PromptSummary[]>;
  usage: Panel<AiUsageDashboard>;
  spend_distribution: Panel<SpendDistribution>;
  task_cost_limits: Panel<AiTaskCostLimit[]>;
  insight_packs: Panel<InsightPackSummary>;
  scheduler: Panel<SchedulerSummary>;
  safety: Panel<SafetySummary>;
  config_audit: Panel<AiConfigAuditRow[]>;
}

export async function buildAiOperationsOverview(billingPeriod: string = currentBillingPeriod()): Promise<AiOperationsOverview> {
  const admin = createAdminClient();

  const [configuration, controls, providers, models, prompts, usage, taskLimits, configAudit, insightPacks, scheduler, safety, spend] = await Promise.all([
    panel(async () => describeModule11AiConfig()),
    panel(async () => { const c = await getPlatformControls(); if (!c) throw new Error('ai_platform_controls singleton missing (migration 0115 not applied)'); return c; }),
    panel(() => listProviderControls()),
    panel(async () => (await listModelRegistry(admin)).map(summariseModel)),
    panel(async () => (await listPromptTemplates(admin)).map((p) => ({ id: p.id, prompt_code: p.prompt_code, prompt_name: p.prompt_name, version: p.version, task_type: p.task_type, status: p.status, output_schema_version: p.output_schema_version, country_scope: p.country_scope, effective_from: p.effective_from }))),
    panel(() => buildUsageDashboard(billingPeriod)),
    panel(() => listTaskCostLimits()),
    panel(() => listConfigAudit(25)),
    panel(() => insightPackSummary()),
    panel(() => schedulerSummary(billingPeriod)),
    panel(() => safetySummary(billingPeriod)),
    spendDistribution(billingPeriod),
  ]);

  return { generated_at: new Date().toISOString(), billing_period: billingPeriod, configuration, controls, providers, models, prompts, usage, spend_distribution: spend, task_cost_limits: taskLimits, insight_packs: insightPacks, scheduler, safety, config_audit: configAudit };
}

function summariseModel(m: ModelRegistryRow): ModelSummary {
  return { id: m.id, provider: m.provider, model_identifier: m.model_identifier, internal_tier: m.internal_tier, active: m.active, approved: m.approved, task_types: m.task_types, cost_input_per_1k_usd: m.cost_input_per_1k_usd, cost_output_per_1k_usd: m.cost_output_per_1k_usd, effective_from: m.effective_from, supports_batch: m.supports_batch, max_input_tokens: m.max_input_tokens, max_output_tokens: m.max_output_tokens };
}

async function insightPackSummary(): Promise<InsightPackSummary> {
  const admin = createAdminClient();
  const { data, error } = await admin.from('ai_insight_packs').select('status, grounding_status, critical_safety_failure, generated_at').order('created_at', { ascending: false }).limit(2000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { status: string; grounding_status: string | null; critical_safety_failure: boolean; generated_at: string | null }[];
  const by: Record<string, number> = {};
  let grounding = 0, safety = 0, last: string | null = null;
  for (const r of rows) {
    by[r.status] = (by[r.status] ?? 0) + 1;
    if (r.grounding_status === 'FAIL') grounding += 1;
    if (r.critical_safety_failure) safety += 1;
    if (r.generated_at && (!last || r.generated_at > last)) last = r.generated_at;
  }
  const n = (s: string) => by[s] ?? 0;
  return { by_status: by, total: rows.length, ready: n('READY'), partial: n('PARTIAL'), failed: n('FAILED'), stale: n('STALE') + n('SUPERSEDED'), grounding_failures: grounding, safety_failures: safety, queued_or_generating: n('PENDING') + n('QUEUED') + n('GENERATING') + n('PROVIDER_COMPLETE') + n('VALIDATING'), last_generated_at: last };
}

async function schedulerSummary(billingPeriod: string): Promise<SchedulerSummary> {
  const admin = createAdminClient();
  const [{ data: controls, error: cErr }, { data: jobs, error: jErr }, { data: runs, error: rErr }, { count: openBatches, error: bErr }] = await Promise.all([
    admin.from('ai_platform_controls').select('scheduler_enabled').eq('id', 'global').maybeSingle(),
    admin.from('ai_insight_pack_scheduler_jobs').select('status').eq('billing_period', billingPeriod),
    admin.from('ai_insight_pack_scheduler_runs').select('id, phase, triggered_by, status, dry_run, started_at, finished_at, discovered_count, skipped_count, submitted_count, reconciled_count, failed_count, error_summary').order('started_at', { ascending: false }).limit(10),
    admin.from('ai_insight_pack_batches').select('id', { count: 'exact', head: true }).eq('status', 'SUBMITTED'),
  ]);
  const err = cErr ?? jErr ?? rErr ?? bErr;
  if (err) throw new Error(`${err.message} (migration 0176 applied?)`);
  const by: Record<string, number> = {};
  for (const j of (jobs ?? []) as { status: string }[]) by[j.status] = (by[j.status] ?? 0) + 1;
  return { scheduler_enabled: Boolean((controls as { scheduler_enabled?: boolean } | null)?.scheduler_enabled), billing_period: billingPeriod, jobs_by_status: by, open_batches: openBatches ?? 0, recent_runs: (runs ?? []) as SchedulerSummary['recent_runs'] };
}

async function safetySummary(billingPeriod: string): Promise<SafetySummary> {
  const admin = createAdminClient();
  const [events, { data: runs, error }] = await Promise.all([
    listOperationalEvents(200),
    admin.from('ai_runs').select('execution_status').gte('created_at', `${billingPeriod}-01T00:00:00Z`),
  ]);
  if (error) throw new Error(error.message);
  const bySeverity: Record<string, number> = {};
  for (const e of events) bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
  const failures: Record<string, number> = {};
  for (const r of (runs ?? []) as { execution_status: string }[]) {
    if (r.execution_status === 'success' || r.execution_status === 'rejected_entitlement' || r.execution_status === 'rejected_certification') continue;
    failures[r.execution_status] = (failures[r.execution_status] ?? 0) + 1;
  }
  const recentHigh = events.filter((e: AiOperationalEvent) => e.severity === 'HIGH' || e.severity === 'CRITICAL').slice(0, 25)
    // §9: user_id, admission_id and metadata are deliberately NOT surfaced.
    .map((e) => ({ event_type: e.event_type, severity: e.severity, task_type: e.task_type, provider: e.provider, created_at: e.created_at, detail: e.detail }));
  return { events_by_severity: bySeverity, recent_high: recentHigh, provider_failures_by_status: failures };
}

/**
 * Per-subject aggregation WITHOUT identifiers (§9), with §7 suppression:
 * fewer than MIN_DISTINCT_SUBJECTS subjects -> suppressed; any band with
 * 1..MIN_CELL_COUNT-1 subjects is merged into its neighbour until every
 * shown cell is ≥ MIN_CELL_COUNT or the panel is suppressed.
 */
async function spendDistribution(billingPeriod: string): Promise<Panel<SpendDistribution>> {
  let perUser: { estimated_cost_usd: number }[];
  try {
    perUser = (await summariseUsageForPeriod(billingPeriod)).perUser;
  } catch (e) {
    return unavailable(e instanceof Error ? e.message : 'ledger read failed');
  }
  const spends = perUser.map((u) => Number(u.estimated_cost_usd) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  if (spends.length === 0) return ok({ subjects_with_spend: 0, bands: [], median_subject_spend_usd: 0 });
  if (spends.length < MIN_DISTINCT_SUBJECTS) return suppressed(`Fewer than ${MIN_DISTINCT_SUBJECTS} subjects have spend this period.`);
  const edges = [0.01, 0.1, 0.5, 1, 2.5, 5];
  const labels = ['< $0.01', '$0.01–0.10', '$0.10–0.50', '$0.50–1.00', '$1.00–2.50', '$2.50–5.00', '≥ $5.00'];
  const counts = new Array(labels.length).fill(0) as number[];
  for (const v of spends) { let i = edges.findIndex((e) => v < e); if (i === -1) i = labels.length - 1; counts[i] += 1; }
  // Merge small cells forward until every non-empty cell is ≥ MIN_CELL_COUNT.
  const bands: { label: string; count: number }[] = [];
  let carryLabel: string | null = null, carry = 0;
  for (let i = 0; i < labels.length; i++) {
    if (counts[i] === 0 && carry === 0) continue;
    carry += counts[i]; carryLabel = carryLabel ? `${carryLabel.split('–')[0]}–${labels[i].split('–')[1] ?? labels[i]}` : labels[i];
    if (carry >= MIN_CELL_COUNT) { bands.push({ label: carryLabel, count: carry }); carry = 0; carryLabel = null; }
  }
  if (carry > 0) { if (bands.length === 0) return suppressed('Every spend band is below the minimum cell count.'); bands[bands.length - 1] = { label: `${bands[bands.length - 1].label} (incl. tail)`, count: bands[bands.length - 1].count + carry }; }
  if (bands.length < 2) return suppressed('A single visible band would disclose the whole population.');
  const median = spends[Math.floor(spends.length / 2)];
  return ok({ subjects_with_spend: spends.length, bands, median_subject_spend_usd: median });
}
