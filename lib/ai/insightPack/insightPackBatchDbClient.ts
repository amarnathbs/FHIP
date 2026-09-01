// Module 11.3 continuation — the real (non-test) InsightPackBatchDbClient,
// wiring AIInsightPackBatchOrchestrator to the actual ai_insight_pack_batches
// table. Mirrors insightPackDbClient.ts's own split from the service class.

import { createAdminClient } from '@/lib/supabase/admin';
import type { BatchRow, InsertBatchInput, InsightPackBatchDbClient } from '@/lib/ai/insightPack/batchTypes';

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
};
