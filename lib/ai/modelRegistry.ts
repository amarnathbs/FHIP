// Module 11.0 — Model Registry service (spec section 27).
//
// Reads/writes the `ai_model_registry` table. This is the ONLY place a task
// type is bound to a concrete provider/model — no business service or
// prompt hardcodes a model name (ADR-M11-001 decision #14).

import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AITaskType } from '@/lib/ai/providers/types';
import { getModule11AiModel, getModule11AiProvider } from '@/lib/ai/config';

export type ModelTier = 'LOW_COST' | 'STANDARD' | 'ADVANCED';

export interface ModelRegistryRow {
  id: string;
  provider: string;
  model_identifier: string;
  internal_tier: ModelTier;
  active: boolean;
  approved: boolean;
  task_types: AITaskType[];
  max_input_tokens: number;
  max_output_tokens: number;
  supports_structured_output: boolean;
  supports_streaming: boolean;
  supports_batch: boolean;
  cost_input_per_1k_usd: number | null;
  cost_output_per_1k_usd: number | null;
  effective_from: string | null;
  effective_to: string | null;
  rollout_percentage: number;
  fallback_model_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listModelRegistry(client?: SupabaseServerClient): Promise<ModelRegistryRow[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase.from('ai_model_registry').select('*').order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ModelRegistryRow[];
}

/**
 * Resolves the active, approved model for a task type/tier. Returns null
 * (never a guessed fallback model name) if none is configured — callers
 * must treat that as "AI unavailable for this task", not silently pick a
 * different model (spec section 47: fail closed).
 */
export async function resolveModelForTask(taskType: AITaskType, tier: ModelTier = 'STANDARD', client?: SupabaseServerClient): Promise<ModelRegistryRow | null> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from('ai_model_registry')
    .select('*')
    .eq('active', true)
    .eq('approved', true)
    .eq('internal_tier', tier)
    .contains('task_types', [taskType])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ModelRegistryRow | null) ?? null;
}

/**
 * R2 — the model resolution Module 11's governed generations actually use.
 * Configuration (lib/ai/config.ts) says WHICH provider/model Module 11 wants;
 * the registry says whether that model is ACTIVE and APPROVED for the task.
 * Both must agree or this returns null (fail closed, no fallback):
 *   * provider 'mock'   -> the newest active+approved mock row for the task
 *                          (tier-agnostic: the mock has one row);
 *   * provider 'openai' -> the active+approved row for EXACTLY
 *                          (openai, MODULE11_AI_MODEL) carrying the task.
 * A registry row for a different openai model, or the configured model
 * still inactive/unapproved (the state migration 0175 seeds), yields null
 * and the caller reports no_approved_model — configuration never
 * authorises a model on its own (ADR-M11-001 #14).
 *
 * `config` is injectable so unit tests can exercise both branches without
 * touching process.env.
 */
export async function resolveConfiguredModelForTask(
  taskType: AITaskType,
  client?: SupabaseServerClient,
  config: { provider: 'mock' | 'openai'; model: string } = { provider: getModule11AiProvider(), model: getModule11AiModel() }
): Promise<ModelRegistryRow | null> {
  const supabase = client ?? (await createClient());
  let q = supabase
    .from('ai_model_registry')
    .select('*')
    .eq('active', true)
    .eq('approved', true)
    .eq('provider', config.provider)
    .contains('task_types', [taskType]);
  if (config.provider === 'openai') q = q.eq('model_identifier', config.model);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ModelRegistryRow | null) ?? null;
}

export interface UpsertModelInput {
  provider: string;
  model_identifier: string;
  internal_tier: ModelTier;
  active: boolean;
  approved: boolean;
  task_types: AITaskType[];
  max_input_tokens: number;
  max_output_tokens: number;
  supports_structured_output: boolean;
  supports_streaming: boolean;
  supports_batch: boolean;
  cost_input_per_1k_usd?: number | null;
  cost_output_per_1k_usd?: number | null;
  rollout_percentage?: number;
  fallback_model_id?: string | null;
}

/** Admin-only write path — callers MUST have already passed requireAdmin(). */
export async function createModelRegistryEntry(input: UpsertModelInput, approvedByUserId: string): Promise<ModelRegistryRow> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_model_registry')
    .insert({ ...input, created_by: approvedByUserId })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ModelRegistryRow;
}

export async function updateModelRegistryEntry(id: string, patch: Partial<UpsertModelInput>, approvedByUserId: string): Promise<ModelRegistryRow> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_model_registry')
    .update({ ...patch, approved_by: patch.approved ? approvedByUserId : undefined, approved_at: patch.approved ? new Date().toISOString() : undefined, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ModelRegistryRow;
}
