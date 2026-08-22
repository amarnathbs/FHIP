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
// The Income-tax Act, 2025 takes effect from 1 April 2026 (Tax Year 2026-27).
//
// R6-FINAL closure (2026-08-22) resolved the prior PLACEHOLDER: the Act's
// capital-gains provisions for equity shares / equity-oriented mutual fund
// units / business-trust units were re-verified against the enacted
// Income-tax Act, 2025 [30 of 2025] text (as amended by Finance Act, 2026)
// via indiankanoon.org's transcription of the Act plus five independent,
// mutually-consistent secondary analyses (see
// docs/investment-intelligence/R6_TAX_LEGAL_SOURCE_REGISTER.md for the full
// citation list, dated 2026-08-22). Finding: Sections 111A/112A of the 1961
// Act were RENUMBERED to Sections 196 (STCG) / 198 (LTCG) of the 2025 Act
// with NO rate or threshold change — same 20% STCG, 12.5% LTCG above
// Rs 1,25,000/tax year, no indexation, same >=65% domestic-equity
// "equity-oriented fund" test (now Section 198(8)). Multiple sources
// independently describe the 2025 Act's capital-gains chapter as a
// structural renumbering/consolidation exercise, not a rate change ("no
// major changes to the core LTCG tax rate or exemption limit" — Budget
// 2025-26 commentary). The debt/"specified mutual fund" always-short-term
// rule (Finance Act 2023) was likewise found to continue unchanged. The
// 2026-04-01-onward row below is therefore CERTIFIED (placeholder: false),
// not a placeholder.
//
// One narrower question was NOT conclusively resolved at statutory-section
// level: which 2025-Act section (if any distinct from the general
// cost-of-acquisition Section 72) re-enacts the 31-Jan-2018 FMV
// grandfathering step-up (originally the proviso to Section 55(2)(ac) of
// the 1961 Act) for LTCG disposals occurring on/after 1 April 2026 of lots
// acquired before 1 February 2018. No source consulted suggested repeal,
// and grandfathering.ts's formula is a cost-basis rule keyed on
// ACQUISITION date (not disposal-date/governing-Act), so this engine
// continues to apply it unconditionally — but this specific continuity is
// disclosed as a research limitation, not silently assumed. See the source
// register's "Open items" section.

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

/** CERTIFIED (R6-FINAL closure, 2026-08-22) — Income-tax Act, 2025 [30 of
 * 2025], in force from 1 April 2026 (Tax Year 2026-27). Section 196 (STCG)
 * and Section 198 (LTCG) re-enact the substance of the 1961 Act's Sections
 * 111A/112A with the SAME rates verified for RULE_1961_POST_20240723 — this
 * was independently confirmed, not assumed by copy-paste. See
 * docs/investment-intelligence/R6_TAX_LEGAL_SOURCE_REGISTER.md for full
 * citations (indiankanoon.org's transcription of the Act text, plus
 * corroborating analyses from ebizfiling, finnovate, TaxGuru, ClearTax,
 * Bajaj Finserv — all independently agreeing on Sections 196/198, the 20%/
 * 12.5%/Rs 1,25,000 figures, and the >=65% equity-oriented-fund test at
 * Section 198(8)). The debt/"specified mutual fund" always-short-term rule
 * was likewise confirmed to continue unchanged. Grandfathering continuity
 * for post-2026-04-01 disposals is a disclosed, narrower open item — see
 * module header and the source register's "Open items" section. */
export const RULE_2025_ACT_POST_20260401: TaxRuleVersion = {
  ruleSetKey: 'in_mutual_fund_capital_gains',
  version: '2025_act_post_20260401',
  countryCode: 'IN',
  effectiveFrom: '2026-04-01',
  effectiveTo: null,
  ruleDefinition: {
    placeholder: false,
    sourceNote:
      'Income-tax Act, 2025 [30 of 2025], effective 1 April 2026 (Tax Year 2026-27). Section 196 ' +
      '(STCG) and Section 198 (LTCG, exemption per Section 198(3), equity-oriented-fund definition ' +
      'per Section 198(8)) re-enact Sections 111A/112A of the 1961 Act with no rate/threshold change: ' +
      'equity/equity-oriented-fund STCG 20%, LTCG 12.5% above Rs 1,25,000/tax year, no indexation. ' +
      'The debt/specified-mutual-fund always-short-term-at-slab-rate rule (originally Finance Act ' +
      '2023) continues unchanged. Verified against indiankanoon.org\'s transcription of the enacted ' +
      'Act text and five independent corroborating secondary sources (2026-08-22) — see ' +
      'R6_TAX_LEGAL_SOURCE_REGISTER.md. Finance Act 2026 was also checked and introduces no capital-' +
      'gains changes for mutual fund units (its changes — buyback taxation, SGB secondary-market ' +
      'gains — are outside this engine\'s mutual-fund-disposal scope).',
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
  RULE_2025_ACT_POST_20260401,
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
