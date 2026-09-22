// Module 11.3 continuation — the real (non-test) InsightPackBatchDbClient,
// wiring AIInsightPackBatchOrchestrator to the actual ai_insight_pack_batches
// table. Mirrors insightPackDbClient.ts's own split from the service class.

import { createAdminClient } from '@/lib/supabase/admin';
import type { BatchRow, InsertBatchInput, InsightPackBatchDbClient } from '@/lib/ai/insightPack/batchTypes';
import type { PackRow } from '@/lib/ai/insightPack/insightPackService';

function batchRowFromDb(row: Record<string, unknown>): BatchRow {
  return row as unknown as BatchRow;
}

export const realInsightPackBatchDbClient: InsightPackBatchDbClient = {
  async insertBatch(input: InsertBatchInput): Promise<BatchRow> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_pack_batches')
      .insert({
        provider: input.provider,
        task_type: input.taskType,
        status: 'PENDING',
        request_count: input.requestCount,
        success_count: 0,
        failure_count: 0,
        estimated_cost_usd: 0,
      })
      .select('*')
      .single();
    if (error) throw new Error(`insertBatch failed: ${error.message}`);
    return batchRowFromDb(data);
  },

  async updateBatch(id: string, patch: Partial<BatchRow>): Promise<BatchRow> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_pack_batches')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(`updateBatch failed: ${error.message}`);
    return batchRowFromDb(data);
  },

  // R3 — resumed reconciliation reads.
  async listPacksForBatch(batchId: string): Promise<PackRow[]> {
    const admin = createAdminClient();
    const { data, error } = await admin.from('ai_insight_packs').select('*').eq('batch_id', batchId).order('created_at', { ascending: true });
    if (error) throw new Error(`listPacksForBatch failed: ${error.message}`);
    return (data ?? []) as unknown as PackRow[];
  },

  async listOpenBatches(limit: number): Promise<BatchRow[]> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ai_insight_pack_batches')
      .select('*')
      .eq('status', 'SUBMITTED')
      .not('provider_batch_id', 'is', null)
      .lte('next_poll_at', new Date().toISOString())
      .order('next_poll_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`listOpenBatches failed: ${error.message}`);
    return (data ?? []).map((r) => batchRowFromDb(r as Record<string, unknown>));
  },
};
