// Shared country-registry fixture for Supabase-client fakes.
//
// WHY THIS EXISTS
// ---------------
// lib/services/countryGate.ts's assertCountryConfirmedForUser() is the shared
// pre-check behind requireCountryConfirmedUser(), which ~241 route handlers
// use. Every time that gate learns to read something new, every hand-rolled
// Supabase fake in the test suite that models one of those routes has to
// learn about it too — or the gate fails closed and the route returns 403
// for a reason that has nothing to do with what the test is asserting.
//
// This has now happened twice:
//   * MCC (2026-08-29/31) added the `user_profiles` read. Three fixtures were
//     patched individually, each with its own copy of a "confirmed profile"
//     row (see commit 150d7ba and the header comments in
//     iiR12PositionsProductionCompat.test.ts and
//     adminAnalyticsPhaseARouteMatrix.test.ts).
//   * G3 (2026-09-03) added the `countries` + `country_capabilities` reads,
//     because the specification requires the experience level to be DERIVED
//     FROM THE REGISTRY rather than inferred from the country code.
//
// Rather than patch each fixture a second time, the registry half is shared
// here once. A future phase that teaches the gate to read something else
// changes this file, not every fixture again.
//
// These rows are the real post-0122/0127 registry contents, so a fake using
// them exercises the same decisions production makes.

export const COUNTRY_REGISTRY_ROWS = [
  { country_code: 'AU', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'IN', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'GB', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'US', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'SG', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'AE', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
] as const;

export const COUNTRY_REGISTRATION_CAPABILITY_ROWS = COUNTRY_REGISTRY_ROWS.map((c) => ({
  country_code: c.country_code,
  capability: 'REGISTRATION',
  enabled: true,
}));

/**
 * Returns the fake `.from(table)` handler for the two registry tables, or
 * `null` if `table` is not one of them — so a caller can delegate:
 *
 *   mockFrom.mockImplementation((table) =>
 *     countryRegistryFrom(table) ?? myOwnHandler(table)
 *   );
 *
 * Deliberately returns `null` rather than throwing for an unknown table: the
 * point is to be a transparent pass-through that existing fixtures can wrap
 * without restructuring, and without their own table assertions ever seeing
 * these two names.
 */
export function countryRegistryFrom(table: string): unknown | null {
  if (table === 'countries') {
    return { select: async () => ({ data: COUNTRY_REGISTRY_ROWS, error: null }) };
  }
  if (table === 'country_capabilities') {
    return { select: () => ({ eq: async () => ({ data: COUNTRY_REGISTRATION_CAPABILITY_ROWS, error: null }) }) };
  }
  return null;
}
