// The ONE shared Premium decision for starting a new chargeable AI operation
// (lib/ai/access/premiumAiAccess.ts). Product Owner instruction 14-10-2026,
// which replaced the two-e-mail AIE pilot allowlist.
//
// UNIT-TESTED: the policy matrix, fail-closed behaviour, the denial Response
// and the proof that the old pilot variables, e-mail addresses and admin roles
// can neither grant nor deny anything. The database read is injected; the real
// read is exercised against DEV (docs/ai/po_apply_premium_wide_access).
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolvePremiumAiAccess,
  refuseUnlessPremiumAi,
  premiumAiDeniedResponse,
  premiumAiDeniedMessage,
  type EntitlementReadResult,
} from '@/lib/ai/access/premiumAiAccess';

const TODAY = '2026-10-14';
const row = (plan_tier: string | null, from: string | null = null, to: string | null = null): EntitlementReadResult => ({
  row: { plan_tier, effective_from: from, effective_to: to },
  error: null,
});
const reader = (r: EntitlementReadResult) => vi.fn(async () => r);

describe('resolvePremiumAiAccess -- who may start a NEW AI operation', () => {
  it('ALLOWS an active Premium entitlement (no window)', async () => {
    const d = await resolvePremiumAiAccess('u1', 'test', { readEntitlement: reader(row('premium')), today: TODAY });
    expect(d).toEqual({ allowed: true, planTier: 'premium' });
  });

  it('ALLOWS Premium on the first and on the last day of its window (both ends inclusive)', async () => {
    expect((await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader(row('premium', TODAY, '2026-12-31')), today: TODAY })).allowed).toBe(true);
    expect((await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader(row('premium', '2026-01-01', TODAY)), today: TODAY })).allowed).toBe(true);
  });

  it('ALLOWS complimentary / promo / admin-granted Premium (a time-limited row is just a Premium row inside its window)', async () => {
    const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader(row('premium', '2026-10-01', '2026-10-30')), today: TODAY });
    expect(d.allowed).toBe(true);
  });

  it('DENIES a Free user, and offers the upgrade', async () => {
    const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader(row('free')), today: TODAY });
    expect(d).toEqual({ allowed: false, reason: 'premium_required', upgradeAvailable: true });
  });

  it('DENIES a user with no entitlement row at all (never subscribed) -- not an allow, not an outage', async () => {
    const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader({ row: null, error: null }), today: TODAY });
    expect(d).toEqual({ allowed: false, reason: 'premium_required', upgradeAvailable: true });
  });

  it('DENIES an EXPIRED Premium entitlement the day after its last day (downgrade / lapse stops NEW execution)', async () => {
    const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader(row('premium', '2026-01-01', '2026-10-13')), today: TODAY });
    expect(d).toEqual({ allowed: false, reason: 'premium_required', upgradeAvailable: true });
  });

  it('DENIES a Premium entitlement whose window has not started yet', async () => {
    const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader(row('premium', '2026-10-15', '2026-12-31')), today: TODAY });
    expect(d.allowed).toBe(false);
  });

  it('DENIES an unrecognised tier value (fail closed, never "any non-free is premium")', async () => {
    for (const tier of ['PREMIUM', 'premium ', 'pro', 'admin', 'enterprise', '', null]) {
      const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader(row(tier as string | null)), today: TODAY });
      expect(d.allowed, `tier ${JSON.stringify(tier)}`).toBe(false);
    }
  });

  it('FAILS CLOSED when the entitlement cannot be read: denied, and NO upgrade prompt (an outage is not a plan problem)', async () => {
    const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: reader({ row: null, error: 'connection reset' }), today: TODAY });
    expect(d).toEqual({ allowed: false, reason: 'entitlement_unavailable', upgradeAvailable: false });
  });

  it('FAILS CLOSED when the reader throws', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('boom');
    });
    const d = await resolvePremiumAiAccess('u1', 't', { readEntitlement: throwing as never, today: TODAY });
    expect(d).toEqual({ allowed: false, reason: 'entitlement_unavailable', upgradeAvailable: false });
  });

  it('DENIES an empty or non-string user id without reading anything', async () => {
    const read = reader(row('premium'));
    for (const bad of ['', '   ', undefined as unknown as string, null as unknown as string]) {
      const d = await resolvePremiumAiAccess(bad, 't', { readEntitlement: read, today: TODAY });
      expect(d).toMatchObject({ allowed: false, reason: 'entitlement_unavailable' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the entitlement of EXACTLY the id it was given -- nothing else can influence the decision', async () => {
    const read = reader(row('free'));
    await resolvePremiumAiAccess('the-session-user', 't', { readEntitlement: read, today: TODAY });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('the-session-user');
  });

  it('does NOT cache: an upgrade is seen on the very next call, and a downgrade stops the very next call', async () => {
    let current = row('free');
    const read = vi.fn(async () => current);
    expect((await resolvePremiumAiAccess('u1', 't', { readEntitlement: read, today: TODAY })).allowed).toBe(false);
    current = row('premium'); // webhook / promo / admin grant just wrote Premium
    expect((await resolvePremiumAiAccess('u1', 't', { readEntitlement: read, today: TODAY })).allowed).toBe(true);
    current = row('free'); // cancelled / expired / revoked
    expect((await resolvePremiumAiAccess('u1', 't', { readEntitlement: read, today: TODAY })).allowed).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('the former pilot, e-mail lists and admin status grant and deny NOTHING', () => {
  const PILOT_VARS = [
    'AIE_PILOT_COHORT_ENFORCED',
    'AIE_PILOT_COHORT_USER_IDS',
    'AIE_PILOT_COHORT_EMAILS',
    'II_AI_FALLBACK_PILOT_COHORT_ENFORCED',
    'II_AI_FALLBACK_PILOT_COHORT_USER_IDS',
    'II_AI_FALLBACK_PILOT_COHORT_EMAILS',
  ] as const;
  const saved = Object.fromEntries(PILOT_VARS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of PILOT_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a former pilot user who is Free is DENIED even if every pilot variable still lists them', async () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'former-pilot-user';
    process.env.AIE_PILOT_COHORT_EMAILS = 'former.pilot@example.com';
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS = 'former-pilot-user';
    const d = await resolvePremiumAiAccess('former-pilot-user', 't', { readEntitlement: reader(row('free')), today: TODAY });
    expect(d.allowed).toBe(false);
  });

  it('a Premium user who is on NO pilot list is ALLOWED even when the pilot variables are set and name someone else', async () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'somebody-else';
    process.env.AIE_PILOT_COHORT_EMAILS = 'somebody.else@example.com';
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    const d = await resolvePremiumAiAccess('premium-outside-cohort', 't', { readEntitlement: reader(row('premium')), today: TODAY });
    expect(d.allowed).toBe(true);
  });

  it('the decision function takes no e-mail, no role and no "is admin" input at all (admin status cannot grant consumer Premium)', () => {
    // Signature proof: (userId, capability, deps). `deps` only carries a reader and a date.
    expect(resolvePremiumAiAccess.length).toBeLessThanOrEqual(3);
    const src = String(resolvePremiumAiAccess);
    expect(src).not.toMatch(/email|role|admin|isAdmin|super/i);
  });
});

describe('the denial a protected route returns', () => {
  it('Free -> 403 with the upgrade flag, in the same envelope requireAIEntitlement() uses', async () => {
    const res = await refuseUnlessPremiumAi('u1', 't', { readEntitlement: reader(row('free')), today: TODAY });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.data).toEqual({ allowed: false, reason: 'premium_required', upgrade_available: true });
    expect(body.error).toBe(premiumAiDeniedMessage('premium_required'));
  });

  it('unreadable entitlement -> 503 and no upgrade offer', async () => {
    const res = await refuseUnlessPremiumAi('u1', 't', { readEntitlement: reader({ row: null, error: 'x' }), today: TODAY });
    expect(res!.status).toBe(503);
    expect((await res!.json()).data.upgrade_available).toBe(false);
  });

  it('Premium -> null (the route proceeds)', async () => {
    expect(await refuseUnlessPremiumAi('u1', 't', { readEntitlement: reader(row('premium')), today: TODAY })).toBeNull();
  });

  it('leaks no internal flag, provider, model, limit or pilot wording', async () => {
    for (const reason of ['premium_required', 'entitlement_unavailable'] as const) {
      const res = premiumAiDeniedResponse({ allowed: false, reason, upgradeAvailable: reason === 'premium_required' });
      const text = JSON.stringify(await res.json());
      expect(text).not.toMatch(/openai|gpt|AIE_|kill|cohort|pilot|allowlist|invite|budget|quota|cost|usd|\$/i);
    }
  });
});
