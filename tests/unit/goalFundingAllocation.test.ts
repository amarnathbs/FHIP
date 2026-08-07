import { describe, it, expect } from 'vitest';
import {
  computeAllocatedMonthlyContribution,
  evaluateAllocation,
  type AllocatedContributionFundingSource,
  type AllocatedContributionInvestment,
  type AllocatedContributionRetirementAccount,
} from '@/lib/services/goalFundingAllocation';

describe('computeAllocatedMonthlyContribution', () => {
  it('sums an allocated share of a linked investment annual_contribution as a monthly figure', () => {
    const sources: AllocatedContributionFundingSource[] = [
      { sourceType: 'investment', linkedInvestmentId: 'inv-1', linkedRetirementId: null, allocationPercentage: 50 },
    ];
    const investments = new Map<string, AllocatedContributionInvestment>([['inv-1', { annualContribution: 12000 }]]);
    const retirement = new Map<string, AllocatedContributionRetirementAccount>();

    // 12000/12 = 1000/mo * 50% = 500
    expect(computeAllocatedMonthlyContribution(sources, investments, retirement)).toBe(500);
  });

  it('sums an allocated share of a linked retirement account monthly contribution', () => {
    const sources: AllocatedContributionFundingSource[] = [
      { sourceType: 'retirement', linkedInvestmentId: null, linkedRetirementId: 'ret-1', allocationPercentage: 100 },
    ];
    const investments = new Map<string, AllocatedContributionInvestment>();
    const retirement = new Map<string, AllocatedContributionRetirementAccount>([
      ['ret-1', { employerContribution: 500, personalContribution: 300, contributionFrequency: 'monthly' }],
    ]);

    expect(computeAllocatedMonthlyContribution(sources, investments, retirement)).toBe(800);
  });

  it('converts a non-monthly retirement contribution frequency correctly', () => {
    const sources: AllocatedContributionFundingSource[] = [
      { sourceType: 'retirement', linkedInvestmentId: null, linkedRetirementId: 'ret-1', allocationPercentage: 100 },
    ];
    const retirement = new Map<string, AllocatedContributionRetirementAccount>([
      ['ret-1', { employerContribution: 1200, personalContribution: 0, contributionFrequency: 'annually' }],
    ]);

    expect(computeAllocatedMonthlyContribution(sources, new Map(), retirement)).toBe(100);
  });

  it('blends multiple funding sources across different goals correctly', () => {
    const sources: AllocatedContributionFundingSource[] = [
      { sourceType: 'investment', linkedInvestmentId: 'inv-1', linkedRetirementId: null, allocationPercentage: 25 },
      { sourceType: 'investment', linkedInvestmentId: 'inv-2', linkedRetirementId: null, allocationPercentage: 100 },
    ];
    const investments = new Map<string, AllocatedContributionInvestment>([
      ['inv-1', { annualContribution: 2400 }], // 200/mo * 25% = 50
      ['inv-2', { annualContribution: 600 }], // 50/mo * 100% = 50
    ]);

    expect(computeAllocatedMonthlyContribution(sources, investments, new Map())).toBe(100);
  });

  it('ignores fixed-amount sources with no allocation_percentage', () => {
    const sources: AllocatedContributionFundingSource[] = [
      { sourceType: 'investment', linkedInvestmentId: 'inv-1', linkedRetirementId: null, allocationPercentage: null },
    ];
    const investments = new Map<string, AllocatedContributionInvestment>([['inv-1', { annualContribution: 12000 }]]);

    expect(computeAllocatedMonthlyContribution(sources, investments, new Map())).toBe(0);
  });

  it('returns 0 for manual/expected sources or when the linked record is missing', () => {
    const sources: AllocatedContributionFundingSource[] = [
      { sourceType: 'manual', linkedInvestmentId: null, linkedRetirementId: null, allocationPercentage: 50 },
      { sourceType: 'investment', linkedInvestmentId: 'missing', linkedRetirementId: null, allocationPercentage: 50 },
    ];
    expect(computeAllocatedMonthlyContribution(sources, new Map(), new Map())).toBe(0);
  });
});

// Existing pure-function coverage extended alongside the new function above,
// same test file convention as the rest of this codebase.
describe('evaluateAllocation (existing)', () => {
  it('rejects an allocation that would exceed 100%', () => {
    const result = evaluateAllocation(70, 40);
    expect(result.ok).toBe(false);
    expect(result.wouldBeTotalPct).toBe(110);
  });

  it('accepts an allocation within bounds', () => {
    const result = evaluateAllocation(30, 40);
    expect(result.ok).toBe(true);
    expect(result.wouldBeTotalPct).toBe(70);
  });
});
