/**
 * AIE per-user daily spend cap (PO decision 16-10-2026) composed with the REAL gateway, the REAL cost-admission
 * wrapper, the shared Premium gate and the kill switches. The only doubles are the provider (a counting fake) and
 * the database RPCs (a small in-memory model of aie_reserve_ai_cost_v2 / aie_settle_ai_cost_v2).
 *
 * EVIDENCE LABEL: UNIT-TESTED. The in-memory RPC model is NOT the evidence for the SQL; the SQL's behaviour is
 * proven in aieUserDailyCapPglite.test.ts on a real Postgres engine. This file proves the orchestration around it:
 *
 *   - the Premium guard is still FIRST: a Free user is refused before any reservation (nothing charged, no row);
 *   - the cap refuses BEFORE the provider is called, with the typed outcome, and nothing is settled;
 *   - the global kill switch and the global allowance are unchanged and still win where they apply;
 *   - one user at the cap does not stop another;
 *   - replay of a refused key never calls the provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { premiumAi } from '../support/premiumAiAccessMock';

vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()),
);

interface Attempt {
  user: string;
  reserved: number;
  settled: number | null;
  outcome: 'admitted' | 'user_daily_cap_reached' | 'budget_exhausted';
}
const db = vi.hoisted(() => ({
  attempts: new Map<string, { user: string; reserved: number; settled: number | null; outcome: string }>(),
  globalReserved: 0,
  globalSettled: 0,
  allowance: 10,
  column: 1,
  rpcLog: [] as string[],
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, a: Record<string, unknown>) => {
      db.rpcLog.push(fn);
      if (fn === 'aie_reserve_ai_cost_v2') {
        const key = String(a.p_idempotency_key);
        const amount = Number(a.p_amount_usd);
        const user = String(a.p_user_id);
        const cap = Math.min(a.p_user_daily_cap_usd === null ? db.column : Number(a.p_user_daily_cap_usd), db.column);
        const allowance = Math.min(Number(a.p_allowance_usd), db.allowance);
        if (db.attempts.has(key)) return { data: [{ reserved: false, remaining_usd: 1, refusal_reason: 'replay', user_remaining_usd: 0 }], error: null };
        const used = [...db.attempts.values()].filter((x) => x.user === user).reduce((s, x) => s + (x.settled ?? x.reserved), 0);
        if (used + amount > cap + 1e-12) {
          db.attempts.set(key, { user, reserved: 0, settled: null, outcome: 'user_daily_cap_reached' });
          return { data: [{ reserved: false, remaining_usd: 1, refusal_reason: 'user_daily_cap', user_remaining_usd: Math.max(cap - used, 0) }], error: null };
        }
        if (db.globalReserved + db.globalSettled + amount > allowance + 1e-12) {
          db.attempts.set(key, { user, reserved: 0, settled: null, outcome: 'budget_exhausted' });
          return { data: [{ reserved: false, remaining_usd: 0, refusal_reason: 'budget_exhausted', user_remaining_usd: Math.max(cap - used, 0) }], error: null };
        }
        db.globalReserved += amount;
        db.attempts.set(key, { user, reserved: amount, settled: null, outcome: 'admitted' });
        return { data: [{ reserved: true, remaining_usd: 1, refusal_reason: null, user_remaining_usd: Math.max(cap - used - amount, 0) }], error: null };
      }
      if (fn === 'aie_settle_ai_cost_v2') {
        const at = db.attempts.get(String(a.p_idempotency_key));
        if (!at || at.outcome !== 'admitted') return { data: null, error: { message: 'no admitted reservation' } };
        if (at.settled !== null) return { data: [{ settled: false, already_settled: true }], error: null };
        db.globalReserved -= at.reserved;
        db.globalSettled += Number(a.p_actual_usd);
        at.settled = Number(a.p_actual_usd);
        return { data: [{ settled: true, already_settled: false }], error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  }),
}));

import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { reserveConservativeAiCost, settleAiCost } from '@/lib/aie/cost/costAdmission';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION } from '@/lib/aie/schema/schemaRegistry';
import { aiFallbackRefusalFromReason, aiFallbackRefusalNote } from '@/lib/ai/access/aiFallbackRefusal';

vi.setConfig({ testTimeout: 60000 });

const U1 = '10000000-0000-4000-8000-000000000001';
const U2 = '10000000-0000-4000-8000-000000000002';
const TEXT = [
  'Harbourline Mutual Bank (synthetic test institution)',
  'This letter covers your everyday account from 1 August 2026 to 31 August 2026.',
  'You began the month with 2000.00 in the account and finished with 2776.55.',
].join('\n');

const ENV = ['AIE_AI_FALLBACK_ENABLED', 'AIE_MASK_TOKEN_ENCRYPTION_KEY', 'AIE_USER_DAILY_COST_CAP_USD'] as const;
let saved: Record<string, string | undefined>;
let n = 0;

function makeStack(opts: { killSwitch?: boolean } = {}) {
  let providerCalls = 0;
  const provider = new MockAieProvider({
    respond: () => {
      providerCalls += 1;
      return JSON.stringify({ fields: [{ fieldName: 'account_number', value: '12345', nullReason: null, sourceReferenceId: 'p1' }] });
    },
  });
  const settleSpy = vi.fn(settleAiCost);
  const reserveSpy = vi.fn(reserveConservativeAiCost);
  const gateway = new AieDocumentAiGateway(provider, {
    isKillSwitchEnabled: () => opts.killSwitch !== false,
    costAdmission: { reserve: reserveSpy, settle: settleSpy },
  });
  async function attempt(userId: string, key = `k-${(n += 1)}`) {
    const gate = await evaluateAiFallbackGate({ userId, adapterEnabled: true, extractedText: TEXT });
    if (!gate.ok) return { stage: 'gate' as const, reason: gate.reason };
    const result = await gateway.requestFieldCompletion({
      systemPrompt: 'extract only requested fields',
      maskedUserPrompt: gate.maskedText,
      schemaName: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME,
      schemaVersion: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION,
      model: 'gpt-4o-mini',
      maxOutputTokens: 256,
      requestedFields: ['account_number'],
      idempotencyKey: key,
      userId,
    });
    return { stage: 'gateway' as const, outcome: result.outcome };
  }
  return { attempt, reserveSpy, settleSpy, providerCalls: () => providerCalls };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
  delete process.env.AIE_USER_DAILY_COST_CAP_USD;
  premiumAi.reset();
  db.attempts.clear();
  db.globalReserved = 0;
  db.globalSettled = 0;
  db.allowance = 10;
  db.column = 1;
  db.rpcLog.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** A reservation for this tiny prompt is about US$0.0027; settlement is a fraction of a cent. */
const TINY_CAP = '0.0055'; // admits two reservations while both are in flight, never three

describe('the cap refuses BEFORE the provider', () => {
  it('a user at their cap gets the typed outcome, the provider is never called, nothing is settled', async () => {
    db.attempts.set('earlier', { user: U1, reserved: 0, settled: 1.0, outcome: 'admitted' } as Attempt);
    const s = makeStack();
    expect(await s.attempt(U1)).toEqual({ stage: 'gateway', outcome: 'user_daily_cap_reached' });
    expect(s.providerCalls()).toBe(0);
    expect(s.settleSpy).not.toHaveBeenCalled();
    expect(s.reserveSpy).toHaveBeenCalledTimes(1);
    expect(db.rpcLog).toEqual(['aie_reserve_ai_cost_v2']);
  });

  it('below the cap the same user gets one reservation, one provider call, one settlement (control for the refusal above)', async () => {
    const s = makeStack();
    expect(await s.attempt(U1)).toEqual({ stage: 'gateway', outcome: 'success' });
    expect(s.providerCalls()).toBe(1);
    expect(s.settleSpy).toHaveBeenCalledTimes(1);
    expect(db.rpcLog).toEqual(['aie_reserve_ai_cost_v2', 'aie_settle_ai_cost_v2']);
  });

  it('the cap is crossed by real usage: settlement frees headroom, so sequential small calls keep working until the day total is reached', async () => {
    process.env.AIE_USER_DAILY_COST_CAP_USD = TINY_CAP;
    const s = makeStack();
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) outcomes.push((await s.attempt(U1) as { outcome: string }).outcome);
    // each call settles at a fraction of its reservation, so none of four sequential calls is refused
    expect(outcomes).toEqual(['success', 'success', 'success', 'success']);
    // but a user already holding two unsettled reservations is refused on the third
    db.attempts.clear();
    db.attempts.set('held-1', { user: U1, reserved: 0.0027, settled: null, outcome: 'admitted' });
    db.attempts.set('held-2', { user: U1, reserved: 0.0027, settled: null, outcome: 'admitted' });
    expect((await s.attempt(U1) as { outcome: string }).outcome).toBe('user_daily_cap_reached');
  });

  it('one user at the cap does not stop another user', async () => {
    db.attempts.set('earlier', { user: U1, reserved: 0, settled: 1.0, outcome: 'admitted' } as Attempt);
    const s = makeStack();
    expect((await s.attempt(U1) as { outcome: string }).outcome).toBe('user_daily_cap_reached');
    expect((await s.attempt(U2) as { outcome: string }).outcome).toBe('success');
    expect(s.providerCalls()).toBe(1);
  });

  it('a replayed key that was refused is refused again and the provider is still never called', async () => {
    db.attempts.set('earlier', { user: U1, reserved: 0, settled: 1.0, outcome: 'admitted' } as Attempt);
    const s = makeStack();
    expect((await s.attempt(U1, 'same') as { outcome: string }).outcome).toBe('user_daily_cap_reached');
    expect((await s.attempt(U1, 'same') as { outcome: string }).outcome).toBe('budget_exhausted'); // replay surfaces as the generic refusal
    expect(s.providerCalls()).toBe(0);
  });
});

describe('composition with the Premium guard, the kill switches and the global allowance', () => {
  it('FREE: refused by the Premium guard FIRST -- no reservation, no row, nothing counted against anyone', async () => {
    premiumAi.setTier(U1, 'free');
    const s = makeStack();
    expect(await s.attempt(U1)).toEqual({ stage: 'gate', reason: 'premium_required' });
    expect(s.reserveSpy).not.toHaveBeenCalled();
    expect(db.attempts.size).toBe(0);
  });

  it('gateway kill switch off: blocked before any reservation (the cap is not consulted)', async () => {
    const s = makeStack({ killSwitch: false });
    expect(await s.attempt(U1)).toEqual({ stage: 'gateway', outcome: 'kill_switch_blocked' });
    expect(s.reserveSpy).not.toHaveBeenCalled();
    expect(db.attempts.size).toBe(0);
  });

  it('global kill switch off: refused at the gate before the plan is even read', async () => {
    process.env.AIE_AI_FALLBACK_ENABLED = 'false';
    const s = makeStack();
    expect(await s.attempt(U1)).toEqual({ stage: 'gate', reason: 'global_kill_switch_disabled' });
    expect(premiumAi.asked).toEqual([]);
    expect(db.attempts.size).toBe(0);
  });

  it('the global allowance still refuses a user who is under their own cap, with the generic outcome (not the per-user one)', async () => {
    db.allowance = 0.001;
    const s = makeStack();
    expect(await s.attempt(U1)).toEqual({ stage: 'gateway', outcome: 'budget_exhausted' });
    expect(s.providerCalls()).toBe(0);
  });

  it('a call with no usable session user is refused before the provider and never reaches the database (fails closed)', async () => {
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => { throw new Error('provider must not be called'); } }), {
      isKillSwitchEnabled: () => true,
      costAdmission: { reserve: reserveConservativeAiCost, settle: settleAiCost },
    });
    const res = await gateway.requestFieldCompletion({
      systemPrompt: 'x',
      maskedUserPrompt: 'masked',
      schemaName: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME,
      schemaVersion: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION,
      model: 'gpt-4o-mini',
      maxOutputTokens: 256,
      requestedFields: [],
      idempotencyKey: 'no-user',
      userId: '', // missing session user
    });
    expect(res.outcome).toBe('budget_exhausted');
    expect(db.rpcLog).toEqual([]);
    expect(db.attempts.size).toBe(0);
  });
});

describe('what the person is told', () => {
  it('the typed outcome maps to the plain-language refusal; the global outcome stays internal', () => {
    expect(aiFallbackRefusalFromReason('user_daily_cap_reached')).toBe('daily_limit_reached');
    expect(aiFallbackRefusalFromReason('budget_exhausted')).toBeUndefined();
    const note = aiFallbackRefusalNote('daily_limit_reached')!;
    expect(note).toMatch(/daily limit/i);
    expect(note).toMatch(/try again tomorrow/i);
    expect(note).toMatch(/manually/i);
  });
});
