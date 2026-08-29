// Module 11.0 — ai_runs audit writer (spec section 32) + usage ledger
// (spec section 33). Every AIModelGateway invocation writes exactly one
// ai_runs row, success or failure, before returning to its caller. Raw
// provider payloads are NEVER stored here by default — only a context_hash
// and structural metadata (ADR-M11-001 alternative #5).

import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SafetyClassification } from '@/lib/ai/structuredOutput';
import type { AITaskType } from '@/lib/ai/providers/types';

export type ExecutionStatus = 'success' | 'rejected_schema' | 'rejected_certification' | 'rejected_source_ref' | 'provider_error' | 'timeout' | 'blocked_safety';

export interface RecordAiRunInput {
  userId: string;
  householdId: string | null;
  conversationId?: string | null;
  requestType: AITaskType;
  promptTemplateId: string | null;
  promptVersion: number | null;
  contextVersion: string;
  contextObject: unknown;
  sourceReferenceIds: string[];
  provider: string;
  model: string;
  modelVersion: string | null;
  inputTokenCount: number;
  cachedInputTokenCount: number;
  outputTokenCount: number;
  estimatedCostUsd: number;
  actualCostUsd?: number | null;
  latencyMs: number;
  structuredOutput: unknown | null;
  safetyClassification: SafetyClassification | null;
  safetyFlags: string[];
  groundingStatus: 'grounded' | 'ungrounded' | 'not_applicable';
  executionStatus: ExecutionStatus;
  errorCode: string | null;
}

export function hashContext(contextObject: unknown): string {
  return createHash('sha256').update(JSON.stringify(contextObject)).digest('hex');
}

export async function recordAiRun(input: RecordAiRunInput): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_runs')
    .insert({
      user_id: input.userId,
      household_id: input.householdId,
      conversation_id: input.conversationId ?? null,
      request_type: input.requestType,
      prompt_template_id: input.promptTemplateId,
      prompt_version: input.promptVersion,
      context_version: input.contextVersion,
      context_hash: hashContext(input.contextObject),
      source_reference_ids: input.sourceReferenceIds,
      provider: input.provider,
      model: input.model,
      model_version: input.modelVersion,
      input_token_count: input.inputTokenCount,
      cached_input_token_count: input.cachedInputTokenCount,
      output_token_count: input.outputTokenCount,
      estimated_cost_usd: input.estimatedCostUsd,
      actual_cost_usd: input.actualCostUsd ?? null,
      latency_ms: input.latencyMs,
      structured_output: input.structuredOutput,
      safety_classification: input.safetyClassification,
      safety_flags: input.safetyFlags,
      grounding_status: input.groundingStatus,
      execution_status: input.executionStatus,
      error_code: input.errorCode,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to record ai_runs audit row: ${error.message}`);

  await upsertUsageLedger({
    userId: input.userId,
    householdId: input.householdId,
    taskType: input.requestType,
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokenCount,
    cachedTokens: input.cachedInputTokenCount,
    outputTokens: input.outputTokenCount,
    estimatedCostUsd: input.estimatedCostUsd,
    actualCostUsd: input.actualCostUsd ?? null,
    isLiveCall: input.executionStatus === 'success',
  });

  return data.id as string;
}

function currentBillingPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface UsageLedgerUpdate {
  userId: string;
  householdId: string | null;
  taskType: AITaskType;
  provider: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  isLiveCall: boolean;
}

/**
 * Increments the current billing period's ledger row for this user/task/
 * model, creating it if absent. No quota enforcement happens here — this is
 * pure accumulation, ready for 11.1 to read from (spec section 33/56: no
 * enforcement in 11.0).
 */
async function upsertUsageLedger(update: UsageLedgerUpdate): Promise<void> {
  const admin = createAdminClient();
  const billingPeriod = currentBillingPeriod();
  const { data: existing } = await admin
    .from('ai_usage_ledger')
    .select('*')
    .eq('user_id', update.userId)
    .eq('billing_period', billingPeriod)
    .eq('task_type', update.taskType)
    .eq('provider', update.provider)
    .eq('model', update.model)
    .maybeSingle();

  if (!existing) {
    await admin.from('ai_usage_ledger').insert({
      user_id: update.userId,
      household_id: update.householdId,
      billing_period: billingPeriod,
      task_type: update.taskType,
      provider: update.provider,
      model: update.model,
      live_call_count: update.isLiveCall ? 1 : 0,
      batch_call_count: 0,
      cached_answer_count: 0,
      input_tokens: update.inputTokens,
      cached_tokens: update.cachedTokens,
      output_tokens: update.outputTokens,
      estimated_cost_usd: update.estimatedCostUsd,
      actual_cost_usd: update.actualCostUsd,
    });
    return;
  }

  await admin
    .from('ai_usage_ledger')
    .update({
      live_call_count: existing.live_call_count + (update.isLiveCall ? 1 : 0),
      input_tokens: existing.input_tokens + update.inputTokens,
      cached_tokens: existing.cached_tokens + update.cachedTokens,
      output_tokens: existing.output_tokens + update.outputTokens,
      estimated_cost_usd: existing.estimated_cost_usd + update.estimatedCostUsd,
      actual_cost_usd: update.actualCostUsd !== null ? (existing.actual_cost_usd ?? 0) + update.actualCostUsd : existing.actual_cost_usd,
    })
    .eq('id', existing.id);
}
