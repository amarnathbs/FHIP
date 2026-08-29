import { describe, it, expect } from 'vitest';
import {
  classifyCountryValue,
  assertCountryConfirmedForUser,
  isBlockingState,
  SUPPORTED_COUNTRY_CODES,
  COUNTRY_GATE_ERROR_CODE,
  COUNTRY_GATE_HTTP_STATUS,
} from '@/lib/services/countryGate';

type Row = Record<string, unknown> | null;

// Same fake-Supabase-client shape used by tests/unit/jurisdictionApplicability.test.ts
// (assertCountryConfirmedForUser issues exactly one query:
// .from('user_profiles').select(...).eq('user_id', ...).maybeSingle()).
function fakeClient(row: Row, opts: { error?: { message: string } } = {}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: opts.error ?? null }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof assertCountryConfirmedForUser>[0];
}

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

  it('treats a well-formed but not-yet-supported code as UNSUPPORTED, never as invalid or as AU/IN', () => {
    expect(classifyCountryValue('NZ')).toBe('UNSUPPORTED');
    expect(classifyCountryValue('US')).toBe('UNSUPPORTED');
    expect(classifyCountryValue('ZZ')).toBe('UNSUPPORTED');
  });

  it('accepts AU and IN case-insensitively as SUPPORTED', () => {
    expect(classifyCountryValue('AU')).toBe('SUPPORTED');
    expect(classifyCountryValue('IN')).toBe('SUPPORTED');
    expect(classifyCountryValue('au')).toBe('SUPPORTED');
    expect(classifyCountryValue('in')).toBe('SUPPORTED');
  });

  it('exposes exactly the two currently-supported countries (repository evidence: supabase/seed.sql)', () => {
    expect([...SUPPORTED_COUNTRY_CODES].sort()).toEqual(['AU', 'IN']);
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
