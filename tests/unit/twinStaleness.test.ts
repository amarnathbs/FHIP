import { describe, it, expect, vi } from 'vitest';
import { ageFromDateOfBirth, ageToAgeBand } from '@/lib/engines/twin/taxonomy';
import { deriveCohortKey, cohortKeyChanged, invalidateStaleTwinRuns } from '@/lib/services/twinStaleness';

// AR-0 §3.4 / Chunk 2 item 2: Financial Twin staleness fix, exercised
// against Spec 1's Twin-01/02/03 cases. Live-repro'd first (see completion
// report): generating a Twin at age 52 (correctly bucketed 45-54), then
// changing date_of_birth to imply age 32 and reloading WITHOUT clicking
// Regenerate showed the stale "age 45-54" cohort — confirming the root
// cause is a missing invalidation step, not a calculation bug (age math and
// cohort-matching filters were already correct).

const FIXED_NOW = new Date('2026-08-21');

describe('Twin-01: age 52 must never bucket as 25-34', () => {
  it('a 52-year-old (DOB 1974-03-15 as of 2026-08-21) maps to AGE_45_54, never AGE_25_34', () => {
    const age = ageFromDateOfBirth('1974-03-15', FIXED_NOW);
    expect(age).toBe(52);
    expect(ageToAgeBand(age)).toBe('AGE_45_54');
    expect(ageToAgeBand(age)).not.toBe('AGE_25_34');
  });

  it('deriveCohortKey produces AGE_45_54 for the same household, not a fallback young-professional band', () => {
    const key = deriveCohortKey({
      countryOfResidence: 'AU',
      dateOfBirth: '1974-03-15',
      employmentStatus: 'full_time_employed',
      dependantsCount: 0,
      householdType: 'single',
      housingTenure: 'mortgage_owner',
      residenceType: 'metro',
    });
    expect(key.ageBand).toBe('AGE_45_54');
  });
});

describe('Twin-02: DOB change across an age-band boundary is detected as a cohort-key change', () => {
  it('flags a change when DOB moves from implying age 52 (45-54) to age 32 (25-34)', () => {
    const common = {
      countryOfResidence: 'AU',
      employmentStatus: 'full_time_employed',
      dependantsCount: 0,
      householdType: 'single',
      housingTenure: 'mortgage_owner',
      residenceType: 'metro',
    };
    const before = deriveCohortKey({ ...common, dateOfBirth: '1974-03-15' }); // age 52
    const after = deriveCohortKey({ ...common, dateOfBirth: '1994-06-01' }); // age 32
    expect(before.ageBand).toBe('AGE_45_54');
    expect(after.ageBand).toBe('AGE_25_34');
    expect(cohortKeyChanged(before, after)).toBe(true);
  });

  it('a DOB change within the same age band does not spuriously flag a cohort-key change', () => {
    const common = {
      countryOfResidence: 'AU',
      employmentStatus: 'full_time_employed',
      dependantsCount: 0,
      householdType: 'single',
      housingTenure: 'mortgage_owner',
      residenceType: 'metro',
    };
    const before = deriveCohortKey({ ...common, dateOfBirth: '1974-03-15' }); // age 52
    const after = deriveCohortKey({ ...common, dateOfBirth: '1975-01-10' }); // age 51, still 45-54
    expect(before.ageBand).toBe(after.ageBand);
    expect(cohortKeyChanged(before, after)).toBe(false);
  });

  it('invalidateStaleTwinRuns deletes every stored run for that user (cascades to metric_results/insights per migration 0011)', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqMock });
    const fromMock = vi.fn().mockReturnValue({ delete: deleteMock });
    const fakeSupabase = { from: fromMock } as unknown as Parameters<typeof invalidateStaleTwinRuns>[1];

    await invalidateStaleTwinRuns('user-123', fakeSupabase);

    expect(fromMock).toHaveBeenCalledWith('financial_twin_runs');
    expect(deleteMock).toHaveBeenCalled();
    expect(eqMock).toHaveBeenCalledWith('user_id', 'user-123');
  });
});

describe('Twin-03: a valid, unchanged DOB never gets an incorrectly-substituted fallback cohort', () => {
  it('re-saving the same profile fields (no actual change) never flags a cohort-key change', () => {
    const params = {
      countryOfResidence: 'IN' as const,
      dateOfBirth: '1988-11-20',
      employmentStatus: 'self_employed',
      dependantsCount: 2,
      householdType: 'couple_with_dependants',
      housingTenure: 'outright_owner' as const,
      residenceType: 'regional' as const,
    };
    const before = deriveCohortKey(params);
    const after = deriveCohortKey({ ...params });
    expect(cohortKeyChanged(before, after)).toBe(false);
    expect(after.ageBand).not.toBeNull();
  });

  it('a present, valid DOB never falls back to a null/substituted age band', () => {
    const key = deriveCohortKey({
      countryOfResidence: 'AU',
      dateOfBirth: '2000-01-01',
      employmentStatus: 'full_time_employed',
      dependantsCount: 0,
      householdType: 'single',
      housingTenure: null,
      residenceType: null,
    });
    expect(key.ageBand).not.toBeNull();
  });

  it('a genuinely missing DOB stays null (no fallback age substituted) and is distinguished from a present one', () => {
    const withDob = deriveCohortKey({
      countryOfResidence: 'AU',
      dateOfBirth: '1990-01-01',
      employmentStatus: 'full_time_employed',
      dependantsCount: 0,
      householdType: 'single',
      housingTenure: null,
      residenceType: null,
    });
    const withoutDob = deriveCohortKey({
      countryOfResidence: 'AU',
      dateOfBirth: null,
      employmentStatus: 'full_time_employed',
      dependantsCount: 0,
      householdType: 'single',
      housingTenure: null,
      residenceType: null,
    });
    expect(withDob.ageBand).not.toBeNull();
    expect(withoutDob.ageBand).toBeNull();
    // Going from "no DOB" to "a real DOB" (or vice versa) is itself a
    // cohort-relevant change that must trigger invalidation.
    expect(cohortKeyChanged(withDob, withoutDob)).toBe(true);
  });
});

describe('other cohort-relevant household fields also trigger invalidation (not just DOB)', () => {
  it('a household_type/dependants change that shifts life_stage or household_type_code is flagged', () => {
    const common = {
      countryOfResidence: 'AU',
      dateOfBirth: '1990-01-01',
      employmentStatus: 'full_time_employed',
      housingTenure: 'renter' as const,
      residenceType: 'metro' as const,
    };
    const before = deriveCohortKey({ ...common, dependantsCount: 0, householdType: 'single' });
    const after = deriveCohortKey({ ...common, dependantsCount: 2, householdType: 'couple_with_dependants' });
    expect(cohortKeyChanged(before, after)).toBe(true);
  });

  it('a country_of_residence change is flagged', () => {
    const common = {
      dateOfBirth: '1990-01-01',
      employmentStatus: 'full_time_employed',
      dependantsCount: 0,
      householdType: 'single',
      housingTenure: 'renter' as const,
      residenceType: 'metro' as const,
    };
    const before = deriveCohortKey({ ...common, countryOfResidence: 'AU' });
    const after = deriveCohortKey({ ...common, countryOfResidence: 'IN' });
    expect(cohortKeyChanged(before, after)).toBe(true);
  });
});
