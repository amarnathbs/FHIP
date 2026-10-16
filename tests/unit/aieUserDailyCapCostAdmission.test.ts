/**
 * AIE per-user daily spend cap (PO decision 16-10-2026) -- the TypeScript wrapper around the atomic
 * `aie_reserve_ai_cost_v2` function (migration 0284).
 *
 * EVIDENCE LABEL: UNIT-TESTED. The RPC is a recording double; the atomic behaviour itself is proven on a real
 * Postgres engine in aieUserDailyCapPglite.test.ts. What is proven HERE is that the wrapper
 *   - always attributes the reservation to the session user and never makes a call without one,
 *   - sends the cap override only as an optional LOWER figure (the stored column stays the authority),
 *   - never falls back to the uncapped 0195 function when v2 is missing or fails (fail closed),
 *   - maps the database reason to a typed refusal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
let rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcImpl(fn, args);
    },
  }),
}));

import { reserveConservativeAiCost } from '@/lib/aie/cost/costAdmission';
import {
  AIE_USER_DAILY_CAP_USD_DEFAULT,
  AIE_USER_DAILY_CAP_DAY_BOUNDARY,
  getAieUserDailyCapOverrideUsd,
} from '@/lib/aie/config';

const USER = '11111111-2222-4333-8444-555555555555';
const ENV = 'AIE_USER_DAILY_COST_CAP_USD';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
  delete process.env[ENV];
  rpcCalls = [];
  rpcImpl = async () => ({ data: null, error: { message: 'not configured' } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  vi.restoreAllMocks();
});

describe('defaults and the documented day boundary', () => {
  it('the default cap is US$1 per user per day, on the UTC day', () => {
    expect(AIE_USER_DAILY_CAP_USD_DEFAULT).toBe(1);
    expect(AIE_USER_DAILY_CAP_DAY_BOUNDARY).toBe('UTC');
  });

  it('the override is only ever a number from the environment; empty, absent or invalid means "let the stored column decide"', () => {
    expect(getAieUserDailyCapOverrideUsd()).toBeNull();
    for (const bad of ['', '   ', 'abc', '-1', 'NaN']) {
      process.env[ENV] = bad;
      expect(getAieUserDailyCapOverrideUsd(), bad).toBeNull();
    }
    process.env[ENV] = '0.25';
    expect(getAieUserDailyCapOverrideUsd()).toBe(0.25);
    process.env[ENV] = '0';
    expect(getAieUserDailyCapOverrideUsd()).toBe(0);
  });
});

describe('reserveConservativeAiCost with the per-user cap', () => {
  it('calls the v2 function with the session user and no cap override by default', async () => {
    rpcImpl = async () => ({ data: [{ reserved: true, remaining_usd: 9.5, refusal_reason: null, user_remaining_usd: 0.9 }], error: null });
    const r = await reserveConservativeAiCost('gpt-4o-mini', 'attempt-1', { userId: USER, promptChars: 3000, maxOutputTokens: 4096 });
    expect(r.admitted).toBe(true);
    expect(r.userRemainingUsd).toBe(0.9);
    expect(r.refusalReason).toBeUndefined();
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('aie_reserve_ai_cost_v2');
    expect(rpcCalls[0].args).toMatchObject({ p_ledger_id: 'global', p_idempotency_key: 'attempt-1', p_user_id: USER, p_user_daily_cap_usd: null });
    expect(typeof rpcCalls[0].args.p_amount_usd).toBe('number');
  });

  it('passes the environment figure as a LOWER override only', async () => {
    process.env[ENV] = '0.05';
    rpcImpl = async () => ({ data: [{ reserved: true, remaining_usd: 9, refusal_reason: null, user_remaining_usd: 0.04 }], error: null });
    await reserveConservativeAiCost('gpt-4o-mini', 'attempt-2', { userId: USER });
    expect(rpcCalls[0].args.p_user_daily_cap_usd).toBe(0.05);
  });

  it('a per-user refusal is typed user_daily_cap and reserves nothing', async () => {
    rpcImpl = async () => ({ data: [{ reserved: false, remaining_usd: 9, refusal_reason: 'user_daily_cap', user_remaining_usd: 0 }], error: null });
    const r = await reserveConservativeAiCost('gpt-4o-mini', 'attempt-3', { userId: USER });
    expect(r).toMatchObject({ admitted: false, reservedUsd: 0, refusalReason: 'user_daily_cap', userRemainingUsd: 0 });
  });

  it('the global refusal and a replay keep their own reasons', async () => {
    rpcImpl = async () => ({ data: [{ reserved: false, remaining_usd: 0, refusal_reason: 'budget_exhausted', user_remaining_usd: 0.5 }], error: null });
    expect((await reserveConservativeAiCost('gpt-4o-mini', 'a', { userId: USER })).refusalReason).toBe('budget_exhausted');
    rpcImpl = async () => ({ data: [{ reserved: false, remaining_usd: 5, refusal_reason: 'replay', user_remaining_usd: 0.5 }], error: null });
    expect((await reserveConservativeAiCost('gpt-4o-mini', 'a', { userId: USER })).refusalReason).toBe('replay');
  });

  it('NO USER, NO CALL: a missing or blank user id is refused without touching the database', async () => {
    for (const userId of [undefined, '', '   ']) {
      const r = await reserveConservativeAiCost('gpt-4o-mini', 'attempt-x', { userId });
      expect(r, String(userId)).toMatchObject({ admitted: false, reservedUsd: 0, refusalReason: 'unavailable' });
    }
    expect(rpcCalls).toEqual([]);
  });

  it('FAILS CLOSED when v2 is missing (migration not applied): refuses, and never calls the uncapped 0195 function', async () => {
    rpcImpl = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.aie_reserve_ai_cost_v2' } });
    const r = await reserveConservativeAiCost('gpt-4o-mini', 'attempt-4', { userId: USER });
    expect(r).toMatchObject({ admitted: false, refusalReason: 'unavailable' });
    expect(rpcCalls.map((c) => c.fn)).toEqual(['aie_reserve_ai_cost_v2']);
  });

  it('a malformed (non-uuid) user id is rejected by the typed database parameter, which is a refusal too', async () => {
    rpcImpl = async () => ({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } });
    const r = await reserveConservativeAiCost('gpt-4o-mini', 'a', { userId: "not-a-uuid'; drop table x;--" });
    expect(r).toMatchObject({ admitted: false, refusalReason: 'unavailable' });
  });

  it('FAILS CLOSED on any database error or an empty answer', async () => {
    rpcImpl = async () => ({ data: null, error: { message: 'connection reset' } });
    expect((await reserveConservativeAiCost('gpt-4o-mini', 'a', { userId: USER })).admitted).toBe(false);
    rpcImpl = async () => ({ data: [], error: null });
    expect((await reserveConservativeAiCost('gpt-4o-mini', 'b', { userId: USER })).admitted).toBe(false);
  });

  it('the cap cannot be supplied by a caller: the wrapper has no cap parameter and ignores smuggled ones', async () => {
    rpcImpl = async () => ({ data: [{ reserved: true, remaining_usd: 9, refusal_reason: null, user_remaining_usd: 0.9 }], error: null });
    await reserveConservativeAiCost('gpt-4o-mini', 'attempt-5', { userId: USER, ...({ userDailyCapUsd: 1000, p_user_daily_cap_usd: 1000 } as object) });
    expect(rpcCalls[0].args.p_user_daily_cap_usd).toBeNull();
  });
});
