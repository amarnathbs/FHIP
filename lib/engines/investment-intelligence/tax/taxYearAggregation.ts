// Investment Intelligence R6-P1 — taxpayer-level, financial-year LTCG
// threshold aggregation. The spec is explicit: the Section 112A exemption
// is a TAXPAYER-LEVEL, WHOLE-FY figure, never applied per-fund or
// per-transaction. This module sums ALL equity-oriented LTCG for the FY
// first, then applies the exemption threshold exactly once.
//
// MID-FY RATE-CHANGE NUANCE (researched, not assumed): FY2024-25 (1 Apr
// 2024 – 31 Mar 2025) straddles the Finance (No. 2) Act, 2024 rate change
// that took effect 23 July 2024. Each disposal's LTCG is taxed at whichever
// rate was in force on ITS OWN disposal date (handled per-disposal by
// `resolveRuleVersion` in capitalGainsEngine.ts). But the ₹1,25,000
// exemption threshold is NOT split or prorated across the two sub-periods —
// CBDT's published FAQ on the new regime confirms the higher ₹1,25,000
// exemption "will apply for FY 2024-25 and subsequent years" as a single
// whole-year figure. This module therefore resolves ONE exemption threshold
// per FY, taken from the rule version in force on the FY's last day (31
// March), and applies it once to that FY's summed LTCG — never one
// threshold per rate-sub-period within the year.

import { financialYearOf, financialYearBounds, type FinancialYearLabel } from './financialYear';
import { resolveRuleVersion, type TaxRuleVersion } from './ruleVersions';
import type { DisposalTaxResult } from './capitalGainsEngine';

export interface TaxYearLtcgSummary {
  financialYear: FinancialYearLabel;
  exemptionThresholdInr: number;
  exemptionRuleVersion: string;
  totalLtcgBeforeExemption: number;
  exemptionApplied: number;
  taxableLtcgAfterExemption: number;
  contributingDisposalCount: number;
  unresolvedExcludedCount: number;
}

export interface TaxYearAggregationResult {
  byFinancialYear: TaxYearLtcgSummary[];
  /** Every disposal whose classification/rule resolution left it
   * unresolved, carried forward untouched rather than silently dropped. */
  unresolvedDisposals: DisposalTaxResult[];
}

/**
 * Aggregate a flat list of per-lot disposal results (from
 * `computeDisposalTax`, across possibly many funds and many redemption
 * events for ONE taxpayer/household) into one taxpayer-level LTCG figure
 * per financial year, applying the exemption threshold exactly once per FY.
 */
export function aggregateTaxYear(
  disposals: readonly DisposalTaxResult[],
  ruleVersions?: readonly TaxRuleVersion[]
): TaxYearAggregationResult {
  const unresolvedDisposals = disposals.filter((d) => d.gainType === 'unresolved');
  const ltcgByFy = new Map<FinancialYearLabel, DisposalTaxResult[]>();

  for (const d of disposals) {
    if (d.gainType !== 'ltcg' || d.classification !== 'equity_oriented') continue; // only Section 112A LTCG is exemption-eligible
    const fy = financialYearOf(d.disposalDate);
    if (!ltcgByFy.has(fy)) ltcgByFy.set(fy, []);
    ltcgByFy.get(fy)!.push(d);
  }

  const byFinancialYear: TaxYearLtcgSummary[] = [...ltcgByFy.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([fy, fyDisposals]) => {
      const { end } = financialYearBounds(fy);
      const exemptionRule = resolveRuleVersion(end, ruleVersions);
      const exemptionThresholdInr = exemptionRule.ruleDefinition.equityOriented.ltcgExemptionThresholdInr;
      const totalLtcgBeforeExemption = fyDisposals.reduce((sum, d) => sum + (d.taxableGain ?? 0), 0);
      const exemptionApplied = Math.min(Math.max(totalLtcgBeforeExemption, 0), exemptionThresholdInr);
      const taxableLtcgAfterExemption = Math.max(totalLtcgBeforeExemption - exemptionApplied, 0);

      return {
        financialYear: fy,
        exemptionThresholdInr,
        exemptionRuleVersion: exemptionRule.version,
        totalLtcgBeforeExemption,
        exemptionApplied,
        taxableLtcgAfterExemption,
        contributingDisposalCount: fyDisposals.length,
        unresolvedExcludedCount: unresolvedDisposals.filter((u) => financialYearOf(u.disposalDate) === fy).length,
      };
    });

  return { byFinancialYear, unresolvedDisposals };
}
