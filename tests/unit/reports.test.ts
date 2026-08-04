import { describe, it, expect } from 'vitest';
import { computeSectionEligibility, isEligibleForOfficialMonthlyReport, type EligibilityInput } from '@/lib/engines/reportEligibility';
import { computeMetricMovement, firstReportMessage } from '@/lib/engines/reportNarrative';
import { isExportFormatImplemented, requiresPremiumEntitlement } from '@/lib/engines/reportExport';

const FULL_INPUT: EligibilityInput = {
  hasIncome: true,
  hasExpenses: true,
  hasAssets: true,
  hasLiabilities: true,
  hasHealthScore: true,
  hasDnaProfile: true,
  hasResilienceResult: true,
  hasActiveGoals: true,
  hasFinancialTwin: false,
  countriesInUseCount: 1,
  hasActions: true,
};

function sectionStatus(results: ReturnType<typeof computeSectionEligibility>, code: string) {
  return results.find((r) => r.code === code)!.status;
}

describe('Reports — synthetic personas', () => {
  it('Persona A: Complete Australian Household — all core sections included', () => {
    const results = computeSectionEligibility(FULL_INPUT);
    expect(sectionStatus(results, 'executive_summary')).toBe('included');
    expect(sectionStatus(results, 'cash_flow')).toBe('included');
    expect(sectionStatus(results, 'net_worth')).toBe('included');
    expect(sectionStatus(results, 'health_score')).toBe('included');
    expect(sectionStatus(results, 'financial_dna')).toBe('included');
    expect(sectionStatus(results, 'resilience')).toBe('included');
    expect(sectionStatus(results, 'goals')).toBe('included');
    expect(sectionStatus(results, 'forecast')).toBe('included');
    expect(sectionStatus(results, 'actions')).toBe('included');
    expect(sectionStatus(results, 'data_quality')).toBe('included');
    expect(sectionStatus(results, 'methodology')).toBe('included');
    // Financial Twin (Module 8/Twin) doesn't exist yet — always unavailable.
    expect(sectionStatus(results, 'financial_twin')).toBe('unavailable');
    // Single country recorded — cross-border section omitted, not shown as an error.
    expect(sectionStatus(results, 'cross_border')).toBe('omitted');
  });

  it('Persona B: Partial Insurance Data — a missing module does not block unrelated sections', () => {
    const input: EligibilityInput = { ...FULL_INPUT, hasResilienceResult: false };
    const results = computeSectionEligibility(input);
    expect(sectionStatus(results, 'resilience')).toBe('unavailable');
    expect(sectionStatus(results, 'net_worth')).toBe('included');
    expect(sectionStatus(results, 'health_score')).toBe('included');
    const officialEligibility = isEligibleForOfficialMonthlyReport(input);
    expect(officialEligibility.eligible).toBe(true); // resilience gap alone doesn't block the official report
  });

  it('Persona C: First Monthly Report baseline message', () => {
    expect(firstReportMessage()).toContain('first monthly financial-health report');
  });

  it('Persona E: Cross-Border Household — multi-country data includes the section', () => {
    const input: EligibilityInput = { ...FULL_INPUT, countriesInUseCount: 2 };
    const results = computeSectionEligibility(input);
    expect(sectionStatus(results, 'cross_border')).toBe('included');
  });

  it('Persona F: No Financial Health Score — official report cannot be generated', () => {
    const input: EligibilityInput = { ...FULL_INPUT, hasHealthScore: false };
    const eligibility = isEligibleForOfficialMonthlyReport(input);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toMatch(/score/i);
  });

  it('Persona G: No Goals — goals section states the fact rather than being omitted or failing', () => {
    const input: EligibilityInput = { ...FULL_INPUT, hasActiveGoals: false };
    const results = computeSectionEligibility(input);
    expect(sectionStatus(results, 'goals')).toBe('included');
  });

  it('Persona H / I: Export entitlement and renderer implementation status', () => {
    expect(requiresPremiumEntitlement('print')).toBe(false);
    expect(requiresPremiumEntitlement('pdf')).toBe(true);
    expect(requiresPremiumEntitlement('csv')).toBe(true);
    expect(isExportFormatImplemented('print')).toBe(true);
    expect(isExportFormatImplemented('pdf')).toBe(true);
    expect(isExportFormatImplemented('csv')).toBe(false);
  });

  it('Movement: currency — net worth increase is positive with correct percent change', () => {
    const m = computeMetricMovement({ label: 'Net worth', current: 625000, previous: 610000, format: 'currency', goodDirection: 'up', currency: 'AUD' });
    expect(m.direction).toBe('positive');
    expect(m.changePercent).toBeCloseTo(2.459, 2);
    expect(m.comparable).toBe(true);
  });

  it('Movement: percentage-point — savings rate is compared in points, not percent-of-percent', () => {
    const m = computeMetricMovement({ label: 'Savings rate', current: 18, previous: 16, format: 'percentage_point', goodDirection: 'up' });
    expect(m.changeAbsolute).toBeCloseTo(2, 5);
    expect(m.changePercent).toBeNull();
    expect(m.displayText).toContain('percentage points');
  });

  it('Movement: ratio — a decreasing debt-to-income is classified positive (goodDirection down)', () => {
    const m = computeMetricMovement({ label: 'Debt-to-income', current: 3.8, previous: 3.9, format: 'ratio', goodDirection: 'down' });
    expect(m.direction).toBe('positive');
    expect(m.displayText).toContain('×');
  });

  it('Movement: not comparable — missing previous value is reported as New, never divides by a phantom zero', () => {
    const m = computeMetricMovement({ label: 'Emergency-fund coverage', current: 2.7, previous: null, format: 'months', goodDirection: 'up' });
    expect(m.comparable).toBe(false);
    expect(m.displayText).toBe('New');
    expect(m.notComparableReason).toBe('Previous value unavailable');
  });

  it('Movement: zero previous value skips percentage computation but keeps the absolute change', () => {
    const m = computeMetricMovement({ label: 'Active goals on track', current: 2, previous: 0, format: 'count', goodDirection: 'up' });
    expect(m.comparable).toBe(true);
    expect(m.changeAbsolute).toBe(2);
    expect(m.changePercent).toBeNull();
  });
});
