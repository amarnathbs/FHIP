// G3 — POST /api/user/country/confirm, exercised as a route.
//
// Separate file from g3RegistrationAlignment.test.ts because this one needs
// module mocks (vi.mock is hoisted per-file), and because the questions it
// answers are about the ROUTE's behaviour — idempotency, disclosure
// enforcement, what it writes and what it refuses to write — rather than
// about the pure functions underneath.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetUser, mockFrom } = vi.hoisted(() => ({ mockGetUser: vi.fn(), mockFrom: vi.fn() }));
const USER_ID = 'g3-user';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockFrom }),
}));

// vi.hoisted so the spy genuinely exists before the (hoisted) vi.mock factory
// is evaluated — referencing an ordinary outer `const` from a mock factory is
// a temporal-dead-zone hazard, not a guarantee.
const auditSpies = vi.hoisted(() => ({
  recordCountryAuditEvent: vi.fn(async (_event: Record<string, unknown>) => undefined),
  recordReportingCurrencyAuditEvent: vi.fn(async (_event: Record<string, unknown>) => undefined),
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

/** Captures the exact patch the route attempts to write. */
let lastUpdatePatch: Record<string, unknown> | null = null;

function harness(profile: Record<string, unknown> | null, opts: { capabilityRows?: typeof CAPABILITY_ROWS } = {}) {
  lastUpdatePatch = null;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'countries') return { select: async () => ({ data: COUNTRY_ROWS, error: null }) };
    if (table === 'country_capabilities') {
      return { select: () => ({ eq: async () => ({ data: opts.capabilityRows ?? CAPABILITY_ROWS, error: null }) }) };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        lastUpdatePatch = patch;
        return {
          eq: () => ({ select: () => ({ single: async () => ({ data: { ...profile, ...patch }, error: null }) }) }),
        };
      },
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
    const body = await res.json();
    expect(body.data.experience_level).toBe('FULL');
    expect(lastUpdatePatch!.country_source).toBe('USER_CONFIRMED');
    expect(lastUpdatePatch!.country_of_residence).toBe('AU');
  });

  it('refuses a GENERIC country with NO acknowledgement (422) and writes nothing', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GB' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED' });
    expect(lastUpdatePatch).toBeNull();
    expect(recordCountryAuditEvent).not.toHaveBeenCalled();
  });

  it('refuses a GENERIC country with a STALE acknowledgement version', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: 'g3-generic-coverage-2020-01' });
    expect(res.status).toBe(422);
    expect(lastUpdatePatch).toBeNull();
  });

  it('confirms a GENERIC country WITH the current acknowledgement and records all three disclosure fields', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(res.status).toBe(200);
    expect((await res.json()).data.experience_level).toBe('GENERIC');
    expect(lastUpdatePatch!.generic_disclosure_version).toBe(GENERIC_DISCLOSURE_VERSION);
    expect(lastUpdatePatch!.generic_disclosure_country).toBe('GB');
    expect(lastUpdatePatch!.generic_disclosure_acknowledged_at).toBeTruthy();
  });

  it('CLEARS a stale disclosure when the user moves to a FULL country', async () => {
    harness({ ...UNCONFIRMED, country_of_residence: 'GB', country_confirmed_at: '2026-09-01T00:00:00Z', generic_disclosure_version: GENERIC_DISCLOSURE_VERSION, generic_disclosure_country: 'GB' });
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(200);
    expect(lastUpdatePatch!.generic_disclosure_version).toBeNull();
    expect(lastUpdatePatch!.generic_disclosure_acknowledged_at).toBeNull();
    expect(lastUpdatePatch!.generic_disclosure_country).toBeNull();
  });

  it('rejects GLOBAL as invalid, never as a country (G3-10)', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'GLOBAL' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'COUNTRY_INVALID' });
    expect(lastUpdatePatch).toBeNull();
  });

  it('rejects an unsupported-but-well-formed country (G3-11)', async () => {
    harness(UNCONFIRMED);
    const res = await post({ country_of_residence: 'NZ' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'COUNTRY_UNSUPPORTED' });
    expect(lastUpdatePatch).toBeNull();
  });

  it('rejects a country the registry no longer permits registration for', async () => {
    harness(UNCONFIRMED, { capabilityRows: CAPABILITY_ROWS.map((r) => (r.country_code === 'GB' ? { ...r, enabled: false } : r)) });
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'COUNTRY_REGISTRATION_NOT_PERMITTED' });
    expect(lastUpdatePatch).toBeNull();
  });

  it('ignores any forged experience level or capability flag in the request body (G3-15)', async () => {
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
    // The write must contain ONLY the fields this route owns.
    expect(Object.keys(lastUpdatePatch!).sort()).toEqual([
      'country_confirmed_at', 'country_of_residence', 'country_source', 'country_updated_at',
      'generic_disclosure_acknowledged_at', 'generic_disclosure_country', 'generic_disclosure_version',
      'updated_at',
    ]);
    expect(lastUpdatePatch!.country_source).toBe('USER_CONFIRMED'); // never the forged ADMIN_CORRECTED
    expect(lastUpdatePatch!.country_confirmed_at).not.toBe('1999-01-01T00:00:00Z'); // always server time
    expect(lastUpdatePatch).not.toHaveProperty('preferred_currency');
    expect(lastUpdatePatch).not.toHaveProperty('billing_country');
    expect(lastUpdatePatch).not.toHaveProperty('primary_country');
  });
});

describe('POST /api/user/country/confirm — idempotency (G3-25)', () => {
  it('a repeated FULL confirmation is a no-op replay: no write, no second audit event', async () => {
    harness({ ...UNCONFIRMED, country_of_residence: 'AU', country_confirmed_at: '2026-09-01T00:00:00Z', country_source: 'USER_CONFIRMED' });
    const res = await post({ country_of_residence: 'AU' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.idempotent_replay).toBe(true);
    expect(body.data.country_confirmed_at).toBe('2026-09-01T00:00:00Z'); // the ORIGINAL timestamp, not a new one
    expect(lastUpdatePatch).toBeNull();
    expect(recordCountryAuditEvent).not.toHaveBeenCalled();
  });

  it('a repeated GENERIC confirmation with the same acknowledgement is also a no-op replay', async () => {
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
    expect(lastUpdatePatch).toBeNull();
    expect(recordCountryAuditEvent).not.toHaveBeenCalled();
  });

  it('a GENERIC replay whose stored acknowledgement is for a DIFFERENT country is NOT treated as a replay', async () => {
    harness({
      country_of_residence: 'GB',
      country_confirmed_at: '2026-09-01T00:00:00Z',
      country_source: 'USER_CONFIRMED',
      generic_disclosure_version: GENERIC_DISCLOSURE_VERSION,
      generic_disclosure_country: 'US', // stale/mismatched
    });
    const res = await post({ country_of_residence: 'GB', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(res.status).toBe(200);
    expect((await res.json()).data.idempotent_replay).toBe(false);
    expect(lastUpdatePatch!.generic_disclosure_country).toBe('GB'); // repaired
    expect(recordCountryAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('a genuine country CHANGE is never treated as a replay and does write an audit event', async () => {
    harness({ ...UNCONFIRMED, country_of_residence: 'AU', country_confirmed_at: '2026-09-01T00:00:00Z', country_source: 'USER_CONFIRMED' });
    const res = await post({ country_of_residence: 'IN' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.idempotent_replay).toBe(false);
    expect(recordCountryAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('records the derived experience level and disclosure version on the audit event', async () => {
    harness(UNCONFIRMED);
    await post({ country_of_residence: 'SG', acknowledged_disclosure_version: GENERIC_DISCLOSURE_VERSION });
    expect(recordCountryAuditEvent).toHaveBeenCalledTimes(1);
    const arg = recordCountryAuditEvent.mock.calls[0]![0];
    expect(arg.experienceLevel).toBe('GENERIC');
    expect(arg.disclosureVersion).toBe(GENERIC_DISCLOSURE_VERSION);
    expect(arg.newCountry).toBe('SG');
  });
});
