import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyCountryValue,
  assertCountryConfirmedForUser,
  countryConfirmationBlockResponse,
  isBlockingState,
  shouldRedirectToConfirmCountry,
  SUPPORTED_COUNTRY_CODES,
  COUNTRY_GATE_ERROR_CODE,
  COUNTRY_GATE_HTTP_STATUS,
  __resetCountryRegistryCacheForTests,
  type CountryGateResult,
} from '@/lib/services/countryGate';

type Row = Record<string, unknown> | null;

// The registry rows as G1 (migration 0122) + G3 (migration 0127) leave them:
// AU/IN FULL, GB/US/SG/AE GENERIC, REGISTRATION enabled for all six.
const DEFAULT_COUNTRY_ROWS = [
  { country_code: 'AU', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'IN', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'GB', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'US', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'SG', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'AE', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
];

const DEFAULT_CAPABILITY_ROWS = DEFAULT_COUNTRY_ROWS.map((c) => ({
  country_code: c.country_code,
  capability: 'REGISTRATION',
  enabled: true,
}));

// G3: assertCountryConfirmedForUser now issues up to THREE queries — the
// profile row (as before) plus the two registry reads
// loadCountryRegistrySnapshot() performs. This fake therefore routes by
// table name instead of returning the same row for everything.
function fakeClient(
  row: Row,
  opts: {
    error?: { message: string };
    countryRows?: typeof DEFAULT_COUNTRY_ROWS;
    capabilityRows?: typeof DEFAULT_CAPABILITY_ROWS;
    registryError?: { message: string };
  } = {}
) {
  const countryRows = opts.countryRows ?? DEFAULT_COUNTRY_ROWS;
  const capabilityRows = opts.capabilityRows ?? DEFAULT_CAPABILITY_ROWS;
  return {
    from: (table: string) => {
      if (table === 'countries') {
        return {
          select: () =>
            Promise.resolve(
              opts.registryError ? { data: null, error: opts.registryError } : { data: countryRows, error: null }
            ),
        };
      }
      if (table === 'country_capabilities') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve(
                opts.registryError ? { data: null, error: opts.registryError } : { data: capabilityRows, error: null }
              ),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: opts.error ?? null }),
          }),
        }),
      };
    },
  } as unknown as Parameters<typeof assertCountryConfirmedForUser>[0];
}

// The registry snapshot is memoised in-process behind a TTL, so it MUST be
// cleared between tests — otherwise one test's registry leaks into the next
// and the suite silently stops testing what it claims to.
beforeEach(() => {
  __resetCountryRegistryCacheForTests();
});

describe('classifyCountryValue', () => {
  it('treats null, undefined and blank/whitespace as MISSING', () => {
    expect(classifyCountryValue(null)).toBe('MISSING');
    expect(classifyCountryValue(undefined)).toBe('MISSING');
    expect(classifyCountryValue('')).toBe('MISSING');
    expect(classifyCountryValue('   ')).toBe('MISSING');
  });

  it('treats non-two-letter or non-alphabetic values as INVALID, never coerced to a country', () => {
    expect(classifyCountryValue('1')).toBe('INVALID');
    expect(classifyCountryValue('AUS')).toBe('INVALID');
    expect(classifyCountryValue('A')).toBe('INVALID');
    expect(classifyCountryValue('12')).toBe('INVALID');
    expect(classifyCountryValue('A1')).toBe('INVALID');
    expect(classifyCountryValue('!!')).toBe('INVALID');
  });

  // G3: 'US' moved from UNSUPPORTED to SUPPORTED because it is now one of the
  // six authoritative registration countries. 'NZ' and 'ZZ' stay UNSUPPORTED,
  // which is the load-bearing half of this assertion — G3 spec section 5.1
  // forbids accepting arbitrary two-letter codes just because they are
  // syntactically valid.
  it('treats a well-formed but not-offered code as UNSUPPORTED, never as invalid or as AU/IN', () => {
    expect(classifyCountryValue('NZ')).toBe('UNSUPPORTED');
    expect(classifyCountryValue('FR')).toBe('UNSUPPORTED');
    expect(classifyCountryValue('ZZ')).toBe('UNSUPPORTED');
  });

  it('accepts all six authoritative countries case-insensitively as SUPPORTED', () => {
    for (const code of ['AU', 'IN', 'GB', 'US', 'SG', 'AE']) {
      expect(classifyCountryValue(code)).toBe('SUPPORTED');
      expect(classifyCountryValue(code.toLowerCase())).toBe('SUPPORTED');
    }
  });

  it('never classifies GLOBAL as anything but INVALID — it is a presentation bucket, not a country', () => {
    expect(classifyCountryValue('GLOBAL')).toBe('INVALID');
    expect(classifyCountryValue('global')).toBe('INVALID');
  });

  it('exposes exactly the six authoritative registration countries (G1 registry + G3 section 5.1)', () => {
    expect([...SUPPORTED_COUNTRY_CODES].sort()).toEqual(['AE', 'AU', 'GB', 'IN', 'SG', 'US']);
  });
});

describe('assertCountryConfirmedForUser', () => {
  it('DB_ERROR on a query failure — never silently treated as confirmed or missing', async () => {
    const gate = await assertCountryConfirmedForUser(fakeClient(null, { error: { message: 'boom' } }), 'u1');
    expect(gate.state).toBe('DB_ERROR');
  });

  it('PROFILE_INCOMPLETE when no profile row exists', async () => {
    const gate = await assertCountryConfirmedForUser(fakeClient(null), 'u1');
    expect(gate.state).toBe('PROFILE_INCOMPLETE');
  });

  it('COUNTRY_MISSING for a null country, even if onboarding_completed is true', async () => {
    const gate = await assertCountryConfirmedForUser(
      fakeClient({ country_of_residence: null, country_confirmed_at: null, country_source: null, onboarding_completed: true }),
      'u1'
    );
    expect(gate.state).toBe('COUNTRY_MISSING');
  });

  it('COUNTRY_MISSING for a blank/whitespace country value', async () => {
    const gate = await assertCountryConfirmedForUser(
      fakeClient({ country_of_residence: '   ', country_confirmed_at: null, country_source: null, onboarding_completed: true }),
      'u1'
    );
    expect(gate.state).toBe('COUNTRY_MISSING');
  });

  it('COUNTRY_INVALID for a malformed value, and never silently converted to AU/IN', async () => {
    const gate = await assertCountryConfirmedForUser(
      fakeClient({ country_of_residence: 'XYZ123', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }),
      'u1'
    );
    expect(gate.state).toBe('COUNTRY_INVALID');
  });

  it('COUNTRY_UNSUPPORTED for a well-formed but unsupported country, even if it carries a confirmation timestamp', async () => {
    const gate = await assertCountryConfirmedForUser(
      fakeClient({ country_of_residence: 'NZ', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }),
      'u1'
    );
    expect(gate.state).toBe('COUNTRY_UNSUPPORTED');
  });

  it('COUNTRY_UNCONFIRMED for a supported country with no confirmation timestamp — the exact "pre-filled AU, never actually confirmed" case', async () => {
    const gate = await assertCountryConfirmedForUser(
      fakeClient({ country_of_residence: 'AU', country_confirmed_at: null, country_source: null, onboarding_completed: true }),
      'u1'
    );
    expect(gate.state).toBe('COUNTRY_UNCONFIRMED');
  });

  it('CONFIRMED only when the country is supported AND explicitly confirmed', async () => {
    const gate = await assertCountryConfirmedForUser(
      fakeClient({ country_of_residence: 'IN', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }),
      'u1'
    );
    expect(gate.state).toBe('CONFIRMED');
    expect(isBlockingState(gate.state)).toBe(false);
  });

  it('every non-CONFIRMED state is blocking', async () => {
    const states: Array<[Row, string]> = [
      [{ country_of_residence: null, country_confirmed_at: null, country_source: null, onboarding_completed: true }, 'COUNTRY_MISSING'],
      [{ country_of_residence: 'AU', country_confirmed_at: null, country_source: null, onboarding_completed: true }, 'COUNTRY_UNCONFIRMED'],
      [{ country_of_residence: 'NZ', country_confirmed_at: '2026-01-01', country_source: 'USER_CONFIRMED', onboarding_completed: true }, 'COUNTRY_UNSUPPORTED'],
      [{ country_of_residence: '###', country_confirmed_at: null, country_source: null, onboarding_completed: true }, 'COUNTRY_INVALID'],
    ];
    for (const [row, expected] of states) {
      const gate = await assertCountryConfirmedForUser(fakeClient(row), 'u1');
      expect(gate.state).toBe(expected);
      expect(isBlockingState(gate.state)).toBe(true);
    }
  });

  it('returns stable, distinguishable error codes and HTTP statuses for every blocking state', () => {
    expect(COUNTRY_GATE_ERROR_CODE.COUNTRY_MISSING).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(COUNTRY_GATE_ERROR_CODE.COUNTRY_UNCONFIRMED).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(COUNTRY_GATE_ERROR_CODE.COUNTRY_UNSUPPORTED).toBe('COUNTRY_UNSUPPORTED');
    expect(COUNTRY_GATE_ERROR_CODE.COUNTRY_INVALID).toBe('COUNTRY_INVALID');
    expect(COUNTRY_GATE_ERROR_CODE.PROFILE_INCOMPLETE).toBe('PROFILE_INCOMPLETE');
    // Never the same code as "confirmed" success, and unsupported/invalid
    // are never flattened into the same code as a missing/unconfirmed state.
    const codes = Object.values(COUNTRY_GATE_ERROR_CODE);
    expect(new Set(codes).size).toBeLessThan(codes.length); // MISSING and UNCONFIRMED intentionally share one UX code
    expect(COUNTRY_GATE_HTTP_STATUS.COUNTRY_INVALID).toBe(422);
    expect(COUNTRY_GATE_HTTP_STATUS.COUNTRY_MISSING).toBe(403);
  });

  it('preferred currency and household data are never read by the classifier at all (no such fields exist on the query result)', async () => {
    // If this ever changed to also select currency/household fields, this
    // test's fake client would still work (extra unused fields are fine) —
    // the real guarantee is structural: assertCountryConfirmedForUser's
    // implementation only ever branches on country_of_residence and
    // country_confirmed_at, verified by the AU-preferred-currency case
    // below still landing on the correct state.
    const gate = await assertCountryConfirmedForUser(
      fakeClient({
        country_of_residence: null,
        country_confirmed_at: null,
        country_source: null,
        onboarding_completed: true,
        preferred_currency: 'AUD', // must NOT be treated as evidence of AU
      }),
      'u1'
    );
    expect(gate.state).toBe('COUNTRY_MISSING');
  });
});

describe('countryConfirmationBlockResponse — round-3 closure (Gap 1, API-layer mirror of the DB-trigger fix)', () => {
  const notOnboarded = fakeClient({ country_of_residence: null, country_confirmed_at: null, country_source: null, onboarding_completed: false });

  it('blocks a not-yet-onboarded caller by DEFAULT (no options) — this is the fix: round 2 exempted every one of the ~241 routes using this helper whenever onboarding_completed was false', async () => {
    const res = await countryConfirmationBlockResponse(notOnboarded, 'u1');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
  });

  it('only exempts a not-yet-onboarded caller when { allowDuringOnboarding: true } is explicitly passed — the ONE real caller of this is app/api/household/route.ts', async () => {
    const res = await countryConfirmationBlockResponse(notOnboarded, 'u1', { allowDuringOnboarding: true });
    expect(res).toBeNull();
  });

  it('a fully-onboarded, unconfirmed caller is blocked regardless of the option (the flag only ever matters pre-onboarding)', async () => {
    const onboardedUnconfirmed = fakeClient({ country_of_residence: 'AU', country_confirmed_at: null, country_source: null, onboarding_completed: true });
    const res = await countryConfirmationBlockResponse(onboardedUnconfirmed, 'u1', { allowDuringOnboarding: true });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('a genuinely CONFIRMED caller is never blocked, with or without the option', async () => {
    const confirmed = fakeClient({ country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true });
    expect(await countryConfirmationBlockResponse(confirmed, 'u1')).toBeNull();
    expect(await countryConfirmationBlockResponse(confirmed, 'u1', { allowDuringOnboarding: true })).toBeNull();
  });
});

describe('shouldRedirectToConfirmCountry — MCC-12 fix (found + fixed 2026-08-29 live-DEV certification)', () => {
  // Helper builds a full CountryGateResult without needing a fake Supabase
  // client, since this function only ever branches on the already-resolved
  // gate object app/(app)/layout.tsx receives from assertCountryConfirmedForUser.
  function result(state: CountryGateResult['state'], onboardingCompleted: boolean): CountryGateResult {
    return {
      state,
      countryOfResidence: null,
      countryConfirmedAt: null,
      countrySource: null,
      onboardingCompleted,
      experienceLevel: null,
    };
  }

  it('MCC-12 regression: DB_ERROR redirects (fails CLOSED) even though onboardingCompleted is always false for this state', () => {
    // Before the fix, app/(app)/layout.tsx's inline condition was
    // `gate.state !== 'CONFIRMED' && gate.onboardingCompleted` — since
    // assertCountryConfirmedForUser's DB_ERROR branch always returns
    // onboardingCompleted: false, that condition evaluated to `false` here,
    // so a database read failure fell through to rendering real financial
    // data instead of being blocked. This is the exact live-DEV-observed bug.
    expect(shouldRedirectToConfirmCountry(result('DB_ERROR', false))).toBe(true);
  });

  it('MCC-12 regression: PROFILE_INCOMPLETE redirects (fails CLOSED) for the same reason — it also always carries onboardingCompleted: false', () => {
    expect(shouldRedirectToConfirmCountry(result('PROFILE_INCOMPLETE', false))).toBe(true);
  });

  it('a genuinely mid-onboarding user (any non-CONFIRMED state, onboarding not yet complete) is NOT redirected by this layout — proxy.ts confines them to /onboarding instead, and this must not fight that', () => {
    expect(shouldRedirectToConfirmCountry(result('COUNTRY_MISSING', false))).toBe(false);
    expect(shouldRedirectToConfirmCountry(result('COUNTRY_UNCONFIRMED', false))).toBe(false);
  });

  it('every non-CONFIRMED state redirects once onboarding is complete', () => {
    const onboardedBlockingStates: CountryGateResult['state'][] = [
      'COUNTRY_MISSING',
      'COUNTRY_UNCONFIRMED',
      'COUNTRY_UNSUPPORTED',
      'COUNTRY_INVALID',
      'DB_ERROR',
      'PROFILE_INCOMPLETE',
    ];
    for (const state of onboardedBlockingStates) {
      expect(shouldRedirectToConfirmCountry(result(state, true))).toBe(true);
    }
  });

  it('CONFIRMED never redirects, regardless of the onboarding flag', () => {
    expect(shouldRedirectToConfirmCountry(result('CONFIRMED', true))).toBe(false);
    expect(shouldRedirectToConfirmCountry(result('CONFIRMED', false))).toBe(false);
  });
});
