/**
 * G5-D1 certification: lib/services/retirementMemberData.ts's
 * loadRetirementPlanningContext() used to resolve countryCode via
 * `country_of_residence === 'IN' ? 'IN' : 'AU'` -- a "not IN becomes AU"
 * fallback that silently misclassified GB/US/SG/AE, a missing profile, or
 * any invalid/forged value as Australia. The fix (commit 2bff056) reuses
 * the canonical G1 narrowing (isKnownCountry / toFullExperienceCountryOrNull,
 * lib/services/jurisdiction.ts) and fails closed (throws) for anything that
 * doesn't narrow to AU/IN.
 *
 * This test exercises loadRetirementPlanningContext() directly against a
 * fake Supabase client so the negative controls (GENERIC countries, a
 * missing profile, a forged/unsupported value) are proven at the unit level
 * -- not merely inferred from the route-level requireCountryConfirmedUser()
 * gate that happens to run first in production. Defence-in-depth is only
 * real defence if it is independently tested.
 */
import { describe, it, expect } from 'vitest';
import { loadRetirementPlanningContext } from '@/lib/services/retirementMemberData';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';

type Row = Record<string, unknown> | null;

function fakeClient(opts: {
  profile: Row;
  household?: Row;
  members?: Row[];
  countryDefaultAge?: Row;
}): SupabaseServerClient {
  const { profile, household = null, members = [], countryDefaultAge = null } = opts;
  return {
    from: (table: string) => {
      if (table === 'user_profiles') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: profile, error: null }) }) }) };
      }
      if (table === 'households') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: household, error: null }) }) }) };
      }
      if (table === 'retirement_members') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: members, error: null }),
            }),
          }),
        };
      }
      if (table === 'forecast_global_assumptions') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: countryDefaultAge, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in test fake: ${table}`);
    },
  } as unknown as SupabaseServerClient;
}

describe('loadRetirementPlanningContext — G5-D1 country narrowing (never fabricates AU/IN)', () => {
  it('resolves a confirmed AU profile to countryCode AU (unchanged AU behaviour)', async () => {
    const client = fakeClient({ profile: { date_of_birth: '1980-01-01', country_of_residence: 'AU' } });
    const ctx = await loadRetirementPlanningContext('user-1', client);
    expect(ctx.countryCode).toBe('AU');
  });

  it('resolves a confirmed IN profile to countryCode IN (unchanged IN behaviour)', async () => {
    const client = fakeClient({ profile: { date_of_birth: '1980-01-01', country_of_residence: 'IN' } });
    const ctx = await loadRetirementPlanningContext('user-1', client);
    expect(ctx.countryCode).toBe('IN');
  });

  it.each(['GB', 'US', 'SG', 'AE'])(
    'fails closed (throws) for GENERIC country %s -- never silently becomes AU',
    async (generic) => {
      const client = fakeClient({ profile: { date_of_birth: '1980-01-01', country_of_residence: generic } });
      await expect(loadRetirementPlanningContext('user-1', client)).rejects.toThrow(
        /not available for your confirmed country/i
      );
    }
  );

  it('fails closed (throws) when country_of_residence is null -- never becomes AU', async () => {
    const client = fakeClient({ profile: { date_of_birth: '1980-01-01', country_of_residence: null } });
    await expect(loadRetirementPlanningContext('user-1', client)).rejects.toThrow();
  });

  it('fails closed (throws) when the profile row is missing entirely -- never becomes AU', async () => {
    const client = fakeClient({ profile: null });
    await expect(loadRetirementPlanningContext('user-1', client)).rejects.toThrow();
  });

  it('fails closed (throws) for a forged/unsupported country code -- never becomes AU', async () => {
    const client = fakeClient({ profile: { date_of_birth: '1980-01-01', country_of_residence: 'ZZ' } });
    await expect(loadRetirementPlanningContext('user-1', client)).rejects.toThrow();
  });

  it('AU default retirement age falls back to the literal 67 when the seeded assumption row is missing', async () => {
    const client = fakeClient({ profile: { date_of_birth: '1980-01-01', country_of_residence: 'AU' }, countryDefaultAge: null });
    const ctx = await loadRetirementPlanningContext('user-1', client);
    expect(ctx.countryDefaultRetirementAge).toBe(67);
  });

  it('IN default retirement age falls back to the literal 60 when the seeded assumption row is missing', async () => {
    const client = fakeClient({ profile: { date_of_birth: '1980-01-01', country_of_residence: 'IN' }, countryDefaultAge: null });
    const ctx = await loadRetirementPlanningContext('user-1', client);
    expect(ctx.countryDefaultRetirementAge).toBe(60);
  });

  it('uses the seeded assumption value over the literal fallback when present', async () => {
    const client = fakeClient({
      profile: { date_of_birth: '1980-01-01', country_of_residence: 'AU' },
      countryDefaultAge: { assumption_value: 70 },
    });
    const ctx = await loadRetirementPlanningContext('user-1', client);
    expect(ctx.countryDefaultRetirementAge).toBe(70);
  });
});
