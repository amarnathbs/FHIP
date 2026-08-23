// Investment Intelligence R5 — historical SIP simulations and timing
// comparison.
//
// EVERYTHING IN THIS FILE IS A SIMULATION OVER HISTORICAL DATA, never a
// recommendation and never a forecast (spec sections 45-48). R5 shows what a
// given contribution schedule WOULD HAVE produced against a real historical
// NAV or index series. It never states which variant the user should choose,
// and it never feeds any of these figures into Forecasting as a future
// contribution assumption (that is R7 scope, requiring explicit user
// confirmation).
//
// METHODOLOGY TRANSPARENCY (spec section 47) — every simulation result
// carries, and the UI displays:
//   * the contribution day-of-month rule
//   * the step-up anniversary rule
//   * non-trading-date treatment (the centralised dateAlignment rule)
//   * NAV/index date alignment used
//   * start and end of period
//   * rounding treatment
//   * whether distributions are included (governed by the supplied series:
//     a TRI/total-return series includes them, a price series does not)
//   * the methodology version

import { xirr, type CashFlow } from '../xirr';
import { resolveObservationOnOrAfter, resolveObservationAsOf, sortSeries, SIP_DATE_ALIGNMENT_VERSION, type Observation } from './dateAlignment';
import { SIMULATION_CONTRIBUTION_ROUNDING, SIP_THRESHOLD_CONFIG_VERSION } from '@/lib/config/investment-intelligence/sipThresholds';

export const SIP_SIMULATION_METHOD_VERSION = 'sip-simulation-historical-r5-v1';
export const SIP_TIMING_METHOD_VERSION = 'sip-timing-historical-comparison-r5-v1';

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}
function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Add `n` months to an ISO date, clamping the day-of-month to the target
 * month's length. Deterministic: 31 Jan + 1 month = 28/29 Feb, and the
 * ORIGINAL day-of-month is preserved for subsequent steps (so 31 Jan + 2
 * months = 31 Mar, not 28 Mar). This clamp rule is part of the versioned
 * methodology, not an implementation accident.
 */
export function addMonthsClamped(startIso: string, n: number): string {
  const d = new Date(toUtc(startIso));
  const targetMonth = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const m = ((targetMonth % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), daysInTarget);
  return isoOf(Date.UTC(y, m, day));
}

export interface SimulationInputs {
  /** Historical NAV or index series the simulation is run against. */
  series: Observation[];
  startDate: string;
  endDate: string;
  /** Contribution in the first year. */
  startingContribution: number;
  /** Annual step-up as a fraction, e.g. 0.05 = 5%. 0 = flat. */
  annualStepUpPct: number;
  /** Months between contributions. 1 = monthly (default), 3 = quarterly. */
  contributionIntervalMonths?: number;
  /** True when `series` is a total-return series (distributions included). */
  seriesIncludesDistributions?: boolean;
  seriesLabel?: string;
}

export interface SimulationAssumptions {
  contributionDayRule: string;
  stepUpAnniversaryRule: string;
  nonTradingDateRule: string;
  dateAlignmentMethod: string;
  periodStart: string;
  periodEnd: string;
  roundingTreatment: string;
  distributionsIncluded: boolean | 'unknown';
  methodologyVersion: string;
  thresholdConfigVersion: string;
}

export interface SimulationResult {
  status: 'ok' | 'unavailable';
  label?: string;
  annualStepUpPct?: number;
  contributionCount?: number;
  totalContributed?: number;
  unitsAccumulated?: number;
  terminalValue?: number;
  xirrRate?: number;
  contributions?: Array<{ date: string; amount: number; seriesDate: string; level: number; units: number }>;
  assumptions?: SimulationAssumptions;
  reason?: 'EMPTY_SERIES' | 'NO_CONTRIBUTION_DATES' | 'ALIGNMENT_FAILED' | 'TERMINAL_UNAVAILABLE' | 'XIRR_UNAVAILABLE' | 'INVALID_INPUT';
  detail?: string;
  method: typeof SIP_SIMULATION_METHOD_VERSION;
}

function roundContribution(amount: number): number {
  // SIMULATION_CONTRIBUTION_ROUNDING = 'nearest_whole_unit'
  return Math.round(amount);
}

/**
 * Run one historical SIP simulation variant (flat when annualStepUpPct = 0).
 *
 * Step-up anniversary rule: the contribution amount increases on each
 * 12-month anniversary of the START DATE, not on a calendar year boundary.
 * Contribution k (0-indexed) in anniversary year y uses
 *   round(startingContribution × (1 + stepUp)^y).
 */
export function simulateHistoricalSip(inputs: SimulationInputs): SimulationResult {
  const base = { method: SIP_SIMULATION_METHOD_VERSION } as const;
  const intervalMonths = inputs.contributionIntervalMonths ?? 1;

  if (!inputs.series || inputs.series.length === 0) {
    return { status: 'unavailable', reason: 'EMPTY_SERIES', detail: 'No historical price or index series is available for this simulation.', ...base };
  }
  if (!(inputs.startingContribution > 0) || !Number.isFinite(inputs.annualStepUpPct) || intervalMonths < 1) {
    return { status: 'unavailable', reason: 'INVALID_INPUT', detail: 'Simulation inputs are not valid.', ...base };
  }
  if (toUtc(inputs.endDate) < toUtc(inputs.startDate)) {
    return { status: 'unavailable', reason: 'INVALID_INPUT', detail: 'Simulation end date precedes its start date.', ...base };
  }

  const sorted = sortSeries(inputs.series);
  const assumptions: SimulationAssumptions = {
    contributionDayRule: `Contributions are made every ${intervalMonths} month(s) on the same day-of-month as the start date, with the day clamped to the last day of any shorter month.`,
    stepUpAnniversaryRule:
      inputs.annualStepUpPct === 0
        ? 'No step-up: the contribution amount is held flat for the whole period.'
        : `The contribution amount increases by ${(inputs.annualStepUpPct * 100).toFixed(1)}% on each 12-month anniversary of the start date.`,
    nonTradingDateRule: 'A contribution falling on a non-trading day is applied at the first available observation on or after that date, within 10 calendar days.',
    dateAlignmentMethod: SIP_DATE_ALIGNMENT_VERSION,
    periodStart: inputs.startDate,
    periodEnd: inputs.endDate,
    roundingTreatment: `Each stepped-up contribution is rounded to the ${SIMULATION_CONTRIBUTION_ROUNDING.replace(/_/g, ' ')}.`,
    distributionsIncluded: inputs.seriesIncludesDistributions ?? 'unknown',
    methodologyVersion: SIP_SIMULATION_METHOD_VERSION,
    thresholdConfigVersion: SIP_THRESHOLD_CONFIG_VERSION,
  };

  const contributions: NonNullable<SimulationResult['contributions']> = [];
  let unitsAccumulated = 0;
  let totalContributed = 0;
  const flows: CashFlow[] = [];

  for (let k = 0; ; k++) {
    const date = addMonthsClamped(inputs.startDate, k * intervalMonths);
    if (toUtc(date) > toUtc(inputs.endDate)) break;
    const anniversaryYear = Math.floor((k * intervalMonths) / 12);
    const amount = roundContribution(inputs.startingContribution * Math.pow(1 + inputs.annualStepUpPct, anniversaryYear));

    const aligned = resolveObservationOnOrAfter(sorted, date);
    if (aligned.status !== 'ok' || !aligned.observation || aligned.observation.value <= 0) {
      return {
        status: 'unavailable',
        reason: 'ALIGNMENT_FAILED',
        detail: `The historical series does not cover the simulated contribution date ${date}, so this simulation cannot be completed over the requested period.`,
        assumptions,
        ...base,
      };
    }
    const units = amount / aligned.observation.value;
    unitsAccumulated += units;
    totalContributed += amount;
    contributions.push({ date, amount, seriesDate: aligned.observation.date, level: aligned.observation.value, units });
    flows.push({ date: new Date(toUtc(date)), amount: -amount });
  }

  if (contributions.length === 0) {
    return { status: 'unavailable', reason: 'NO_CONTRIBUTION_DATES', detail: 'The requested period contains no contribution dates.', assumptions, ...base };
  }

  const terminal = resolveObservationAsOf(sorted, inputs.endDate);
  if (terminal.status !== 'ok' || !terminal.observation) {
    return { status: 'unavailable', reason: 'TERMINAL_UNAVAILABLE', detail: `No observation is available on or before the simulation end date ${inputs.endDate}.`, assumptions, ...base };
  }
  const terminalValue = unitsAccumulated * terminal.observation.value;
  flows.push({ date: new Date(toUtc(inputs.endDate)), amount: terminalValue });

  const solved = xirr(flows);
  return {
    status: 'ok',
    label: inputs.annualStepUpPct === 0 ? 'Flat contribution' : `${(inputs.annualStepUpPct * 100).toFixed(0)}% annual step-up`,
    annualStepUpPct: inputs.annualStepUpPct,
    contributionCount: contributions.length,
    totalContributed,
    unitsAccumulated,
    terminalValue,
    xirrRate: solved.status === 'ok' ? solved.rate : undefined,
    contributions,
    assumptions,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Timing comparison
// ---------------------------------------------------------------------------

export type TimingUnavailableReason = 'EMPTY_SERIES' | 'ALIGNMENT_FAILED' | 'TERMINAL_UNAVAILABLE' | 'NO_CONTRIBUTIONS';

export interface TimingComparisonResult {
  status: 'ok' | 'unavailable';
  /** Ending value of the ACTUAL staggered contribution schedule. */
  staggeredEndingValue?: number;
  /** Ending value had the SAME total capital been invested at the start date. */
  lumpSumAtStartEndingValue?: number;
  totalCapital?: number;
  /** staggered − lumpSumAtStart. Positive = staggering produced more wealth over this recorded period. */
  wealthDifference?: number;
  wealthDifferencePct?: number;
  /** Verbatim-safe descriptive framing. Never "skill", never a recommendation. */
  statement?: string;
  assumptions?: { startDate: string; endDate: string; dateAlignmentMethod: string; methodologyVersion: string; counterfactual: string };
  reason?: TimingUnavailableReason;
  detail?: string;
  method: typeof SIP_TIMING_METHOD_VERSION;
}

/**
 * Compare the actual staggered contribution schedule against a controlled
 * historical counterfactual: the SAME total capital invested in one go on the
 * series' own start date, in the SAME fund, using the SAME NAV series.
 *
 * WEALTH DIFFERENCE is the reported metric, deliberately NOT an XIRR
 * difference: the two schedules have fundamentally different cash-flow
 * shapes, so comparing their XIRRs would be exactly the incompatible
 * comparison R5 exists to prevent (spec section 48). The result is labelled
 * a historical timing comparison — never "investor skill", never a
 * recommendation, never a forecast.
 */
export function calculateTimingComparison(
  contributions: Array<{ date: string; amount: number }>,
  navSeries: Observation[],
  endDate: string
): TimingComparisonResult {
  const base = { method: SIP_TIMING_METHOD_VERSION } as const;
  if (!contributions || contributions.length === 0) {
    return { status: 'unavailable', reason: 'NO_CONTRIBUTIONS', detail: 'No contributions to compare.', ...base };
  }
  if (!navSeries || navSeries.length === 0) {
    return { status: 'unavailable', reason: 'EMPTY_SERIES', detail: 'No NAV history is available for this comparison.', ...base };
  }
  const sorted = sortSeries(navSeries);
  const ordered = [...contributions].sort((a, b) => toUtc(a.date) - toUtc(b.date));
  const startDate = ordered[0].date;

  let staggeredUnits = 0;
  let totalCapital = 0;
  for (const c of ordered) {
    const aligned = resolveObservationOnOrAfter(sorted, c.date);
    if (aligned.status !== 'ok' || !aligned.observation || aligned.observation.value <= 0) {
      return { status: 'unavailable', reason: 'ALIGNMENT_FAILED', detail: `NAV history does not cover the contribution date ${c.date}.`, ...base };
    }
    staggeredUnits += Math.abs(c.amount) / aligned.observation.value;
    totalCapital += Math.abs(c.amount);
  }

  const startObs = resolveObservationOnOrAfter(sorted, startDate);
  if (startObs.status !== 'ok' || !startObs.observation || startObs.observation.value <= 0) {
    return { status: 'unavailable', reason: 'ALIGNMENT_FAILED', detail: `NAV history does not cover the series start date ${startDate}.`, ...base };
  }
  const terminal = resolveObservationAsOf(sorted, endDate);
  if (terminal.status !== 'ok' || !terminal.observation) {
    return { status: 'unavailable', reason: 'TERMINAL_UNAVAILABLE', detail: `No NAV is available on or before ${endDate}.`, ...base };
  }

  const staggeredEndingValue = staggeredUnits * terminal.observation.value;
  const lumpSumUnits = totalCapital / startObs.observation.value;
  const lumpSumAtStartEndingValue = lumpSumUnits * terminal.observation.value;
  const wealthDifference = staggeredEndingValue - lumpSumAtStartEndingValue;

  return {
    status: 'ok',
    staggeredEndingValue,
    lumpSumAtStartEndingValue,
    totalCapital,
    wealthDifference,
    wealthDifferencePct: lumpSumAtStartEndingValue !== 0 ? wealthDifference / lumpSumAtStartEndingValue : undefined,
    statement:
      `Historical timing comparison. Over the recorded period, contributions made progressively ended at a value ` +
      `${wealthDifference >= 0 ? 'above' : 'below'} what the same total capital would have reached had it all been invested in this fund on ${startDate}. ` +
      `This describes how this fund's prices moved across the dates money actually arrived; it is not a forecast and not a recommendation.`,
    assumptions: {
      startDate,
      endDate,
      dateAlignmentMethod: SIP_DATE_ALIGNMENT_VERSION,
      methodologyVersion: SIP_TIMING_METHOD_VERSION,
      counterfactual: 'The same total capital invested as a single amount on the series start date, in the same fund, using the same NAV series.',
    },
    ...base,
  };
}
