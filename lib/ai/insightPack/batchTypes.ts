// Module 11.3 continuation — async batch-provider path (the one genuine
// scope gap the original CONDITIONAL PASS disclosed, spec sections 25-26,
// 66-69). Provider-neutral contract: a real batch-capable provider (a
// vendor Batch API) could implement `BatchCapableProvider` directly,
// without the orchestration layer below ever changing.
//
// DESIGN. A batch submission carries N independent household requests, each
// with a STABLE, caller-assigned `requestId` (this module reuses the same
// pack-identity idempotency key every household already gets for the
// single-call path — lib/ai/insightPack/packIdentity.ts — so a batch result
// is matched back to its household the identical way idempotency already
// matches a duplicate single-call request, not a new correlation scheme).
// Results may return in ANY order and must be attributed by `requestId`
// alone, never by array position — see AIInsightPackBatchOrchestrator's
// reconciliation step and its adversarial cross-tenant test.

export interface BatchPackItemRequest {
  /** Stable per-household id — the pack identity's own idempotency key. Never reused across households. */
  requestId: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxOutputTokens: number;
}

export type BatchPackItemResult =
  | { requestId: string; ok: true; rawText: string; inputTokens: number; outputTokens: number }
  | { requestId: string; ok: false; errorCode: string; errorMessage: string };

export type BatchPollStatus = 'PENDING' | 'COMPLETED';

export interface BatchPollResult {
  status: BatchPollStatus;
  /** May be a SUBSET of, in ANY order relative to, the submitted items — the orchestrator must not assume completeness or order. */
  results: BatchPackItemResult[];
  /** R3 — set by a real async provider when the batch itself ended in a non-success terminal state (failed/expired/cancelled). Items absent from `results` are then batch-level failures. */
  batchFailure?: { status: string; message: string };
}

/**
 * Provider-neutral batch contract. A provider that cannot batch simply does
 * not implement this — the orchestrator only accepts a provider satisfying
 * it (spec section 25: "provider-neutral... a real batch-capable provider
 * could later be substituted without changing the orchestration layer").
 */
export interface BatchCapableProvider {
  readonly providerName: string;
  submitBatch(items: BatchPackItemRequest[]): Promise<{ providerBatchId: string; itemCount: number }>;
  pollBatch(providerBatchId: string): Promise<BatchPollResult>;
}

export function isBatchCapable(provider: unknown): provider is BatchCapableProvider {
  return !!provider && typeof (provider as BatchCapableProvider).submitBatch === 'function' && typeof (provider as BatchCapableProvider).pollBatch === 'function';
}

// ---------------------------------------------------------------------------
// ai_insight_pack_batches (migration 0121) — bookkeeping-only grouping row.
// PENDING -> SUBMITTED -> COMPLETED|PARTIAL|FAILED, with request_count/
// success_count/failure_count/estimated_cost_usd computed from REAL
// per-household outcomes, never hardcoded (spec section 26).
// ---------------------------------------------------------------------------
export type BatchStatus = 'PENDING' | 'SUBMITTED' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface BatchRow {
  id: string;
  provider: string;
  task_type: string;
  status: BatchStatus;
  submitted_at: string | null;
  completed_at: string | null;
  request_count: number;
  success_count: number;
  failure_count: number;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
  // R3 (migration 0176) — real async provider bookkeeping. Optional so the
  // pre-R3 in-memory doubles keep compiling; the real client returns them.
  provider_batch_id?: string | null;
  provider_input_file_id?: string | null;
  provider_output_file_id?: string | null;
  provider_status?: string | null;
  poll_count?: number;
  next_poll_at?: string | null;
  cost_pricing_basis?: 'standard' | 'batch' | null;
}

export interface InsertBatchInput {
  provider: string;
  taskType: string;
  requestCount: number;
}

export interface InsightPackBatchDbClient {
  insertBatch(input: InsertBatchInput): Promise<BatchRow>;
  updateBatch(id: string, patch: Partial<BatchRow>): Promise<BatchRow>;
  /** R3 — the packs admitted into a batch (for resumed reconciliation). */
  listPacksForBatch(batchId: string): Promise<import('@/lib/ai/insightPack/insightPackService').PackRow[]>;
  /** R3 — SUBMITTED batches whose next_poll_at has passed. */
  listOpenBatches(limit: number): Promise<BatchRow[]>;
}
