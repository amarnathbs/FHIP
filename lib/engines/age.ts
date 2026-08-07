// Shared date-of-birth math, consolidated from 3 previously-identical
// duplicate implementations (lib/services/healthScoreData.ts,
// lib/services/financialDnaData.ts, lib/engines/twin/taxonomy.ts) — none of
// which enforced any plausibility bound, so an implausible DOB (e.g. implying
// a 1-2 year old, or a 90-100+ year old) would silently flow through the
// Health Score, Financial DNA, Financial Twin and Retirement Forecast
// calculators unchecked (Forecasting P1 fix FHIP-FC-RET-001).
// Bounds for the PRIMARY account holder / any adult (e.g. retirement-timing
// math) — a real person old enough to have their own financial profile.
export const MIN_PLAUSIBLE_AGE = 16;
export const MAX_PLAUSIBLE_AGE = 100;

// Household members/dependants may legitimately be infants — only reject
// genuine data-entry errors (negative age, three-digit ages from a
// wrong-century typo), not young age itself.
export const MIN_PLAUSIBLE_DEPENDANT_AGE = 0;
export const MAX_PLAUSIBLE_DEPENDANT_AGE = 100;

export function ageFromDob(dob: string | null, asOf: Date = new Date()): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  let age = asOf.getFullYear() - birth.getFullYear();
  const monthDiff = asOf.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < birth.getDate())) age--;
  return age;
}

// A DOB is "implausible" when it isn't a real date, or implies an age
// outside [minAge, maxAge] — defaults reject obvious data-entry errors for
// an adult (a toddler, a 110-year-old) without rejecting genuinely elderly
// users; pass MIN/MAX_PLAUSIBLE_DEPENDANT_AGE for household members, who can
// legitimately be very young. Returns true for a null/missing DOB (nothing
// to reject) — callers that require a DOB check for null separately.
export function isPlausibleDob(
  dob: string | null,
  asOf: Date = new Date(),
  minAge: number = MIN_PLAUSIBLE_AGE,
  maxAge: number = MAX_PLAUSIBLE_AGE
): boolean {
  if (!dob) return true;
  if (Number.isNaN(new Date(dob).getTime())) return false;
  const age = ageFromDob(dob, asOf);
  return age !== null && age >= minAge && age <= maxAge;
}
