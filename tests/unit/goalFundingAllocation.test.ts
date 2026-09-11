import { describe, it, expect } from 'vitest';
import {
  computeAllocatedMonthlyContribution,
  computeLiveLinkedFundingValue,
  evaluateAllocation,
  type AllocatedContributionFundingSource,
  type AllocatedContributionInvestment,
  type AllocatedContributionRetirementAccount,
  type LiveLinkedFundingSource,
  type LiveLinkedCurrentValue,
} from '@/lib/services/goalFundingAllocation';

// G6 Contract 6: currentValueById now carries each linked record's own
// currency_code alongside its value. `null` here means "same currency as
// the goal" for these pre-Contract-6 tests, which never pass
// goalCurrencyCode/fxRateAudInr either — proving the no-op/backward-compat
// path (untouched raw value) still holds byte-for-byte.
function localValue(value: number): LiveLinkedCurrentValue {
  return { value, currencyCode: null };
}

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

  // Education/Children Investment -> Goal Linkage spec s.46: "Education 70%,
  // Home 50%, Total 120% must be rejected" — the exact worked example.
  it('spec s.46: Education 70% + Home 50% (120% total) is rejected', () => {
    const result = evaluateAllocation(70, 50);
    expect(result.ok).toBe(false);
    expect(result.wouldBeTotalPct).toBe(120);
    expect(result.error).toMatch(/exceed 100%/);
  });
});

// Education/Children Investment -> Goal Linkage (spec s.26/32-33/37/44/51,
// s.77-85) — the live-recomputed contribution an investment/asset/
// retirement-linked funding source makes toward its goal's current funding,
// as opposed to the stale creation-time snapshot in allocated_amount.
describe('computeLiveLinkedFundingValue', () => {
  it('spec s.77 Simple Education: ETF $40,000 linked 100% contributes $40,000', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'etf-1', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([['etf-1', localValue(40000)]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById)).toBe(40000);
  });

  it('spec s.78 Partial: ETF $100,000 linked 60% contributes $60,000, not the full $100,000', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'etf-1', linkedRetirementId: null, allocationPercentage: 60, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([['etf-1', localValue(100000)]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById)).toBe(60000);
  });

  it('spec s.33 Market movement: a live value increase flows through without re-editing the funding source', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'etf-1', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    // allocatedAmount snapshot (stale) says $50,000; live current_value has since moved to $55,000.
    expect(computeLiveLinkedFundingValue(sources, new Map([['etf-1', localValue(55000)]]))).toBe(55000);
  });

  it('spec s.79 Multiple Holdings -> one Goal: $50k + $30k + $20k = $100,000, not $200,000', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'etf', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'td', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'mf', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([
      ['etf', localValue(50000)],
      ['td', localValue(30000)],
      ['mf', localValue(20000)],
    ]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById)).toBe(100000);
  });

  it('spec s.44 fixed-amount allocation uses the committed amount, not the live balance', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'etf-1', linkedRetirementId: null, allocationPercentage: null, allocatedAmount: 25000 },
    ];
    // Live value has grown to $100,000, but this is a FIXED-amount commitment, not a percentage share.
    expect(computeLiveLinkedFundingValue(sources, new Map([['etf-1', localValue(100000)]]))).toBe(25000);
  });

  it('manual/cash/expected sources carry no live-value signal (spec: informational only)', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'manual', linkedAssetId: null, linkedInvestmentId: null, linkedRetirementId: null, allocationPercentage: null, allocatedAmount: 5000 },
    ];
    expect(computeLiveLinkedFundingValue(sources, new Map())).toBe(0);
  });

  it('a linked record with no known current value contributes $0, never throws', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'missing', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    expect(computeLiveLinkedFundingValue(sources, new Map())).toBe(0);
  });
});

// G6 Contract 6 (docs/country-programme/g6-data-contracts.md) — a
// percentage-based funding source linked to a record in a DIFFERENT
// currency from its goal is now converted before the percentage is applied.
describe('computeLiveLinkedFundingValue — cross-currency conversion (G6 Contract 6)', () => {
  const fxRateAudInr = 55; // INR per 1 AUD

  it('THE DEFECT THIS CONTRACT FIXES: an INR-denominated linked investment feeding an AUD goal is converted, not treated as a raw AUD figure', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-in', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([['inv-in', { value: 5500000, currencyCode: 'INR' }]]);
    // 5,500,000 INR / 55 = 100,000 AUD — NOT 5,500,000 (which the pre-Contract-6 code would have returned).
    expect(computeLiveLinkedFundingValue(sources, currentValueById, 'AUD', fxRateAudInr)).toBe(100000);
  });

  it('a percentage allocation is applied AFTER conversion, not before', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-in', linkedRetirementId: null, allocationPercentage: 50, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([['inv-in', { value: 5500000, currencyCode: 'INR' }]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById, 'AUD', fxRateAudInr)).toBe(50000);
  });

  it('same-currency link and goal: convertToReportingCurrency is a no-op, zero numeric change from before Contract 6', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-au', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([['inv-au', { value: 40000, currencyCode: 'AUD' }]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById, 'AUD', fxRateAudInr)).toBe(40000);
  });

  it('fixed-amount sources are NEVER converted, even when currencies differ — they are already goal-currency-denominated by the user\'s own entry', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-in', linkedRetirementId: null, allocationPercentage: null, allocatedAmount: 25000 },
    ];
    const currentValueById = new Map([['inv-in', { value: 5500000, currencyCode: 'INR' }]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById, 'AUD', fxRateAudInr)).toBe(25000);
  });

  it('backward compatibility: omitting goalCurrencyCode/fxRateAudInr entirely (pre-Contract-6 call shape) leaves the raw value untouched', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-in', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([['inv-in', { value: 5500000, currencyCode: 'INR' }]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById)).toBe(5500000);
  });

  it('an unrecognised/missing linked currency_code is never guessed at — the raw value passes through unconverted', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-x', linkedRetirementId: null, allocationPercentage: 100, allocatedAmount: 0 },
    ];
    const currentValueById = new Map([['inv-x', { value: 40000, currencyCode: null }]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById, 'AUD', fxRateAudInr)).toBe(40000);
  });
});
