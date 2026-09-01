// Module 11.3 continuation — item 4, real-Postgres (PGlite) proof of the
// async batch path: the REAL AIInsightPackBatchOrchestrator, REAL
// MockBatchInsightPackProvider, and REAL ai_insight_pack_batches /
// ai_insight_packs / ai_insight_pack_blocks tables (via the shared harness),
// not a FakeDb. Complements aiInsightPackBatchOrchestrator.test.ts's
// FakeDb-based unit certification with a genuine structural proof: the
// batch row's status/count columns and the per-household pack rows'
// batch_id linkage are exactly what a real database persisted, independently
// re-read.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const recordAiRunMock = vi.fn<(input: unknown) => Promise<string>>(async () => null as unknown as string);
vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: (input: unknown) => recordAiRunMock(input),
  hashContext: (ctx: unknown) => `hash-${JSON.stringify((ctx as { meta?: { snapshot_id?: string } })?.meta?.snapshot_id ?? '')}`,
}));

import { AIInsightPackBatchOrchestrator } from '@/lib/ai/insightPack/batchOrchestrator';
import { MockInsightPackProvider, MockBatchInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import { buildPgliteInsightPackHarness, insertPremiumUser, type PgliteInsightPackHarness } from './support/pgliteInsightPackHarness';
import { makeContext } from './support/financialContextFixture';

const USERS = ['99999999-9999-9999-9999-999999990001', '99999999-9999-9999-9999-999999990002', '99999999-9999-9999-9999-999999990003'];

describe('Module 11.3 continuation — batch orchestrator against REAL Postgres (PGlite)', () => {
  let harness: PgliteInsightPackHarness;

  beforeAll(async () => {
    harness = await buildPgliteInsightPackHarness();
    for (const [i, u] of USERS.entries()) await insertPremiumUser(harness.db, u, `pglite-batch-${i}@t.test`);
  }, 90_000);

  afterAll(async () => {
    for (const u of USERS) {
      await harness.db.query(`delete from ai_insights where user_id=$1`, [u]);
      await harness.db.query(`delete from ai_insight_packs where user_id=$1`, [u]);
      await harness.db.query(`delete from user_entitlements where user_id=$1`, [u]);
      await harness.db.query(`delete from auth.users where id=$1`, [u]);
    }
    for (const u of USERS) {
      const packs = await harness.db.query(`select id from ai_insight_packs where user_id=$1`, [u]);
      expect(packs.rows.length, `residual packs for ${u}`).toBe(0);
      const users = await harness.db.query(`select id from auth.users where id=$1`, [u]);
      expect(users.rows.length, `residual auth.users for ${u}`).toBe(0);
    }
    await harness.db.close();
  });

  it('real 3-household batch: batch row transitions PENDING->SUBMITTED->COMPLETED, pack rows are correctly batch_id-linked', async () => {
    const provider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(
      harness.dbClient, harness.batchDbClient,
      (ctx) => new MockInsightPackProvider(ctx, 'valid'),
      provider, harness.gate
    );

    const households = USERS.map((u, i) => ({
      userId: u, householdId: null,
      context: makeContext({ meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: `pglite-batch-snap-${i}` } }),
    }));

    const result = await orchestrator.generateBatch(households);

    expect(result.households.every((h) => h.status === 'READY')).toBe(true);
    expect(result.batch.status).toBe('COMPLETED');
    expect(result.batch.request_count).toBe(3);
    expect(result.batch.success_count).toBe(3);
    expect(result.batch.failure_count).toBe(0);
    expect(result.batch.submitted_at).not.toBeNull();
    expect(result.batch.completed_at).not.toBeNull();

    // Ground truth: re-read the batch row directly, independent of what the
    // orchestrator returned.
    const { rows: batchRows } = await harness.db.query(`select * from ai_insight_pack_batches where id=$1`, [result.batch.id]);
    const batchRow = batchRows[0] as Record<string, unknown>;
    expect(batchRow.status).toBe('COMPLETED');
    expect(batchRow.success_count).toBe(3);

    // Ground truth: every pack row genuinely carries this batch's id.
    for (const u of USERS) {
      const { rows } = await harness.db.query(`select batch_id, status, ready_at, grounding_status from ai_insight_packs where user_id=$1`, [u]);
      expect(rows).toHaveLength(1);
      const packRow = rows[0] as Record<string, unknown>;
      expect(packRow.batch_id).toBe(result.batch.id);
      expect(packRow.status).toBe('READY');
      expect(packRow.ready_at).not.toBeNull();
      expect(packRow.grounding_status).toBe('PASS');
    }
  });
});
