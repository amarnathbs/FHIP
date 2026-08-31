// Module 11.0 — ai_runs audit writer (spec section 32) + usage ledger
// (spec section 33). Every AIModelGateway invocation writes exactly one
// ai_runs row, success or failure, before returning to its caller. Raw
// provider payloads are NEVER stored here by default — only a context_hash
// and structural metadata (ADR-M11-001 alternative #5).

import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { currentBillingPeriod } from '@/lib/ai/billingPeriod';
import type { SafetyClassification } from '@/lib/ai/structuredOutput';
import type { AITaskType } from '@/lib/ai/providers/types';

// Module 11.1 added 'rejected_entitlement' (and widened the matching CHECK
// constraint on ai_runs in migration 0115). ADR-M11-001 decision #8 requires
// every gateway invocation to write one ai_runs row, so a request refused by
// the entitlement/quota/kill-switch gate needs a truthful status of its own —
// reusing 'blocked_safety' or 'rejected_certification' would record a false
// reason in the audit log. The specific reason (quota_exhausted, not_premium,
// kill_switch_active, ...) travels in the existing error_code column.
export type ExecutionStatus = 'success' | 'rejected_schema' | 'rejected_certification' | 'rejected_source_ref' | 'provider_error' | 'timeout' | 'blocked_safety' | 'rejected_entitlement';

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
 * model, creating it if absent.
 *
 * MODULE 11.1 DEFECT FIX (disclosed change to Module 11.0 code). This was a
 * read-modify-write: it SELECTed the row, then INSERTed or UPDATEd using
 * values computed from that already-stale read. Two concurrent AI runs in the
 * same billing period could therefore either both miss and race the table's
 * unique constraint, or lose one run's token and cost increments entirely.
 *
 * In Module 11.0 that was an accounting inaccuracy with no consequence,
 * because nothing read the ledger. Module 11.1 makes the same table the
 * source of truth for the per-user and platform-wide COST CEILINGS, so a lost
 * cost increment becomes a ceiling that under-counts real spend — a
 * correctness defect in enforcement, not just in reporting. It is fixed here
 * because making the ledger authoritative is precisely what 11.1 does.
 *
 * The RPC performs a single atomic
 * `insert ... on conflict ... do update set col = table.col + excluded.col`,
 * and deliberately touches only the accumulation columns — the quota counters
 * are owned by ai_admit_request() and are never written from this path.
 */
async function upsertUsageLedger(update: UsageLedgerUpdate): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc('ai_usage_ledger_accumulate', {
    p_user_id: update.userId,
    p_household_id: update.householdId,
    p_billing_period: currentBillingPeriod(),
    p_task_type: update.taskType,
    p_provider: update.provider,
    p_model: update.model,
    p_live_call_count: update.isLiveCall ? 1 : 0,
    p_input_tokens: update.inputTokens,
    p_cached_tokens: update.cachedTokens,
    p_output_tokens: update.outputTokens,
    p_estimated_cost_usd: update.estimatedCostUsd,
    p_actual_cost_usd: update.actualCostUsd,
  });
  // Accumulation failure must not mask the ai_runs row that was already
  // written, but it must be visible — a silently-missing ledger increment is
  // a silently-under-counted cost ceiling.
  if (error) console.error('ai_usage_ledger_accumulate failed:', error.message);
}
