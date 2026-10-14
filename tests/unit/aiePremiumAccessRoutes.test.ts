// The five AIE intake / process ROUTES -- who may start them (14-10-2026).
//
// The two-e-mail pilot allowlist is gone. Each route now refuses, BEFORE it
// creates an intake row, stores a byte or reads the request body, unless the
// authenticated session user has an active Premium entitlement. NEGATIVE
// CONTROLS sit in the same file: the identical request from a Premium user who
// was never on any pilot list gets PAST the gate (so the refusals above are the
// entitlement check, not an earlier gate), and the old pilot variables are set
// throughout to prove they neither admit nor block anyone.
//
// UNIT-TESTED. Routes are the real route modules; the entitlement DATABASE read
// is the shared test double (tests/support/premiumAiAccessMock.ts).
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { premiumAi } from '../support/premiumAiAccessMock';

// Composition with the Premium upload entitlement (r2): these routes check "may this user START an upload" before the AI gate,
// and this file's session mock has no entitlement row. The legacy-test double answers 'entitled' so THIS file still tests the AI gate alone.
vi.mock('@/lib/entitlements/financialDataImport', async (importOriginal) =>
  (await import('../support/premiumImportEntitlementMock')).withPremiumImportEntitlement(await importOriginal()));

vi.setConfig({ testTimeout: 60000 });

const h = vi.hoisted(() => ({
  user: { current: { id: 'user-x', email: 'former.pilot@example.test' } as { id: string; email: string } | null },
  createIntake: vi.fn(async () => ({ error: 'stop here (test)' })),
  getIntakeForUser: vi.fn(async () => null),
  uploadToQuarantine: vi.fn(async () => ({ ok: false })),
  bodyRead: false,
}));

vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()),
);
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const auth = async () =>
    h.user.current
      ? { user: h.user.current, unauthenticated: null }
      : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) };
  return { ...actual, requireCountryConfirmedUser: auth, requireUser: auth };
});
vi.mock('@/lib/services/appCapability', () => ({
  requireModuleCapability: async () =>
    h.user.current
      ? { user: h.user.current, blocked: null }
      : { user: null, blocked: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => ({}) }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({}) }) }));
vi.mock('@/lib/aie/audit', () => ({ recordAieAuditEvent: async () => {} }));
vi.mock('@/lib/aie/storage', () => ({
  buildQuarantineStorageKey: (u: string, i: string) => `${u}/${i}`,
  uploadToQuarantine: h.uploadToQuarantine,
}));
vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return {
    ...actual,
    createIntake: h.createIntake,
    getIntakeForUser: h.getIntakeForUser,
    updateIntakeStatus: async () => true,
    recordFingerprint: async () => {},
    existingFingerprintHashesForUser: async () => [],
  };
});

const ENV = [
  'AIE_DOCUMENT_INTAKE_ENABLED',
  'AIE_FDH_BANK_ADAPTER_ENABLED',
  'AIE_II_ADAPTER_ENABLED',
  'AIE_INSURANCE_ADAPTER_ENABLED',
  'AIE_ALLOW_MISSING_SIGNATURE_SCANNER',
  'AIE_PILOT_COHORT_ENFORCED',
  'AIE_PILOT_COHORT_USER_IDS',
  'AIE_PILOT_COHORT_EMAILS',
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  premiumAi.reset();
  h.user.current = { id: 'user-x', email: 'former.pilot@example.test' };
  h.createIntake.mockClear();
  h.getIntakeForUser.mockClear();
  h.uploadToQuarantine.mockClear();
  h.bodyRead = false;
  process.env.AIE_DOCUMENT_INTAKE_ENABLED = 'true';
  process.env.AIE_FDH_BANK_ADAPTER_ENABLED = 'true';
  process.env.AIE_II_ADAPTER_ENABLED = 'true';
  process.env.AIE_INSURANCE_ADAPTER_ENABLED = 'true';
  process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER = 'true';
  // The retired pilot variables, set to LIST this user: they must change nothing.
  process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
  process.env.AIE_PILOT_COHORT_USER_IDS = 'user-x';
  process.env.AIE_PILOT_COHORT_EMAILS = 'former.pilot@example.test';
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function post(path: string): Request {
  const body = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const req = new Request(new URL(`https://app.test${path}`), {
    method: 'POST',
    headers: { 'content-length': String(body.byteLength), 'content-type': 'application/pdf' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const original = req.arrayBuffer.bind(req);
  req.arrayBuffer = async () => {
    h.bodyRead = true;
    return original();
  };
  return req;
}

interface RouteCase {
  name: string;
  path: string;
  load: () => Promise<{ POST: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> }>;
  /** What a Premium user who passes the gate runs into next (proves the gate, not an earlier check, refused the others). */
  premiumReaches: (res: Response) => void | Promise<void>;
}
const params = { params: Promise.resolve({ intakeId: 'intake-1' }) };
const CASES: RouteCase[] = [
  {
    name: 'POST /api/aie/intake',
    path: '/api/aie/intake?filename=s.pdf',
    load: () => import('@/app/api/aie/intake/route') as never,
    premiumReaches: () => expect(h.createIntake).toHaveBeenCalledTimes(1),
  },
  {
    name: 'POST /api/aie/insurance/intake',
    path: '/api/aie/insurance/intake?filename=s.pdf',
    load: () => import('@/app/api/aie/insurance/intake/route') as never,
    premiumReaches: () => expect(h.createIntake).toHaveBeenCalledTimes(1),
  },
  {
    name: 'POST /api/aie/fdh-bank/intake',
    path: '/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD&filename=s.pdf',
    load: () => import('@/app/api/aie/fdh-bank/intake/route') as never,
    premiumReaches: (res) => expect(res.status).toBe(422), // owner_required: the next check after the gate
  },
  {
    name: 'POST /api/aie/investment-intelligence/intake',
    path: '/api/aie/investment-intelligence/intake?filename=s.pdf',
    load: () => import('@/app/api/aie/investment-intelligence/intake/route') as never,
    premiumReaches: (res) => expect(res.status).toBe(422), // owner_required
  },
  {
    name: 'POST /api/aie/investment-intelligence/intake/{id}/process',
    path: '/api/aie/investment-intelligence/intake/intake-1/process',
    load: () => import('@/app/api/aie/investment-intelligence/intake/[intakeId]/process/route') as never,
    premiumReaches: async (res) => {
      expect(h.getIntakeForUser).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(404); // the (mocked) intake does not exist -- but the gate let it look
    },
  },
];

describe.each(CASES)('$name', (c) => {
  it('UNAUTHENTICATED: 401 -- the plan is never read, nothing is created or stored', async () => {
    h.user.current = null;
    const { POST } = await c.load();
    const res = await POST(post(c.path), params);
    expect(res.status).toBe(401);
    expect(premiumAi.asked).toEqual([]);
    expect(h.createIntake).not.toHaveBeenCalled();
    expect(h.uploadToQuarantine).not.toHaveBeenCalled();
    expect(h.bodyRead).toBe(false);
  });

  it('FREE (and listed on the retired pilot variables): 403 premium_required, upgrade offered, NOTHING created, stored or read', async () => {
    premiumAi.setTier('user-x', 'free');
    const { POST } = await c.load();
    const res = await POST(post(c.path), params);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.data).toEqual({ allowed: false, reason: 'premium_required', upgrade_available: true });
    expect(premiumAi.asked).toEqual(['user-x']); // the SESSION user, nobody else
    expect(h.createIntake).not.toHaveBeenCalled();
    expect(h.getIntakeForUser).not.toHaveBeenCalled();
    expect(h.uploadToQuarantine).not.toHaveBeenCalled();
    expect(h.bodyRead).toBe(false);
  });

  it('EXPIRED / DOWNGRADED Premium: 403 -- a lapsed entitlement starts nothing new', async () => {
    premiumAi.setTier('user-x', 'expired');
    const { POST } = await c.load();
    expect((await POST(post(c.path), params)).status).toBe(403);
    expect(h.createIntake).not.toHaveBeenCalled();
  });

  it('ENTITLEMENT UNREADABLE: 503, no upgrade offer, nothing created (fail closed)', async () => {
    premiumAi.setTier('user-x', 'unavailable');
    const { POST } = await c.load();
    const res = await POST(post(c.path), params);
    expect(res.status).toBe(503);
    expect((await res.json()).data.upgrade_available).toBe(false);
    expect(h.createIntake).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL -- PREMIUM, never on any pilot list: gets past the gate to the next real check', async () => {
    h.user.current = { id: 'user-y', email: 'brand.new.premium@example.test' }; // not in AIE_PILOT_COHORT_*
    premiumAi.setTier('user-y', 'premium');
    const { POST } = await c.load();
    const res = await POST(post(c.path), params);
    expect(res.status).not.toBe(401);
    const text = await res.clone().text();
    expect(text).not.toContain('premium_required');
    expect(text).not.toContain('entitlement_unavailable');
    expect(premiumAi.asked).toEqual(['user-y']);
    await c.premiumReaches(res);
  });
});

describe('the SESSION decides, never the caller', () => {
  it('a query-string / header claiming another user or Premium changes nothing', async () => {
    premiumAi.setTier('user-x', 'free');
    premiumAi.setTier('victim-premium-user', 'premium');
    const { POST } = await import('@/app/api/aie/intake/route');
    const req = post('/api/aie/intake?filename=s.pdf&user_id=victim-premium-user&premium=true&plan_tier=premium');
    req.headers.set('x-user-id', 'victim-premium-user');
    req.headers.set('x-plan-tier', 'premium');
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(premiumAi.asked).toEqual(['user-x']);
    expect(h.createIntake).not.toHaveBeenCalled();
  });
});
