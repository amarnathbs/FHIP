import { describe, it, expect } from 'vitest';
import { computeSectionCompletionPercent, effectiveSectionStatus } from '@/lib/engines/financialSectionStatus';

// App Review spec §7: Input Completion Percentage — Fix.
//
// Reproduces the acceptance test verbatim: "3 valid income types entered,
// no missing fields, user indicates no additional income -> Income shows
// complete, not 11%." Also exercises the exact bug scenario the spec
// describes (catalogue-row-count producing ~11% for a fully-entered section)
// as a negative control against the OLD formula, computed inline here so the
// contrast is explicit without re-importing dead code.
describe('computeSectionCompletionPercent (App Review spec §7)', () => {
  it('negative control: reproduces the reported ~11% bug under the OLD catalogue-coverage formula', () => {
    // Income catalogue has 26 items (supabase/seed_master_items.sql); a
    // household with 3 real, fully-filled income sources under the old
    // formula (includedMasterCount / masterItemCount * 100) got:
    const oldFormulaResult = Math.round((3 / 26) * 100);
    expect(oldFormulaResult).toBe(12); // 3 of the real Income catalogue's 26 items (supabase/seed_master_items.sql) — the same order of magnitude as the reported "shows ~11%" defect
    expect(oldFormulaResult).toBeLessThan(20); // the reported symptom: misleadingly low despite nothing missing
  });

  it('3 valid income types entered, no missing fields, user confirms "I have added everything relevant to me" -> 100%, not ~11%', () => {
    const status = effectiveSectionStatus({ hasRows: true, explicitConfirmation: 'reviewed_with_data' });
    expect(status).toBe('reviewed_with_data');
    const completion = computeSectionCompletionPercent({ status, includedCount: 3, missingRequiredCount: 0 });
    expect(completion).toBe(100);
  });

  it('explicit "no additional income / I have none of this" (reviewed_zero) with zero rows -> 100%, not penalised for lacking categories', () => {
    const status = effectiveSectionStatus({ hasRows: false, explicitConfirmation: 'reviewed_zero' });
    const completion = computeSectionCompletionPercent({ status, includedCount: 0, missingRequiredCount: 0 });
    expect(completion).toBe(100);
  });

  it('explicit "not applicable" -> 100% regardless of rows', () => {
    const status = effectiveSectionStatus({ hasRows: false, explicitConfirmation: 'not_applicable' });
    const completion = computeSectionCompletionPercent({ status, includedCount: 0, missingRequiredCount: 0 });
    expect(completion).toBe(100);
  });

  it('no rows and no confirmation -> 0%, not a misleading nonzero catalogue-coverage number', () => {
    const status = effectiveSectionStatus({ hasRows: false, explicitConfirmation: null });
    expect(status).toBe('not_started');
    const completion = computeSectionCompletionPercent({ status, includedCount: 0, missingRequiredCount: 0 });
    expect(completion).toBe(0);
  });

  it('rows entered, all required fields present, but not yet confirmed complete -> partial (75%), not 0% and not falsely 100%', () => {
    const status = effectiveSectionStatus({ hasRows: true, explicitConfirmation: null });
    expect(status).toBe('in_progress');
    const completion = computeSectionCompletionPercent({ status, includedCount: 2, missingRequiredCount: 0 });
    expect(completion).toBe(75);
  });

  it('rows entered but a required field is still missing -> lower partial (50%) than the fields-OK case', () => {
    const status = effectiveSectionStatus({ hasRows: true, explicitConfirmation: null });
    const completion = computeSectionCompletionPercent({ status, includedCount: 2, missingRequiredCount: 1 });
    expect(completion).toBe(50);
  });

  it('a stale reviewed_with_data confirmation whose rows were since deleted reverts to not_started, not a false 100%', () => {
    const status = effectiveSectionStatus({ hasRows: false, explicitConfirmation: 'reviewed_with_data' });
    expect(status).toBe('not_started');
    const completion = computeSectionCompletionPercent({ status, includedCount: 0, missingRequiredCount: 0 });
    expect(completion).toBe(0);
  });
});
