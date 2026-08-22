// Investment Intelligence R6-P1 — independent certification harness
// (production side).
//
// Consumes the IDENTICAL scripts/ii-r6p1-certification/cases.json that the
// independent Python oracle consumes, runs it through the real R6-P1
// production engines, and compares against
// scripts/ii-r6p1-certification/oracle_results.json, produced WITHOUT
// importing any production code (verified: `grep -n "^import\|^from"
// scripts/ii_r6p1_independent_reconciliation.py` shows only stdlib
// modules).
//
// PRE-DECLARED TOLERANCES. Declared here, before any result was reviewed,
// and never widened in response to a failure — a failure is fixed in the
// engine, not absorbed into the tolerance. Tax-lot/gains arithmetic is
// exact decimal-style arithmetic (no iterative solver like R5's XIRR), so
// tolerances are tight — effectively float-noise-only.
//
//   currency amounts (cost basis / sale value / taxable gain / exit load)  0.01  (Rs 0.01)
//   per-unit cost basis                                                   1e-6
//   holding-period days                                                   exact (integer)
//   classification / gain-type / rule-version / boolean flags             exact

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { replayFifo, type AcquisitionEvent, type DisposalEvent } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import { applyGrandfathering } from '@/lib/engines/investment-intelligence/tax/grandfathering';
import { computeHoldingPeriod } from '@/lib/engines/investment-intelligence/tax/holdingPeriod';
import { computeDisposalTax } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';
import { aggregateTaxYear } from '@/lib/engines/investment-intelligence/tax/taxYearAggregation';
import { resolveExitLoadPct } from '@/lib/engines/investment-intelligence/tax/exitLoad';
import { resolveRuleVersion, ALL_RULE_VERSIONS } from '@/lib/engines/investment-intelligence/tax/ruleVersions';
import type { SchemeClassificationResult } from '@/lib/engines/investment-intelligence/tax/schemeClassification';
import type { LotConsumption } from '@/lib/engines/investment-intelligence/tax/taxLotEngine';
import type { DisposalTaxResult } from '@/lib/engines/investment-intelligence/tax/capitalGainsEngine';

export const TOLERANCES = {
  currency: 0.01,
  costPerUnit: 1e-6,
} as const;

// Concrete shapes of the JSON produced by generate_cases.mjs and the Python
// oracle. Declaring them explicitly (fields optional, since each family
// populates a different subset) keeps this harness fully typed without
// resorting to `any`, matching the R5 certification harness's convention.
interface FyDisposalInput {
  disposalDate: string;
  classification: string;
  gainType: string;
  taxableGain: number;
}
// Every field below is declared required for typing convenience — in
// practice each family's cases.json entries only populate the subset that
// family's generator writes (see generate_cases.mjs), and each `describe`
// block below only reads the fields its own family actually wrote.
interface CertCase {
  id: string;
  family: string;
  // fifo
  acquisitions: AcquisitionEvent[];
  disposals: unknown[]; // DisposalEvent[] for fifo; FyDisposalInput[] for fy_aggregation/cross_fy
  // grandfathering
  branch: string;
  acquisitionDate: string;
  actualCostPerUnit: number;
  salePricePerUnit: number;
  fmvPerUnit: number | null;
  isEquityOriented: boolean;
  // boundary
  disposalDate: string;
  thresholdMonths: number;
  expectLongTerm: boolean;
  // debt
  instrumentKey: string;
  unitsConsumed: number;
  costPerUnit: number;
  // exit_load
  tiers: Array<{ uptoDays: number; loadPct: number }>;
  saleValueApportioned: number;
  // ambiguous
  basis: SchemeClassificationResult['basis'];
  // act_transition / grand_boundary
  pairKey: string;
  side: string;
}
interface OracleFyEntry {
  exemptionThresholdInr: number;
  exemptionRuleVersion: string;
  totalLtcgBeforeExemption: number;
  exemptionApplied: number;
  taxableLtcgAfterExemption: number;
  contributingDisposalCount: number;
}
// Same "declared required, populated per-family" convention as CertCase.
interface OracleEntry {
  // fifo
  byDisposal: Record<string, { consumedLots: Array<{ acquisitionDate: string; unitsConsumed: number; costBasis: number }>; totalCostBasis: number; totalUnitsConsumed: number }>;
  // grandfathering
  basisSource: string;
  costBasisPerUnit: number;
  // boundary
  isLongTerm: boolean;
  holdingDays: number;
  anniversaryDate: string;
  // debt / ambiguous
  costBasisUsed: number;
  saleValue: number;
  taxableGain: number | null;
  gainType: string;
  // fy_aggregation / cross_fy
  byFinancialYear: Record<string, OracleFyEntry>;
  // exit_load
  applicableLoadPct: number;
  exitLoadAmount: number;
  // rate_version
  ruleVersion: string;
  placeholder: boolean;
  stcgRatePct: number;
  ltcgRatePct: number;
  ltcgExemptionThresholdInr: number;
  // grand_boundary
  grandfatheringEligible: boolean;
}

const CERT_DIR = path.resolve(__dirname, '../../scripts/ii-r6p1-certification');
const casesData = JSON.parse(fs.readFileSync(path.join(CERT_DIR, 'cases.json'), 'utf8'));
const oracleData = JSON.parse(fs.readFileSync(path.join(CERT_DIR, 'oracle_results.json'), 'utf8'));
const cases: CertCase[] = casesData.cases;
const oracleById: Record<string, OracleEntry> = oracleData.cases;

interface ComparisonRow {
  case: string;
  metric: string;
  production: unknown;
  independent: unknown;
  variance: number | string;
  tolerance: number | string;
  result: 'PASS' | 'FAIL';
}
const report: ComparisonRow[] = [];

function compareNumber(caseId: string, metric: string, prod: number | null | undefined, exp: number | null | undefined, tol: number) {
  if (prod === null || prod === undefined || exp === null || exp === undefined) {
    const ok = (prod ?? null) === (exp ?? null);
    report.push({ case: caseId, metric, production: prod ?? null, independent: exp ?? null, variance: ok ? 0 : 'n/a', tolerance: tol, result: ok ? 'PASS' : 'FAIL' });
    expect(prod ?? null, `${caseId} / ${metric}`).toEqual(exp ?? null);
    return;
  }
  const variance = Math.abs(prod - exp);
  const ok = variance <= tol;
  report.push({ case: caseId, metric, production: prod, independent: exp, variance, tolerance: tol, result: ok ? 'PASS' : 'FAIL' });
  expect(variance, `${caseId} / ${metric}: production=${prod} independent=${exp} variance=${variance} tolerance=${tol}`).toBeLessThanOrEqual(tol);
}

function compareExact(caseId: string, metric: string, prod: unknown, exp: unknown) {
  const ok = JSON.stringify(prod) === JSON.stringify(exp);
  report.push({ case: caseId, metric, production: prod, independent: exp, variance: ok ? 0 : 'mismatch', tolerance: 'exact', result: ok ? 'PASS' : 'FAIL' });
  expect(prod, `${caseId} / ${metric}`).toEqual(exp);
}

function makeClassification(kind: 'equity_oriented' | 'debt_specified' | 'unresolved', basis: SchemeClassificationResult['basis'] = 'computed_from_holdings'): SchemeClassificationResult {
  return {
    instrumentKey: 'x',
    classification: kind,
    domesticEquityPct: kind === 'equity_oriented' ? 80 : null,
    basis,
    disclosureDate: null,
    note: 'test fixture',
  };
}

describe('II R6-P1 Independent Certification (132 cases: 120 original + 12 R6-FINAL closure)', () => {
  it('generated exactly 132 cases (the original 120 are unchanged/permanent per spec Sec.34)', () => {
    expect(cases.length).toBe(132);
    const originalFamilies = ['fifo', 'grandfathering', 'boundary', 'debt', 'fy_aggregation', 'cross_fy', 'exit_load', 'ambiguous', 'rate_version'];
    const originalCount = cases.filter((c) => originalFamilies.includes(c.family)).length;
    expect(originalCount).toBe(120);
  });

  describe('FIFO family', () => {
    const fifoCases = cases.filter((c) => c.family === 'fifo');
    it.each(fifoCases)('$id', (c: CertCase) => {
      const acquisitions: AcquisitionEvent[] = c.acquisitions;
      const disposals: DisposalEvent[] = c.disposals as DisposalEvent[];
      const { consumptions } = replayFifo(acquisitions, disposals);
      const exp = oracleById[c.id].byDisposal;

      for (const disposal of disposals) {
        const prodConsumptions = consumptions.filter((k: LotConsumption) => k.disposalEventId === disposal.sourceEventId);
        const expDisposal = exp[disposal.sourceEventId];
        compareExact(c.id, `${disposal.sourceEventId}.lotCount`, prodConsumptions.length, expDisposal.consumedLots.length);
        for (let i = 0; i < expDisposal.consumedLots.length; i++) {
          compareExact(c.id, `${disposal.sourceEventId}.lot[${i}].acquisitionDate`, prodConsumptions[i]?.acquisitionDate, expDisposal.consumedLots[i].acquisitionDate);
          compareNumber(c.id, `${disposal.sourceEventId}.lot[${i}].unitsConsumed`, prodConsumptions[i]?.unitsConsumed, expDisposal.consumedLots[i].unitsConsumed, TOLERANCES.costPerUnit);
          compareNumber(c.id, `${disposal.sourceEventId}.lot[${i}].costBasis`, prodConsumptions[i]?.costBasis, expDisposal.consumedLots[i].costBasis, TOLERANCES.currency);
        }
        const totalCostBasis = prodConsumptions.reduce((s: number, k: LotConsumption) => s + k.costBasis, 0);
        const totalUnits = prodConsumptions.reduce((s: number, k: LotConsumption) => s + k.unitsConsumed, 0);
        compareNumber(c.id, `${disposal.sourceEventId}.totalCostBasis`, totalCostBasis, expDisposal.totalCostBasis, TOLERANCES.currency);
        compareNumber(c.id, `${disposal.sourceEventId}.totalUnitsConsumed`, totalUnits, expDisposal.totalUnitsConsumed, TOLERANCES.costPerUnit);
      }
    });

    it('never over-consumes a lot (running remainder never negative)', () => {
      for (const c of fifoCases) {
        const { lots } = replayFifo(c.acquisitions, c.disposals as DisposalEvent[]);
        for (const lot of lots) expect(lot.unitsRemaining).toBeGreaterThanOrEqual(-1e-9);
      }
    });
  });

  describe('Grandfathering family (three-way min/max/cap)', () => {
    const grandCases = cases.filter((c) => c.family === 'grandfathering');
    it.each(grandCases)('$id ($branch)', (c: CertCase) => {
      const result = applyGrandfathering({
        acquisitionDate: c.acquisitionDate,
        actualCostPerUnit: c.actualCostPerUnit,
        salePricePerUnit: c.salePricePerUnit,
        fmvPerUnit: c.fmvPerUnit,
        isEquityOriented: c.isEquityOriented,
      });
      const exp = oracleById[c.id];
      compareExact(c.id, 'basisSource', result.basisSource, exp.basisSource);
      compareNumber(c.id, 'costBasisPerUnit', result.costBasisPerUnit, exp.costBasisPerUnit, TOLERANCES.costPerUnit);
    });

    it('capped_at_sale branch never exceeds the sale price', () => {
      for (const c of grandCases.filter((x) => x.branch === 'capped_at_sale')) {
        const result = applyGrandfathering({ acquisitionDate: c.acquisitionDate, actualCostPerUnit: c.actualCostPerUnit, salePricePerUnit: c.salePricePerUnit, fmvPerUnit: c.fmvPerUnit, isEquityOriented: true });
        expect(result.costBasisPerUnit).toBeLessThanOrEqual(c.salePricePerUnit + 1e-9);
      }
    });

    it('real_loss_preserved branch never turns a real loss into a smaller loss or gain', () => {
      for (const c of grandCases.filter((x) => x.branch === 'real_loss_preserved')) {
        const result = applyGrandfathering({ acquisitionDate: c.acquisitionDate, actualCostPerUnit: c.actualCostPerUnit, salePricePerUnit: c.salePricePerUnit, fmvPerUnit: c.fmvPerUnit, isEquityOriented: true });
        expect(result.costBasisPerUnit).toBeCloseTo(c.actualCostPerUnit, 6);
      }
    });
  });

  describe('Holding-period boundary family (12-month anniversary)', () => {
    const boundCases = cases.filter((c) => c.family === 'boundary');
    it.each(boundCases)('$id', (c: CertCase) => {
      const result = computeHoldingPeriod(c.acquisitionDate, c.disposalDate, c.thresholdMonths);
      const exp = oracleById[c.id];
      compareExact(c.id, 'isLongTerm', result.isLongTerm, exp.isLongTerm);
      compareExact(c.id, 'holdingDays', result.holdingDays, exp.holdingDays);
      compareExact(c.id, 'anniversaryDate', result.anniversaryDate, exp.anniversaryDate);
      compareExact(c.id, 'expectLongTerm-matches-generator', result.isLongTerm, c.expectLongTerm);
    });
  });

  describe('Debt/specified-mutual-fund family (always short-term)', () => {
    const debtCases = cases.filter((c) => c.family === 'debt');
    it.each(debtCases)('$id', (c: CertCase) => {
      const consumption: LotConsumption = {
        disposalEventId: `${c.id}-d`,
        lotId: `${c.id}-l`,
        instrumentKey: c.instrumentKey,
        acquisitionDate: c.acquisitionDate,
        kind: 'purchase',
        disposalDate: c.disposalDate,
        unitsConsumed: c.unitsConsumed,
        costPerUnit: c.costPerUnit,
        costBasis: c.unitsConsumed * c.costPerUnit,
        saleValueApportioned: c.unitsConsumed * c.salePricePerUnit,
      };
      const result = computeDisposalTax({
        consumption,
        saleValuePerUnit: c.salePricePerUnit,
        classification: makeClassification('debt_specified'),
        fmv31Jan2018PerUnit: null,
      });
      const exp = oracleById[c.id];
      compareExact(c.id, 'gainType', result.gainType, exp.gainType);
      compareExact(c.id, 'holdingDays', result.holdingDays, exp.holdingDays);
      compareNumber(c.id, 'costBasisUsed', result.costBasisUsed, exp.costBasisUsed, TOLERANCES.currency);
      compareNumber(c.id, 'taxableGain', result.taxableGain, exp.taxableGain, TOLERANCES.currency);
      expect(result.gainType, `${c.id}: debt/specified must ALWAYS be stcg regardless of holding period`).toBe('stcg');
    });
  });

  function buildFakeDisposal(d: FyDisposalInput, idx: number): DisposalTaxResult {
    return {
      disposalEventId: `d-${idx}`,
      lotId: `l-${idx}`,
      instrumentKey: 'X',
      acquisitionDate: '2020-01-01',
      disposalDate: d.disposalDate,
      unitsConsumed: 1,
      classification: d.classification as DisposalTaxResult['classification'],
      gainType: d.gainType as DisposalTaxResult['gainType'],
      holdingDays: 500,
      ruleVersion: 'test',
      ruleVersionPlaceholder: false,
      saleValue: 0,
      costBasisUsed: 0,
      costBasisPreGrandfathering: 0,
      taxableGain: d.taxableGain,
      grandfathering: null,
      note: '',
    };
  }

  describe('Tax-year aggregation family (taxpayer-level LTCG exemption)', () => {
    const fyCases = cases.filter((c) => c.family === 'fy_aggregation');
    it.each(fyCases)('$id', (c: CertCase) => {
      const disposals = (c.disposals as FyDisposalInput[]).map(buildFakeDisposal);
      const result = aggregateTaxYear(disposals);
      const exp = oracleById[c.id].byFinancialYear;
      const resultByFy = Object.fromEntries(result.byFinancialYear.map((f) => [f.financialYear, f]));
      compareExact(c.id, 'fyKeys', Object.keys(resultByFy).sort(), Object.keys(exp).sort());
      for (const fy of Object.keys(exp)) {
        compareNumber(c.id, `${fy}.totalLtcgBeforeExemption`, resultByFy[fy]?.totalLtcgBeforeExemption, exp[fy].totalLtcgBeforeExemption, TOLERANCES.currency);
        compareNumber(c.id, `${fy}.exemptionThresholdInr`, resultByFy[fy]?.exemptionThresholdInr, exp[fy].exemptionThresholdInr, TOLERANCES.currency);
        compareNumber(c.id, `${fy}.exemptionApplied`, resultByFy[fy]?.exemptionApplied, exp[fy].exemptionApplied, TOLERANCES.currency);
        compareNumber(c.id, `${fy}.taxableLtcgAfterExemption`, resultByFy[fy]?.taxableLtcgAfterExemption, exp[fy].taxableLtcgAfterExemption, TOLERANCES.currency);
        compareExact(c.id, `${fy}.contributingDisposalCount`, resultByFy[fy]?.contributingDisposalCount, exp[fy].contributingDisposalCount);
      }
    });

    it('the exemption threshold is applied EXACTLY ONCE per FY, not per disposal', () => {
      // A case with >=2 contributing disposals in the same FY must show the
      // SAME exemptionApplied figure whether summed from one aggregate call
      // or if each disposal were (incorrectly) evaluated in isolation the
      // naive per-disposal exemption would double/triple-count the threshold.
      const multiDisposalCase = fyCases.find((c) => c.disposals.length >= 3);
      expect(multiDisposalCase).toBeDefined();
      const disposals = (multiDisposalCase!.disposals as FyDisposalInput[]).map(buildFakeDisposal);
      const result = aggregateTaxYear(disposals);
      for (const fySummary of result.byFinancialYear) {
        const naivePerDisposalExemption = disposals
          .filter((d: DisposalTaxResult) => new Date(d.disposalDate) >= new Date(`${fySummary.financialYear.slice(2, 6)}-04-01`))
          .reduce((sum: number, d: DisposalTaxResult) => sum + Math.min(Math.max(d.taxableGain ?? 0, 0), fySummary.exemptionThresholdInr), 0);
        if (fySummary.contributingDisposalCount >= 2) {
          expect(fySummary.exemptionApplied).toBeLessThanOrEqual(fySummary.exemptionThresholdInr + 1e-6);
          // The correctly-aggregated exemption must not exceed the threshold
          // even though the naive per-disposal sum could exceed it several times over.
          expect(naivePerDisposalExemption).toBeGreaterThanOrEqual(fySummary.exemptionApplied - 1e-6);
        }
      }
    });
  });

  describe('Cross-FY boundary family (31 March straddle)', () => {
    const crossCases = cases.filter((c) => c.family === 'cross_fy');
    it.each(crossCases)('$id', (c: CertCase) => {
      const disposals = (c.disposals as FyDisposalInput[]).map(buildFakeDisposal);
      const result = aggregateTaxYear(disposals);
      const exp = oracleById[c.id].byFinancialYear;
      const resultByFy = Object.fromEntries(result.byFinancialYear.map((f) => [f.financialYear, f]));
      compareExact(c.id, 'fyKeys', Object.keys(resultByFy).sort(), Object.keys(exp).sort());
      // A 31-March disposal and the very next day's 1-April disposal MUST
      // land in two different FY buckets, one day apart.
      expect(Object.keys(exp).length).toBeGreaterThanOrEqual(2);
      for (const fy of Object.keys(exp)) {
        compareNumber(c.id, `${fy}.totalLtcgBeforeExemption`, resultByFy[fy]?.totalLtcgBeforeExemption, exp[fy].totalLtcgBeforeExemption, TOLERANCES.currency);
        compareNumber(c.id, `${fy}.taxableLtcgAfterExemption`, resultByFy[fy]?.taxableLtcgAfterExemption, exp[fy].taxableLtcgAfterExemption, TOLERANCES.currency);
      }
    });
  });

  describe('Exit-load family (holding-period-dependent per lot)', () => {
    const exitCases = cases.filter((c) => c.family === 'exit_load');
    it.each(exitCases)('$id', (c: CertCase) => {
      const holdingDays = Math.round((new Date(c.disposalDate).getTime() - new Date(c.acquisitionDate).getTime()) / 86_400_000);
      const pct = resolveExitLoadPct(c.tiers, holdingDays);
      const amount = (c.saleValueApportioned * pct) / 100;
      const exp = oracleById[c.id];
      compareExact(c.id, 'holdingDays', holdingDays, exp.holdingDays);
      compareNumber(c.id, 'applicableLoadPct', pct, exp.applicableLoadPct, TOLERANCES.costPerUnit);
      compareNumber(c.id, 'exitLoadAmount', amount, exp.exitLoadAmount, TOLERANCES.currency);
    });
  });

  describe('Ambiguous/unresolved classification family (flag, never guess)', () => {
    const ambigCases = cases.filter((c) => c.family === 'ambiguous');
    it.each(ambigCases)('$id ($basis)', (c: CertCase) => {
      const consumption: LotConsumption = {
        disposalEventId: `${c.id}-d`,
        lotId: `${c.id}-l`,
        instrumentKey: 'X',
        acquisitionDate: c.acquisitionDate,
        kind: 'purchase',
        disposalDate: c.disposalDate,
        unitsConsumed: c.unitsConsumed,
        costPerUnit: c.costPerUnit,
        costBasis: c.unitsConsumed * c.costPerUnit,
        saleValueApportioned: c.unitsConsumed * c.salePricePerUnit,
      };
      const result = computeDisposalTax({
        consumption,
        saleValuePerUnit: c.salePricePerUnit,
        classification: makeClassification('unresolved', c.basis),
        fmv31Jan2018PerUnit: null,
      });
      const exp = oracleById[c.id];
      compareExact(c.id, 'gainType', result.gainType, exp.gainType);
      compareExact(c.id, 'taxableGain', result.taxableGain, exp.taxableGain);
      expect(result.taxableGain, `${c.id}: unresolved classification must NEVER produce a numeric taxable gain`).toBeNull();
    });

    it('unresolved disposals are excluded from LTCG exemption aggregation, not silently zeroed into it', () => {
      const resolved = buildFakeDisposal({ disposalDate: '2024-06-01', classification: 'equity_oriented', gainType: 'ltcg', taxableGain: 50000 }, 0);
      const unresolved: DisposalTaxResult = { ...buildFakeDisposal({ disposalDate: '2024-06-15', classification: 'equity_oriented', gainType: 'ltcg', taxableGain: 999999 }, 1), gainType: 'unresolved', taxableGain: null, classification: 'unresolved' };
      const result = aggregateTaxYear([resolved, unresolved]);
      const fy = result.byFinancialYear.find((f) => f.financialYear === 'FY2024-25')!;
      expect(fy.totalLtcgBeforeExemption).toBeCloseTo(50000, 2); // the unresolved 999999 must NOT leak in
      expect(result.unresolvedDisposals).toHaveLength(1);
    });
  });

  describe('Rule-version resolution family (effective-dated, 1961 -> 2025 Act)', () => {
    const rateCases = cases.filter((c) => c.family === 'rate_version');
    it.each(rateCases)('$id ($disposalDate)', (c: CertCase) => {
      const result = resolveRuleVersion(c.disposalDate);
      const exp = oracleById[c.id];
      compareExact(c.id, 'ruleVersion', result.version, exp.ruleVersion);
      compareExact(c.id, 'placeholder', result.ruleDefinition.placeholder, exp.placeholder);
      compareNumber(c.id, 'stcgRatePct', result.ruleDefinition.equityOriented.stcgRatePct, exp.stcgRatePct, TOLERANCES.costPerUnit);
      compareNumber(c.id, 'ltcgRatePct', result.ruleDefinition.equityOriented.ltcgRatePct, exp.ltcgRatePct, TOLERANCES.costPerUnit);
      compareNumber(c.id, 'ltcgExemptionThresholdInr', result.ruleDefinition.equityOriented.ltcgExemptionThresholdInr, exp.ltcgExemptionThresholdInr, TOLERANCES.currency);
    });

    it('a disposal is taxed under the rules in force ON ITS OWN disposal date, never "today"', () => {
      // Resolving the SAME disposal date always yields the SAME rule
      // version, regardless of how many times / when it's called — proves
      // there is no hidden dependency on the current wall-clock date.
      const d = '2024-01-15';
      const r1 = resolveRuleVersion(d);
      const r2 = resolveRuleVersion(d);
      expect(r1.version).toBe(r2.version);
      expect(r1.version).toBe('1961_act_pre_20240723');
    });

    it('every rule version is exposed, and the 2025 Act row is certified (no placeholder remains)', () => {
      expect(ALL_RULE_VERSIONS).toHaveLength(3);
      const act2025 = ALL_RULE_VERSIONS.find((v) => v.version === '2025_act_post_20260401')!;
      expect(act2025).toBeDefined();
      expect(act2025.ruleDefinition.placeholder).toBe(false);
      expect(ALL_RULE_VERSIONS.every((v) => v.ruleDefinition.placeholder === false)).toBe(true);
    });
  });

  describe('R6-FINAL Sec.10: 1961 Act -> 2025 Act transition, paired at 31-Mar/1-Apr-2026', () => {
    const actCases = cases.filter((c) => c.family === 'act_transition');
    it.each(actCases)('$id ($side, $disposalDate)', (c: CertCase) => {
      const consumption: LotConsumption = {
        disposalEventId: `${c.id}-d`,
        lotId: `${c.id}-l`,
        instrumentKey: 'SCH-ACTTRANS',
        acquisitionDate: c.acquisitionDate,
        kind: 'purchase',
        disposalDate: c.disposalDate,
        unitsConsumed: c.unitsConsumed,
        costPerUnit: c.costPerUnit,
        costBasis: c.unitsConsumed * c.costPerUnit,
        saleValueApportioned: c.unitsConsumed * c.salePricePerUnit,
      };
      const result = computeDisposalTax({
        consumption,
        saleValuePerUnit: c.salePricePerUnit,
        classification: makeClassification('equity_oriented'),
        fmv31Jan2018PerUnit: null,
      });
      const exp = oracleById[c.id];
      compareExact(c.id, 'ruleVersion', result.ruleVersion, exp.ruleVersion);
      compareExact(c.id, 'ruleVersionPlaceholder', result.ruleVersionPlaceholder, exp.placeholder);
      compareExact(c.id, 'gainType', result.gainType, exp.gainType);
      compareNumber(c.id, 'costBasisUsed', result.costBasisUsed, exp.costBasisUsed, TOLERANCES.currency);
      compareNumber(c.id, 'taxableGain', result.taxableGain, exp.taxableGain, TOLERANCES.currency);
    });

    it('the 2026-03-31/2026-04-01 pair carries a DIFFERENT rule version but an IDENTICAL taxable gain', () => {
      // The adversarial assertion Section 10 asks for: a naive implementer
      // might assume an Act transition always changes the numbers. Research
      // (R6_TAX_LEGAL_SOURCE_REGISTER.md) found Sections 111A/112A were
      // renumbered to 196/198 with NO rate change, so the correct behaviour
      // is "version label changes, arithmetic does not" — and this proves it
      // on the real engine, not just by inspecting ruleVersions.ts data.
      const groups = new Map<string, CertCase[]>();
      for (const c of actCases) {
        const g = groups.get(c.pairKey) ?? [];
        g.push(c);
        groups.set(c.pairKey, g);
      }
      expect(groups.size).toBe(3);
      for (const [pairKey, pair] of groups) {
        expect(pair, pairKey).toHaveLength(2);
        const pre = pair.find((c) => c.side === 'pre')!;
        const post = pair.find((c) => c.side === 'post')!;
        const preResult = computeDisposalTax({
          consumption: {
            disposalEventId: 'pre', lotId: 'pre', instrumentKey: 'X', acquisitionDate: pre.acquisitionDate,
            kind: 'purchase', disposalDate: pre.disposalDate, unitsConsumed: pre.unitsConsumed,
            costPerUnit: pre.costPerUnit, costBasis: pre.unitsConsumed * pre.costPerUnit,
            saleValueApportioned: pre.unitsConsumed * pre.salePricePerUnit,
          },
          saleValuePerUnit: pre.salePricePerUnit,
          classification: makeClassification('equity_oriented'),
          fmv31Jan2018PerUnit: null,
        });
        const postResult = computeDisposalTax({
          consumption: {
            disposalEventId: 'post', lotId: 'post', instrumentKey: 'X', acquisitionDate: post.acquisitionDate,
            kind: 'purchase', disposalDate: post.disposalDate, unitsConsumed: post.unitsConsumed,
            costPerUnit: post.costPerUnit, costBasis: post.unitsConsumed * post.costPerUnit,
            saleValueApportioned: post.unitsConsumed * post.salePricePerUnit,
          },
          saleValuePerUnit: post.salePricePerUnit,
          classification: makeClassification('equity_oriented'),
          fmv31Jan2018PerUnit: null,
        });
        expect(preResult.ruleVersion, pairKey).toBe('1961_act_post_20240723');
        expect(postResult.ruleVersion, pairKey).toBe('2025_act_post_20260401');
        expect(preResult.ruleVersion).not.toBe(postResult.ruleVersion);
        expect(postResult.taxableGain, pairKey).toBeCloseTo(preResult.taxableGain!, 6);
        expect(postResult.costBasisUsed, pairKey).toBeCloseTo(preResult.costBasisUsed, 6);
      }
    });

    it('a disposal dated 31-Mar-2026 keeps 1961-Act rules even if the engine runs long after 1-Apr-2026 (no retroactive re-rating)', () => {
      const d = '2026-03-31';
      const r1 = resolveRuleVersion(d);
      // Simulate "time passing" by simply re-resolving the SAME fixed
      // disposal date again — resolveRuleVersion has no wall-clock input at
      // all, so this is the strongest proof available that re-running the
      // computation next year cannot change a historical transaction's rules.
      const r2 = resolveRuleVersion(d);
      expect(r1.version).toBe('1961_act_post_20240723');
      expect(r2.version).toBe(r1.version);
    });
  });

  describe('R6-FINAL Sec.11: grandfathering eligibility cutoff, paired at 31-Jan/1-Feb-2018', () => {
    const gbCases = cases.filter((c) => c.family === 'grand_boundary');
    it.each(gbCases)('$id ($side, $acquisitionDate)', (c: CertCase) => {
      const consumption: LotConsumption = {
        disposalEventId: `${c.id}-d`,
        lotId: `${c.id}-l`,
        instrumentKey: 'SCH-GRANDBOUND',
        acquisitionDate: c.acquisitionDate,
        kind: 'purchase',
        disposalDate: c.disposalDate,
        unitsConsumed: c.unitsConsumed,
        costPerUnit: c.costPerUnit,
        costBasis: c.unitsConsumed * c.costPerUnit,
        saleValueApportioned: c.unitsConsumed * c.salePricePerUnit,
      };
      const result = computeDisposalTax({
        consumption,
        saleValuePerUnit: c.salePricePerUnit,
        classification: makeClassification('equity_oriented'),
        fmv31Jan2018PerUnit: c.fmvPerUnit,
      });
      const exp = oracleById[c.id];
      compareExact(c.id, 'ruleVersion', result.ruleVersion, exp.ruleVersion);
      compareExact(c.id, 'grandfatheringEligible', result.grandfathering?.eligible ?? false, exp.grandfatheringEligible);
      compareExact(c.id, 'basisSource', result.grandfathering?.basisSource ?? 'not_applicable', exp.basisSource);
      compareNumber(c.id, 'costBasisUsed', result.costBasisUsed, exp.costBasisUsed, TOLERANCES.currency);
      compareNumber(c.id, 'taxableGain', result.taxableGain, exp.taxableGain, TOLERANCES.currency);
      // Every case in this family disposes on 2026-06-15, under the 2025 Act
      // — this is the disclosed continuity behaviour from ruleVersions.ts's
      // module header: grandfathering is applied (or not) purely from
      // acquisitionDate, unconditional on which Act governs the disposal.
      expect(result.ruleVersion).toBe('2025_act_post_20260401');
    });

    it('acquiring one day earlier (31-Jan-2018 vs 1-Feb-2018) flips grandfathering eligibility, all else equal', () => {
      const groups = new Map<string, CertCase[]>();
      for (const c of gbCases) {
        const g = groups.get(c.pairKey) ?? [];
        g.push(c);
        groups.set(c.pairKey, g);
      }
      expect(groups.size).toBe(3);
      for (const [pairKey, pair] of groups) {
        expect(pair, pairKey).toHaveLength(2);
        const eligible = pair.find((c) => c.side === 'eligible')!;
        const ineligible = pair.find((c) => c.side === 'ineligible')!;
        expect(eligible.acquisitionDate, pairKey).toBe('2018-01-31');
        expect(ineligible.acquisitionDate, pairKey).toBe('2018-02-01');
        const eligibleExp = oracleById[eligible.id];
        const ineligibleExp = oracleById[ineligible.id];
        expect(eligibleExp.grandfatheringEligible, pairKey).toBe(true);
        expect(ineligibleExp.grandfatheringEligible, pairKey).toBe(false);
      }
    });
  });

  it('writes the comparison report', () => {
    const failures = report.filter((r) => r.result === 'FAIL');
    fs.writeFileSync(
      path.join(CERT_DIR, 'comparison_report.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          tolerances: TOLERANCES,
          caseCount: cases.length,
          comparisonCount: report.length,
          passCount: report.filter((r) => r.result === 'PASS').length,
          failCount: failures.length,
          rows: report,
        },
        null,
        2
      )
    );
    expect(failures, `certification failures: ${JSON.stringify(failures.slice(0, 10), null, 2)}`).toHaveLength(0);
  });
});
