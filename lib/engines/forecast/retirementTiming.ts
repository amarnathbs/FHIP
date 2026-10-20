/**
 * Retirement Forecast timing: ONE pure resolver, used by the forecast run AND by the Retirement Forecast page.
 *
 * Document2 (4) F26 (PO, 20-10-2026): "I already entered the retirement age in the Retirement tab but the Retirement
 * Forecast shows blank and asks me to enter again. It should take the value from there."
 *
 * The saved target age lives in retirement_members.target_retirement_age (one per person: Self, Spouse), set once on the
 * Retirement page. The forecast engine already read it for Self, but the Forecast page never SHOWED it and its timing card
 * presented two blank inputs ("Retirement date", "Months until retirement (no date of birth on file)") even when a date of
 * birth and a saved age existed, so it read as a second request for the same fact. This module is the single place that says,
 * for each person, which age is in use and where it came from, so the page can state it and the run can use it.
 *
 * Precedence for a person's target age (highest first):
 *   1. what-if age, supplied for THIS run only (never saved anywhere);
 *   2. the saved target age (retirement_members);
 *   3. Self only: the legacy forecast_profiles.retirement_age, then the country default assumption.
 * Spouse never gets a made-up age: with nothing saved the Spouse has no age and is not projected separately.
 *
 * The exact retirement date (forecast_profiles.retirement_date) and the manual months fallback keep the precedence the
 * forecast has always had (FHIP-FC-RET-001): an exact date wins over the age; the manual months are used only when there is
 * no usable date of birth.
 */
import { isPlausibleDob } from '../age';

export type RetirementMemberType = 'self' | 'spouse';

export type RetirementAgeSource =
  /** A what-if age typed for this run only. Not saved. */
  | 'what_if'
  /** The target age saved on the Retirement page (retirement_members). */
  | 'saved'
  /** Self only: the older Forecast-settings value kept for continuity. */
  | 'legacy_profile'
  /** Self only: the approved country default (AU 67, IN 60). */
  | 'country_default'
  /** Nothing saved and no default applies (Spouse). */
  | 'missing';

export type RetirementTimingSource = 'exact_date' | 'age' | 'manual_months' | 'unknown';

export interface RetirementTimingMemberInput {
  memberType: RetirementMemberType;
  /** retirement_members.target_retirement_age for this person; null when none is saved. */
  savedTargetAge: number | null;
  /** Date of birth as stored (yyyy-mm-dd); null/undefined when none is on file. */
  dateOfBirth: string | null | undefined;
  /** A what-if age for this run only. */
  whatIfAge?: number | null;
}

export interface RetirementTimingInput {
  /** yyyy-mm-dd the forecast starts from. */
  baselineDate: string;
  self: RetirementTimingMemberInput;
  /** Absent when the household has no Spouse/Partner retirement member. */
  spouse?: RetirementTimingMemberInput | null;
  /** forecast_profiles.retirement_age (legacy), Self only. */
  legacyProfileAge?: number | null;
  /** The approved country default retirement age (assumption). */
  countryDefaultAge: number;
  /** forecast_profiles.retirement_date (yyyy-mm-dd) or null. */
  exactRetirementDate?: string | null;
  /** forecast_profiles.retirement_timing_override_months or null. */
  manualMonths?: number | null;
}

export interface RetirementMemberTiming {
  memberType: RetirementMemberType;
  label: 'Self' | 'Spouse/Partner';
  /** The age the run uses for this person; null for a Spouse with none. */
  retirementAge: number | null;
  ageSource: RetirementAgeSource;
  /** The saved age, whatever the run uses (so the page can show "saved 67, this run 60"). */
  savedTargetAge: number | null;
  /** Whole-and-fractional years at the baseline; null when no plausible date of birth is on file. */
  currentAge: number | null;
  hasPlausibleDateOfBirth: boolean;
  /** Months from the baseline to this person's target age; null when the age or the date of birth is missing. */
  monthsToTargetAge: number | null;
}

export interface RetirementTiming {
  self: RetirementMemberTiming;
  spouse: RetirementMemberTiming | null;
  /** Months until retirement the run uses for the household projection (Self's timing); null = cannot be projected. */
  monthsUntilRetirement: number | null;
  /** The override handed to the calculator: set only for an exact date or the manual-months fallback. */
  monthsUntilRetirementOverride: number | null;
  timingSource: RetirementTimingSource;
}

/** Fractional age at the baseline, exactly as the forecast has always computed it (year difference + month difference / 12). */
export function ageAtBaseline(dateOfBirth: string | null | undefined, baselineDate: string): number | null {
  if (!dateOfBirth) return null;
  const asOf = new Date(`${baselineDate}T00:00:00Z`);
  if (!isPlausibleDob(dateOfBirth, asOf)) return null;
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return null;
  return asOf.getUTCFullYear() - dob.getUTCFullYear() + (asOf.getUTCMonth() - dob.getUTCMonth()) / 12;
}

function validAge(age: number | null | undefined): age is number {
  return typeof age === 'number' && Number.isFinite(age) && age >= 1 && age <= 119;
}

function resolveMember(
  member: RetirementTimingMemberInput,
  baselineDate: string,
  fallbacks: { legacyProfileAge?: number | null; countryDefaultAge: number } | null,
): RetirementMemberTiming {
  let retirementAge: number | null = null;
  let ageSource: RetirementAgeSource = 'missing';
  if (validAge(member.whatIfAge)) {
    retirementAge = member.whatIfAge;
    ageSource = 'what_if';
  } else if (validAge(member.savedTargetAge)) {
    retirementAge = member.savedTargetAge;
    ageSource = 'saved';
  } else if (fallbacks) {
    if (validAge(fallbacks.legacyProfileAge)) {
      retirementAge = fallbacks.legacyProfileAge;
      ageSource = 'legacy_profile';
    } else {
      retirementAge = fallbacks.countryDefaultAge;
      ageSource = 'country_default';
    }
  }
  const currentAge = ageAtBaseline(member.dateOfBirth, baselineDate);
  return {
    memberType: member.memberType,
    label: member.memberType === 'self' ? 'Self' : 'Spouse/Partner',
    retirementAge,
    ageSource,
    savedTargetAge: validAge(member.savedTargetAge) ? member.savedTargetAge : null,
    currentAge,
    hasPlausibleDateOfBirth: currentAge !== null,
    monthsToTargetAge: retirementAge !== null && currentAge !== null ? Math.max(0, Math.round((retirementAge - currentAge) * 12)) : null,
  };
}

function monthsBetween(baselineDate: string, targetDate: string): number {
  const base = new Date(`${baselineDate}T00:00:00Z`);
  const target = new Date(`${targetDate}T00:00:00Z`);
  return Math.max(0, (target.getUTCFullYear() - base.getUTCFullYear()) * 12 + (target.getUTCMonth() - base.getUTCMonth()));
}

export function resolveRetirementTiming(input: RetirementTimingInput): RetirementTiming {
  const self = resolveMember(input.self, input.baselineDate, { legacyProfileAge: input.legacyProfileAge, countryDefaultAge: input.countryDefaultAge });
  const spouse = input.spouse ? resolveMember(input.spouse, input.baselineDate, null) : null;

  let monthsUntilRetirementOverride: number | null = null;
  let timingSource: RetirementTimingSource = 'unknown';
  if (input.exactRetirementDate) {
    monthsUntilRetirementOverride = monthsBetween(input.baselineDate, input.exactRetirementDate);
    timingSource = 'exact_date';
  } else if (self.currentAge === null && input.manualMonths != null) {
    monthsUntilRetirementOverride = Math.max(0, input.manualMonths);
    timingSource = 'manual_months';
  } else if (self.monthsToTargetAge !== null) {
    timingSource = 'age';
  }
  const monthsUntilRetirement = monthsUntilRetirementOverride ?? self.monthsToTargetAge;
  return { self, spouse, monthsUntilRetirement, monthsUntilRetirementOverride, timingSource };
}

/** Plain-words line for one person for the Forecast page. Never an internal key. */
export function describeMemberTiming(m: RetirementMemberTiming): string {
  const age = m.retirementAge;
  const who = m.label;
  if (age === null) {
    return `${who}: no target retirement age is saved yet. Set it on the Retirement page.`;
  }
  const where =
    m.ageSource === 'saved' ? 'saved on the Retirement page'
    : m.ageSource === 'what_if' ? 'a what-if age for this run only, not saved'
    : m.ageSource === 'legacy_profile' ? 'from your older Forecast setting; save a target age on the Retirement page to replace it'
    : m.ageSource === 'country_default' ? 'the standard age for your country, because no target age is saved yet; set yours on the Retirement page'
    : 'not set';
  const when = m.monthsToTargetAge === null
    ? ' No date of birth is on file, so the time left cannot be worked out.'
    : m.monthsToTargetAge === 0
      ? ' That age has been reached.'
      : ` About ${Math.round((m.monthsToTargetAge / 12) * 10) / 10} years to go.`;
  return `${who}: target retirement age ${age} (${where}).${when}`;
}
