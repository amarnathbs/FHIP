// Investment Intelligence R6-P1 — versioned tax-rule config, keyed by
// effective-date range. This is the module that removes any "if/else on
// today's date" from the engine: `resolveRuleVersion(disposalDate, ...)`
// always looks up the rule set that was IN FORCE ON THE DISPOSAL DATE,
// independent of when the calculation is actually run. A disposal computed
// today for a sale that happened in FY2023-24 gets FY2023-24's rules; the
// same disposal recomputed a year from now still gets the same rules.
//
// Persisted as rows in `ii_tax_rule_versions` (already shaped in R1
// migration 0031, world-readable reference data, previously unpopulated —
// R6-P1 is the first release to seed and consume it). This module also
// exports the seed data used by the migration and by tests/oracle so the
// three surfaces (DB seed, engine, certification oracle) can be diffed
// against one canonical source... except the Python oracle deliberately
// re-transcribes these numbers independently rather than importing this
// file (see scripts/ii_r6p1_independent_reconciliation.py header).
//
// THE 1961 ACT → 2025 ACT TRANSITION: the Income-tax Act, 1961 (as amended
// by successive Finance Acts) applies to every disposal before 1 April 2026.
// The Income-tax Act, 2025 takes effect from 1 April 2026. Its capital-gains
// rate/threshold specifics were not publicly finalised at the time this
// engine was built, so the 2026-04-01-onward rule row is an explicit,
// clearly-flagged PLACEHOLDER reusing the last known 1961-Act-era structure
// — never presented as authoritative (see disclaimer.ts
// PLACEHOLDER_RULE_DISCLAIMER, attached automatically whenever this version
// is selected).

import type { IsoDate } from './holdingPeriod';

export type SchemeTaxClass = 'equity_oriented' | 'debt_specified' | 'other_hybrid';

export interface EquityOrientedRules {
  /** >=65% domestic equity threshold that defines "equity-oriented" for tax
   * purposes (Explanation to erstwhile Section 112A / Rule 4). Configurable
   * here, never hardcoded inline in the classification engine. */
  domesticEquityThresholdPct: number;
  stcgHoldingPeriodMonths: number; // <=12 months = STCG
  stcgRatePct: number;
  ltcgRatePct: number;
  ltcgExemptionThresholdInr: number; // per taxpayer per FY, Section 112A
  indexationAllowed: false;
}

export interface DebtSpecifiedRules {
  /** The "specified mutual fund" rule (Finance Act 2023) applies to debt/
   * specified funds ACQUIRED on/after this date — funds acquired before
   * retain the pre-2023-04-01 regime, which this engine does not separately
   * model (out of scope: pre-FY2023-24 debt-fund acquisitions are rare in a
   * fresh II dataset and flagged unresolved rather than guessed). */
  specifiedFundAcquiredOnOrAfter: IsoDate;
  alwaysShortTerm: true;
  indexationAllowed: false;
  /** Taxed at the taxpayer's income-tax slab rate — this engine does not
   * know the household's slab (out of scope, forecasting/tax-return
   * territory), so it reports the gain as short-term/slab-rate-applicable
   * and leaves the actual rate for the user's CA to apply. */
  taxedAtSlabRate: true;
}

export interface RuleDefinition {
  placeholder: boolean;
  sourceNote: string;
  equityOriented: EquityOrientedRules;
  debtSpecified: DebtSpecifiedRules;
  /** "Other/hybrid" funds are classified as equity-oriented or not by
   * applying the SAME >=65% domestic-equity test — no separate rate table,
   * per spec ("apply the equity-oriented test to determine treatment"). */
}

export interface TaxRuleVersion {
  ruleSetKey: 'in_mutual_fund_capital_gains';
  version: string;
  countryCode: 'IN';
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  ruleDefinition: RuleDefinition;
}

// ---------------------------------------------------------------------------
// Canonical seed rows (mirrored into migration 0045's INSERT statements).
// ---------------------------------------------------------------------------

/** Finance Act 2023 (debt-fund rule) through Budget 2024's pre-23-Jul-2024
 * equity rates. Researched and verified: STCG 15%, LTCG 10% over ₹1,00,000,
 * no indexation for equity LTCG (Section 112A as it stood before the
 * Finance (No. 2) Act, 2024). */
export const RULE_1961_PRE_20240723: TaxRuleVersion = {
  ruleSetKey: 'in_mutual_fund_capital_gains',
  version: '1961_act_pre_20240723',
  countryCode: 'IN',
  effectiveFrom: '2023-04-01',
  effectiveTo: '2024-07-22',
  ruleDefinition: {
    placeholder: false,
    sourceNote:
      'Income-tax Act 1961 as amended by Finance Act 2023 (specified mutual fund short-term rule, ' +
      'effective FY2023-24) and pre-Budget-2024 Section 112A rates.',
    equityOriented: {
      domesticEquityThresholdPct: 65,
      stcgHoldingPeriodMonths: 12,
      stcgRatePct: 15,
      ltcgRatePct: 10,
      ltcgExemptionThresholdInr: 100_000,
      indexationAllowed: false,
    },
    debtSpecified: {
      specifiedFundAcquiredOnOrAfter: '2023-04-01',
      alwaysShortTerm: true,
      indexationAllowed: false,
      taxedAtSlabRate: true,
    },
  },
};

/** Finance (No. 2) Act, 2024 — effective for transfers on/after 23 July
 * 2024: equity STCG 15%→20%, LTCG 10%→12.5%, exemption ₹1,00,000→₹1,25,000.
 * Verified via Budget 2024 coverage (Business Standard, Bajaj AMC). */
export const RULE_1961_POST_20240723: TaxRuleVersion = {
  ruleSetKey: 'in_mutual_fund_capital_gains',
  version: '1961_act_post_20240723',
  countryCode: 'IN',
  effectiveFrom: '2024-07-23',
  effectiveTo: '2026-03-31',
  ruleDefinition: {
    placeholder: false,
    sourceNote:
      'Finance (No. 2) Act, 2024, effective for transfers on/after 23 July 2024: equity STCG raised ' +
      'to 20%, LTCG raised to 12.5%, Section 112A exemption raised to ₹1,25,000/FY. Debt/specified-' +
      'fund short-term-always rule (FY2023-24 Finance Act) unchanged.',
    equityOriented: {
      domesticEquityThresholdPct: 65,
      stcgHoldingPeriodMonths: 12,
      stcgRatePct: 20,
      ltcgRatePct: 12.5,
      ltcgExemptionThresholdInr: 125_000,
      indexationAllowed: false,
    },
    debtSpecified: {
      specifiedFundAcquiredOnOrAfter: '2023-04-01',
      alwaysShortTerm: true,
      indexationAllowed: false,
      taxedAtSlabRate: true,
    },
  },
};

/** PLACEHOLDER — pending final Income-tax Act, 2025 rules. In force from
 * 1 April 2026. Structurally identical to the last known 1961-Act-era rates
 * (RULE_1961_POST_20240723) as an explicitly documented placeholder — see
 * module header and disclaimer.ts PLACEHOLDER_RULE_DISCLAIMER. Never
 * present these numbers as the actual 2025 Act rates. */
export const RULE_2025_ACT_PLACEHOLDER: TaxRuleVersion = {
  ruleSetKey: 'in_mutual_fund_capital_gains',
  version: '2025_act_placeholder',
  countryCode: 'IN',
  effectiveFrom: '2026-04-01',
  effectiveTo: null,
  ruleDefinition: {
    placeholder: true,
    sourceNote:
      'PLACEHOLDER — the Income-tax Act, 2025 is in force from 1 April 2026 but its specific capital-' +
      'gains rates/thresholds for mutual funds were not publicly finalised/verifiable at the time this ' +
      'engine was built. This row deliberately reuses the pre-transition (1961 Act, Finance (No. 2) ' +
      'Act 2024) rate structure as a placeholder so the engine has a defined, non-fabricated answer ' +
      'rather than guessing new numbers. Replace this row\'s ruleDefinition once the 2025 Act rules ' +
      'are confirmed — do not edit the rates without also updating this sourceNote and re-running the ' +
      'certification pack.',
    equityOriented: {
      domesticEquityThresholdPct: 65,
      stcgHoldingPeriodMonths: 12,
      stcgRatePct: 20,
      ltcgRatePct: 12.5,
      ltcgExemptionThresholdInr: 125_000,
      indexationAllowed: false,
    },
    debtSpecified: {
      specifiedFundAcquiredOnOrAfter: '2023-04-01',
      alwaysShortTerm: true,
      indexationAllowed: false,
      taxedAtSlabRate: true,
    },
  },
};

export const ALL_RULE_VERSIONS: readonly TaxRuleVersion[] = [
  RULE_1961_PRE_20240723,
  RULE_1961_POST_20240723,
  RULE_2025_ACT_PLACEHOLDER,
];

export class NoApplicableRuleVersionError extends Error {
  constructor(disposalDate: string) {
    super(`resolveRuleVersion: no tax rule version covers disposal date ${disposalDate}`);
    this.name = 'NoApplicableRuleVersionError';
  }
}

/**
 * Resolve the rule version IN FORCE on a given disposal date. This is the
 * one function that must be called instead of any if/else on "today" —
 * every capital-gains computation goes through here keyed by the
 * DISPOSAL's own date, never the date the engine happens to run.
 */
export function resolveRuleVersion(
  disposalDate: IsoDate,
  versions: readonly TaxRuleVersion[] = ALL_RULE_VERSIONS
): TaxRuleVersion {
  const match = versions.find(
    (v) => disposalDate >= v.effectiveFrom && (v.effectiveTo === null || disposalDate <= v.effectiveTo)
  );
  if (!match) throw new NoApplicableRuleVersionError(disposalDate);
  return match;
}
