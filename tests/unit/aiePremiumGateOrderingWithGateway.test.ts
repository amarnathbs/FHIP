// The shared Premium gate composed with the REAL AIE gateway and a counting cost-admission double:
// who is refused where, and what each refusal costs (14-10-2026).
//
// UNIT-TESTED. The provider is a counting fake; the cost ledger is a recording double (its real atomic SQL
// behaviour under concurrency is proven separately by aieCostAdmissionPglitePostgresProof.test.ts, unchanged).
//
//   Free / expired / unreadable plan -> refused by the gate: no reservation, no provider call, nothing to settle.
//   Premium + budget exhausted        -> admitted by the gate, refused by the ledger BEFORE the provider.
//   Premium + gateway kill switch off -> blocked before any reservation.
//   Premium + budget available        -> exactly one reservation, one provider call, one settlement.
//   replay / concurrency              -> one provider call per idempotency key; independent users do not interfere.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { premiumAi } from '../support/premiumAiAccessMock';

vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()),
);

import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION } from '@/lib/aie/schema/schemaRegistry';

vi.setConfig({ testTimeout: 60000 });

const TEXT = [
  'Harbourline Mutual Bank (synthetic test institution)',
  'This letter covers your everyday account from 1 August 2026 to 31 August 2026.',
  'You began the month with 2000.00 in the account and finished with 2776.55.',
].join('\n');

const ENV = ['AIE_AI_FALLBACK_ENABLED', 'AIE_MASK_TOKEN_ENCRYPTION_KEY'] as const;
let saved: Record<string, string | undefined>;

function makeStack(opts: { admit?: boolean; killSwitch?: boolean } = {}) {
  let providerCalls = 0;
  const provider = new MockAieProvider({
    respond: () => {
      providerCalls += 1;
      return JSON.stringify({ fields: [{ fieldName: 'account_number', value: '12345', nullReason: null, sourceReferenceId: 'p1' }] });
    },
  });
  const reserve = vi.fn(async () => ({ admitted: opts.admit !== false, remainingUsd: 9, reservedUsd: 0.01 }));
  const settle = vi.fn(async () => ({ settled: true, alreadySettled: false }));
  const gateway = new AieDocumentAiGateway(provider, {
    isKillSwitchEnabled: () => opts.killSwitch !== false,
    costAdmission: { reserve, settle },
  });
  /** What every document-class service does: gate first, then the gateway with the MASKED text only. */
  async function attempt(userId: string, key: string) {
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
  return { attempt, reserve, settle, providerCalls: () => providerCalls };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
  premiumAi.reset();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('who is refused where, and what it costs', () => {
  it('FREE: refused at the gate -- no reservation, no provider call, nothing settled', async () => {
    premiumAi.setTier('free-user', 'free');
    const s = makeStack();
    expect(await s.attempt('free-user', 'k1')).toEqual({ stage: 'gate', reason: 'premium_required' });
    expect(s.reserve).not.toHaveBeenCalled();
    expect(s.providerCalls()).toBe(0);
    expect(s.settle).not.toHaveBeenCalled();
  });

  it('EXPIRED and UNREADABLE plans: the same, with no charge', async () => {
    const s = makeStack();
    premiumAi.setTier('lapsed', 'expired');
    premiumAi.setTier('unknown-plan', 'unavailable');
    expect(await s.attempt('lapsed', 'k1')).toEqual({ stage: 'gate', reason: 'premium_required' });
    expect(await s.attempt('unknown-plan', 'k2')).toEqual({ stage: 'gate', reason: 'entitlement_unavailable' });
    expect(s.reserve).not.toHaveBeenCalled();
    expect(s.providerCalls()).toBe(0);
  });

  it('PREMIUM, spend ceiling exhausted: the ledger refuses BEFORE the provider; nothing is settled', async () => {
    const s = makeStack({ admit: false });
    expect(await s.attempt('premium-a', 'k1')).toEqual({ stage: 'gateway', outcome: 'budget_exhausted' });
    expect(s.reserve).toHaveBeenCalledTimes(1);
    expect(s.providerCalls()).toBe(0);
    expect(s.settle).not.toHaveBeenCalled();
  });

  it('PREMIUM, gateway kill switch off: blocked before any reservation', async () => {
    const s = makeStack({ killSwitch: false });
    expect(await s.attempt('premium-a', 'k1')).toEqual({ stage: 'gateway', outcome: 'kill_switch_blocked' });
    expect(s.reserve).not.toHaveBeenCalled();
    expect(s.providerCalls()).toBe(0);
  });

  it('PREMIUM, global kill switch off: refused at the gate before the plan is even read', async () => {
    process.env.AIE_AI_FALLBACK_ENABLED = 'false';
    const s = makeStack();
    expect(await s.attempt('premium-a', 'k1')).toEqual({ stage: 'gate', reason: 'global_kill_switch_disabled' });
    expect(premiumAi.asked).toEqual([]);
    expect(s.providerCalls()).toBe(0);
  });

  it('PREMIUM with budget: exactly one reservation, one provider call, one settlement (control for every refusal above)', async () => {
    const s = makeStack();
    expect(await s.attempt('premium-a', 'k1')).toEqual({ stage: 'gateway', outcome: 'success' });
    expect(s.reserve).toHaveBeenCalledTimes(1);
    expect(s.providerCalls()).toBe(1);
    expect(s.settle).toHaveBeenCalledTimes(1);
  });
});

describe('replay and concurrency', () => {
  it('six concurrent identical requests (same idempotency key) make ONE provider call and ONE reservation', async () => {
    const s = makeStack();
    const results = await Promise.all(Array.from({ length: 6 }, () => s.attempt('premium-a', 'same-key')));
    expect(results.every((r) => r.stage === 'gateway')).toBe(true);
    expect(s.providerCalls()).toBe(1);
    expect(s.reserve).toHaveBeenCalledTimes(1);
  });

  it('two independent Premium users with their own keys do not interfere: two calls, two reservations', async () => {
    const s = makeStack();
    const [a, b] = await Promise.all([s.attempt('premium-a', 'key-a'), s.attempt('premium-b', 'key-b')]);
    expect(a).toEqual({ stage: 'gateway', outcome: 'success' });
    expect(b).toEqual({ stage: 'gateway', outcome: 'success' });
    expect(s.providerCalls()).toBe(2);
    expect(s.reserve).toHaveBeenCalledTimes(2);
    expect(premiumAi.asked.sort()).toEqual(['premium-a', 'premium-b']);
  });

  it('a Free request racing a Premium request: only the Premium one reaches the provider', async () => {
    premiumAi.setTier('free-user', 'free');
    const s = makeStack();
    const [f, p] = await Promise.all([s.attempt('free-user', 'kf'), s.attempt('premium-a', 'kp')]);
    expect(f.stage).toBe('gate');
    expect(p).toEqual({ stage: 'gateway', outcome: 'success' });
    expect(s.providerCalls()).toBe(1);
  });
});
