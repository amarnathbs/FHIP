/**
 * AIE-1 closure mission — unit coverage for `lib/aie/cost/costAdmission.ts`.
 * The actual atomicity guarantee lives entirely in migration 0150's SQL
 * function (one atomic `UPDATE ... WHERE ... RETURNING`) — DEV/production
 * verification of THAT is BLOCKED (no DDL channel; see the migration's own
 * header). This suite proves the TypeScript wrapper shapes the RPC call
 * correctly and fails closed if the RPC itself is unreachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
let selectRow: Record<string, unknown> | null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: selectRow }),
        }),
      }),
    }),
  }),
}));

import { reserveConservativeAiCost, settleAiCost, getAieCostLedgerSnapshot, AIE_COST_LEDGER_ID } from '@/lib/aie/cost/costAdmission';

beforeEach(() => {
  selectRow = null;
  rpcImpl = async () => ({ data: null, error: { message: 'not configured' } });
});

describe('reserveConservativeAiCost', () => {
  it('admits and returns the remaining allowance when the RPC admits', async () => {
    rpcImpl = async (fn, args) => {
      expect(fn).toBe('aie_reserve_ai_cost');
      expect(args.p_ledger_id).toBe(AIE_COST_LEDGER_ID);
      expect(typeof args.p_amount_usd).toBe('number');
      expect(typeof args.p_allowance_usd).toBe('number');
      return { data: [{ reserved: true, remaining_usd: 9.5 }], error: null };
    };
    const result = await reserveConservativeAiCost('gpt-4o-mini-2024-07-18', 'attempt-1');
    expect(result.admitted).toBe(true);
    expect(result.remainingUsd).toBe(9.5);
    expect(result.reservedUsd).toBeGreaterThan(0);
  });

  it('refuses when the RPC refuses', async () => {
    rpcImpl = async () => ({ data: [{ reserved: false, remaining_usd: 0 }], error: null });
    const result = await reserveConservativeAiCost('gpt-4o-mini-2024-07-18', 'attempt-2');
    expect(result.admitted).toBe(false);
    expect(result.reservedUsd).toBe(0);
  });

  it('fails CLOSED (never admits) if the RPC itself errors -- a broken admission gate must not become no gate at all', async () => {
    rpcImpl = async () => ({ data: null, error: { message: 'function does not exist' } });
    const result = await reserveConservativeAiCost('gpt-4o-mini-2024-07-18', 'attempt-3');
    expect(result.admitted).toBe(false);
  });

  it('fails closed on an empty data array too', async () => {
    rpcImpl = async () => ({ data: [], error: null });
    const result = await reserveConservativeAiCost('gpt-4o-mini-2024-07-18', 'attempt-4');
    expect(result.admitted).toBe(false);
  });

  it('passes idempotencyKey through as p_idempotency_key (migration 0152 -- protects a genuine cross-process retry, not just the gateway\'s own in-memory in-flight map)', async () => {
    let captured: Record<string, unknown> | null = null;
    rpcImpl = async (_fn, args) => {
      captured = args;
      return { data: [{ reserved: true, remaining_usd: 9.5 }], error: null };
    };
    await reserveConservativeAiCost('gpt-4o-mini-2024-07-18', 'attempt-5-stable-key');
    expect((captured as unknown as { p_idempotency_key: string }).p_idempotency_key).toBe('attempt-5-stable-key');
  });
});

describe('settleAiCost', () => {
  it('settles at the estimated actual cost by default', async () => {
    let captured: Record<string, unknown> | null = null;
    rpcImpl = async (fn, args) => {
      captured = args;
      expect(fn).toBe('aie_settle_ai_cost');
      return { data: null, error: null };
    };
    await settleAiCost({ reservedUsd: 0.01, actualInputTokens: 100, actualOutputTokens: 50, model: 'gpt-4o-mini-2024-07-18', idempotencyKey: 'attempt-settle-1' });
    expect((captured as unknown as { p_reserved_usd: number }).p_reserved_usd).toBe(0.01);
    expect((captured as unknown as { p_actual_usd: number }).p_actual_usd).toBeGreaterThan(0);
    expect((captured as unknown as { p_input_tokens: number }).p_input_tokens).toBe(100);
    expect((captured as unknown as { p_idempotency_key: string }).p_idempotency_key).toBe('attempt-settle-1');
  });

  it('settles at the full reserved amount when treatAsFullReservedCost is set (uncertain/timeout charge)', async () => {
    let captured: Record<string, unknown> | null = null;
    rpcImpl = async (_fn, args) => {
      captured = args;
      return { data: null, error: null };
    };
    await settleAiCost({ reservedUsd: 0.02, actualInputTokens: 0, actualOutputTokens: 0, model: 'gpt-4o-mini-2024-07-18', idempotencyKey: 'attempt-settle-2', treatAsFullReservedCost: true });
    expect((captured as unknown as { p_actual_usd: number }).p_actual_usd).toBe(0.02);
  });
});

describe('getAieCostLedgerSnapshot', () => {
  it('computes remainingUsd as allowance minus reserved minus settled', async () => {
    selectRow = { allowance_usd: '10.00', reserved_usd: '2.00', settled_usd: '1.50', total_attempts: 5, total_input_tokens: 1000, total_output_tokens: 500 };
    const snapshot = await getAieCostLedgerSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.remainingUsd).toBeCloseTo(6.5, 5);
    expect(snapshot!.totalAttempts).toBe(5);
  });

  it('returns null when the ledger row does not exist (e.g. migration 0150 not yet applied)', async () => {
    selectRow = null;
    const snapshot = await getAieCostLedgerSnapshot();
    expect(snapshot).toBeNull();
  });
});
