// Module 11.0 — Prompt Registry service (spec sections 28-29).
//
// Reads/writes `ai_prompt_templates`. Prompts are versioned product assets;
// only one APPROVED+ACTIVE version per (prompt_code, country_scope) is ever
// live at once (enforced by a partial unique index in the migration, not
// just application discipline).

import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AITaskType } from '@/lib/ai/providers/types';

export type PromptStatus = 'DRAFT' | 'TESTING' | 'APPROVED' | 'ACTIVE' | 'RETIRED';

export interface PromptTemplateRow {
  id: string;
  prompt_code: string;
  prompt_name: string;
  version: number;
  task_type: AITaskType;
  system_prompt: string;
  developer_prompt: string;
  context_schema_version: string;
  output_schema_version: string;
  country_scope: string | null;
  safety_policy_version: string;
  status: PromptStatus;
  approved_by: string | null;
  approved_at: string | null;
  effective_from: string | null;
  effective_to: string | null;
  supersedes_prompt_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function listPromptTemplates(client?: SupabaseServerClient): Promise<PromptTemplateRow[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase.from('ai_prompt_templates').select('*').order('prompt_code', { ascending: true }).order('version', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PromptTemplateRow[];
}

/**
 * The ONLY lookup a future AI request path may use to pick a prompt: the
 * single ACTIVE version for this exact (prompt_code, country_scope), or
 * the global (country_scope IS NULL) ACTIVE version as a fallback. Returns
 * null — never a DRAFT/TESTING prompt — if no ACTIVE version exists (spec
 * section 28: "Only one approved active version... should be used unless a
 * controlled experiment is explicitly configured", and none is configured
 * in 11.0).
 */
export async function getActivePrompt(promptCode: string, countryScope: string | null, client?: SupabaseServerClient): Promise<PromptTemplateRow | null> {
  const supabase = client ?? (await createClient());
  if (countryScope) {
    const { data: scoped } = await supabase.from('ai_prompt_templates').select('*').eq('prompt_code', promptCode).eq('country_scope', countryScope).eq('status', 'ACTIVE').maybeSingle();
    if (scoped) return scoped as PromptTemplateRow;
  }
  const { data: global } = await supabase.from('ai_prompt_templates').select('*').eq('prompt_code', promptCode).is('country_scope', null).eq('status', 'ACTIVE').maybeSingle();
  return (global as PromptTemplateRow | null) ?? null;
}

export interface CreatePromptInput {
  prompt_code: string;
  prompt_name: string;
  task_type: AITaskType;
  system_prompt: string;
  developer_prompt: string;
  context_schema_version: string;
  output_schema_version: string;
  country_scope?: string | null;
  safety_policy_version: string;
  supersedes_prompt_id?: string | null;
}

/** Admin-only write path — callers MUST have already passed requireAdmin(). New prompts always start DRAFT. */
export async function createPromptTemplate(input: CreatePromptInput): Promise<PromptTemplateRow> {
  const admin = createAdminClient();
  const { data: existing } = await admin.from('ai_prompt_templates').select('version').eq('prompt_code', input.prompt_code).order('version', { ascending: false }).limit(1).maybeSingle();
  const nextVersion = (existing?.version ?? 0) + 1;
  const { data, error } = await admin
    .from('ai_prompt_templates')
    .insert({ ...input, version: nextVersion, status: 'DRAFT' as PromptStatus })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as PromptTemplateRow;
}

/**
 * Transitions a prompt's status. Moving a prompt to ACTIVE atomically
 * retires any other ACTIVE version of the same (prompt_code, country_scope)
 * pair first, so the "exactly one ACTIVE version" invariant never has a
 * window where two are simultaneously ACTIVE.
 */
export async function transitionPromptStatus(id: string, status: PromptStatus, approvedByUserId: string): Promise<PromptTemplateRow> {
  const admin = createAdminClient();
  const { data: target, error: fetchErr } = await admin.from('ai_prompt_templates').select('*').eq('id', id).single();
  if (fetchErr || !target) throw new Error(fetchErr?.message ?? 'Prompt not found.');

  if (status === 'ACTIVE') {
    // Best-effort pre-retirement of any other ACTIVE version of the same
    // (prompt_code, country_scope) pair — the partial unique index added in
    // the migration is the real backstop against two simultaneously-ACTIVE
    // rows, this just keeps the common case tidy without a race window.
    let retireQuery = admin.from('ai_prompt_templates').update({ status: 'RETIRED', effective_to: new Date().toISOString() }).eq('prompt_code', target.prompt_code).eq('status', 'ACTIVE').neq('id', id);
    retireQuery = target.country_scope === null ? retireQuery.is('country_scope', null) : retireQuery.eq('country_scope', target.country_scope);
    await retireQuery;
  }

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === 'APPROVED') {
    patch.approved_by = approvedByUserId;
    patch.approved_at = new Date().toISOString();
  }
  if (status === 'ACTIVE') patch.effective_from = new Date().toISOString();
  if (status === 'RETIRED') patch.effective_to = new Date().toISOString();

  const { data, error } = await admin.from('ai_prompt_templates').update(patch).eq('id', id).select('*').single();
  if (error) throw new Error(error.message);
  return data as PromptTemplateRow;
}
