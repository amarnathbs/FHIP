// Investment Intelligence R6-SECURITY-FINAL closure — additive verification
// only. Does NOT modify the certified 142-case R6-P1 pack, its oracle, or
// any production arithmetic. Two closure items:
//
// 1. Grandfathering Act-transition continuity (spec Sections 19-24, 27):
//    the SAME eligible pre-1-Feb-2018 acquisition, disposed once under the
//    1961 Act (31-Mar-2026) and once under the 2025 Act (1-Apr-2026), must
//    produce IDENTICAL grandfathering treatment — this is what "directly
//    sourced, not silently inferred" actually has to prove at the
//    engine-behaviour level, on top of the legal citation itself (see
//    grandfathering.ts's header and R6_TAX_LEGAL_SOURCE_REGISTER.md
//    Section 5 for the Section 90(7)-(9), Income-tax Act 2025 citation).
//
// 2. Placeholder/uncertified-rule negative control (spec Section 27): using
//    a LOCAL clone of the rule-version table (never the real seed data),
//    prove the engine's existing disclaimer plumbing actually flags a
//    disposal computed under a `placeholder: true` rule version, and that
//    the REAL production 2025-Act row is genuinely `placeholder: false`
//    (i.e. today's real disposals are not silently running through an
//    unflagged, uncertified rule).

import { describe, it, expect } from 'vitest';
import { computeDisposalTax } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import { withTaxDisclaimer, PLACEHOLDER_RULE_DISCLAIMER } from '@/lib/engines/investment-intelligence/tax/disclaimer';
import {
  ALL_RULE_VERSIONS,
  RULE_2025_ACT_POST_20260401,
  resolveRuleVersion,
  type TaxRuleVersion,
} from '@/lib/engines/investment-intelligence/tax/ruleVersions';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';
import type { LotConsumption } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';

// II-PC1-F1: FIFO is now scoped to (account, instrument). Every case in this
// pre-existing suite is a single-folio scenario, so one shared account key
// preserves the original behaviour and expectations exactly.
const ACCOUNT = 'acct-r6-security-final';

function makeClassification(kind: 'equity_oriented' | 'debt_specified' | 'unresolved'): SchemeClassificationResult {
  return {
    instrumentKey: 'x',
    classification: kind,
    domesticEquityPct: kind === 'equity_oriented' ? 80 : null,
    basis: 'computed_from_holdings',
    disclosureDate: null,
    note: 'test fixture',
  };
}

describe('R6-SECURITY-FINAL closure — grandfathering continuity across the 1961-Act/2025-Act boundary', () => {
  const facts = { acquisitionDate: '2017-06-01', costPerUnit: 20, fmvPerUnit: 60, salePricePerUnit: 100, unitsConsumed: 100 };

  function run(disposalDate: string) {
    const consumption: LotConsumption = {
      disposalEventId: `d-${disposalDate}`,
      lotId: `l-${disposalDate}`,
      accountKey: ACCOUNT,
      instrumentKey: 'SCH-CONTINUITY',
      acquisitionDate: facts.acquisitionDate,
      kind: 'purchase',
      disposalDate,
      unitsConsumed: facts.unitsConsumed,
      costPerUnit: facts.costPerUnit,
      costBasis: facts.unitsConsumed * facts.costPerUnit,
      saleValueApportioned: facts.unitsConsumed * facts.salePricePerUnit,
    };
    return computeDisposalTax({
      consumption,
      saleValuePerUnit: facts.salePricePerUnit,
      classification: makeClassification('equity_oriented'),
      fmv31Jan2018PerUnit: facts.fmvPerUnit,
    });
  }

  it('a disposal the day before the 2025 Act takes effect (31-Mar-2026) applies grandfathering under the 1961 Act', () => {
    const r = run('2026-03-31');
    expect(r.ruleVersion).toBe('1961_act_post_20240723');
    expect(r.grandfathering?.eligible).toBe(true);
    expect(r.grandfathering?.basisSource).toBe('fmv_grandfathered');
    // max(actualCost=20, min(fmv=60, sale=100)) = 60
    expect(r.costBasisUsed).toBeCloseTo(60 * facts.unitsConsumed, 6);
  });

  it('the SAME eligible facts, disposed the day the 2025 Act takes effect (1-Apr-2026), apply the IDENTICAL grandfathering treatment', () => {
    const r = run('2026-04-01');
    expect(r.ruleVersion).toBe('2025_act_post_20260401');
    expect(r.grandfathering?.eligible).toBe(true);
    expect(r.grandfathering?.basisSource).toBe('fmv_grandfathered');
    expect(r.costBasisUsed).toBeCloseTo(60 * facts.unitsConsumed, 6);
  });

  it('continuity: pre- and post-2025-Act results are numerically identical for identical facts, only ruleVersion differs', () => {
    const pre = run('2026-03-31');
    const post = run('2026-04-01');
    expect(pre.ruleVersion).not.toBe(post.ruleVersion);
    expect(post.costBasisUsed).toBeCloseTo(pre.costBasisUsed, 6);
    expect(post.taxableGain).toBeCloseTo(pre.taxableGain!, 6);
    expect(post.grandfathering?.basisSource).toBe(pre.grandfathering?.basisSource);
  });

  it('the REAL production 2025-Act rule version is genuinely certified (placeholder: false) — today’s disposals are not silently running through an unflagged inference', () => {
    expect(RULE_2025_ACT_POST_20260401.ruleDefinition.placeholder).toBe(false);
    const resolved = resolveRuleVersion('2026-04-01');
    expect(resolved.version).toBe('2025_act_post_20260401');
    expect(resolved.ruleDefinition.placeholder).toBe(false);
  });
});

describe('R6-SECURITY-FINAL closure — negative control: an uncertified rule version is never silently treated as authoritative', () => {
  it('a LOCALLY CLONED rule set with placeholder:true for the governing version causes the engine to report ruleVersionPlaceholder:true and the orchestrator to attach PLACEHOLDER_RULE_DISCLAIMER', () => {
    // Deep-clone ALL_RULE_VERSIONS and flip only the 2025-Act row's
    // placeholder flag — this NEVER touches the real exported constant or
    // the DB seed, only a local array passed via computeDisposalTax's own
    // `ruleVersions` override parameter (the same seam production code
    // would use if a future Finance Act amendment genuinely couldn't be
    // verified in time).
    const uncertifiedVersions: TaxRuleVersion[] = ALL_RULE_VERSIONS.map((v) =>
      v.version === '2025_act_post_20260401'
        ? { ...v, ruleDefinition: { ...v.ruleDefinition, placeholder: true } }
        : v
    );

    const consumption: LotConsumption = {
      disposalEventId: 'neg-1', lotId: 'neg-1', accountKey: ACCOUNT, instrumentKey: 'SCH-NEG',
      acquisitionDate: '2020-01-01', kind: 'purchase', disposalDate: '2026-06-15',
      unitsConsumed: 10, costPerUnit: 100, costBasis: 1000, saleValueApportioned: 1500,
    };
    const result = computeDisposalTax({
      consumption,
      saleValuePerUnit: 150,
      classification: makeClassification('equity_oriented'),
      fmv31Jan2018PerUnit: null,
      ruleVersions: uncertifiedVersions,
    });

    expect(result.ruleVersion).toBe('2025_act_post_20260401');
    expect(result.ruleVersionPlaceholder).toBe(true);

    const withDisclaimer = withTaxDisclaimer(result, { placeholderRuleUsed: result.ruleVersionPlaceholder });
    expect(withDisclaimer.ruleVersionNote).toBe(PLACEHOLDER_RULE_DISCLAIMER);

    // Restore/positive-control: the REAL (unmodified) rule set for the
    // identical disposal does NOT carry the placeholder flag.
    const realResult = computeDisposalTax({
      consumption,
      saleValuePerUnit: 150,
      classification: makeClassification('equity_oriented'),
      fmv31Jan2018PerUnit: null,
    });
    expect(realResult.ruleVersionPlaceholder).toBe(false);
    const realWithDisclaimer = withTaxDisclaimer(realResult, { placeholderRuleUsed: realResult.ruleVersionPlaceholder });
    expect(realWithDisclaimer.ruleVersionNote).toBeUndefined();
  });
});
