// R6-FINAL closure — Section 33 NC-4 target: the Section 112A LTCG
// exemption threshold is a TAXPAYER-LEVEL, WHOLE-FINANCIAL-YEAR figure,
// applied ONCE across every equity-oriented fund the household holds — never
// per-fund and never per-transaction (taxYearAggregation.ts's own module
// header already states this; this test makes it concrete with MULTIPLE
// distinct instruments in one FY).
//
// FINDING while building this control: the existing 120-case certification
// pack's fy_aggregation/cross_fy families (scripts/ii-r6p1-certification/
// generate_cases.mjs) synthesize every disposal in a case under a SINGLE
// instrumentKey ('X', see iiR6P1Certification.test.ts's buildFakeDisposal).
// Because aggregateTaxYear does not currently group by instrument at all,
// a per-fund/per-taxpayer aggregation bug would NOT be caught by those
// cases — a single-fund household can't distinguish "sum across all my
// funds" from "sum within this one fund", they're numerically identical.
// This standalone test closes that specific gap with a genuinely
// multi-instrument fixture, and is the regression target for NC-4.

import { describe, it, expect } from 'vitest';
import { aggregateTaxYear } from '@/lib/engines/investment-intelligence/tax/taxYearAggregation';
import type { DisposalTaxResult } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';

function fakeDisposal(instrumentKey: string, disposalDate: string, taxableGain: number, idx: number): DisposalTaxResult {
  return {
    disposalEventId: `d-${idx}`,
    lotId: `l-${idx}`,
    instrumentKey,
    acquisitionDate: '2020-01-01',
    disposalDate,
    unitsConsumed: 1,
    classification: 'equity_oriented',
    gainType: 'ltcg',
    holdingDays: 900,
    ruleVersion: 'test',
    ruleVersionPlaceholder: false,
    saleValue: 0,
    costBasisUsed: 0,
    costBasisPreGrandfathering: 0,
    taxableGain,
    grandfathering: null,
    note: '',
  };
}

describe('R6-FINAL Sec.33 NC-4 target: LTCG exemption is taxpayer-level, applied ONCE across multiple funds in one FY', () => {
  it('two different funds, each individually under the Rs 1,25,000 threshold, still get exactly ONE combined exemption when summed together exceed it', () => {
    // FY2024-25 exemption threshold (rule version in force on FY-end
    // 2025-03-31) is Rs 1,25,000. Fund A: Rs 80,000 gain. Fund B: Rs 90,000
    // gain. Neither alone exceeds the threshold, but SUMMED (Rs 170,000)
    // they do — correct taxpayer-level behaviour taxes Rs 45,000, NOT zero.
    const disposals = [
      fakeDisposal('FUND-A', '2024-06-01', 80_000, 0),
      fakeDisposal('FUND-B', '2024-09-01', 90_000, 1),
    ];
    const result = aggregateTaxYear(disposals);
    expect(result.byFinancialYear).toHaveLength(1);
    const fy = result.byFinancialYear[0];
    expect(fy.totalLtcgBeforeExemption).toBeCloseTo(170_000, 2);
    expect(fy.exemptionThresholdInr).toBe(125_000);
    expect(fy.exemptionApplied).toBeCloseTo(125_000, 2); // exemption applied ONCE, taxpayer-wide
    expect(fy.taxableLtcgAfterExemption).toBeCloseTo(45_000, 2); // 170,000 - 125,000
    expect(fy.contributingDisposalCount).toBe(2);
  });

  it('the SAME two funds, if wrongly exempted per-fund, would incorrectly report zero taxable gain — this is the exact defect NC-4 mutates in', () => {
    // Documents the WRONG answer a per-fund exemption would produce, so the
    // negative control's expected failure is traceable to a concrete,
    // named number: Fund A (80,000 < 125,000 exemption) -> 0 taxable. Fund B
    // (90,000 < 125,000 exemption) -> 0 taxable. Wrong total: 0. Correct
    // total (asserted above): 45,000. The two numbers are different by
    // construction, which is exactly what makes this fixture able to catch
    // the mutation.
    const perFundWrongTotal = Math.max(80_000 - 125_000, 0) + Math.max(90_000 - 125_000, 0);
    expect(perFundWrongTotal).toBe(0);
    expect(perFundWrongTotal).not.toBe(45_000);
  });
});
