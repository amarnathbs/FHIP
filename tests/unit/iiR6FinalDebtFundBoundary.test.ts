// R6-FINAL closure — Section 11: re-verification of the 31-Mar-2023 /
// 1-Apr-2023 "specified mutual fund" boundary.
//
// RESEARCH FINDING (2026-08-22, see
// docs/investment-intelligence/R6_TAX_LEGAL_SOURCE_REGISTER.md for full
// citations): this IS a real, legally significant boundary — the Finance
// Act, 2023 introduced the "specified mutual fund" always-short-term rule
// for units of a mutual fund investing >65% in debt/money-market instruments,
// ACQUIRED on or after 1 April 2023 (multiple independent sources agree:
// ClearTax, Bajaj Finserv, Tax2win, HDFC Life, business-standard). The
// Income-tax Act, 2025 was found to carry this rule forward unchanged (see
// source register). So — unlike the 22/23-Jul-2024 date the R6-FINAL spec
// explicitly asked us to sanity-check — there is no finding here that a
// spec-assumed boundary is NOT real; it IS real.
//
// R6-DEBTFIX (2026-08-22, superseding this file's original text): an
// independent acceptance review confirmed the finding this file originally
// only DISCLOSED — that R6-P1's engine did NOT enforce this boundary AT THE
// PER-LOT LEVEL — was a real, live-DEV-confirmed defect, not an acceptable
// scope boundary: a debt-fund lot acquired in 2019 and disposed after a
// 1978-day (5.4-year) holding period was being reported as STCG when it
// should have been evaluated as LTCG under the pre-2023 debt-fund regime.
// capitalGainsEngine.ts now READS `DebtSpecifiedRules.
// specifiedFundAcquiredOnOrAfter` as a genuine per-lot gate: a lot acquired
// BEFORE the cutoff gets the legacy pre-2023 treatment (see
// `ruleVersions.ts`'s `LegacyDebtFundRegime` and
// `docs/investment-intelligence/R6_DEBT_FUND_ACQUISITION_DATE_FIX.md`), NOT
// the always-short-term Section 50AA rule. This test file's assertions are
// updated accordingly — the PRE-cutoff and POST-cutoff cases below now
// correctly diverge instead of both being forced to STCG.
//
// See tests/unit/iiR6P1Certification.test.ts's "R6-DEBTFIX: legacy debt-fund
// family" describe block (DEBTPRE-001..010, 142-case independent
// certification pack) for the full, independently-oracled regression suite.

import { describe, it, expect } from 'vitest';
import { computeDisposalTax } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import { RULE_1961_POST_20240723 } from '@/lib/engines/investment-intelligence/tax/ruleVersions';
import type { LotConsumption } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';

// II-PC1-F1: FIFO is now scoped to (account, instrument). Every case in this
// pre-existing suite is a single-folio scenario, so one shared account key
// preserves the original behaviour and expectations exactly.
const ACCOUNT = 'acct-r6-debt-fund-boundary';

function debtClassification(): SchemeClassificationResult {
  return {
    instrumentKey: 'SCH-DEBT-BOUNDARY',
    classification: 'debt_specified',
    domesticEquityPct: null,
    basis: 'known_debt_specified_category',
    disclosureDate: null,
    note: 'test fixture',
  };
}

function consumptionFor(acquisitionDate: string, disposalDate: string): LotConsumption {
  return {
    disposalEventId: 'd',
    lotId: 'l',
    accountKey: ACCOUNT,
    instrumentKey: 'SCH-DEBT-BOUNDARY',
    acquisitionDate,
    kind: 'purchase',
    disposalDate,
    unitsConsumed: 100,
    costPerUnit: 20,
    costBasis: 2000,
    saleValueApportioned: 2500,
  };
}

describe('R6-FINAL Sec.11 / R6-DEBTFIX: specified-mutual-fund (debt) 31-Mar-2023/1-Apr-2023 boundary', () => {
  it('the rate table documents the boundary date, sourced and verified (Finance Act 2023, carried forward unchanged into the 2025 Act)', () => {
    expect(RULE_1961_POST_20240723.ruleDefinition.debtSpecified.specifiedFundAcquiredOnOrAfter).toBe('2023-04-01');
    expect(RULE_1961_POST_20240723.ruleDefinition.debtSpecified.alwaysShortTerm).toBe(true);
  });

  it('FIXED BEHAVIOUR (R6-DEBTFIX): a lot acquired BEFORE the 2023-04-01 cutoff now gets the legacy pre-2023 debt-fund treatment (LTCG here, long holding), while an otherwise-identical lot acquired ON/AFTER the cutoff still gets the always-STCG Section 50AA rule', () => {
    const preCutoff = computeDisposalTax({
      consumption: consumptionFor('2019-06-01', '2025-01-01'), // acquired well BEFORE the cutoff
      saleValuePerUnit: 25,
      classification: debtClassification(),
      fmv31Jan2018PerUnit: null,
    });
    const postCutoff = computeDisposalTax({
      consumption: consumptionFor('2023-06-01', '2025-01-01'), // acquired AFTER the cutoff
      saleValuePerUnit: 25,
      classification: debtClassification(),
      fmv31Jan2018PerUnit: null,
    });
    // preCutoff: acquired 2019-06-01, disposed 2025-01-01 (>24 months,
    // disposal on/after the 23-Jul-2024 Budget boundary) -> legacy regime,
    // 24-month threshold -> LTCG.
    expect(preCutoff.gainType).toBe('ltcg');
    expect(preCutoff.grandfathering).toBeNull();
    expect(preCutoff.note).not.toMatch(/always short-term/i);
    // postCutoff: acquired on/after the cutoff -> Section 50AA -> always STCG
    // regardless of holding period (unchanged, pre-existing, correct
    // behaviour).
    expect(postCutoff.gainType).toBe('stcg');
    expect(postCutoff.grandfathering).toBeNull();
    expect(postCutoff.note).toMatch(/50AA/);
    // The whole point of the fix: these two lots, differing ONLY in
    // acquisition date, must no longer collapse to the same treatment.
    expect(preCutoff.gainType).not.toBe(postCutoff.gainType);
  });
});
