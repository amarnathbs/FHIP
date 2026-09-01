// Module 11.3 continuation — item 2 of the closure dispatch: a SAFE,
// ISOLATED live behavioural proof of the kill-switch / hard-cost-ceiling
// stop, using the REAL code paths (not a reimplementation), without ever
// touching the SHARED DEV `ai_platform_controls` singleton row (which other
// agents may be concurrently relying on).
//
// ISOLATION MECHANISM: a fresh, ephemeral PGlite Postgres instance (built by
// tests/unit/support/pgliteInsightPackHarness.ts) — the full real migration
// chain (0001..latest) applied from empty, exactly as
// scripts/db-rebuild-check/*.mjs already do for structural certification.
// This instance's `ai_platform_controls` row is entirely private to this
// test process; nothing here can be observed by, or interfere with, any
// concurrent DEV workload.
//
// REAL CODE PATHS EXERCISED (not reimplemented):
//   * the REAL `ai_admit_request()` / `ai_refund_admission()` /
//     `ai_finalise_admission()` SQL functions (verbatim from the migrations
//     — the actual kill-switch/cost-ceiling enforcement logic lives there,
//     not in application code);
//   * the REAL `interpretAdmissionPayload()` result-interpreter
//     (lib/ai/entitlement/entitlementService.ts), reused verbatim to
//     translate the RPC's row into a typed AdmissionResult — only the
//     TRANSPORT is swapped (a direct PGlite query instead of an HTTP
//     `.rpc()` call over a real Supabase project), not the interpretation
//     logic;
//   * the REAL `AIPersonalisedInsightPackService` (lib/ai/insightPack/
//     insightPackService.ts), completely unmodified;
//   * the REAL `AIModelGateway` (lib/ai/gateway/aiModelGateway.ts),
//     completely unmodified — `recordAiRun`/`hashContext` are mocked (the
//     SAME seam every other Module 11.3 unit test already uses, because
//     recordAiRun hits a live Supabase project this sandbox has no
//     connection for; this is the ONLY substitution anywhere in this file);
//   * the REAL `MockInsightPackProvider` (lib/ai/insightPack/
//     mockPackProvider.ts), wrapped only to COUNT calls, never to change
//     its behaviour.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// ai_insight_packs.ai_run_id is a real FK column (references ai_runs(id),
// nullable) even in this PGlite instance. recordAiRun is mocked (the SAME
// seam every other Module 11.3 unit test uses, since it hits a live
// Supabase project this sandbox has no connection for) — it returns null
// rather than a fabricated non-existent uuid, so the nullable FK is
// satisfied honestly instead of risking a silent foreign-key mismatch.
const recordAiRunMock = vi.fn<(input: unknown) => Promise<string>>(async () => null as unknown as string);
vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: (input: unknown) => recordAiRunMock(input),
  hashContext: (ctx: unknown) => `hash-${JSON.stringify((ctx as { meta?: { snapshot_id?: string } })?.meta?.snapshot_id ?? '')}`,
}));

import { AIPersonalisedInsightPackService } from '@/lib/ai/insightPack/insightPackService';
import { MockInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import { buildPgliteInsightPackHarness, insertPremiumUser, type PgliteInsightPackHarness } from './support/pgliteInsightPackHarness';
import { makeContext } from './support/financialContextFixture';

const USER = '77777777-7777-7777-7777-777777777701';

describe('Module 11.3 — ISOLATED live kill-switch / hard-cost-ceiling proof (real RPC, real service, ephemeral PGlite)', () => {
  let harness: PgliteInsightPackHarness;
  let providerCallCount = 0;

  class CountingProvider extends MockInsightPackProvider {
    async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) {
      providerCallCount++;
      return super.generateStructured(req);
    }
  }

  beforeAll(async () => {
    harness = await buildPgliteInsightPackHarness();
    await insertPremiumUser(harness.db, USER, 'isolated-kill-switch@t.test');
  }, 90_000);

  afterAll(async () => {
    await harness.db.close();
  });

  function ctxFor(snapshotId: string) {
    return makeContext({ meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: snapshotId } });
  }

  async function questionsRemaining(): Promise<number | null> {
    const { rows } = await harness.db.query(`select ai_entitlement_state($1) v`, [USER]);
    const v = (rows[0] as Record<string, unknown>).v as { custom_questions?: { remaining?: number } } | null;
    return v?.custom_questions?.remaining ?? null;
  }

  function newService() {
    return new AIPersonalisedInsightPackService(harness.dbClient, (ctx) => new CountingProvider(ctx, 'valid'), harness.gate);
  }

  it('1. ENABLED: a real generation call is admitted, reaches the provider, and the provider call count increases', async () => {
    const before = await questionsRemaining();
    const outcome = await newService().generateOrGetPack({ userId: USER, householdId: null, context: ctxFor('snap-enabled-1') });
    expect(outcome.status).toBe('READY');
    expect(providerCallCount).toBe(1);
    const after = await questionsRemaining();
    expect(after).toBe(before); // BATCH_AI never consumes custom-question quota
  });

  it('2. DISABLED (batch_generation_enabled=false, in the ISOLATED instance only): admission is refused BEFORE the provider, count does not increase, quota untouched', async () => {
    await harness.db.exec(`update ai_platform_controls set batch_generation_enabled = false where id='global';`);
    const before = await questionsRemaining();
    const countBefore = providerCallCount;
    const outcome = await newService().generateOrGetPack({ userId: USER, householdId: null, context: ctxFor('snap-disabled-1') });
    expect(outcome.status).toBe('BATCH_DISABLED');
    expect(providerCallCount).toBe(countBefore); // unchanged — provider never reached
    const after = await questionsRemaining();
    expect(after).toBe(before); // ground truth: quota genuinely untouched by the blocked attempt
  });

  it('2b. DISABLED, defence-in-depth: even if the app-level check were bypassed, the REAL ai_admit_request() RPC itself ALSO refuses with batch_disabled', async () => {
    // Confirms the kill switch is enforced in TWO independent real layers
    // (the service's own isBatchGenerationEnabled() gate proven above, AND
    // the database function itself), matching the spec's defence-in-depth
    // design — not merely the application layer remembering to check.
    const { rows } = await harness.db.query(
      `select ai_admit_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) v`,
      [USER, null, 'standard', 'monthly_insight_pack', 'mock', 'mock-standard-1', 'STANDARD', 0.02, false, 'BATCH_AI', 'isolated-defence-in-depth-key', 'body', 2000, 0, 700]
    );
    const admitResult = (rows[0] as Record<string, unknown>).v as { allowed: boolean; deny_reason: string };
    expect(admitResult.allowed).toBe(false);
    expect(admitResult.deny_reason).toBe('batch_disabled');
    await harness.db.exec(`update ai_platform_controls set batch_generation_enabled = true where id='global';`);
  });

  it('3. RE-ENABLED: calls resume — a new generation is admitted and reaches the provider again', async () => {
    const countBefore = providerCallCount;
    const outcome = await newService().generateOrGetPack({ userId: USER, householdId: null, context: ctxFor('snap-reenabled-1'), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('READY');
    expect(providerCallCount).toBe(countBefore + 1);
  });

  it('4. HARD COST-CEILING STOP: an ultra-low platform ceiling (in the ISOLATED instance only) blocks admission before the provider, count unchanged, quota untouched, and is reversible', async () => {
    await harness.db.exec(`update ai_platform_controls set platform_soft_cost_threshold_usd = null, per_user_soft_cost_threshold_usd = null, platform_monthly_cost_ceiling_usd = 0.0000001, per_user_monthly_cost_ceiling_usd = 0.0000001 where id='global';`);
    const before = await questionsRemaining();
    const countBefore = providerCallCount;
    const service = newService();
    const outcome = await service.generateOrGetPack({ userId: USER, householdId: null, context: ctxFor('snap-cost-blocked-1'), bypassRegenerationCooldown: true });
    expect(outcome.status).toBe('COST_BLOCKED');
    expect(providerCallCount).toBe(countBefore); // provider never reached
    const after = await questionsRemaining();
    expect(after).toBe(before);

    // Restore the ceiling and confirm generation resumes — the hard stop is
    // reversible, not a one-way trip.
    await harness.db.exec(`update ai_platform_controls set platform_monthly_cost_ceiling_usd = 500, per_user_monthly_cost_ceiling_usd = 5 where id='global';`);
    const resumedCountBefore = providerCallCount;
    const resumed = await service.generateOrGetPack({ userId: USER, householdId: null, context: ctxFor('snap-cost-resumed-1'), bypassRegenerationCooldown: true });
    expect(resumed.status).toBe('READY');
    expect(providerCallCount).toBe(resumedCountBefore + 1);
  });
});
