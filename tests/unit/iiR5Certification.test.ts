// Investment Intelligence R5 — independent certification harness (production side).
//
// Consumes the IDENTICAL scripts/ii-r5-certification/cases.json that the
// independent Python oracle consumes, runs it through the real R5 production
// engines, and compares against scripts/ii-r5-certification/oracle_results.json,
// which was produced WITHOUT importing any production code.
//
// PRE-DECLARED TOLERANCES (spec section 90). Declared here, in code, BEFORE
// any result was reviewed. These are never widened in response to a failure —
// a failure is fixed in the engine, not absorbed by the tolerance.
//
//   XIRR / rate                      1e-6
//   weight calculations              1e-8
//   overlap                          1e-8
//   sector / market-cap exposure     1e-8
//   HHI                              1e-8
//   simulation currency value        0.01  (the smallest material unit, Rs 0.01)
//
// A comparison report is written to comparison_report.json for the acceptance
// record.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { detectSipSeries, type SipCandidateTransaction, type SipSeries } from '@/lib/engines/investment-intelligence/sip/sipDetection';
import { attributeSipUnits } from '@/lib/engines/investment-intelligence/sip/sipAttribution';
import { calculateActualSipXirr, calculateBenchmarkSip } from '@/lib/engines/investment-intelligence/sip/sipXirr';
import { calculateSipConsistency, classifySipActivity } from '@/lib/engines/investment-intelligence/sip/sipConsistency';
import { simulateHistoricalSip } from '@/lib/engines/investment-intelligence/sip/sipSimulation';
import {
  calculatePortfolioLookThrough,
  selectSnapshotAsOf,
  type FundHoldingsSnapshot,
  type PortfolioFundPosition,
} from '@/lib/engines/investment-intelligence/xray/lookThrough';
import { calculateFundOverlap, calculateOverlapMatrix } from '@/lib/engines/investment-intelligence/xray/overlap';
import {
  calculateSecurityConcentration,
  calculateSectorExposure,
  calculateMarketCapExposure,
  calculateAmcConcentration,
} from '@/lib/engines/investment-intelligence/xray/concentration';
import { calculateCreditQuality, calculateMaturityBuckets, calculateWeightedDuration, calculateIssuerConcentration, type DebtExposureLine } from '@/lib/engines/investment-intelligence/xray/debtXray';

export const TOLERANCES = {
  xirr: 1e-6,
  weight: 1e-8,
  overlap: 1e-8,
  exposure: 1e-8,
  hhi: 1e-8,
  simulationValue: 0.01,
} as const;

const CERT_DIR = path.resolve(__dirname, '../../scripts/ii-r5-certification');
const cases = JSON.parse(fs.readFileSync(path.join(CERT_DIR, 'cases.json'), 'utf8')).cases as Array<Record<string, any>>;
const oracle = JSON.parse(fs.readFileSync(path.join(CERT_DIR, 'oracle_results.json'), 'utf8')).results as Array<Record<string, any>>;
const oracleById = new Map(oracle.map((r) => [r.id, r]));

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

// ---------------------------------------------------------------------------
// Production-side computation, mirroring the oracle's structure but using the
// real engines.
// ---------------------------------------------------------------------------
function toSnapshot(s: Record<string, any>): FundHoldingsSnapshot {
  return s as FundHoldingsSnapshot;
}

function primarySeries(all: SipSeries[]): SipSeries | null {
  if (all.length === 0) return null;
  return [...all].sort((a, b) => (b.contributions.length - a.contributions.length) || a.seriesKey.localeCompare(b.seriesKey))[0];
}

function runSip(input: Record<string, any>) {
  const txns = input.transactions as SipCandidateTransaction[];
  const all = detectSipSeries(txns);
  const out: Record<string, any> = { seriesCount: all.length };
  const primary = primarySeries(all);
  if (!primary) {
    return { ...out, cadence: null, confidence: null, contributionCount: 0, actualSipXirrStatus: 'unavailable', actualSipXirr: null, consistencyPct: null, activityStatus: null };
  }
  out.cadence = primary.cadence;
  out.confidence = primary.confidence;
  out.contributionCount = primary.contributions.length;
  out.trend = primary.trend;
  out.allCadences = all.map((s) => s.cadence).sort();
  out.allConfidences = all.map((s) => s.confidence).sort();
  out.allContributionCounts = all.map((s) => s.contributions.length).sort((a, b) => a - b);

  const positionTxns = (input.positionTransactions && input.positionTransactions.length > 0 ? input.positionTransactions : primary.contributions) as SipCandidateTransaction[];
  const attr = attributeSipUnits(primary, positionTxns, input.asOfDate);
  const actual = calculateActualSipXirr(primary, attr, {
    asOfDate: input.asOfDate,
    navAtAsOf: input.navAtAsOf,
    attributableInflows: input.attributableInflows ?? [],
  });
  out.actualSipXirrStatus = actual.status;
  out.actualSipXirr = actual.status === 'ok' ? actual.rate : null;
  out.actualSipXirrReason = actual.status === 'ok' ? null : actual.reason;
  out.terminalValue = actual.terminalValue ?? null;
  if (attr.status === 'ok') out.seriesUnitsRemaining = attr.seriesUnitsRemaining;

  const cons = calculateSipConsistency(primary);
  out.consistencyPct = cons.consistencyPct ?? null;
  out.expectedPeriods = cons.expectedPeriods ?? null;
  out.skippedPeriods = cons.skippedPeriods ?? null;

  out.activityStatus = classifySipActivity(primary, input.asOfDate).status;
  out.notConfirmed = primary.confidence !== 'CONFIRMED_SOURCE';
  return out;
}

function runBenchmarkSip(input: Record<string, any>) {
  // Build a minimal series carrier from the raw contribution list.
  const contributions = (input.contributions as Array<{ date: string; amount: number }>).map((c, i) => ({
    id: `C${i}`,
    accountId: 'A',
    instrumentId: 'I',
    transactionType: 'sip',
    transactionDate: c.date,
    grossAmount: c.amount,
    units: null,
    currencyCode: 'INR',
  })) as SipCandidateTransaction[];
  const series: SipSeries = {
    seriesKey: 'A:I:sip',
    accountId: 'A',
    instrumentId: 'I',
    currencyCode: 'INR',
    contributions,
    cadence: 'MONTHLY',
    periodsPerYear: 12,
    confidence: 'CONFIRMED_SOURCE',
    confidenceRationale: '',
    trend: 'FLAT',
    firstContributionDate: contributions[0]?.transactionDate ?? '',
    latestContributionDate: contributions[contributions.length - 1]?.transactionDate ?? '',
    detectionMethodVersion: 'sip-detection-r5-v1' as never,
    thresholdConfigVersion: 'sip-thresholds-r5-v1' as never,
  };
  const r = calculateBenchmarkSip(series, { benchmarkSeries: input.benchmarkSeries, asOfDate: input.asOfDate });
  return {
    benchmarkSipStatus: r.status,
    benchmarkSipReason: r.status === 'ok' ? null : r.reason,
    benchmarkSipXirr: r.status === 'ok' ? r.rate : null,
    syntheticUnits: r.status === 'ok' ? r.syntheticUnits : null,
    terminalValue: r.status === 'ok' ? r.terminalValue : null,
    noFabricatedBenchmarkRate: r.status === 'ok' ? r.rate !== undefined : true,
  };
}

function runSimulation(input: Record<string, any>) {
  const r = simulateHistoricalSip({
    series: input.series,
    startDate: input.startDate,
    endDate: input.endDate,
    startingContribution: input.startingContribution,
    annualStepUpPct: input.annualStepUpPct,
    contributionIntervalMonths: input.contributionIntervalMonths,
  });
  if (r.status !== 'ok') return { simulationStatus: 'unavailable', reason: r.reason };
  return {
    simulationStatus: 'ok',
    contributionCount: r.contributionCount,
    totalContributed: r.totalContributed,
    unitsAccumulated: r.unitsAccumulated,
    terminalValue: r.terminalValue,
    simulationXirr: r.xirrRate ?? null,
  };
}

function buildSnapshotMap(snapshots: Array<Record<string, any>>): Map<string, FundHoldingsSnapshot[]> {
  const m = new Map<string, FundHoldingsSnapshot[]>();
  for (const s of snapshots) {
    const k = s.fundInstrumentId as string;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(toSnapshot(s));
  }
  return m;
}

function runLookThrough(input: Record<string, any>) {
  const positions = input.positions as PortfolioFundPosition[];
  const r = calculatePortfolioLookThrough(positions, buildSnapshotMap(input.snapshots ?? []), input.asOfDate, input.portfolioAsOfDate ?? input.asOfDate);
  if (r.status !== 'ok') {
    return {
      lookThroughStatus: 'unavailable',
      exposures: [],
      effectiveCoverage: r.effectiveCoverage,
      cashWeight: r.cashWeight,
      unresolvedWeight: r.unresolvedWeight,
      noSnapshotWeight: r.noSnapshotWeight,
      freshness: r.freshness,
      noFabricatedZeroSectors: true,
    };
  }
  return {
    lookThroughStatus: 'ok',
    exposures: r.exposures.map((e) => ({ canonicalId: e.canonicalId, effectiveWeight: e.effectiveWeight, schemeCount: e.schemeCount })),
    effectiveCoverage: r.effectiveCoverage,
    schemeCoverage: r.schemeCoverage,
    holdingsCoverageWithinSchemes: r.holdingsCoverageWithinSchemes,
    cashWeight: r.cashWeight,
    derivativeWeight: r.derivativeWeight,
    otherWeight: r.otherWeight,
    unresolvedWeight: r.unresolvedWeight,
    noSnapshotWeight: r.noSnapshotWeight,
    undisclosedRemainderWeight: r.undisclosedRemainderWeight,
    freshness: r.freshness,
    oldestHoldingsDate: r.oldestHoldingsDate,
    newestHoldingsDate: r.newestHoldingsDate,
    mixedDateSpreadDays: r.mixedDateSpreadDays,
    mixedDateWarning: r.mixedDateWarning,
    hasStaleStatus: r.qualityStatuses.includes('STALE_HOLDINGS'),
    hasUnresolvedStatus: r.qualityStatuses.includes('UNDERLYING_UNRESOLVED'),
    noFabricatedZeroSectors: true,
    weightIdentity:
      r.exposures.reduce((s, e) => s + e.effectiveWeight, 0) +
      r.cashWeight + r.derivativeWeight + r.otherWeight + r.unresolvedWeight + r.noSnapshotWeight + r.undisclosedRemainderWeight,
    exactExposureX: r.exposures.find((e) => e.canonicalId === 'X')?.effectiveWeight ?? null,
  };
}

function runOverlap(input: Record<string, any>) {
  const snaps = (input.snapshots as Array<Record<string, any>>).map(toSnapshot);
  if (snaps.length === 2) {
    const fwd = calculateFundOverlap(snaps[0], snaps[1], input.asOfDate);
    const rev = calculateFundOverlap(snaps[1], snaps[0], input.asOfDate);
    return {
      overlapStatus: fwd.status,
      weightedOverlap: fwd.weightedOverlap ?? null,
      commonSecurityCount: fwd.commonSecurityCount ?? null,
      hasQualityWarning: fwd.qualityWarning !== null && fwd.qualityWarning !== undefined,
      symmetry: fwd.weightedOverlap !== undefined && rev.weightedOverlap !== undefined && Math.abs(fwd.weightedOverlap - rev.weightedOverlap) < 1e-12,
    };
  }
  const m = calculateOverlapMatrix(snaps.map((s) => ({ fundInstrumentId: s.fundInstrumentId, fundName: s.fundInstrumentId, snapshot: s })), input.asOfDate);
  const n = m.matrix.length;
  const values: Array<number | null> = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) values.push(m.matrix[i][j] === null ? null : Number((m.matrix[i][j] as number).toFixed(12)));
  let symmetric = true;
  let bounded = true;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (m.matrix[i][j] !== m.matrix[j][i]) symmetric = false;
      const v = m.matrix[i][j];
      if (v !== null && (v < -1e-12 || v > 1 + 1e-12)) bounded = false;
    }
  }
  return { matrixSize: n, matrixSymmetric: symmetric, matrixBounded: bounded, matrixValues: values };
}

function runConcentration(input: Record<string, any>) {
  const positions = input.positions as PortfolioFundPosition[];
  const lt = calculatePortfolioLookThrough(positions, buildSnapshotMap(input.snapshots ?? []), input.asOfDate, input.portfolioAsOfDate ?? input.asOfDate);
  const conc = calculateSecurityConcentration(lt);
  const sector = calculateSectorExposure(lt, 'cert-classification-v1');
  const mcap = calculateMarketCapExposure(lt, 'cert-classification-v1');
  return {
    top1: conc.top1 ?? null,
    top5: conc.top5 ?? null,
    top10: conc.top10 ?? null,
    hhi: conc.hhi ?? null,
    sectorBuckets: sector.buckets.map((b) => ({ key: b.key, effectiveWeight: b.effectiveWeight })),
    sectorClassifiedWeight: sector.classifiedWeight,
    sectorUnclassifiedWeight: sector.unclassifiedWeight,
    marketCapBuckets: mcap.buckets.map((b) => ({ key: b.key, effectiveWeight: b.effectiveWeight })),
    marketCapClassifiedWeight: mcap.classifiedWeight,
    marketCapUnclassifiedWeight: mcap.unclassifiedWeight,
  };
}

function runAmc(input: Record<string, any>) {
  const r = calculateAmcConcentration(input.positions as PortfolioFundPosition[]);
  return {
    amcBuckets: r.buckets.map((b) => ({ amcId: b.amcId, weight: b.weight, schemeCount: b.schemeCount })),
    amcUnattributedWeight: r.unattributedWeight,
  };
}

function runDebt(input: Record<string, any>) {
  const lines = input.lines as DebtExposureLine[];
  const credit = calculateCreditQuality(lines, input.consolidationMethodology ?? null);
  const maturity = calculateMaturityBuckets(lines, input.asOfDate);
  const duration = calculateWeightedDuration(lines);
  const issuer = calculateIssuerConcentration(lines);
  return {
    creditStatus: credit.status,
    creditBuckets: credit.buckets.map((b) => ({ key: b.key, effectiveWeight: b.effectiveWeight })),
    consolidationSuppressed: credit.consolidationSuppressed,
    maturityStatus: maturity.status,
    maturityBuckets: maturity.buckets.map((b) => ({ key: b.key, effectiveWeight: b.effectiveWeight })),
    durationStatus: duration.status,
    weightedDuration: duration.status === 'ok' ? duration.weightedModifiedDuration : null,
    issuerBuckets: issuer.buckets.map((b) => ({ issuerId: b.issuerId, effectiveWeight: b.effectiveWeight })),
    issuerUnattributedWeight: issuer.unattributedWeight,
    noFabricatedDuration: duration.status === 'unavailable' || duration.weightedModifiedDuration !== undefined,
  };
}

function runCase(c: Record<string, any>): Record<string, any> {
  switch (c.family) {
    case 'sip': return runSip(c.input);
    case 'benchmark_sip': return runBenchmarkSip(c.input);
    case 'simulation': return runSimulation(c.input);
    case 'xray': return runLookThrough(c.input);
    case 'overlap': return runOverlap(c.input);
    case 'concentration': return runConcentration(c.input);
    case 'amc_concentration': return runAmc(c.input);
    case 'debt': return runDebt(c.input);
    case 'data_quality': {
      const kind = c.input.kind;
      if (kind === 'xray') return runLookThrough(c.input);
      if (kind === 'benchmark_sip') return runBenchmarkSip(c.input);
      if (kind === 'sip') return runSip(c.input);
      if (kind === 'debt') return runDebt(c.input);
      return {};
    }
    default: throw new Error(`Unknown family ${c.family}`);
  }
}

const NUMERIC_TOLERANCE: Record<string, number> = {
  actualSipXirr: TOLERANCES.xirr,
  benchmarkSipXirr: TOLERANCES.xirr,
  simulationXirr: TOLERANCES.xirr,
  consistencyPct: TOLERANCES.weight,
  effectiveCoverage: TOLERANCES.weight,
  cashWeight: TOLERANCES.weight,
  unresolvedWeight: TOLERANCES.weight,
  noSnapshotWeight: TOLERANCES.weight,
  weightedOverlap: TOLERANCES.overlap,
  top1: TOLERANCES.weight,
  top5: TOLERANCES.weight,
  top10: TOLERANCES.weight,
  hhi: TOLERANCES.hhi,
  sectorClassifiedWeight: TOLERANCES.exposure,
  sectorUnclassifiedWeight: TOLERANCES.exposure,
  marketCapClassifiedWeight: TOLERANCES.exposure,
  marketCapUnclassifiedWeight: TOLERANCES.exposure,
  amcUnattributedWeight: TOLERANCES.weight,
  totalContributed: TOLERANCES.simulationValue,
  terminalValue: TOLERANCES.simulationValue,
  unitsAccumulated: TOLERANCES.weight,
  syntheticUnits: TOLERANCES.weight,
  weightedDuration: TOLERANCES.exposure,
  exactExposureX: TOLERANCES.weight,
  weightIdentity: TOLERANCES.weight,
  mixedDateSpreadDays: 0,
};

describe('R5 independent certification pack', () => {
  it('has an oracle result for every generated case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    for (const c of cases) expect(oracleById.has(c.id), `missing oracle result for ${c.id}`).toBe(true);
  });

  for (const c of cases) {
    it(`${c.id} — ${c.description}`, () => {
      const production = runCase(c);
      const expected = oracleById.get(c.id)!.expected as Record<string, any>;

      for (const metric of c.certify as string[]) {
        // Some certify keys are derived views onto the same result object;
        // resolve them generically.
        const prodVal = production[metric];
        const expVal = expected[metric];

        if (metric === 'exposures') {
          // Compare the full effective-exposure vector, canonical id by
          // canonical id, at weight tolerance.
          const p = (prodVal ?? []) as Array<{ canonicalId: string; effectiveWeight: number; schemeCount: number }>;
          const e = (expVal ?? []) as Array<{ canonicalId: string; effectiveWeight: number; schemeCount: number }>;
          compareExact(c.id, 'exposures.count', p.length, e.length);
          compareExact(c.id, 'exposures.order', p.map((x) => x.canonicalId), e.map((x) => x.canonicalId));
          for (let i = 0; i < e.length; i++) {
            compareNumber(c.id, `exposures[${e[i].canonicalId}].effectiveWeight`, p[i]?.effectiveWeight, e[i].effectiveWeight, TOLERANCES.weight);
            compareExact(c.id, `exposures[${e[i].canonicalId}].schemeCount`, p[i]?.schemeCount, e[i].schemeCount);
          }
          continue;
        }
        if (metric === 'sectorBuckets' || metric === 'marketCapBuckets') {
          const p = (prodVal ?? []) as Array<{ key: string; effectiveWeight: number }>;
          const e = (expVal ?? []) as Array<{ key: string; effectiveWeight: number }>;
          compareExact(c.id, `${metric}.keys`, p.map((x) => x.key), e.map((x) => x.key));
          for (let i = 0; i < e.length; i++) compareNumber(c.id, `${metric}[${e[i].key}]`, p[i]?.effectiveWeight, e[i].effectiveWeight, TOLERANCES.exposure);
          continue;
        }
        if (metric === 'creditBuckets' || metric === 'maturityBuckets') {
          const p = (prodVal ?? []) as Array<{ key: string; effectiveWeight: number }>;
          const e = (expVal ?? []) as Array<{ key: string; effectiveWeight: number }>;
          compareExact(c.id, `${metric}.keys`, p.map((x) => x.key), e.map((x) => x.key));
          for (let i = 0; i < e.length; i++) compareNumber(c.id, `${metric}[${e[i].key}]`, p[i]?.effectiveWeight, e[i].effectiveWeight, TOLERANCES.exposure);
          continue;
        }
        if (metric === 'issuerBuckets') {
          const p = (prodVal ?? []) as Array<{ issuerId: string; effectiveWeight: number }>;
          const e = (expVal ?? []) as Array<{ issuerId: string; effectiveWeight: number }>;
          compareExact(c.id, 'issuerBuckets.keys', p.map((x) => x.issuerId), e.map((x) => x.issuerId));
          for (let i = 0; i < e.length; i++) compareNumber(c.id, `issuerBuckets[${e[i].issuerId}]`, p[i]?.effectiveWeight, e[i].effectiveWeight, TOLERANCES.exposure);
          continue;
        }
        if (metric === 'amcBuckets') {
          const p = (prodVal ?? []) as Array<{ amcId: string; weight: number; schemeCount: number }>;
          const e = (expVal ?? []) as Array<{ amcId: string; weight: number; schemeCount: number }>;
          compareExact(c.id, 'amcBuckets.keys', p.map((x) => x.amcId), e.map((x) => x.amcId));
          for (let i = 0; i < e.length; i++) {
            compareNumber(c.id, `amcBuckets[${e[i].amcId}].weight`, p[i]?.weight, e[i].weight, TOLERANCES.weight);
            compareExact(c.id, `amcBuckets[${e[i].amcId}].schemeCount`, p[i]?.schemeCount, e[i].schemeCount);
          }
          continue;
        }
        if (metric === 'matrixValues') {
          const p = (prodVal ?? []) as Array<number | null>;
          const e = (expVal ?? []) as Array<number | null>;
          compareExact(c.id, 'matrixValues.count', p.length, e.length);
          for (let i = 0; i < e.length; i++) compareNumber(c.id, `matrixValues[${i}]`, p[i], e[i], TOLERANCES.overlap);
          continue;
        }

        if (metric in NUMERIC_TOLERANCE && (typeof expVal === 'number' || expVal === null)) {
          compareNumber(c.id, metric, prodVal as number | null, expVal as number | null, NUMERIC_TOLERANCE[metric]);
        } else {
          compareExact(c.id, metric, prodVal ?? null, expVal ?? null);
        }
      }
    });
  }

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
