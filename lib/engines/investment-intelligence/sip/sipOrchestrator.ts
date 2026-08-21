// Investment Intelligence R5 — SIP analytics orchestration.
//
// Pure: takes a fully-loaded dataset and returns versioned results. All
// database access lives in lib/services/investment-intelligence/r5Repository.ts,
// so this module is directly unit-testable and contains no I/O.
//
// INSIGHT CLASSIFICATION (spec section 100): every statement R5 produces is
// OBSERVATION, EDUCATION, or SIMULATION. PERSONALISED_ADVICE is never
// produced — there is no code path in R5 that can emit it.

import { detectSipSeries, isPresentableSeries, type SipCandidateTransaction, type SipSeries } from './sipDetection';
import { attributeSipUnits, type SipAttributionResult } from './sipAttribution';
import {
  calculateActualSipXirr,
  calculateBenchmarkSip,
  calculateSipExcessReturn,
  calculateSipWealthComparison,
  type SipXirrResult,
  type BenchmarkSipResult,
  type SipExcessReturnResult,
  type SipWealthComparison,
} from './sipXirr';
import { calculateSipConsistency, classifySipActivity, type SipConsistencyResult, type SipActivityResult } from './sipConsistency';
import { simulateHistoricalSip, calculateTimingComparison, type SimulationResult, type TimingComparisonResult } from './sipSimulation';
import { resolveObservationAsOf, sortSeries, type Observation } from './dateAlignment';
import { SIMULATION_STEP_UP_VARIANTS } from '@/lib/config/investment-intelligence/sipThresholds';
import { SIP_ENGINE_VERSION, R5_SIP_SUB_VERSIONS, fingerprintSipInputs } from '../r5Versioning';

export type R5InsightClassification = 'OBSERVATION' | 'EDUCATION' | 'SIMULATION';

export interface SipDataset {
  userId: string;
  asOfDate: string;
  /** Every certified transaction for the user, across all accounts/instruments. */
  transactions: SipCandidateTransaction[];
  /** NAV series keyed by instrument id. */
  navByInstrument: Map<string, Observation[]>;
  /** Benchmark series keyed by instrument id (already resolved via the effective-dated mapping). */
  benchmarkByInstrument: Map<string, { benchmarkId: string; benchmarkKey: string; returnType: string | null; mappingVersion: string | null; series: Observation[] }>;
  /** Cash distributions / redemptions attributable to a series, keyed by series key. */
  attributableInflowsBySeries?: Map<string, Array<{ date: string; amount: number }>>;
  instrumentNames?: Map<string, string>;
}

export interface SipSeriesAnalytics {
  series: SipSeries;
  instrumentName: string | null;
  presentable: boolean;
  attribution: SipAttributionResult;
  actualXirr: SipXirrResult;
  benchmarkSip: BenchmarkSipResult;
  excessReturn: SipExcessReturnResult;
  wealthComparison: SipWealthComparison;
  consistency: SipConsistencyResult;
  activity: SipActivityResult;
  timing: TimingComparisonResult;
  benchmarkKey: string | null;
  benchmarkReturnType: string | null;
  navAtAsOf: number | null;
  navDateUsed: string | null;
  /** Deterministic fingerprint of everything that could change this result. */
  inputSnapshotVersion: string;
  engineVersion: typeof SIP_ENGINE_VERSION;
  subVersions: typeof R5_SIP_SUB_VERSIONS;
  /** Descriptive statements, safe to render verbatim. Never advice. */
  observations: Array<{ classification: R5InsightClassification; text: string }>;
}

export interface SipAnalyticsResult {
  asOfDate: string;
  seriesCount: number;
  presentableCount: number;
  analytics: SipSeriesAnalytics[];
  engineVersion: typeof SIP_ENGINE_VERSION;
}

/** Build the descriptive, non-advisory statements shown alongside a series. */
function buildObservations(a: Omit<SipSeriesAnalytics, 'observations'>): Array<{ classification: R5InsightClassification; text: string }> {
  const out: Array<{ classification: R5InsightClassification; text: string }> = [];

  out.push({ classification: 'OBSERVATION', text: a.series.confidenceRationale });

  if (a.consistency.status === 'ok' && a.consistency.consistencyPct !== undefined) {
    out.push({
      classification: 'OBSERVATION',
      text: `${a.consistency.observedPeriods} contributions are recorded against ${a.consistency.expectedPeriods} expected intervals between ${a.consistency.firstContributionDate} and ${a.consistency.latestContributionDate}.`,
    });
  }

  out.push({ classification: 'OBSERVATION', text: a.activity.statement });

  if (a.actualXirr.status === 'ok' && a.benchmarkSip.status === 'ok' && a.excessReturn.status === 'ok') {
    out.push({
      classification: 'OBSERVATION',
      text:
        `Over the recorded period this series returned ${(a.actualXirr.rate! * 100).toFixed(2)}% on a money-weighted basis. ` +
        `The same contributions, on the same dates, applied to ${a.benchmarkKey ?? 'the mapped benchmark'} would have returned ` +
        `${(a.benchmarkSip.rate! * 100).toFixed(2)}%. Both figures use an identical contribution schedule.`,
    });
  } else if (a.benchmarkSip.status !== 'ok') {
    out.push({ classification: 'OBSERVATION', text: a.benchmarkSip.detail ?? 'A like-for-like benchmark comparison is not available for this series.' });
  }

  if (a.actualXirr.status !== 'ok') {
    out.push({ classification: 'OBSERVATION', text: a.actualXirr.detail ?? 'A money-weighted return is not available for this series.' });
  } else if (a.actualXirr.positionIsMixed) {
    out.push({
      classification: 'EDUCATION',
      text: 'This fund also holds purchases made outside this recurring series. The figures above cover only the units attributable to the recurring contributions, reconstructed on a first-in-first-out basis.',
    });
  }

  if (a.timing.status === 'ok') {
    out.push({ classification: 'OBSERVATION', text: a.timing.statement! });
  }

  return out;
}

export function runSipAnalytics(dataset: SipDataset): SipAnalyticsResult {
  const allSeries = detectSipSeries(dataset.transactions);
  const analytics: SipSeriesAnalytics[] = [];

  for (const series of allSeries) {
    const navSeries = sortSeries(dataset.navByInstrument.get(series.instrumentId) ?? []);
    const navObs = resolveObservationAsOf(navSeries, dataset.asOfDate);
    const navAtAsOf = navObs.status === 'ok' ? navObs.observation!.value : null;

    // Every transaction for the same (account, instrument), so attribution
    // sees non-series purchases and disposals too.
    const positionTxns = dataset.transactions.filter((t) => t.accountId === series.accountId && t.instrumentId === series.instrumentId);
    const attribution = attributeSipUnits(series, positionTxns, dataset.asOfDate);

    const inflows = dataset.attributableInflowsBySeries?.get(series.seriesKey) ?? [];
    const actualXirr = calculateActualSipXirr(series, attribution, { asOfDate: dataset.asOfDate, navAtAsOf, attributableInflows: inflows });

    const bm = dataset.benchmarkByInstrument.get(series.instrumentId);
    const benchmarkSip = calculateBenchmarkSip(series, {
      benchmarkSeries: bm?.series ?? null,
      asOfDate: dataset.asOfDate,
      benchmarkReturnType: bm?.returnType ?? null,
    });

    const excessReturn = calculateSipExcessReturn(actualXirr, benchmarkSip, series);
    const wealthComparison = calculateSipWealthComparison(actualXirr, benchmarkSip);
    const consistency = calculateSipConsistency(series);
    const activity = classifySipActivity(series, dataset.asOfDate);
    const timing = calculateTimingComparison(
      series.contributions.map((c) => ({ date: c.transactionDate, amount: c.grossAmount })),
      navSeries,
      dataset.asOfDate
    );

    const inputSnapshotVersion = fingerprintSipInputs({
      seriesKey: series.seriesKey,
      contributions: series.contributions.map((c) => ({ id: c.id, date: c.transactionDate, amount: c.grossAmount, units: c.units })),
      attributableInflows: inflows,
      navAtAsOf,
      benchmarkPoints: (bm?.series ?? []).map((p) => ({ date: p.date, value: p.value })),
      asOfDate: dataset.asOfDate,
      methodVersions: { ...R5_SIP_SUB_VERSIONS, engine: SIP_ENGINE_VERSION },
    });

    const partial: Omit<SipSeriesAnalytics, 'observations'> = {
      series,
      instrumentName: dataset.instrumentNames?.get(series.instrumentId) ?? null,
      presentable: isPresentableSeries(series),
      attribution,
      actualXirr,
      benchmarkSip,
      excessReturn,
      wealthComparison,
      consistency,
      activity,
      timing,
      benchmarkKey: bm?.benchmarkKey ?? null,
      benchmarkReturnType: bm?.returnType ?? null,
      navAtAsOf,
      navDateUsed: navObs.status === 'ok' ? navObs.observation!.date : null,
      inputSnapshotVersion,
      engineVersion: SIP_ENGINE_VERSION,
      subVersions: R5_SIP_SUB_VERSIONS,
    };

    analytics.push({ ...partial, observations: buildObservations(partial) });
  }

  return {
    asOfDate: dataset.asOfDate,
    seriesCount: analytics.length,
    presentableCount: analytics.filter((a) => a.presentable).length,
    analytics,
    engineVersion: SIP_ENGINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Simulations — always labelled, never a recommendation
// ---------------------------------------------------------------------------

export interface SipSimulationSet {
  classification: 'SIMULATION';
  /** Prominent, non-negotiable framing rendered with every simulation. */
  disclaimer: string;
  variants: SimulationResult[];
  engineVersion: typeof SIP_ENGINE_VERSION;
}

export const SIMULATION_DISCLAIMER =
  'These are simulations over historical prices, shown side by side for comparison. ' +
  'They describe what a given contribution schedule would have produced over a period that has already happened. ' +
  'They are not forecasts, and they are not a recommendation about which schedule to choose.';

/**
 * Run the illustrative simulation variants (flat, 5% step-up, 10% step-up)
 * over a real historical series. R5 presents all variants together and never
 * states which one the user should pick.
 */
export function runSipSimulations(inputs: {
  series: Observation[];
  startDate: string;
  endDate: string;
  startingContribution: number;
  contributionIntervalMonths?: number;
  seriesIncludesDistributions?: boolean;
  seriesLabel?: string;
  stepUpVariants?: readonly number[];
}): SipSimulationSet {
  const variants = (inputs.stepUpVariants ?? SIMULATION_STEP_UP_VARIANTS).map((stepUp) =>
    simulateHistoricalSip({
      series: inputs.series,
      startDate: inputs.startDate,
      endDate: inputs.endDate,
      startingContribution: inputs.startingContribution,
      annualStepUpPct: stepUp,
      contributionIntervalMonths: inputs.contributionIntervalMonths,
      seriesIncludesDistributions: inputs.seriesIncludesDistributions,
      seriesLabel: inputs.seriesLabel,
    })
  );
  return { classification: 'SIMULATION', disclaimer: SIMULATION_DISCLAIMER, variants, engineVersion: SIP_ENGINE_VERSION };
}
