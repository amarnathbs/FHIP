// Module 11 remediation R3 — SyncFanoutBatchProvider (brief section 28,
// second paragraph): the governed-async-queue transport for when the
// provider-native batch mode is NOT available.
//
// WHY THIS EXISTS — a real finding, not a hypothetical. The first live
// OpenAI Batch API probe on 2026-09-22 (scripts/module11/real_batch_dev_probe.ts)
// completed the full mechanical round trip (file upload -> batch created ->
// validating -> in_progress -> completed -> output matched by custom_id) but
// every item came back `403 Project ... does not have access to model
// gpt-4o-mini-2024-07-18-batch`: the OpenAI PROJECT this credential belongs
// to is not entitled to the batch model variant. That is an account-console
// setting only the account owner can change, so until it is changed the
// monthly pipeline needs a transport that preserves the commercial
// architecture (jobs ledger, lease, per-household admission, idempotent
// identity, reconciliation by request id, cost attribution) WITHOUT
// pretending to be a provider-native batch.
//
// HOW IT WORKS. It implements the same provider-neutral BatchCapableProvider
// contract. submitBatch() executes every item through the SYNCHRONOUS
// adapter (OpenAIProviderAdapter — same strict schema, same guards, standard
// pricing) one at a time, in the submitting process, and stores the results
// in memory keyed by a generated batch id; pollBatch() returns COMPLETED on
// the first call. `completesSynchronously = true` tells the orchestrator
// and scheduler to reconcile in the SAME invocation (an ephemeral Next.js
// runtime cannot rely on a later process finding in-memory results).
//
// COST: standard rate (no 50% batch discount) — the batch row records
// cost_pricing_basis 'standard'. BLAST RADIUS: the scheduler bounds
// households per run (MODULE11_SCHEDULER_MAX_HOUSEHOLDS_PER_RUN, default 5
// in this mode) so one tick stays within a single HTTP invocation's budget.
//
// Selected by MODULE11_AI_BATCH_MODE = 'sync_fanout' (the default until the
// project is entitled to the batch model; 'provider_batch' switches to
// OpenAIBatchProvider — see lib/ai/providers/providerFactory.ts).

import type { AIProvider } from '@/lib/ai/providers/types';
import { ProviderError } from '@/lib/ai/providers/types';
import type { BatchCapableProvider, BatchPackItemRequest, BatchPackItemResult, BatchPollResult } from '@/lib/ai/insightPack/batchTypes';

export class SyncFanoutBatchProvider implements BatchCapableProvider {
  readonly providerName: string;
  /** Orchestrator/scheduler hint: results exist only in this process — reconcile now. */
  readonly completesSynchronously = true as const;
  private readonly batches = new Map<string, BatchPollResult>();
  private seq = 0;

  constructor(private readonly inner: AIProvider) {
    this.providerName = inner.providerName;
  }

  async submitBatch(items: BatchPackItemRequest[]): Promise<{ providerBatchId: string; itemCount: number }> {
    if (items.length === 0) throw new ProviderError('INVALID_REQUEST', 'Refusing to submit an empty batch.');
    const providerBatchId = `fanout-${Date.now()}-${++this.seq}`;
    const results: BatchPackItemResult[] = [];
    for (const item of items) {
      try {
        const r = await this.inner.generateStructured({
          systemPrompt: item.systemPrompt,
          userPrompt: item.userPrompt,
          taskType: 'monthly_insight_pack',
          model: item.model,
          maxOutputTokens: item.maxOutputTokens,
          responseSchema: 'insight_pack_envelope',
        });
        results.push({ requestId: item.requestId, ok: true, rawText: r.rawText, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
      } catch (err) {
        results.push({ requestId: item.requestId, ok: false, errorCode: err instanceof ProviderError ? err.code : 'UNKNOWN', errorMessage: err instanceof Error ? err.message : 'provider call failed' });
      }
    }
    this.batches.set(providerBatchId, { status: 'COMPLETED', results });
    return { providerBatchId, itemCount: items.length };
  }

  async pollBatch(providerBatchId: string): Promise<BatchPollResult> {
    const found = this.batches.get(providerBatchId);
    if (!found) {
      // A later process cannot see this batch: report it as a failed batch so
      // the orchestrator fails the households closed (refund + retry-eligible)
      // rather than waiting forever.
      return { status: 'COMPLETED', results: [], batchFailure: { status: 'lost', message: 'Sync fan-out results are not persisted across processes; this batch must be reconciled in the process that submitted it.' } };
    }
    return found;
  }
}
