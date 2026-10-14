/**
 * Premium Upload Entitlement -- the central capability (lib/entitlements/financialDataImport.ts).
 *
 * Pages 41-50, 14-16, 42, 44-46, 48-49, 59-60, 76-78, 184-191 of the programme prompt:
 *   - Premium allowed; Free / no row / unknown tier / expired / not-yet-started / malformed => PREMIUM_REQUIRED (403)
 *   - a read error / throwing reader / blank user id => ENTITLEMENT_UNAVAILABLE (503), never "allowed", never "Free"
 *   - the decision comes ONLY from the server-side row: a spoofed client plan has nowhere to enter
 *   - no caching: upgrade is visible on the next call, downgrade stops the next call
 *   - subscription lifecycle uses the canonical mapping (active/trialing/past_due keep Premium; terminal => Free)
 *
 * NEGATIVE CONTROL: a deliberately broken variant (a reader that treats a read error as Free-with-access) is run
 * through the same assertions and must FAIL them -- so the suite demonstrably detects a fail-open regression.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertFinancialImportAllowed,
  financialImportAccessView,
  financialImportDeniedBody,
  financialImportErrorResponse,
  FinancialImportDeniedError,
  refuseUnlessFinancialImportAllowed,
  refuseUnlessImportRunMayStart,
  resolveFinancialImportAccess,
  type FinancialImportAccessDeps,
  type FinancialImportEntitlementRead,
} from '@/lib/entitlements/financialDataImport';
import { isPremiumSubscriptionStatus } from '@/lib/services/payments/entitlementSync';

const TODAY = '2026-10-14';
const row = (r: Record<string, unknown> | null): FinancialImportAccessDeps => ({
  today: TODAY,
  onEvent: () => {},
  readEntitlement: async (): Promise<FinancialImportEntitlementRead> => ({ row: r as never, error: null }),
});
const failing = (message = 'connection refused'): FinancialImportAccessDeps => ({
  today: TODAY,
  onEvent: () => {},
  readEntitlement: async () => ({ row: null, error: message }),
});

describe('resolveFinancialImportAccess -- who may start a new import', () => {
  it('Premium (no window) => allowed', async () => {
    expect(await resolveFinancialImportAccess('u1', 's', row({ plan_tier: 'premium', effective_from: '2026-01-01', effective_to: null }))).toEqual({ allowed: true, planTier: 'premium' });
  });

  it('Premium with an open window that includes today (inclusive both ends) => allowed', async () => {
    expect((await resolveFinancialImportAccess('u1', 's', row({ plan_tier: 'premium', effective_from: TODAY, effective_to: TODAY }))).allowed).toBe(true);
  });

  it.each([
    ['Free row', { plan_tier: 'free', effective_from: '2026-01-01', effective_to: null }],
    ['no entitlement row at all', null],
    ['unknown tier value', { plan_tier: 'enterprise', effective_from: null, effective_to: null }],
    ['upper-case tier (malformed)', { plan_tier: 'PREMIUM', effective_from: null, effective_to: null }],
    ['null tier', { plan_tier: null, effective_from: null, effective_to: null }],
    ['Premium window ended yesterday (expired grant / trial)', { plan_tier: 'premium', effective_from: '2026-01-01', effective_to: '2026-10-13' }],
    ['Premium window starts tomorrow', { plan_tier: 'premium', effective_from: '2026-10-15', effective_to: null }],
    ['Premium with a garbage end date (malformed => never grants)', { plan_tier: 'premium', effective_from: null, effective_to: 'zzz' }],
    ['Premium with a garbage start date', { plan_tier: 'premium', effective_from: '14/10/2026', effective_to: null }],
  ])('%s => PREMIUM_REQUIRED, HTTP 403, upgrade offered', async (_name, r) => {
    const d = await resolveFinancialImportAccess('u1', 's', row(r as never));
    expect(d).toEqual({ allowed: false, code: 'PREMIUM_REQUIRED', httpStatus: 403, upgradeAvailable: true });
  });

  it('a read error => ENTITLEMENT_UNAVAILABLE, HTTP 503, NO upgrade offered (an outage is not a payment problem)', async () => {
    expect(await resolveFinancialImportAccess('u1', 's', failing())).toEqual({ allowed: false, code: 'ENTITLEMENT_UNAVAILABLE', httpStatus: 503, upgradeAvailable: false });
  });

  it('a reader that THROWS => ENTITLEMENT_UNAVAILABLE (fail closed, never an exception into the route)', async () => {
    const d = await resolveFinancialImportAccess('u1', 's', { today: TODAY, onEvent: () => {}, readEntitlement: async () => { throw new Error('boom'); } });
    expect(d).toMatchObject({ allowed: false, code: 'ENTITLEMENT_UNAVAILABLE', httpStatus: 503 });
  });

  it.each(['', '   ', undefined as unknown as string, null as unknown as string, 42 as unknown as string])('an unusable user id (%s) => ENTITLEMENT_UNAVAILABLE without reading anything', async (id) => {
    const read = vi.fn();
    const d = await resolveFinancialImportAccess(id, 's', { today: TODAY, onEvent: () => {}, readEntitlement: read as never });
    expect(d).toMatchObject({ allowed: false, code: 'ENTITLEMENT_UNAVAILABLE' });
    expect(read).not.toHaveBeenCalled();
  });

  it('SPOOFED CLIENT PLAN has nowhere to enter: the decision is a function of the stored row only', async () => {
    // The helper's signature takes a user id and a surface label -- there is no plan / header / body / cookie parameter.
    // Whatever a hostile client sends, the answer is the row's. (Route-level spoofing is covered in premiumUploadRoutes.)
    expect(resolveFinancialImportAccess.length).toBeLessThanOrEqual(3);
    const free = await resolveFinancialImportAccess('u1', 'plan=premium&price=0&country=AU&isPremium=true', row({ plan_tier: 'free' }));
    expect(free).toMatchObject({ allowed: false, code: 'PREMIUM_REQUIRED' });
  });

  it('asks only for its OWN user: the reader is called with exactly the id it was given', async () => {
    const read = vi.fn(async () => ({ row: { plan_tier: 'premium' } as never, error: null }));
    await resolveFinancialImportAccess('user-A', 's', { today: TODAY, onEvent: () => {}, readEntitlement: read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('user-A');
  });

  it('no cache: an upgrade is visible on the very next call and a downgrade stops the very next call', async () => {
    let current: Record<string, unknown> = { plan_tier: 'free' };
    const deps: FinancialImportAccessDeps = { today: TODAY, onEvent: () => {}, readEntitlement: async () => ({ row: current as never, error: null }) };
    expect((await resolveFinancialImportAccess('u', 's', deps)).allowed).toBe(false);
    current = { plan_tier: 'premium' }; // verified webhook flips the row
    expect((await resolveFinancialImportAccess('u', 's', deps)).allowed).toBe(true);
    current = { plan_tier: 'free' }; // cancellation / trial expiry
    expect((await resolveFinancialImportAccess('u', 's', deps)).allowed).toBe(false);
  });
});

describe('subscription lifecycle semantics (the canonical mapping, not a second one)', () => {
  const tierFor = (status: Parameters<typeof isPremiumSubscriptionStatus>[0]) => ({ plan_tier: isPremiumSubscriptionStatus(status) ? 'premium' : 'free' });
  it.each([
    ['active', true],
    ['trialing', true], // page 77: a trial is Premium
    ['past_due', true], // page 76: the existing grace decision is preserved
    ['canceled', false], // page 75: new admission stops
    ['unpaid', false], // page 157
    ['incomplete', false], // page 183: an unfinished checkout is not Premium
    ['incomplete_expired', false],
  ])('%s => import allowed = %s', async (status, allowed) => {
    expect((await resolveFinancialImportAccess('u', 's', row(tierFor(status as never)))).allowed).toBe(allowed);
  });
});

describe('the refusal contract (pages 59, 60, 187)', () => {
  it('PREMIUM_REQUIRED is HTTP 403 with the stable code, the PO wording and the existing upgrade path; never 404', async () => {
    const res = (await refuseUnlessFinancialImportAllowed('u1', 's', row({ plan_tier: 'free' })))!;
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.code).toBe('PREMIUM_REQUIRED');
    expect(body.error).toBe('Statement and document import is available on Premium. You can continue to add and edit your financial information manually on the Free plan.');
    expect(body.data).toEqual({ allowed: false, reason: 'PREMIUM_REQUIRED', upgrade_available: true, upgrade_path: '/profile' });
    expect(JSON.stringify(body)).not.toMatch(/stripe|razorpay|past_due|trialing|plan_tier|subscription/i); // no billing internals
  });

  it('ENTITLEMENT_UNAVAILABLE is HTTP 503 and says retry, not "pay"', async () => {
    const res = (await refuseUnlessFinancialImportAllowed('u1', 's', failing()))!;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('ENTITLEMENT_UNAVAILABLE');
    expect(body.data.upgrade_available).toBe(false);
    expect(body.data.upgrade_path).toBeNull();
    expect(body.error).toMatch(/try again/i);
    expect(body.error).not.toMatch(/premium/i);
  });

  it('a Premium user gets null (proceed) -- no response is built', async () => {
    expect(await refuseUnlessFinancialImportAllowed('u1', 's', row({ plan_tier: 'premium' }))).toBeNull();
  });

  it('the thrown form maps to the same response, and an unrelated error maps to null (the caller keeps its own mapping)', async () => {
    const err = await assertFinancialImportAllowed('u1', 's', row({ plan_tier: 'free' })).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(FinancialImportDeniedError);
    const res = financialImportErrorResponse(err)!;
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PREMIUM_REQUIRED');
    expect(financialImportErrorResponse(new Error('other'))).toBeNull();
    await expect(assertFinancialImportAllowed('u1', 's', row({ plan_tier: 'premium' }))).resolves.toBeUndefined();
  });

  it('financialImportDeniedBody is pure and stable', () => {
    expect(financialImportDeniedBody({ allowed: false, code: 'PREMIUM_REQUIRED', httpStatus: 403, upgradeAvailable: true }).code).toBe('PREMIUM_REQUIRED');
  });
});

describe('events are privacy-safe (page 176)', () => {
  it('a denial records the surface and the code only -- no user id, no file name, no document content', async () => {
    const events: unknown[] = [];
    await resolveFinancialImportAccess('user-secret-id', 'fdh.bank_pdf.upload', { today: TODAY, readEntitlement: async () => ({ row: null, error: null }), onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ event: 'import_admission_denied_free', surface: 'fdh.bank_pdf.upload', code: 'PREMIUM_REQUIRED' }]);
    expect(JSON.stringify(events)).not.toContain('user-secret-id');
  });

  it('a throwing event sink can never change the decision', async () => {
    const d = await resolveFinancialImportAccess('u', 's', { today: TODAY, readEntitlement: async () => ({ row: { plan_tier: 'premium' } as never, error: null }), onEvent: () => { throw new Error('sink down'); } });
    expect(d.allowed).toBe(true);
  });
});

describe('financialImportAccessView -- presentation only', () => {
  it('maps the three outcomes', async () => {
    expect(await financialImportAccessView('u', 's', row({ plan_tier: 'premium' }))).toEqual({ state: 'allowed' });
    expect(await financialImportAccessView('u', 's', row({ plan_tier: 'free' }))).toEqual({ state: 'premium_required' });
    expect(await financialImportAccessView('u', 's', failing())).toEqual({ state: 'unavailable' });
  });
});

describe('downgrade / in-flight policy (pages 9, 32-34, 95, 117, 155, 199)', () => {
  const free = row({ plan_tier: 'free' });
  const premium = row({ plan_tier: 'premium' });
  const pos = (p: 'first_run' | 'in_flight' | 'retry' | 'forced' | 'unknown') => vi.fn(async () => p);

  it('Premium: allowed whatever the position, and the document is never even read', async () => {
    const p = pos('retry');
    expect(await refuseUnlessImportRunMayStart('u', 's', p, premium)).toBeNull();
    expect(p).not.toHaveBeenCalled();
  });

  it.each(['first_run', 'in_flight'] as const)('Free after a downgrade: %s of an admitted document may continue', async (where) => {
    expect(await refuseUnlessImportRunMayStart('u', 's', pos(where), free)).toBeNull();
  });

  it.each(['retry', 'forced', 'unknown'] as const)('Free: %s is NEW extraction work (or no admitted document) => PREMIUM_REQUIRED', async (where) => {
    const res = (await refuseUnlessImportRunMayStart('u', 's', pos(where), free))!;
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PREMIUM_REQUIRED');
  });

  it('a position lookup that throws is treated as unknown (refused), never as a continuation', async () => {
    const res = (await refuseUnlessImportRunMayStart('u', 's', async () => { throw new Error('db'); }, free))!;
    expect(res.status).toBe(403);
  });

  it('entitlement unreadable => 503 and the document is not even consulted', async () => {
    const p = pos('first_run');
    const res = (await refuseUnlessImportRunMayStart('u', 's', p, failing()))!;
    expect(res.status).toBe(503);
    expect(p).not.toHaveBeenCalled();
  });
});

describe('NEGATIVE CONTROL -- the suite detects a fail-open regression', () => {
  // A deliberately broken helper that treats "could not read" as Free-WITH-access. The assertion the real helper
  // passes (an unreadable entitlement must never allow) must FAIL for it, proving the assertion is not vacuous.
  async function brokenResolve(read: () => Promise<FinancialImportEntitlementRead>) {
    const r = await read();
    if (r.error) return { allowed: true as const };
    return { allowed: r.row?.plan_tier === 'premium' };
  }
  it('the broken variant is caught by the exact assertion used above', async () => {
    const real = await resolveFinancialImportAccess('u', 's', failing());
    const broken = await brokenResolve(async () => ({ row: null, error: 'down' }));
    expect(real.allowed).toBe(false);
    expect(broken.allowed).toBe(true); // i.e. `expect(broken.allowed).toBe(false)` WOULD fail -- demonstrated, not assumed
    expect(() => expect(broken.allowed).toBe(false)).toThrow();
  });
});
