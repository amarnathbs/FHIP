import type { SupabaseServerClient } from './dashboardData';
import { ageFromDateOfBirth, normalizeHouseholdType } from '@/lib/engines/twin/taxonomy';
import type { MemberType } from '@/lib/validation/retirementMember';
import { isKnownCountry, toFullExperienceCountryOrNull, type CountryCode } from '@/lib/services/jurisdiction';

export interface RetirementMemberRow {
  id: string;
  member_type: MemberType;
  target_retirement_age: number | null;
  country_code: string | null;
  age_source: 'user_confirmed' | 'suggested_default' | 'needs_confirmation';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RetirementPlanningContext {
  self: RetirementMemberRow | null;
  spouse: RetirementMemberRow | null;
  // Spouse/partner card should only be shown when the household's own
  // canonical composition model says so (spec s.9) -- reuses the same
  // normalizeHouseholdType classifier the Financial Twin already uses for
  // cohort matching, rather than inventing a second spouse-detection rule.
  spouseApplicable: boolean;
  selfCurrentAge: number | null;
  countryCode: 'AU' | 'IN';
  countryDefaultRetirementAge: number;
}

// Approved FHIP defaults (migration 0014, forecast_global_assumptions,
// assumption_key='retirement_age') -- AU 67 / IN 60. Used only as the
// absolute last-resort literal if the seeded row is ever missing, matching
// the same literal fallback already hardcoded in
// lib/engines/twin/metricDerivation.ts and lib/services/forecastData.ts, so
// all three call sites agree even in that edge case.
const LITERAL_FALLBACK_RETIREMENT_AGE: Record<'AU' | 'IN', number> = { AU: 67, IN: 60 };

async function getCountryDefaultRetirementAge(supabase: SupabaseServerClient, countryCode: 'AU' | 'IN'): Promise<number> {
  const { data } = await supabase
    .from('forecast_global_assumptions')
    .select('assumption_value')
    .eq('country_code', countryCode)
    .eq('assumption_key', 'retirement_age')
    .maybeSingle();
  return data?.assumption_value ?? LITERAL_FALLBACK_RETIREMENT_AGE[countryCode];
}

export async function loadRetirementPlanningContext(userId: string, supabase: SupabaseServerClient): Promise<RetirementPlanningContext> {
  const [profileRes, householdRes, membersRes] = await Promise.all([
    supabase.from('user_profiles').select('date_of_birth, country_of_residence').eq('user_id', userId).single(),
    supabase.from('households').select('household_type, dependants_count').eq('user_id', userId).maybeSingle(),
    supabase
      .from('retirement_members')
      .select('id, member_type, target_retirement_age, country_code, age_source, is_active, created_at, updated_at')
      .eq('user_id', userId)
      .eq('is_active', true),
  ]);

  const profile = profileRes.data;
  const household = householdRes.data;
  const members = (membersRes.data ?? []) as RetirementMemberRow[];

  // G5-D1 fix: this used to be `country_of_residence === 'IN' ? 'IN' : 'AU'`,
  // which silently converted GB/US/SG/AE, a missing profile or any invalid
  // value into Australia. Reuses the canonical G1 narrowing
  // (toFullExperienceCountryOrNull, lib/services/jurisdiction.ts) — the same
  // function every other domestic-only call site now uses — instead of a
  // second, locally invented "not IN means AU" fallback. A GENERIC-experience
  // country (or an unresolved one) narrows to `null`, which fails closed
  // below rather than being treated as AU. In practice this route
  // (app/api/retirement/members/route.ts) already refuses GENERIC callers via
  // requireCountryConfirmedUser() before this function ever runs; this is
  // defence-in-depth for any future caller that forgets that gate.
  const residenceCountry: CountryCode | null = isKnownCountry(profile?.country_of_residence)
    ? profile.country_of_residence
    : null;
  const countryCode = toFullExperienceCountryOrNull(residenceCountry);
  if (!countryCode) {
    // Missing/unsupported/GENERIC country -> fail closed. Never fabricate an
    // AU or IN retirement context, and never return a zeroed-out one either
    // (dispatch: "do not return zero where the result is unavailable").
    throw new Error('Retirement planning is not available for your confirmed country yet.');
  }
  const selfCurrentAge = profile?.date_of_birth ? ageFromDateOfBirth(profile.date_of_birth) : null;

  const householdTypeCode = normalizeHouseholdType(household?.household_type ?? null, household?.dependants_count ?? 0);
  const spouseApplicable = householdTypeCode === 'couple_no_kids' || householdTypeCode === 'couple_with_kids';

  const self = members.find((m) => m.member_type === 'self') ?? null;
  const spouse = members.find((m) => m.member_type === 'spouse') ?? null;

  const countryDefaultRetirementAge = await getCountryDefaultRetirementAge(supabase, countryCode);

  return { self, spouse, spouseApplicable, selfCurrentAge, countryCode, countryDefaultRetirementAge };
}
