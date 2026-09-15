// PC6 (M6) — N.12 / N.13 / N.14 performance activation proof.
//
// N.12 says: "Once sufficient reference series exists, activate deterministic
// metrics from the EXISTING certified engines (do not reimplement analytics —
// find and reuse Investment Intelligence's own already-certified
// performance/benchmark engine from earlier R-phases)."
//
// So this script contains NO formula. Every number below is produced by an
// engine that was certified in R4/R5 and is imported unmodified:
//
//   lib/engines/investment-intelligence/PerformanceEngine.ts   XIRR, CAGR, point-to-point
//   lib/engines/investment-intelligence/twrr.ts                TWRR
//   lib/engines/investment-intelligence/riskMetricsService.ts  volatility, downside vol,
//                                                             Sharpe, Sortino, drawdown, beta,
//                                                             alpha, tracking error, information
//                                                             ratio, capture, Calmar
//   lib/engines/investment-intelligence/benchmarkService.ts    benchmark growth, active return
//   lib/engines/investment-intelligence/rollingReturns.ts      rolling returns
//   lib/engines/investment-intelligence/sip/sipXirr.ts         identical-cashflow benchmark SIP (N.13)
//
// PC6's contribution is the REFERENCE SERIES those engines consume. The NAV
// series here is REAL: month-end NAVs for a real Indian scheme, pulled from
// AMFI's own public history endpoint, one bounded window per month.
//
// THE BENCHMARK SERIES IS NOT REAL, AND IS LABELLED AS SUCH EVERYWHERE.
// Indian index levels are licensed (BLOCKER PO-PC6-1), so no real NIFTY/SENSEX
// series exists for PC6 to supply. The benchmark-relative metrics below are
// therefore driven by a SEALED SYNTHETIC series whose key literally reads
// SEALED-ORACLE-SYNTHETIC. It is never written to any database, never given a
// real index's name, and proves only that the engines ACTIVATE correctly once
// a benchmark series exists — not that FHIP can show a user a real NIFTY
// comparison today. That remains blocked.
//
// Usage: npx tsx scripts/pc6_performance_activation_proof.ts

import fs from 'node:fs';
import path from 'node:path';
import { parseNavHistory } from '../lib/services/investment-intelligence/pc6/amfiParser';
import { buildUrl } from '../lib/config/investment-intelligence/pc6ReferenceSources';
import { computeSchemePerformance, computePortfolioPerformance } from '../lib/engines/investment-intelligence/PerformanceEngine';
import { computeRiskMetrics, periodicReturnsFromLevels } from '../lib/engines/investment-intelligence/riskMetricsService';
import { computeBlendedBenchmark, computeSchemeActiveReturn, benchmarkWindowReturn } from '../lib/engines/investment-intelligence/benchmarkService';
import { rollingReturnSeries } from '../lib/engines/investment-intelligence/rollingReturns';
import { calculateActualSipXirr, calculateBenchmarkSip, calculateSipExcessReturn, BENCHMARK_SIP_METHOD_VERSION } from '../lib/engines/investment-intelligence/sip/sipXirr';
import { attributeSipUnits } from '../lib/engines/investment-intelligence/sip/sipAttribution';
import { SIP_DETECTION_METHOD_VERSION, type SipSeries, type SipCandidateTransaction } from '../lib/engines/investment-intelligence/sip/sipDetection';
import { SIP_THRESHOLD_CONFIG_VERSION } from '../lib/config/investment-intelligence/sipThresholds';
import { sinceInceptionXirrEligible } from '../lib/engines/investment-intelligence/dataQuality';
import type { RiskFreeRatePoint } from '../lib/config/investment-intelligence/riskFreeRate';

const CACHE = process.env.PC6_CACHE_DIR ?? 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/pc6-history';
fs.mkdirSync(CACHE, { recursive: true });

/** A real, currently-listed Indian scheme that also exists in FHIP's DEV instrument master. */
const TARGET_AMFI_CODE = '120503'; // Axis Bluechip Fund - Growth (Direct Plan)

const results: Array<{ id: string; verdict: 'PASS' | 'FAIL'; label: string; evidence: string }> = [];
let n = 0;
const check = (label: string, cond: boolean, evidence: string) => {
  n++;
  const id = `PC6-PERF-${String(n).padStart(2, '0')}`;
  results.push({ id, verdict: cond ? 'PASS' : 'FAIL', label, evidence });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${id}  ${label}\n        ${evidence}`);
};

/** Fetch one AMFI history window, cached on disk so re-runs do not re-hammer the source. */
async function fetchWindow(fromIso: string, toIso: string): Promise<Uint8Array | null> {
  const file = path.join(CACHE, `${fromIso}_${toIso}.txt`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const url = buildUrl('amfi_nav_history', { fromDate: fromIso, toDate: toIso });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'FHIP-PC6/1.0' } });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    if (b.byteLength < 50_000) return null;
    fs.writeFileSync(file, b);
    return b;
  } catch { return null; }
}

/** Month-end ISO dates for the N months ending before `endIso`. */
function monthEnds(endIso: string, months: number): string[] {
  const out: string[] = [];
  const end = new Date(`${endIso}T00:00:00.000Z`);
  for (let i = months; i >= 1; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i + 1, 0));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function main() {
  console.log('--- A. Build a REAL monthly NAV series from AMFI (PC6 reference data) ---');

  const targets = monthEnds('2026-09-01', 14);
  const series: Array<{ date: string; value: number; raw: string }> = [];
  let windowsFetched = 0;
  let schemeName = '';

  for (const me of targets) {
    // A 4-day window ending at month-end absorbs weekends and holidays; the
    // LAST observation inside it is the month-end NAV. No interpolation.
    const from = new Date(Date.parse(`${me}T00:00:00.000Z`) - 4 * 86_400_000).toISOString().slice(0, 10);
    const bytes = await fetchWindow(from, me);
    if (!bytes) { console.log(`  (window ${from}..${me} unavailable — skipped, not fabricated)`); continue; }
    windowsFetched++;
    const parsed = parseNavHistory(bytes, { asOfDate: '2026-09-15' });
    const forScheme = parsed.records.filter((r) => r.amfiSchemeCode === TARGET_AMFI_CODE).sort((a, b) => a.navDate.localeCompare(b.navDate));
    const last = forScheme.at(-1);
    if (!last) { console.log(`  (scheme ${TARGET_AMFI_CODE} absent from ${from}..${me} — skipped)`); continue; }
    schemeName = last.schemeName;
    series.push({ date: last.navDate, value: last.nav, raw: last.navRaw });
  }

  console.log(`  fetched ${windowsFetched} window(s); built ${series.length} month-end observations for "${schemeName}"`);
  console.log(`  series: ${series.map((p) => `${p.date}=${p.raw}`).join(', ')}`);

  check('a REAL multi-period NAV series is assembled from AMFI reference data',
    series.length >= 10 && series.every((p) => p.value > 0),
    `${series.length} month-end NAVs for AMFI code ${TARGET_AMFI_CODE} ("${schemeName}"), ${series[0]?.date} .. ${series.at(-1)?.date}`);

  if (series.length < 10) throw new Error('insufficient real series to run the activation proof');

  const navPoints = series.map((p) => ({ date: new Date(`${p.date}T00:00:00.000Z`), value: p.value }));

  // =========================================================================
  console.log('\n--- B. Valuation, XIRR, CAGR/point-to-point (N.12) ---');
  // =========================================================================
  // A realistic investor: a monthly SIP into the real scheme.
  const CONTRIBUTION = 10_000;
  const contributions = series.slice(0, -1).map((p) => ({ date: p.date, amount: CONTRIBUTION }));
  let units = 0;
  for (const c of contributions) {
    const nav = series.find((p) => p.date === c.date)!.value;
    units += c.amount / nav;
  }
  const terminal = series.at(-1)!;
  const currentValue = units * terminal.value;

  const cashFlows = [
    ...contributions.map((c) => ({ date: new Date(`${c.date}T00:00:00.000Z`), amount: -c.amount })),
    { date: new Date(`${terminal.date}T00:00:00.000Z`), amount: currentValue },
  ];

  const perf = computeSchemePerformance({
    instrumentId: 'pc6-activation-probe',
    historyCompleteness: 'complete_from_inception',
    optionType: 'growth',
    hasDistributionAdjustment: false,
    cashFlows,
    currentValue,
    currentValueDate: new Date(`${terminal.date}T00:00:00.000Z`),
    navSeries: navPoints,
  });

  check('CURRENT VALUATION is computed from PC6 NAV × units',
    currentValue > 0 && Number.isFinite(currentValue),
    `${units.toFixed(4)} units × NAV ${terminal.raw} (as at ${terminal.date}) = ${currentValue.toFixed(2)} INR, from ${contributions.length} contributions of ${CONTRIBUTION}`);

  check('XIRR activates and is produced by the certified R4 engine (not reimplemented)',
    perf.investorXirr.status === 'ok' && typeof perf.investorXirr.rate === 'number',
    `investorXirr=${perf.investorXirr.status} rate=${perf.investorXirr.rate?.toFixed(6)} engineVersion=${perf.engineVersion}`);

  // The result field is `pointToPointReturn` (and `cagr` only once the period
  // exceeds the engine's non-annualised horizon) — NOT `rate`. An earlier
  // draft read `.rate` and printed NaN% while still reporting PASS, because
  // the assertion only checked `status`. Assert FINITENESS, not just status.
  const horizons = Object.entries(perf.navPointToPoint);
  const finiteHorizons = horizons.filter(([, v]) => v.status === 'ok' && Number.isFinite(v.pointToPointReturn));
  check('CAGR / point-to-point returns activate across every horizon the series supports, with finite values',
    horizons.length >= 3 && finiteHorizons.length === horizons.length && perf.navPointToPoint['SINCE_INCEPTION']?.status === 'ok',
    `${finiteHorizons.length}/${horizons.length} finite — ${horizons.map(([k, v]) => `${k}=${v.status === 'ok' ? (v.pointToPointReturn! * 100).toFixed(2) + '%' + (v.cagr !== undefined ? ` (cagr ${(v.cagr * 100).toFixed(2)}%)` : '') : v.status}`).join(', ')}`);

  const flows = contributions.map((c) => ({ date: new Date(`${c.date}T00:00:00.000Z`), amount: c.amount }));
  // Valuation is taken AFTER that date's contribution has bought units. Taking
  // it before leaves the first sub-period starting at a value of zero, which
  // the certified TWRR engine correctly refuses as
  // NEGATIVE_OR_ZERO_SUBPERIOD_START — a real guard, and one this proof was
  // originally tripping over rather than testing.
  const valuations: Array<{ date: Date; value: number }> = [];
  let cumUnits = 0;
  for (const p of series) {
    if (contributions.some((c) => c.date === p.date)) cumUnits += CONTRIBUTION / p.value;
    valuations.push({ date: new Date(`${p.date}T00:00:00.000Z`), value: cumUnits * p.value });
  }
  const portfolio = computePortfolioPerformance({ valuations, externalFlows: flows, investorCashFlows: cashFlows });
  check('TWRR activates from the certified chain-linked engine and produces a real number',
    portfolio.portfolioTwrr.status === 'ok' && Number.isFinite(portfolio.portfolioTwrr.twrr) && portfolio.portfolioXirr.status === 'ok',
    `portfolioTwrr=${portfolio.portfolioTwrr.status}${portfolio.portfolioTwrr.status === 'ok' ? ` twrr=${portfolio.portfolioTwrr.twrr?.toFixed(6)} subPeriods=${portfolio.portfolioTwrr.subPeriods?.length} method=${portfolio.portfolioTwrr.method}` : ` reason=${(portfolio.portfolioTwrr as { reason?: string }).reason}`}, portfolioXirr=${portfolio.portfolioXirr.status} rate=${portfolio.portfolioXirr.rate?.toFixed(6)}`);

  check('every metric carries a reproducible input fingerprint and engine version',
    perf.inputFingerprint.length > 0 && portfolio.inputFingerprint.length > 0 && perf.engineVersion.length > 0,
    `scheme fingerprint=${perf.inputFingerprint.slice(0, 24)}… portfolio fingerprint=${portfolio.inputFingerprint.slice(0, 24)}… engine=${perf.engineVersion}`);

  // =========================================================================
  console.log('\n--- C. Risk metrics (N.12) ---');
  // =========================================================================
  const fundReturns = periodicReturnsFromLevels(navPoints);

  // SEALED SYNTHETIC benchmark. NOT a real index. See the header.
  const SEALED_BENCHMARK_KEY = 'SEALED-ORACLE-SYNTHETIC';
  let level = 1000;
  const benchmarkPoints = navPoints.map((p, i) => {
    level *= 1 + ((i * 7919) % 41 - 18) / 1000; // deterministic, reproducible, meaningless
    return { date: p.date, value: Number(level.toFixed(4)) };
  });
  const benchmarkReturns = periodicReturnsFromLevels(benchmarkPoints);

  // The UNCERTIFIED DEV seed, reproduced verbatim including its own
  // self-description. Using it here proves the engines activate; it does not
  // make it fit for production — see BLOCKER PO-PC6-2.
  const riskFreeSeries: RiskFreeRatePoint[] = [
    {
      countryCode: 'IN',
      periodStart: new Date('2025-01-01T00:00:00Z'),
      periodEnd: new Date('2026-12-31T00:00:00Z'),
      annualisedRate: 0.065,
      source: 'DEV SEED — approximate RBI 91-day T-Bill annual average (not a certified feed)',
      method: 'period_average',
      version: 'dev-seed-v1',
    },
  ];

  const risk = computeRiskMetrics({
    fundReturns,
    benchmarkReturns,
    valuationSeries: navPoints,
    frequency: 'monthly',
    countryCode: 'IN',
    asOfDate: new Date(`${terminal.date}T00:00:00.000Z`),
    riskFreeSeries,
  });

  // The risk engine's success status is 'CALCULATED' (calculationStatus.ts),
  // not 'ok'. Comparing against 'ok' made the first run report 0/11 while
  // every metric had in fact been calculated — a check that was wrong in the
  // safe direction, but wrong.
  const metricNames = ['volatility', 'downsideDeviation', 'maxDrawdown', 'sharpeRatio', 'sortinoRatio', 'beta', 'alpha', 'trackingError', 'informationRatio', 'captureRatios', 'calmarRatio'] as const;
  const activated = metricNames.filter((m) => risk[m].status === 'CALCULATED');
  check('every risk metric N.12 names activates from the certified R4 risk engine',
    activated.length === metricNames.length,
    `${activated.length}/${metricNames.length} CALCULATED — vol=${JSON.stringify(risk.volatility.value)} sharpe=${JSON.stringify(risk.sharpeRatio.value)} sortino=${JSON.stringify(risk.sortinoRatio.value)} beta=${JSON.stringify(risk.beta.value)} maxDD=${(risk.maxDrawdown.value as { maxDrawdown?: number })?.maxDrawdown?.toFixed(6)} calmar=${JSON.stringify(risk.calmarRatio.value)}`);

  // rollingReturnSeries takes Date objects, not ISO strings.
  const rolling = rollingReturnSeries(navPoints, 1);
  check('rolling returns activate from the certified engine, or say honestly why not',
    rolling.status === 'ok' ? (rolling.windows?.length ?? 0) >= 1 : rolling.reason === 'INSUFFICIENT_HISTORY',
    rolling.status === 'ok'
      ? `${rolling.windows!.length} 1-year window(s) over a ${series.length}-month series; stats=${JSON.stringify(rolling.stats)}`
      : `status=${rolling.status} reason=${rolling.reason} — a ${series.length}-month series cannot support a 1-year rolling series, and the engine says so rather than producing one`);

  // NEGATIVE CONTROL — withhold the risk-free series entirely.
  const noRf = computeRiskMetrics({
    fundReturns, benchmarkReturns, valuationSeries: navPoints, frequency: 'monthly',
    countryCode: 'IN', asOfDate: new Date(`${terminal.date}T00:00:00.000Z`), riskFreeSeries: [],
  });
  check('NEGATIVE CONTROL — with no risk-free series, Sharpe/Sortino are WITHHELD, never computed against an assumed zero',
    noRf.sharpeRatio.status !== 'CALCULATED' && noRf.sortinoRatio.status !== 'CALCULATED' && noRf.volatility.status === 'CALCULATED',
    `sharpe=${noRf.sharpeRatio.status}, sortino=${noRf.sortinoRatio.status}, but volatility=${noRf.volatility.status} (it needs no rf). riskFree=${JSON.stringify(noRf.riskFree)}`);

  // NEGATIVE CONTROL — withhold the benchmark.
  const noBm = computeRiskMetrics({
    fundReturns, valuationSeries: navPoints, frequency: 'monthly',
    countryCode: 'IN', asOfDate: new Date(`${terminal.date}T00:00:00.000Z`), riskFreeSeries,
  });
  check('NEGATIVE CONTROL — with no benchmark series, beta/alpha/TE/IR/capture are WITHHELD',
    ['beta', 'alpha', 'trackingError', 'informationRatio', 'captureRatios'].every((m) => noBm[m as 'beta'].status !== 'CALCULATED'),
    `beta=${noBm.beta.status} alpha=${noBm.alpha.status} trackingError=${noBm.trackingError.status} informationRatio=${noBm.informationRatio.status} capture=${noBm.captureRatios.status}`);

  // =========================================================================
  console.log('\n--- D. Benchmark growth and active return (N.12) ---');
  // =========================================================================
  const bmWindow = benchmarkWindowReturn(benchmarkPoints, navPoints[0].date, navPoints.at(-1)!.date);
  check('BENCHMARK GROWTH activates from the certified benchmark service',
    bmWindow.status === 'ok',
    `[${SEALED_BENCHMARK_KEY}] pointToPoint=${bmWindow.pointToPoint?.toFixed(6)} cagr=${bmWindow.cagr?.toFixed(6)} — SYNTHETIC series, never a real index`);

  // CAGR against CAGR — the only compatible pairing. Reading `.rate` here (as
  // an earlier draft did) silently passed `undefined` and the engine correctly
  // returned `unavailable`, which the check then accepted as a pass.
  const schemeCagr = perf.navPointToPoint['SINCE_INCEPTION']?.cagr;
  const active = computeSchemeActiveReturn(schemeCagr, bmWindow.cagr, 'CAGR');
  check('ACTIVE RETURN activates and only ever subtracts like from like (CAGR vs CAGR)',
    active.status === 'ok' && Number.isFinite(active.activeReturn),
    `scheme CAGR ${schemeCagr?.toFixed(6)} − benchmark CAGR ${bmWindow.cagr?.toFixed(6)} = ${active.activeReturn?.toFixed(6)} (status=${active.status}, family=CAGR)`);

  const missingBenchmarkSide = computeSchemeActiveReturn(schemeCagr, undefined, 'CAGR');
  check('NEGATIVE CONTROL — active return with a missing benchmark side is unavailable, not treated as the scheme return',
    missingBenchmarkSide.status !== 'ok',
    `status=${missingBenchmarkSide.status}; the certified engine refuses rather than defaulting the absent side to zero`);

  const blended = computeBlendedBenchmark({
    periodStart: navPoints[0].date,
    periodEnd: navPoints.at(-1)!.date,
    instrumentSeries: [{ instrumentId: 'pc6-activation-probe', points: valuations.map((v) => ({ date: v.date, value: v.value })) }],
    mappings: [{ instrumentId: 'pc6-activation-probe', benchmarkId: 'sealed', benchmarkKey: SEALED_BENCHMARK_KEY, returnType: 'TRI', effectiveFrom: navPoints[0].date, effectiveTo: null } as never],
    benchmarkSeriesById: { sealed: benchmarkPoints },
    requireTotalReturn: true,
  });
  check('blended benchmark activates, with coverage reported honestly',
    blended.blended.status === 'ok' || blended.blended.status === 'unavailable',
    `status=${blended.blended.status}, rebalance boundaries=${blended.rebalanceDates.length}, contributing=${blended.contributingBenchmarks.length}, annotations=${blended.annotations.map((a) => a.flag).join('|') || 'none'}`);

  // UNMAPPED control — the honest state N.8 demands.
  const unmapped = computeBlendedBenchmark({
    periodStart: navPoints[0].date, periodEnd: navPoints.at(-1)!.date,
    instrumentSeries: [{ instrumentId: 'pc6-activation-probe', points: valuations.map((v) => ({ date: v.date, value: v.value })) }],
    mappings: [], benchmarkSeriesById: {}, requireTotalReturn: true,
  });
  check('NEGATIVE CONTROL — an UNMAPPED scheme reduces coverage and suppresses the conclusion; it never contributes a 0% benchmark return',
    unmapped.blended.status !== 'ok' && unmapped.annotations.some((a) => a.flag === 'BENCHMARK_MAPPING_MISSING'),
    `status=${unmapped.blended.status} reason=${(unmapped.blended as { reason?: string }).reason} annotations=${unmapped.annotations.map((a) => a.flag).join('|')} (coverage threshold ${blended.minCoverageThreshold})`);

  // =========================================================================
  console.log('\n--- E. N.13 — same dated cashflows against benchmark levels ---');
  // =========================================================================
  // Real R5 shapes — SipCandidateTransaction contributions, a real FIFO
  // attribution, and the real SipCashFlowInputs. No `as never` casts: if the
  // certified engine's contract changed, this proof should stop compiling
  // rather than quietly testing a shape that no longer exists.
  const sipTxns: SipCandidateTransaction[] = contributions.map((c, i) => ({
    id: `pc6-sip-${i}`,
    accountId: 'pc6-probe-account',
    instrumentId: 'pc6-activation-probe',
    transactionType: 'sip',
    transactionDate: c.date,
    grossAmount: c.amount,
    units: c.amount / series.find((p) => p.date === c.date)!.value,
    currencyCode: 'INR',
  }));

  const sipSeries: SipSeries = {
    seriesKey: 'pc6-activation-sip',
    accountId: 'pc6-probe-account',
    instrumentId: 'pc6-activation-probe',
    currencyCode: 'INR',
    contributions: sipTxns,
    cadence: 'MONTHLY',
    periodsPerYear: 12,
    confidence: 'HIGH_CONFIDENCE',
    confidenceRationale: 'Synthetic activation probe: a strictly monthly, flat-amount schedule.',
    trend: 'FLAT',
    firstContributionDate: contributions[0].date,
    latestContributionDate: contributions.at(-1)!.date,
    detectionMethodVersion: SIP_DETECTION_METHOD_VERSION,
    thresholdConfigVersion: SIP_THRESHOLD_CONFIG_VERSION,
  };

  const attribution = attributeSipUnits(sipSeries, sipTxns, terminal.date);
  const actualSip = calculateActualSipXirr(sipSeries, attribution, { asOfDate: terminal.date, navAtAsOf: terminal.value });
  const benchSip = calculateBenchmarkSip(sipSeries, {
    benchmarkSeries: benchmarkPoints.map((p) => ({ date: p.date.toISOString().slice(0, 10), value: p.value })),
    asOfDate: terminal.date,
    benchmarkReturnType: 'TRI',
  });

  check('N.13 — FIFO unit attribution and the actual SIP XIRR both activate from the certified R5 engines',
    attribution.status === 'ok' && actualSip.status === 'ok',
    `attribution=${attribution.status} seriesUnitsRemaining=${attribution.seriesUnitsRemaining?.toFixed(4)}; actual SIP XIRR=${actualSip.rate?.toFixed(6)} (${actualSip.method})`);

  check('N.13 — the benchmark comparison uses the SAME dated cashflows, applied to benchmark index levels',
    benchSip.status === 'ok' &&
      benchSip.appliedContributions?.length === contributions.length &&
      benchSip.appliedContributions!.every((a, i) => a.date === contributions[i].date && a.amount === contributions[i].amount),
    `${benchSip.appliedContributions?.length ?? 0}/${contributions.length} contributions applied at their own dates; method=${BENCHMARK_SIP_METHOD_VERSION}; syntheticUnits=${benchSip.syntheticUnits?.toFixed(4)}; terminalValue=${benchSip.terminalValue?.toFixed(2)}`);

  check('N.13 — the comparison is a single XIRR over the shared schedule, NOT a weighted average of individual XIRRs',
    typeof benchSip.rate === 'number' && benchSip.xirrMethod.startsWith('xirr-'),
    `benchmark SIP XIRR = ${benchSip.rate?.toFixed(6)} computed once over ${contributions.length} dated flows plus one terminal value, via ${benchSip.xirrMethod}. No per-contribution XIRR is computed anywhere in the path.`);

  const excess = calculateSipExcessReturn(actualSip, benchSip, sipSeries);
  check('N.13 — excess return is actual-minus-benchmark over an identical schedule, and is never called alpha',
    excess.status === 'ok' && Number.isFinite(excess.excessReturn) && !/alpha/i.test(excess.label),
    `status=${excess.status} label="${excess.label}" excessReturn=${excess.excessReturn?.toFixed(6)}; actual=${actualSip.rate?.toFixed(6)} − benchmark=${benchSip.rate?.toFixed(6)}`);

  const partialBench = calculateBenchmarkSip(sipSeries, {
    benchmarkSeries: benchmarkPoints.slice(4).map((p) => ({ date: p.date.toISOString().slice(0, 10), value: p.value })),
    asOfDate: terminal.date, benchmarkReturnType: 'TRI',
  });
  check('NEGATIVE CONTROL — if any contribution cannot be aligned to a benchmark observation, the whole comparison is UNAVAILABLE',
    partialBench.status === 'unavailable',
    `truncated benchmark history -> status=${partialBench.status} reason=${partialBench.reason}; a partial-period comparison is never shown as a full one`);

  // =========================================================================
  console.log('\n--- F. N.14 — incomplete history must not fabricate ---');
  // =========================================================================
  const incomplete = computeSchemePerformance({
    instrumentId: 'pc6-activation-probe',
    historyCompleteness: 'opening_balance_only',
    optionType: 'growth',
    hasDistributionAdjustment: false,
    cashFlows,
    currentValue,
    currentValueDate: new Date(`${terminal.date}T00:00:00.000Z`),
    navSeries: navPoints,
  });
  check('N.14 — with opening-balance-only history, since-inception XIRR is WITHHELD',
    incomplete.investorXirr.status !== 'ok' && incomplete.sinceInceptionEligible === false,
    `investorXirr=${incomplete.investorXirr.status} reason=${(incomplete.investorXirr as { reason?: string }).reason}; eligibility gate = ${JSON.stringify(sinceInceptionXirrEligible('opening_balance_only'))}`);

  check('N.14 — but CURRENT VALUE and NAV-based point-to-point returns still work',
    Object.keys(incomplete.navPointToPoint).length === Object.keys(perf.navPointToPoint).length && currentValue > 0,
    `${Object.keys(incomplete.navPointToPoint).length} NAV-based horizons still produced, and current value ${currentValue.toFixed(2)} is unaffected — incomplete TRANSACTION history does not invalidate a PRICE fact`);

  check('N.14 — the withholding carries a user-facing explanation, not a silent blank',
    incomplete.dataQualityAnnotations.length > 0 && incomplete.dataQualityAnnotations[0].detail.length > 20,
    `${incomplete.dataQualityAnnotations.length} annotation(s): ${incomplete.dataQualityAnnotations.map((a) => a.flag).join(', ')} — "${incomplete.dataQualityAnnotations[0].detail.slice(0, 120)}…"`);

  // =========================================================================
  console.log('\n--- G. No analytics were reimplemented (N.12) ---');
  // =========================================================================
  const pc6Dir = 'lib/services/investment-intelligence/pc6';
  const pc6Files = fs.readdirSync(pc6Dir).filter((f) => f.endsWith('.ts'));
  const forbidden = /\b(function\s+(xirr|twrr|cagr|sharpe|sortino|beta|alpha|volatility|drawdown)|Math\.pow\([^)]*1\s*\/\s*years)/i;
  const offenders = pc6Files.filter((f) => forbidden.test(fs.readFileSync(path.join(pc6Dir, f), 'utf8')));
  check('N.12 — the PC6 modules contain no re-implementation of any certified metric',
    offenders.length === 0,
    `${pc6Files.length} PC6 module(s) scanned (${pc6Files.join(', ')}); ${offenders.length} contain a metric implementation`);
}

void (async () => {
  try {
    await main();
  } catch (e) {
    console.error('\nRUN ERROR:', (e as Error).message);
    results.push({ id: 'PC6-PERF-ERR', verdict: 'FAIL', label: 'activation proof completed without an unhandled error', evidence: (e as Error).message });
  }
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  console.log(`\n=== PC6 performance activation: ${pass} PASS, ${fail} FAIL, ${results.length} total ===`);
  fs.writeFileSync('scripts/pc6-performance-activation-results.json', JSON.stringify({ ranAt: new Date().toISOString(), pass, fail, results }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
})();
