// G3 — POST /api/user/country/confirm, exercised as a route.
//
// Separate file from g3RegistrationAlignment.test.ts because this one needs
// module mocks (vi.mock is hoisted per-file), and because the questions it
// answers are about the ROUTE's behaviour — idempotency, disclosure
// enforcement, what it writes and what it refuses to write — rather than
// about the pure functions underneath.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetUser, mockFrom, mockRpc } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));
const USER_ID = 'g3-user';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockFrom, rpc: mockRpc }),
}));

// vi.hoisted so the spy genuinely exists before the (hoisted) vi.mock factory
// is evaluated — referencing an ordinary outer `const` from a mock factory is
// a temporal-dead-zone hazard, not a guarantee.
const auditSpies = vi.hoisted(() => ({
  // Typed via the generic rather than a named parameter so the argument shape
  // is still available to `.mock.calls[0][0]` without declaring an unused
  // binding.
  recordCountryAuditEvent: vi.fn<(event: Record<string, unknown>) => Promise<void>>(async () => undefined),
  recordReportingCurrencyAuditEvent: vi.fn<(event: Record<string, unknown>) => Promise<void>>(async () => undefined),
}));
vi.mock('@/lib/services/countryAudit', () => auditSpies);
const recordCountryAuditEvent = auditSpies.recordCountryAuditEvent;

import { POST as confirmPOST } from '@/app/api/user/country/confirm/route';
import { __resetCountryRegistryCacheForTests } from '@/lib/services/countryGate';
import { GENERIC_DISCLOSURE_VERSION } from '@/lib/services/countryDisclosure';

const COUNTRY_ROWS = [
  { country_code: 'AU', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'IN', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'GB', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'US', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'SG', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'AE', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
];
const CAPABILITY_ROWS = COUNTRY_ROWS.map((c) => ({ country_code: c.country_code, capability: 'REGISTRATION', enabled: true }));

// G3-R5 closure: the route no longer writes user_profiles itself. It calls
// the confirm_country_of_residence() RPC, which performs the validation, the
// profile write and the mandatory audit insert in ONE transaction. So what
// these tests capture is the RPC ARGUMENTS — and, just as importantly, that
// the route never issues a user_profiles UPDATE at all.
let lastRpc: { fn: string; args: Record<string, unknown> } | null = null;
let updateAttempted = false;

function harness(
  profile: Record<string, unknown> | null,
  opts: { capabilityRows?: typeof CAPABILITY_ROWS; rpcError?: { message: string } } = {}
) {
  lastRpc = null;
  updateAttempted = false;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'countries') return { select: async () => ({ data: COUNTRY_ROWS, error: null }) };
    if (table === 'country_capabilities') {
      return { select: () => ({ eq: async () => ({ data: opts.capabilityRows ?? CAPABILITY_ROWS, error: null }) }) };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }),
      // Any call here is a failure of the G3-R5 design, not a success path.
      update: () => {
        updateAttempted = true;
        return { eq: () => ({ select: () => ({ single: async () => ({ data: profile, error: null }) }) }) };
      },
    };
  });

  mockRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    lastRpc = { fn, args };
    if (opts.rpcError) return { data: null, error: opts.rpcError };

    // Faithful stand-in for the real RPC's decisions, so the route's mapping
    // of RPC outcomes to HTTP responses is what is actually under test here.
    // The RPC's OWN behaviour is certified against real PostgreSQL in
    // scripts/db-rebuild-check/g3_registration_alignment_cert.mjs.
    const country = args.p_country_code as string;
    const version = (args.p_disclosure_version as string | null) ?? null;
    const level = COUNTRY_ROWS.find((c) => c.country_code === country)?.experience_level ?? null;
    if (level === 'GENERIC' && !version) {
      return { data: null, error: { message: 'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED: ...' } };
    }
    const replay =
      profile?.country_confirmed_at != null &&
      profile?.country_of_residence === country &&
      (level !== 'GENERIC' ||
        (profile?.generic_disclosure_version === version && profile?.generic_disclosure_country === country));
    return {
      data: {
        country_of_residence: country,
        country_confirmed_at: replay ? profile!.country_confirmed_at : '2026-09-03T00:00:00Z',
        country_source: 'USER_CONFIRMED',
        generic_disclosure_version: level === 'GENERIC' ? version : null,
        experience_level: level,
        idempotent_replay: replay,
      },
      error: null,
    };
  });
}

function post(body: unknown) {
  return confirmPOST(new Request('http://test/api/user/country/confirm', { method: 'POST', body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCountryRegistryCacheForTests();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
});

const UNCONFIRMED = { country_of_residence: null, country_confirmed_at: null, country_source: null, generic_disclosure_version: null, generic_disclosure_country: null };

describe('POST /api/user/country/confirm — server authority', () => {
  it('confirms a FULL country with no acknowledgement and derives FULL server-side', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.experience_level).toBe('FULL');
    expect(lastRpc!.fn).toBe('confirm_country_of_residence');
    expect(lastRpc!.args).toEqual({ p_country_code: 'AU', p_disclosure_version: null });
  });

  it('refuses a GENERIC country with NO acknowledgement (422) before the RPC is ever called', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GB' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED' });
    expect(lastRpc).toBeNull();
  });

  it('refuses a GENERIC country with a STALE acknowledgement version', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: 'g3-generic-coverage-2020-01' });
    expect(res.status).toBe(422);
    expect(lastRpc).toBeNull();
  });

  it('passes the CURRENT disclosure version to the RPC for a GENERIC country', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(res.status).toBe(200);
    expect((await res.json()).data.experience_level).toBe('GENERIC');
    expect(lastRpc!.args).toEqual({ p_country_code: 'GB', p_disclosure_version: GENERIC_DISCLOSURE_VERSION });
  });

  it('sends a null disclosure version for a FULL country, so any stale acknowledgement is cleared', async () => {
    harness({ ...UNCONFIRMED, country_of_residence: 'GB', country_confirmed_at: '2026-09-01T00:00:00Z', generic_disclosure_version: GENERIC_DISCLOSURE_VERSION, generic_disclosure_country: 'GB' });
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(200);
    expect(lastRpc!.args.p_disclosure_version).toBeNull();
    expect((await res.json()).data.generic_disclosure_version).toBeNull();
  });

  it('rejects GLOBAL as invalid, never as a country (G3-10)', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GLOBAL' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'COUNTRY_INVALID' });
    expect(lastRpc).toBeNull();
  });

  it('rejects an unsupported-but-well-formed country (G3-11)', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'NZ' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'COUNTRY_UNSUPPORTED' });
    expect(lastRpc).toBeNull();
  });

  it('rejects a country the registry no longer permits registration for', async () => {
    harness(UNCONFIRMED, { capabilityRows: CAPABILITY_ROWS.map((r) => (r.country_code === 'GB' ? { ...r, enabled: false } : r)) });
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'COUNTRY_REGISTRATION_NOT_PERMITTED' });
    expect(lastRpc).toBeNull();
  });

  it('ignores any forged experience level, capability flag or authoritative field in the body (G3-15)', async () => {
    harness(UNCONFIRMED);
    const res = await post({
      country_of_residence: 'GB',
      acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION,
      experience_level: 'FULL',
      capabilities: { DOMESTIC_CALCULATIONS: true },
      country_confirmed_at: '1999-01-01T00:00:00Z',
      country_source: 'ADMIN_CORRECTED',
      preferred_currency: 'USD',
      billing_country: 'GB',
      primary_country: 'AU',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.experience_level).toBe('GENERIC');
    // The RPC receives EXACTLY two arguments. There is no parameter through
    // which any forged field could travel, so none of them can reach the
    // database at all.
    expect(Object.keys(lastRpc!.args).sort()).toEqual(['p_country_code', 'p_disclosure_version']);
    expect(lastRpc!.args.p_country_code).toBe('GB');
  });

  it('G3-R5: the route never writes user_profiles itself — the RPC owns the write', async () => {
    harness(UNCONFIRMED);
    await post({ country_of_residence: 'AU' });
    expect(updateAttempted).toBe(false);
  });

  it('G3-R5: the route no longer writes the audit event either — the RPC does, in the same transaction', async () => {
    harness(UNCONFIRMED);
    await post({ country_of_residence: 'AU' });
    expect(recordCountryAuditEvent).not.toHaveBeenCalled();
  });

  it('maps an RPC controlled-workflow rejection to an operational error rather than leaking SQL', async () => {
    harness(UNCONFIRMED, { rpcError: { message: 'COUNTRY_CONFIRMATION_REQUIRES_CONTROLLED_WORKFLOW: direct update of country_confirmed_at ...' } });
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'OPERATIONAL_ERROR' });
    expect(JSON.stringify(body)).not.toMatch(/update|trigger|column/i);
  });

  it('maps the RPC disclosure rejection to 422 (defence in depth if the route check were ever bypassed)', async () => {
    harness(UNCONFIRMED, { rpcError: { message: 'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED: country GB ...' } });
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED' });
  });

  it('maps an RPC PROFILE_INCOMPLETE rejection to 403', async () => {
    harness(null, { rpcError: { message: 'PROFILE_INCOMPLETE' } });
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'PROFILE_INCOMPLETE' });
  });
});

describe('POST /api/user/country/confirm — idempotency (G3-25)', () => {
  it('a repeated FULL confirmation replays: original timestamp returned, no route-side write', async () => {
    harness({ ...UNCONFIRMED, country_of_residence: 'AU', country_confirmed_at: '2026-09-01T00:00:00Z', country_source: 'USER_CONFIRMED' });
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.idempotent_replay).toBe(true);
    expect(body.data.country_confirmed_at).toBe('2026-09-01T00:00:00Z');
    expect(updateAttempted).toBe(false);
    expect(recordCountryAuditEvent).not.toHaveBeenCalled();
  });

  it('a repeated GENERIC confirmation with the same acknowledgement also replays', async () => {
    harness({
      country_of_residence: 'GB',
      country_confirmed_at: '2026-09-01T00:00:00Z',
      country_source: 'USER_CONFIRMED',
      generic_disclosure_version: GENERIC_DISCLOSURE_VERSION,
      generic_disclosure_country: 'GB',
    });
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(res.status).toBe(200);
    expect((await res.json()).data.idempotent_replay).toBe(true);
  });

  it('a GENERIC replay whose stored acknowledgement names a DIFFERENT country is not a replay', async () => {
    harness({
      country_of_residence: 'GB',
      country_confirmed_at: '2026-09-01T00:00:00Z',
      country_source: 'USER_CONFIRMED',
      generic_disclosure_version: GENERIC_DISCLOSURE_VERSION,
      generic_disclosure_country: 'US',
    });
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(res.status).toBe(200);
    expect((await res.json()).data.idempotent_replay).toBe(false);
  });

  it('a genuine country CHANGE is never treated as a replay', async () => {
    harness({ ...UNCONFIRMED, country_of_residence: 'AU', country_confirmed_at: '2026-09-01T00:00:00Z', country_source: 'USER_CONFIRMED' });
    const res = await post({ country_of_residence: 'IN' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.idempotent_replay).toBe(false);
  });
});
