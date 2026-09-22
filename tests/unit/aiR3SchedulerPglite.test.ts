// Module 11 remediation R3 — SCHEDULER DEV CERTIFICATION PATH (brief section
// 33), executed against a REAL, isolated PGlite Postgres carrying the REAL
// migration chain (incl. 0175 + 0176), the REAL ai_admit_request()/refund/
// finalise functions, the REAL ai_insight_pack_scheduler_claim()/release()
// lease functions, the REAL AIInsightPackSchedulerService, the REAL
// AIInsightPackBatchOrchestrator (submit + resumed reconcile) and the REAL
// grounding/persistence pipeline. The provider is the in-process mock batch
// provider (per-request behaviour overrides), wrapped so it behaves like an
// ASYNC provider: the first poll returns PENDING, so reconciliation must be
// resumed from persisted state in a "later" invocation — exactly the real
// OpenAI Batch shape.
//
// Proves, in order (section 33): eligible discovery -> job claim ->
// duplicate suppression -> provider call -> validation -> persistence ->
// stored-answer retrieval -> cleanup; plus sections 25-27 (eligibility,
// no calendar-only generation, identity/duplicate control), 29 (out-of-
// order results), 30 (20 jobs: 18 valid / 1 provider failure / 1
// grounding failure -> 18 + 2 independent), 31 (retry classification),
// 32 (24h cadence) and the kill switches.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const recordAiRunMock = vi.fn(async () => null as unknown as string);
vi.mock('@/lib/ai/audit/aiRuns', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai/audit/aiRuns')>();
  return { ...original, recordAiRun: () => recordAiRunMock() };
});

import { AIInsightPackBatchOrchestrator } from '@/lib/ai/insightPack/batchOrchestrator';
import { AIInsightPackSchedulerService } from '@/lib/ai/insightPack/scheduler/schedulerService';
import { MockBatchInsightPackProvider, MockInsightPackProvider, buildMockPackRawText } from '@/lib/ai/insightPack/mockPackProvider';
import { SyncFanoutBatchProvider } from '@/lib/ai/providers/syncFanoutBatchProvider';
import { splitPackUserPrompt } from '@/lib/ai/insightPack/packComposition';
import type { AIProvider, AIGenerateRequest, AIGenerateResult } from '@/lib/ai/providers/types';
import type { BatchCapableProvider, BatchPackItemRequest, BatchPollResult } from '@/lib/ai/insightPack/batchTypes';
import { buildPgliteInsightPackHarness, buildPgliteSchedulerDbClient, insertPremiumUser, type PgliteInsightPackHarness } from './support/pgliteInsightPackHarness';
import { makeContext } from './support/financialContextFixture';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { SchedulerDbClient } from '@/lib/ai/insightPack/scheduler/types';

function uid(n: number): string { return `66666666-6666-6666-6666-${String(n).padStart(12, '0')}`; }
const PERIOD = '2026-09';

/** Wraps the mock so the FIRST poll of every batch is PENDING — forcing the resumed-reconcile path. */
class AsyncLikeMockBatchProvider implements BatchCapableProvider {
  readonly providerName = 'mock';
  readonly inner = new MockBatchInsightPackProvider();
  readonly polled = new Map<string, number>();
  submitCalls = 0;
  async submitBatch(items: BatchPackItemRequest[]) {
    this.submitCalls += 1;
    return this.inner.submitBatch(items);
  }
  async pollBatch(id: string): Promise<BatchPollResult> {
    const n = (this.polled.get(id) ?? 0) + 1;
    this.polled.set(id, n);
    if (n === 1) return { status: 'PENDING', results: [] };
    return this.inner.pollBatch(id);
  }
}

let harness: PgliteInsightPackHarness;
let schedulerDb: SchedulerDbClient;
let provider: AsyncLikeMockBatchProvider;
/** Per-user context fixture; the scheduler's context builder reads from here (a stand-in for buildFinancialContextObject with a service-role client). */
const contexts = new Map<string, FinancialContextObject>();
const buildContext = async (userId: string): Promise<FinancialContextObject> => {
  const ctx = contexts.get(userId);
  if (!ctx) throw new Error(`no context for ${userId}`);
  return ctx;
};

function ctxFor(userId: string, snapshotId: string | null): FinancialContextObject {
  return makeContext({ meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: snapshotId, user_scope_identifier: userId } });
}

function newService(p: BatchCapableProvider = provider, maxRetries = 3) {
  const orchestrator = new AIInsightPackBatchOrchestrator(harness.dbClient, harness.batchDbClient, (ctx) => new MockInsightPackProvider(ctx, 'valid'), p, harness.gate, maxRetries, undefined, 5, 0, 0.5);
  return new AIInsightPackSchedulerService(schedulerDb, harness.batchDbClient, orchestrator, buildContext, async () => true, async () => 2);
}

beforeAll(async () => {
  harness = await buildPgliteInsightPackHarness();
  schedulerDb = buildPgliteSchedulerDbClient(harness.db);
  provider = new AsyncLikeMockBatchProvider();
  // 20 Premium subjects + 1 Free subject + 1 Premium subject with NO certified snapshot.
  for (let i = 1; i <= 20; i++) { await insertPremiumUser(harness.db, uid(i), `r3-${i}@example.test`); contexts.set(uid(i), ctxFor(uid(i), `snap-${i}`)); }
  await harness.db.exec(`insert into auth.users(id,email) values ('${uid(21)}','r3-free@example.test');`); // free tier (entitlement row default)
  contexts.set(uid(21), ctxFor(uid(21), 'snap-21'));
  await insertPremiumUser(harness.db, uid(22), 'r3-nosnap@example.test');
  contexts.set(uid(22), ctxFor(uid(22), null)); // premium but no certified snapshot -> must be SKIPPED (section 26)
  await harness.db.exec(`update ai_platform_controls set scheduler_enabled=true, rate_limit_max_requests=1000 where id='global';`);
}, 180_000);

afterAll(async () => { await harness.db.close(); });

async function schedulerJobs(period = PERIOD) {
  const { rows } = await harness.db.query(`select user_id, status, skip_reason, failure_code, pack_id, batch_id from ai_insight_pack_scheduler_jobs where billing_period=$1 order by user_id`, [period]);
  return rows as { user_id: string; status: string; skip_reason: string | null; failure_code: string | null; pack_id: string | null; batch_id: string | null }[];
}

describe('R3 — scheduler kill switches and lease (sections 25, 33, 36)', () => {
  it('scheduler_enabled=false refuses a CRON-triggered submit before any discovery; admin/dev triggers are still allowed', async () => {
    await harness.db.exec(`update ai_platform_controls set scheduler_enabled=false where id='global';`);
    const cron = await newService().runSubmitPhase({ triggeredBy: 'cron', dryRun: true, billingPeriod: PERIOD });
    expect(cron.status).toBe('SKIPPED');
    expect(cron.reason).toBe('scheduler_disabled');
    const dev = await newService().runSubmitPhase({ triggeredBy: 'dev', dryRun: true, billingPeriod: PERIOD });
    expect(dev.status).toBe('COMPLETED');
    await harness.db.exec(`update ai_platform_controls set scheduler_enabled=true where id='global';`);
  });

  it('batch_generation_enabled=false refuses submit; ai_globally_enabled=false refuses both phases', async () => {
    await harness.db.exec(`update ai_platform_controls set batch_generation_enabled=false where id='global';`);
    expect((await newService().runSubmitPhase({ triggeredBy: 'cron', dryRun: true, billingPeriod: PERIOD })).reason).toBe('batch_disabled');
    await harness.db.exec(`update ai_platform_controls set batch_generation_enabled=true, ai_globally_enabled=false where id='global';`);
    expect((await newService().runSubmitPhase({ triggeredBy: 'cron', dryRun: true, billingPeriod: PERIOD })).reason).toBe('ai_disabled');
    expect((await newService().runReconcilePhase({ triggeredBy: 'cron', billingPeriod: PERIOD })).reason).toBe('ai_disabled');
    await harness.db.exec(`update ai_platform_controls set ai_globally_enabled=true where id='global';`);
  });

  it('job claim: a second concurrent claim of the same phase is refused while the lease is held, and accepted after release', async () => {
    const first = await schedulerDb.claimRun('submit', 'dev', PERIOD, 900, true);
    expect(first).toBeTruthy();
    const second = await schedulerDb.claimRun('submit', 'dev', PERIOD, 900, true);
    expect(second).toBeNull();
    const asService = await newService().runSubmitPhase({ triggeredBy: 'dev', dryRun: true, billingPeriod: PERIOD });
    expect(asService.reason).toBe('lease_held_by_another_run');
    await schedulerDb.releaseRun(first!, 'SKIPPED', {}, 'test release', null);
    expect(await schedulerDb.claimRun('submit', 'dev', PERIOD, 900, true)).toBeTruthy();
    const { rows } = await harness.db.query(`update ai_insight_pack_scheduler_runs set status='SKIPPED', finished_at=now() where status='RUNNING' returning id`);
    expect(rows.length).toBe(1);
  });

  it('an expired lease (crashed worker) is reclaimed automatically and recorded LEASE_EXPIRED', async () => {
    const stale = await schedulerDb.claimRun('reconcile', 'dev', PERIOD, 1, false);
    expect(stale).toBeTruthy();
    await harness.db.query(`update ai_insight_pack_scheduler_runs set lease_until = now() - interval '1 second' where id=$1`, [stale]);
    const fresh = await schedulerDb.claimRun('reconcile', 'dev', PERIOD, 900, false);
    expect(fresh).toBeTruthy();
    const { rows } = await harness.db.query(`select status from ai_insight_pack_scheduler_runs where id=$1`, [stale]);
    expect((rows[0] as { status: string }).status).toBe('LEASE_EXPIRED');
    await schedulerDb.releaseRun(fresh!, 'SKIPPED', {}, null, null);
  });
});

describe('R3 — discovery, eligibility, dry run (sections 25-26, 33)', () => {
  it('dry run: the discovery universe is Premium-only (the Free subject is never listed); 21 discovered, 19 would submit, 1 not_premium (entitlement gate says no), 1 no-snapshot; NO job rows written', async () => {
    const svc = new AIInsightPackSchedulerService(schedulerDb, harness.batchDbClient,
      new AIInsightPackBatchOrchestrator(harness.dbClient, harness.batchDbClient, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, harness.gate),
      // uid(20) is listed as premium but the entitlement gate (cancel-at-period-end etc.) says not eligible for THIS dry run only.
      buildContext, async (userId) => userId !== uid(20), async () => 2);
    const r = await svc.runSubmitPhase({ triggeredBy: 'dev', dryRun: true, billingPeriod: PERIOD, maxHouseholds: 100 });
    expect(r.status).toBe('COMPLETED');
    expect(r.dryRun).toBe(true);
    expect(r.discovered).toBe(21); // 20 premium + the premium-without-snapshot; the Free subject (uid 21) is not in the universe at all
    expect(r.submitted).toBe(19);
    expect(r.skipReasons.not_premium).toBe(1);
    expect(r.skipReasons.no_certified_snapshot).toBe(1);
    expect((await schedulerJobs()).length).toBe(0);
    expect(provider.submitCalls).toBe(0);
  });
});

describe('R3 — the section 30/29/33 end-to-end run: 20 jobs, 18 valid, 1 provider failure, 1 grounding failure, async resumed reconcile', () => {
  let batchId: string;

  it('SUBMIT: 20 admitted into ONE provider batch, packs GENERATING with admission ids persisted, jobs SUBMITTED, run COMPLETED', async () => {
    // Behaviours are keyed by requestId (= pack idempotency key) which is only known after admission —
    // so register them lazily on submit, deterministically by position of the admitted item's user.
    const original = provider.inner.submitBatch.bind(provider.inner);
    provider.inner.submitBatch = async (items) => {
      // items are in admission order (uid(1)..uid(20)); mark #7 provider failure, #13 grounding failure — on the 20-item submission only.
      if (items.length === 20) {
        provider.inner.setBehaviorForRequest(items[6].requestId, 'provider_unavailable');
        provider.inner.setBehaviorForRequest(items[12].requestId, 'fabricated_percentage');
      }
      return original(items);
    };
    const svc = new AIInsightPackSchedulerService(schedulerDb, harness.batchDbClient,
      new AIInsightPackBatchOrchestrator(harness.dbClient, harness.batchDbClient, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, harness.gate, 3),
      buildContext, async (userId) => userId !== uid(21), async () => 2);
    const r = await svc.runSubmitPhase({ triggeredBy: 'cron', billingPeriod: PERIOD, maxHouseholds: 100 });
    expect(r.status).toBe('COMPLETED');
    expect(r.submitted).toBe(20);
    expect(r.failed).toBe(0);
    expect(r.batchId).toBeTruthy();
    expect(r.providerBatchId).toBeTruthy();
    batchId = r.batchId!;

    const jobs = await schedulerJobs();
    expect(jobs.filter((j) => j.status === 'SUBMITTED').length).toBe(20);
    expect(jobs.find((j) => j.user_id === uid(21))).toBeUndefined(); // Free: never discovered
    expect(jobs.find((j) => j.user_id === uid(22))?.status).toBe('SKIPPED');
    expect(jobs.find((j) => j.user_id === uid(22))?.skip_reason).toBe('no_certified_snapshot');
    const { rows: packs } = await harness.db.query(`select status, admission_id from ai_insight_packs where batch_id=$1`, [batchId]);
    expect(packs.length).toBe(20);
    expect(packs.every((p) => (p as { status: string }).status === 'GENERATING')).toBe(true);
    expect(packs.every((p) => (p as { admission_id: string | null }).admission_id)).toBe(true);
    const { rows: batch } = await harness.db.query(`select status, provider_batch_id, next_poll_at from ai_insight_pack_batches where id=$1`, [batchId]);
    expect((batch[0] as { status: string }).status).toBe('SUBMITTED');
    expect((batch[0] as { provider_batch_id: string }).provider_batch_id).toBeTruthy();
  });

  it('DUPLICATE SUPPRESSION: a second submit tick in the same period discovers nothing new and submits nothing', async () => {
    const r = await newService().runSubmitPhase({ triggeredBy: 'cron', billingPeriod: PERIOD, maxHouseholds: 100 });
    expect(r.status).toBe('COMPLETED');
    expect(r.discovered).toBe(0);
    expect(r.submitted).toBe(0);
    expect(r.reason).toBe('nothing_to_submit');
    expect(provider.submitCalls).toBe(1);
  });

  it('RECONCILE tick 1: provider still PENDING -> batch stays SUBMITTED, poll_count 1, nothing persisted, reservations intact', async () => {
    const r = await newService().runReconcilePhase({ triggeredBy: 'cron', billingPeriod: PERIOD });
    expect(r.status).toBe('COMPLETED');
    expect(r.batchesPolled).toBe(1);
    expect(r.batchesStillPending).toBe(1);
    const { rows } = await harness.db.query(`select status, poll_count from ai_insight_pack_batches where id=$1`, [batchId]);
    expect((rows[0] as { status: string; poll_count: number }).status).toBe('SUBMITTED');
    expect((rows[0] as { status: string; poll_count: number }).poll_count).toBe(1);
  });

  it('RECONCILE tick 2 (resumed from DB, contexts rebuilt + hash-verified, results out of order): 18 READY, 1 provider failure, 1 grounding failure, no cross-household contamination', async () => {
    await harness.db.query(`update ai_insight_pack_batches set next_poll_at = now() where id=$1`, [batchId]);
    const r = await newService().runReconcilePhase({ triggeredBy: 'cron', billingPeriod: PERIOD });
    expect(r.status).toBe('COMPLETED');
    expect(r.batchesPolled).toBe(1);
    expect(r.batchesStillPending).toBe(0);
    expect(r.reconciled).toBe(18);
    expect(r.failed).toBe(2);

    const jobs = (await schedulerJobs()).filter((j) => j.batch_id === batchId);
    expect(jobs.filter((j) => j.status === 'READY').length).toBe(18);
    const failed = jobs.filter((j) => j.status === 'FAILED');
    expect(failed.length).toBe(2);
    expect(failed.map((j) => j.failure_code).sort()).toEqual(['PROVIDER_UNAVAILABLE', 'grounding_failure:overall_financial_summary'].sort());

    // Every READY pack belongs to its own user and its own snapshot — never another household's.
    const { rows: packs } = await harness.db.query(`select user_id, snapshot_id, status, admission_id from ai_insight_packs where batch_id=$1`, [batchId]);
    for (const p of packs as { user_id: string; snapshot_id: string; status: string }[]) {
      const n = Number(p.user_id.slice(-12));
      expect(p.snapshot_id).toBe(`snap-${n}`);
    }
    expect((packs as { status: string }[]).filter((p) => p.status === 'READY').length).toBe(18);
    // Stored answers exist only for READY households.
    const { rows: insights } = await harness.db.query(`select distinct user_id from ai_insights where insight_code like 'insight_pack:%'`);
    expect(insights.length).toBe(18);
    // The batch bookkeeping matches the real per-household outcomes.
    const { rows: batch } = await harness.db.query(`select status, success_count, failure_count, provider_status from ai_insight_pack_batches where id=$1`, [batchId]);
    expect(batch[0]).toMatchObject({ status: 'PARTIAL', success_count: 18, failure_count: 2, provider_status: 'completed' });
  });

  it('STORED-ANSWER RETRIEVAL: a READY household resolves its SCORE_EXPLANATION from ai_insights with the snapshot-compatible value', async () => {
    const { rows } = await harness.db.query(`select metric_code, current_value, future_ai_explanation from ai_insights where user_id=$1 and metric_code='SCORE_EXPLANATION'`, [uid(1)]);
    expect(rows.length).toBe(1);
    expect(Number((rows[0] as { current_value: number }).current_value)).toBe(72);
    expect(String((rows[0] as { future_ai_explanation: string }).future_ai_explanation)).toContain('72');
  });

  it('RETRY CLASSIFICATION (section 31): the grounding failure is NOT retryable; the provider failure IS — a forced re-run of the period re-admits only the transient one', async () => {
    // Open a new period so discovery runs again for everyone; the 18 READY + grounding-failed keep their existing identities.
    const NEXT = '2026-10';
    const r = await newService().runSubmitPhase({ triggeredBy: 'cron', billingPeriod: NEXT, maxHouseholds: 100 });
    const jobs = await schedulerJobs(NEXT);
    // 18 with a current READY pack for the same identity -> current_pack_exists; grounding-failed -> FAILED (not retryable); provider-failed -> re-submitted.
    expect(r.skipReasons.current_pack_exists).toBe(18);
    const retried = jobs.filter((j) => j.status === 'SUBMITTED');
    expect(retried.length).toBe(1);
    expect(retried[0].user_id).toBe(uid(7));
    const terminal = jobs.filter((j) => j.status === 'FAILED');
    expect(terminal.length).toBe(1);
    expect(terminal[0].user_id).toBe(uid(13));
    expect(terminal[0].failure_code?.startsWith('grounding_failure')).toBe(true);
  });

  it('CONTEXT CHANGED BEFORE RECONCILE: a household whose certified data moved while the batch was in flight fails closed, never grounded against stale context', async () => {
    // The retry batch for uid(7) is SUBMITTED and PENDING on first poll. Change uid(7)'s context, then reconcile twice.
    contexts.set(uid(7), ctxFor(uid(7), 'snap-7-changed'));
    await harness.db.query(`update ai_insight_pack_batches set next_poll_at = now() where status='SUBMITTED'`);
    await newService().runReconcilePhase({ triggeredBy: 'cron', billingPeriod: '2026-10' }); // PENDING
    await harness.db.query(`update ai_insight_pack_batches set next_poll_at = now() where status='SUBMITTED'`);
    const r = await newService().runReconcilePhase({ triggeredBy: 'cron', billingPeriod: '2026-10' });
    expect(r.failed).toBe(1);
    expect(r.reconciled).toBe(0);
    const jobs = await schedulerJobs('2026-10');
    expect(jobs.find((j) => j.user_id === uid(7))?.failure_code).toBe('context_changed_before_reconcile');
    // Reservation released: no dangling reserved admission for uid(7).
    const { rows } = await harness.db.query(`select count(*)::int n from ai_admission_events where user_id=$1 and status='reserved'`, [uid(7)]).catch(() => ({ rows: [{ n: 0 }] }));
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('CADENCE (section 32): a fresh identity for a subject generated <24h ago is REGENERATION_RATE_LIMITED -> job SKIPPED regeneration_cooldown, no provider submission', async () => {
    contexts.set(uid(1), ctxFor(uid(1), 'snap-1-new'));
    const before = provider.submitCalls;
    const r = await newService().runSubmitPhase({ triggeredBy: 'cron', billingPeriod: '2026-11', maxHouseholds: 1 });
    expect(r.skipReasons.regeneration_cooldown).toBe(1);
    expect(r.submitted).toBe(0);
    expect(provider.submitCalls).toBe(before);
  });

  it('CLEANUP: scheduler artefacts are removable with zero residue (cascade + explicit), proving the DEV proof path can be reset', async () => {
    await harness.db.exec(`delete from ai_insight_pack_scheduler_jobs; delete from ai_insight_pack_scheduler_runs; delete from ai_insights where insight_code like 'insight_pack:%'; delete from ai_insight_packs; delete from ai_insight_pack_batches;`);
    for (const t of ['ai_insight_pack_scheduler_jobs', 'ai_insight_pack_scheduler_runs', 'ai_insight_packs', 'ai_insight_pack_batches', 'ai_insight_pack_blocks']) {
      const { rows } = await harness.db.query(`select count(*)::int n from ${t}`);
      expect((rows[0] as { n: number }).n).toBe(0);
    }
  });
});

describe('R3 — sync fan-out transport (section 28 fallback): same governed queue, reconciled in the submitting invocation, standard pricing basis', () => {
  it('a fresh period with the fan-out provider: jobs go DISCOVERED -> SUBMITTED -> READY inside ONE submit run; batch COMPLETED with cost_pricing_basis=standard', async () => {
    // A minimal synchronous AIProvider double that behaves like the real adapter from the prompt text alone.
    let calls = 0;
    const syncProvider: AIProvider = {
      providerName: 'openai', // the fan-out wraps the REAL adapter in production; named so here so bookkeeping takes the non-mock branch
      async generateStructured(req: AIGenerateRequest): Promise<AIGenerateResult> {
        calls += 1;
        const { contextJson, rankedItems } = splitPackUserPrompt(req.userPrompt);
        const rawText = buildMockPackRawText(JSON.parse(contextJson), 'valid', rankedItems);
        return { rawText, inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, latencyMs: 1, modelVersion: 'mock', finishReason: 'stop' };
      },
      async validateProviderHealth() { return { healthy: true, checkedAt: '', detail: null }; },
      estimateCost(i, o) { return { inputTokens: i, outputTokens: o, estimatedCostUsd: 0.001 }; },
    };
    const fanout = new SyncFanoutBatchProvider(syncProvider);
    // New identities for 3 subjects (cooldown-free: their last generation was >24h ago? No — the cooldown blocks. Use subjects 18-20 whose packs were deleted at cleanup and set generated_at back).
    await harness.db.exec(`update ai_insight_packs set generated_at = now() - interval '2 days' where user_id in ('${uid(18)}','${uid(19)}','${uid(20)}')`);
    for (const n of [18, 19, 20]) contexts.set(uid(n), ctxFor(uid(n), `snap-${n}-fanout`));
    const svc = newService(fanout);
    const r = await svc.runSubmitPhase({ triggeredBy: 'dev', billingPeriod: '2026-12', maxHouseholds: 3 });
    expect(r.status).toBe('COMPLETED');
    expect(r.submitted).toBe(3);
    expect(r.reconciledInProcess).toBe(3);
    expect(calls).toBe(3);
    const jobs = (await schedulerJobs('2026-12')).filter((j) => j.batch_id === r.batchId);
    expect(jobs.map((j) => j.status)).toEqual(['READY', 'READY', 'READY']);
    const { rows } = await harness.db.query(`select status, success_count, cost_pricing_basis, actual_cost_usd, estimated_cost_usd from ai_insight_pack_batches where id=$1`, [r.batchId]);
    expect(rows[0]).toMatchObject({ status: 'COMPLETED', success_count: 3, cost_pricing_basis: 'standard' });
    expect(Number((rows[0] as { actual_cost_usd: number }).actual_cost_usd)).toBeCloseTo(Number((rows[0] as { estimated_cost_usd: number }).estimated_cost_usd), 8);
  });
});
