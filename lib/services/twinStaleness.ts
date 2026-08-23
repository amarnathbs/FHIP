// AR-0 §3.4 / Chunk 2 item 2: Financial Twin staleness fix.
//
// Root cause (confirmed via live repro): app/api/financial-twin/current
// always serves the most recently *generated* stored run
// (financial_twin_runs, ordered created_at desc) — nothing ever invalidated
// that stored run when the profile fields its cohort match was computed
// from later changed (e.g. a corrected date_of_birth). The age-band
// bucketing and cohort-matching filters themselves are correct; this module
// closes the missing invalidation step.
//
// Design choice — invalidate, don't eagerly regenerate: generateFinancialTwin()
// (lib/services/financialTwinService.ts) computes 67 metrics across several
// other engines and is documented in that file as already slow enough to
// have previously timed out its own dedicated request. Running it
// synchronously inside a profile/household save would add that latency (and
// failure risk) to every onboarding/profile save — including brand-new
// users who haven't generated a first Twin yet. Deleting the stale run(s)
// instead makes GET /api/financial-twin/current naturally fall back to its
// existing "no twin generated yet" empty state, which already prompts the
// user to (re)generate — the wrong cohort is never shown again, without
// adding computation cost to the save path itself.
import type { SupabaseServerClient } from './dashboardData';
import {
  ageFromDateOfBirth,
  ageToAgeBand,
  normalizeEmploymentType,
  normalizeHouseholdType,
  deriveLifeStage,
  type AgeBand,
  type EmploymentType,
  type HouseholdTypeCode,
  type LifeStage,
} from '@/lib/engines/twin/taxonomy';

// The profile/household fields matchCohort() (twinCohortMatching.ts) keys
// on, EXCLUDING income_band. income_band is derived from continuously
// changing financial data (income_sources, via the Dashboard engine), not a
// discrete profile field saved through a deliberate "Save" action — wiring
// invalidation into every income/expense edit would be both a much larger
// blast-radius change (the shared grid registry used by all 7 financial
// modules) and overly aggressive (a Twin nuked on every small income tweak).
// This is a deliberate, disclosed scope decision: the bug this fixes is
// "your age/country/household changed and the Twin didn't notice", not
// "your income changed by $10 and the Twin didn't notice".
export interface CohortKeyInputs {
  countryOfResidence: string | null;
  ageBand: AgeBand | null;
  employmentType: EmploymentType;
  dependantsCount: number;
  householdTypeCode: HouseholdTypeCode;
  housingTenure: string | null;
  residenceType: string | null;
  lifeStage: LifeStage;
}

export function deriveCohortKey(params: {
  countryOfResidence: string | null;
  dateOfBirth: string | null;
  employmentStatus: string | null;
  dependantsCount: number;
  householdType: string | null;
  housingTenure: string | null;
  residenceType: string | null;
}): CohortKeyInputs {
  const age = params.dateOfBirth ? ageFromDateOfBirth(params.dateOfBirth) : null;
  const ageBand = age !== null ? ageToAgeBand(age) : null;
  const employmentType = normalizeEmploymentType(params.employmentStatus);
  const householdTypeCode = normalizeHouseholdType(params.householdType, params.dependantsCount);
  const lifeStage = deriveLifeStage({ ageBand, dependantsCount: params.dependantsCount, employmentType });
  return {
    countryOfResidence: params.countryOfResidence,
    ageBand,
    employmentType,
    dependantsCount: params.dependantsCount,
    householdTypeCode,
    housingTenure: params.housingTenure,
    residenceType: params.residenceType,
    lifeStage,
  };
}

export function cohortKeyChanged(before: CohortKeyInputs, after: CohortKeyInputs): boolean {
  return (
    before.countryOfResidence !== after.countryOfResidence ||
    before.ageBand !== after.ageBand ||
    before.employmentType !== after.employmentType ||
    before.dependantsCount !== after.dependantsCount ||
    before.householdTypeCode !== after.householdTypeCode ||
    before.housingTenure !== after.housingTenure ||
    before.residenceType !== after.residenceType ||
    before.lifeStage !== after.lifeStage
  );
}

// Deletes every stored Financial Twin run for this user. Cascades to
// financial_twin_metric_results / financial_twin_insights per migration
// 0011's `on delete cascade` FKs — no orphaned rows left behind. Needs no
// schema change (unlike Task 1's currency_override column), so this works
// against DEV immediately without any migration being applied.
export async function invalidateStaleTwinRuns(userId: string, supabase: SupabaseServerClient): Promise<void> {
  await supabase.from('financial_twin_runs').delete().eq('user_id', userId);
}
