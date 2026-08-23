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
// R6-SECURITY-FINAL (2026-08-22) RESOLVED the one narrower question left
// open by the pass above: which 2025-Act provision re-enacts the 31-Jan-2018
// FMV grandfathering step-up (originally the proviso to Section 55(2)(ac) of
// the 1961 Act) for LTCG disposals occurring on/after 1 April 2026 of lots
// acquired before 1 February 2018. Direct current-law authority was found:
// Section 90(7)-(9) of the Income-tax Act, 2025 — "for the purposes of
// sections 72 and 73" (the Act's general capital-gains computation
// sections) — restates the IDENTICAL cost-of-acquisition rule for "a
// long-term capital asset, being an equity share in a company or a unit of
// an equity oriented fund or a unit of a business trust referred to in
// section 198, acquired before the 1st February, 2018": higher of (a) the
// actual cost of acquisition, or (b) the lower of the fair market value as
// on 31 January 2018 and the sale consideration — i.e. the same
// max(actualCost, min(fmv, saleConsideration)) formula this engine already
// implements in grandfathering.ts, independently corroborated across two
// separate secondary-source fetches quoting matching verbatim statutory
// text (aubsp.com, eztax.in — both citing Section 90(7) with the identical
// wording; official incometaxindia.gov.in/indiankanoon.org direct fetches
// again returned HTTP 403, the same pattern already disclosed for
// Sections 196/198 above). grandfathering.ts's formula is a cost-basis rule
// keyed on ACQUISITION date, not disposal-date/governing-Act, so no code
// change was required — the existing unconditional-by-acquisition-date
// behaviour is now DIRECTLY SOURCED, not merely inferred. See
// R6_TAX_LEGAL_SOURCE_REGISTER.md Section 5 for the full citation.

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

/** R6-DEBTFIX (2026-08-22): the pre-existing capital-gains treatment for a
 * debt/specified-mutual-fund LOT ACQUIRED BEFORE `specifiedFundAcquiredOnOrAfter`
 * (1 April 2023) — Section 50AA / the Finance Act 2023 always-short-term rule
 * does NOT apply to such a lot; it retains the general Section 2(42A)/112
 * capital-asset treatment that predates the 2023 carve-out. This nested
 * regime is keyed by the RULE VERSION the lot's DISPOSAL falls into (same
 * effective-dated resolution as everything else in this module) because the
 * regime itself changed on 23 July 2024 (Finance (No. 2) Act, 2024 — see
 * docs/investment-intelligence/R6_TAX_LEGAL_SOURCE_REGISTER.md Section 4a):
 *   - Disposals before 23-Jul-2024: >36-month holding = LTCG @ 20%, WITH
 *     Cost-Inflation-Index indexation (Section 112, pre-Budget-2024).
 *   - Disposals on/after 23-Jul-2024: >24-month holding = LTCG @ 12.5%, NO
 *     indexation (Budget 2024 removed indexation across most non-equity
 *     asset classes, including this one — confirmed this is NOT the same as
 *     the optional 20%-indexed/12.5%-unindexed CHOICE that Budget 2024 later
 *     granted for land/building only; debt-fund LTCG has no such choice, it
 *     is mandatorily the new figure for any disposal on/after 23-Jul-2024).
 * Either side of that boundary, short-term gains remain taxed at slab rate,
 * same as the always-short-term branch. */
export interface LegacyDebtFundRegime {
  ltcgHoldingPeriodMonths: number;
  ltcgRatePct: number;
  /** When true, real indexation benefit is legally available for this
   * disposal-date window, but this engine does NOT compute an indexed cost
   * basis (no verified Cost Inflation Index table wired in yet) — the
   * caller must surface this as an honest limitation (see
   * capitalGainsEngine.ts's note text for the debt_specified/pre-2023-
   * acquisition/LTCG branch) rather than presenting the un-indexed figure as
   * final. */
  indexationAllowed: boolean;
  stcgTaxedAtSlabRate: true;
}

export interface DebtSpecifiedRules {
  /** The "specified mutual fund" rule (Finance Act 2023, Section 50AA)
   * applies to debt/specified funds ACQUIRED on/after this date — funds
   * acquired before retain the pre-2023-04-01 regime, modelled by
   * `legacyRegime` below (R6-DEBTFIX: previously this field was defined but
   * never consumed as a per-lot gate; capitalGainsEngine.ts now reads it). */
  specifiedFundAcquiredOnOrAfter: IsoDate;
  alwaysShortTerm: true;
  indexationAllowed: false;
  /** Taxed at the taxpayer's income-tax slab rate — this engine does not
   * know the household's slab (out of scope, forecasting/tax-return
   * territory), so it reports the gain as short-term/slab-rate-applicable
   * and leaves the actual rate for the user's CA to apply. */
  taxedAtSlabRate: true;
  /** Treatment for a lot acquired BEFORE `specifiedFundAcquiredOnOrAfter` —
   * see `LegacyDebtFundRegime` above. */
  legacyRegime: LegacyDebtFundRegime;
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
      'effective FY2023-24) and pre-Budget-2024 Section 112A rates. R6-DEBTFIX (2026-08-22): ' +
      'debtSpecified.legacyRegime for lots acquired before 2023-04-01 researched and verified 20% ' +
      'LTCG with CII indexation, 36-month threshold, under Section 112 as it stood before Budget ' +
      '2024 (ClearTax, ICICI Direct "Changes in taxation of non-equity funds from FY23-24", ' +
      'ValueResearchOnline — see R6_TAX_LEGAL_SOURCE_REGISTER.md Section 4a).',
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
      legacyRegime: {
        ltcgHoldingPeriodMonths: 36,
        ltcgRatePct: 20,
        indexationAllowed: true,
        stcgTaxedAtSlabRate: true,
      },
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
      'fund short-term-always rule (FY2023-24 Finance Act) unchanged. R6-DEBTFIX (2026-08-22): ' +
      'debtSpecified.legacyRegime for lots acquired before 2023-04-01 changed on this SAME 23-Jul-' +
      '2024 boundary — Budget 2024 shortened the non-equity/debt-fund LTCG holding threshold from ' +
      '36 to 24 months AND removed indexation, replacing 20%-with-indexation with a flat 12.5%-no-' +
      'indexation rate (mandatory for this disposal-date window, NOT the optional 20%-indexed/' +
      '12.5%-unindexed CHOICE Budget 2024 separately granted for land/building — confirmed distinct, ' +
      'see R6_TAX_LEGAL_SOURCE_REGISTER.md Section 4a). Verified via ValueResearchOnline, ' +
      'PrimeInvestor "Budget 2024 – how your equity & debt investments are taxed now", ICICI Direct.',
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
      legacyRegime: {
        ltcgHoldingPeriodMonths: 24,
        ltcgRatePct: 12.5,
        indexationAllowed: false,
        stcgTaxedAtSlabRate: true,
      },
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
 * for post-2026-04-01 disposals — RESOLVED (R6-SECURITY-FINAL, 2026-08-22):
 * Section 90(7)-(9) of the Income-tax Act, 2025 directly re-enacts the
 * identical 31-Jan-2018 FMV step-up formula for equity/equity-oriented-fund
 * units referred to in Section 198, acquired before 1 February 2018 — see
 * module header and R6_TAX_LEGAL_SOURCE_REGISTER.md Section 5. */
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
      'gains — are outside this engine\'s mutual-fund-disposal scope). R6-DEBTFIX (2026-08-22): ' +
      'debtSpecified.legacyRegime figures (24-month/12.5%/no-indexation) are carried forward ' +
      'UNCHANGED from RULE_1961_POST_20240723 by INFERENCE — no source found during this pass ' +
      'discusses the pre-2023-acquisition debt-fund legacy regime specifically under the 2025 Act ' +
      '(same class of gap as the grandfathering-continuity open item above: a cost/rate mechanic, ' +
      'not a headline provision, so less prominently covered by consumer tax explainers). ' +
      'Reasonably certain given the 2025 Act was repeatedly characterised as a renumbering/' +
      'consolidation exercise with no capital-gains policy change, but NOT independently section-' +
      'cited — flagged as an open item, not silently assumed. See R6_TAX_LEGAL_SOURCE_REGISTER.md ' +
      '"Open items".',
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
      legacyRegime: {
        ltcgHoldingPeriodMonths: 24,
        ltcgRatePct: 12.5,
        indexationAllowed: false,
        stcgTaxedAtSlabRate: true,
      },
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
