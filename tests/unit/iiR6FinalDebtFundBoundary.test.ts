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
// HOWEVER: this pass also discovered (while tracing how the boundary would
// actually need to be enforced) that R6-P1's engine does NOT currently
// enforce this boundary AT THE PER-LOT LEVEL. `DebtSpecifiedRules.
// specifiedFundAcquiredOnOrAfter` (ruleVersions.ts) is defined and
// documented but never READ by capitalGainsEngine.ts — every lot already
// classified `debt_specified` (upstream, by schemeClassification.ts /
// taxRepository.ts's instrument-category data) is treated as always-
// short-term regardless of its own acquisitionDate. ruleVersions.ts's own
// comment on this field already discloses this as a deliberate R6-P1 scope
// boundary ("out of scope: pre-FY2023-24 debt-fund acquisitions are rare in
// a fresh II dataset and flagged unresolved rather than guessed") — this is
// PRE-EXISTING, DISCLOSED behaviour, not something Section 8/9's placeholder
// removal touches, and per this dispatch's explicit instruction not to
// rebuild core engine logic, it is left as-is here. This test exists to (a)
// confirm the boundary date is real via research, and (b) make the current,
// disclosed non-enforcement an explicit, visible, regression-tested fact
// rather than an implicit assumption nobody has actually checked lately.

import { describe, it, expect } from 'vitest';
import { computeDisposalTax } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import { RULE_1961_POST_20240723 } from '@/lib/engines/investment-intelligence/tax/ruleVersions';
import type { LotConsumption } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';

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

describe('R6-FINAL Sec.11: specified-mutual-fund (debt) 31-Mar-2023/1-Apr-2023 boundary', () => {
  it('the rate table documents the boundary date, sourced and verified (Finance Act 2023, carried forward unchanged into the 2025 Act)', () => {
    expect(RULE_1961_POST_20240723.ruleDefinition.debtSpecified.specifiedFundAcquiredOnOrAfter).toBe('2023-04-01');
    expect(RULE_1961_POST_20240723.ruleDefinition.debtSpecified.alwaysShortTerm).toBe(true);
  });

  it('DISCLOSED BEHAVIOUR: a lot already classified debt_specified is always-short-term regardless of ITS OWN acquisition date relative to the 2023-04-01 cutoff (the field is not consumed as a per-lot gate)', () => {
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
    // Both sides get identical STCG-always treatment today — this IS the
    // current, disclosed engine behaviour, held here as a named fact so a
    // future change to it is a deliberate decision, not a silent drift.
    expect(preCutoff.gainType).toBe('stcg');
    expect(postCutoff.gainType).toBe('stcg');
    expect(preCutoff.grandfathering).toBeNull();
    expect(postCutoff.grandfathering).toBeNull();
  });
});
