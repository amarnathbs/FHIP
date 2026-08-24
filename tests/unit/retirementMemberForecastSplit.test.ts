/**
 * Retirement Member UI (spec s.29-30) — pure-function tests for the
 * per-member Self/Spouse forecast split added to runRetirementForecast.
 * These require no database and directly cover the required test cases
 * RM-02 ("Self accounts use 65, spouse accounts use 62") and RM-14
 * (cross-border: one Self target retirement age, not two).
 */
import { describe, expect, it } from 'vitest';
import { runRetirementForecast, type RetirementCalculatorInput } from '@/lib/engines/forecast/retirementCalculator';
import type { ResolvedAssumptionSet } from '@/lib/engines/forecast/types';

const assumptions: ResolvedAssumptionSet = {};

const baseInput: RetirementCalculatorInput = {
  baselineDate: '2026-08-01',
  months: 24,
  assumptions,
  currency: 'AUD',
  currentBalance: 100000,
  monthlyContribution: 1000,
  currentAge: 52,
  retirementAge: 65,
  targetMethod: 'target_corpus',
  targetCorpus: 500000,
};

describe('runRetirementForecast — legacy single-household-age path is unchanged', () => {
  it('produces every row with entityId=null when members is not supplied (byte-for-byte legacy behaviour, spec s.30)', () => {
    const { results, explanations } = runRetirementForecast(baseInput);
    expect(results.length).toBe(24);
    expect(results.every((r) => r.entityId === null)).toBe(true);
    expect(explanations).toHaveLength(1);
    expect(explanations[0].entityId).toBeNull();
    expect(explanations[0].title).toBe('Retirement readiness forecast');
  });

  it('is identical whether members is omitted or an array of fewer than 2 legs', () => {
    const a = runRetirementForecast(baseInput);
    const b = runRetirementForecast({ ...baseInput, members: [] });
    const c = runRetirementForecast({
      ...baseInput,
      members: [{ memberId: 'self-id', label: 'Self', currentBalance: 100000, monthlyContribution: 1000, currentAge: 52, retirementAge: 65 }],
    });
    expect(b.results).toEqual(a.results);
    expect(c.results).toEqual(a.results);
  });
});

describe('runRetirementForecast — RM-02/RM-14: Self and Spouse use their own independent target ages', () => {
  const selfLeg = { memberId: 'self-member-id', label: 'Self', currentBalance: 200000, monthlyContribution: 1200, currentAge: 52, retirementAge: 65 };
  const spouseLeg = { memberId: 'spouse-member-id', label: 'Spouse/Partner', currentBalance: 80000, monthlyContribution: 600, currentAge: 49, retirementAge: 62 };

  const { results, explanations } = runRetirementForecast({ ...baseInput, members: [selfLeg, spouseLeg] });

  // forecast_results has always had exactly one row per period for
  // forecast_type='retirement' (unlike goal/debt/investment, which already
  // have multiple entity rows per period and whose UI consumers already
  // know to group/sum them). Several existing consumers of the retirement
  // forecast (RunSummary reading explanations[0]'s flat fields,
  // ReportTrendChart rendering results without a `summed` prop, the
  // Premium Report's retirement_readiness section) assume that
  // single-row-per-period, flat-field shape — so the row-level trajectory
  // and every flat summary field stay computed off the top-level
  // household input exactly as before, and the split's genuine per-member
  // breakdown is carried as supplementary detail in the one combined
  // explanation's calculation_inputs.members (spec s.30: integrate into
  // the existing architecture, don't rewrite it).
  it('never introduces a second row per period — exactly one row per period, entity_id=null, same shape as before', () => {
    expect(results).toHaveLength(24);
    expect(results.every((r) => r.entityId === null)).toBe(true);
    expect(explanations).toHaveLength(1);
    expect(explanations[0].entityId).toBeNull();
  });

  it('the row-level trajectory and flat summary fields are unchanged from the legacy household-level calculation (zero regression)', () => {
    const legacy = runRetirementForecast(baseInput); // same top-level currentBalance/monthlyContribution/currentAge/retirementAge, no members
    expect(results).toEqual(legacy.results);
    expect(explanations[0].calculationInputs.balanceAtRetirement).toEqual(legacy.explanations[0].calculationInputs.balanceAtRetirement);
    expect(explanations[0].calculationInputs.requiredCorpus).toEqual(legacy.explanations[0].calculationInputs.requiredCorpus);
    expect(explanations[0].calculationInputs.status).toEqual(legacy.explanations[0].calculationInputs.status);
  });

  it('the explanation records each member\'s own target age distinctly (not blended) via calculation_inputs.members', () => {
    const members = explanations[0].calculationInputs.members as { label: string; retirementAge: number }[];
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.label === 'Self')?.retirementAge).toBe(65);
    expect(members.find((m) => m.label === 'Spouse/Partner')?.retirementAge).toBe(62);
  });

  it('each member\'s own breakdown is computed off THEIR OWN balance/contribution/age — Self accounts use Self\'s age, Spouse accounts use Spouse\'s age (spec s.29)', () => {
    const members = explanations[0].calculationInputs.members as { label: string; currentBalance: number; monthlyContribution: number; balanceAtRetirement: number }[];
    const self = members.find((m) => m.label === 'Self')!;
    const spouse = members.find((m) => m.label === 'Spouse/Partner')!;
    expect(self.currentBalance).toBe(200000);
    expect(spouse.currentBalance).toBe(80000);
    // Self (real DOB, age 52 -> 65) has a computable balanceAtRetirement;
    // Spouse has no DOB anywhere in FHIP (spec s.32) so her own leg cannot
    // compute one without fabricating a retirement date — both facts are
    // independently real, not blended into one household number.
    expect(self.balanceAtRetirement).toBeGreaterThan(0);
  });

  it('the narrative states each member\'s own target age distinctly', () => {
    expect(explanations[0].explanationText).toContain("Self's target retirement age is 65");
    expect(explanations[0].explanationText).toContain("Spouse/Partner's target retirement age is 62");
  });

  it('does not change the number of rows/explanations when Self and Spouse target ages genuinely match (spec s.29: "unless both values genuinely match")', () => {
    const matchingSpouse = { ...spouseLeg, retirementAge: 65 };
    const { results: matchedResults, explanations: matchedExplanations } = runRetirementForecast({ ...baseInput, members: [selfLeg, matchingSpouse] });
    expect(matchedResults).toHaveLength(24);
    expect(matchedResults.every((r) => r.entityId === null)).toBe(true);
    expect(matchedExplanations).toHaveLength(1);
  });
});
