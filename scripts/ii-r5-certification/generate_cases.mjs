// Investment Intelligence R5 — independent certification input generator.
//
// Pure, dependency-free, deterministic (fixed-seed PRNG). Imports NOTHING
// from production code. Writes cases.json, the single shared input consumed
// by BOTH sides of the certification:
//
//   * the production harness  -> tests/unit/iiR5Certification.test.ts
//   * the independent oracle  -> scripts/ii_r5_independent_reconciliation.py
//
// Neither side ever sees the other's output while computing. Expected values
// are NEVER generated using production code — the oracle derives them
// independently in Python from these raw inputs.
//
// Families (spec sections 82-89):
//   SIP-001..020        recurring-series detection + actual SIP XIRR
//   SIP-BENCH-001..010  identical-cash-flow benchmark SIP
//   STEP-001..008       historical flat / step-up simulations
//   XRAY-001..015       weighted look-through
//   OVERLAP-001..010    fund-to-fund overlap
//   CONC-001..008       concentration and classification exposure
//   DEBT-001..008       debt X-ray
//   DQ-R5-001..010      data-quality / no-fabrication proofs
//
// Run: node scripts/ii-r5-certification/generate_cases.mjs

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministic PRNG (mulberry32) — fixed seed so cases.json is
// byte-for-byte reproducible on every run.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260821);

function iso(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}
function addDays(isoDate, days) {
  const dt = new Date(isoDate + 'T00:00:00.000Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function addMonthsClamped(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00.000Z');
  const tm = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(tm / 12);
  const m = ((tm % 12) + 12) % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), dim))).toISOString().slice(0, 10);
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

/** Build a daily NAV/index series between two dates with a fixed drift. */
function buildSeries(startIso, endIso, startValue, annualDrift, volSeed, skipWeekends = true) {
  const r = mulberry32(volSeed);
  const out = [];
  let cur = startIso;
  let v = startValue;
  const daily = Math.pow(1 + annualDrift, 1 / 365) - 1;
  let guard = 0;
  while (cur <= endIso && guard++ < 20000) {
    const dow = new Date(cur + 'T00:00:00.000Z').getUTCDay();
    if (!skipWeekends || (dow !== 0 && dow !== 6)) {
      out.push({ date: cur, value: Math.round(v * 1e6) / 1e6 });
    }
    v = v * (1 + daily + (r() - 0.5) * 0.004);
    cur = addDays(cur, 1);
  }
  return out;
}

const cases = [];
let txnSeq = 0;
function txn(over) {
  txnSeq += 1;
  return {
    id: `T${String(txnSeq).padStart(5, '0')}`,
    accountId: 'ACC-1',
    instrumentId: 'INST-1',
    transactionType: 'sip',
    transactionDate: '2020-01-06',
    grossAmount: 5000,
    units: null,
    currencyCode: 'INR',
    sourceDescription: 'SIP INSTALMENT',
    ...over,
  };
}

/** Monthly SIP contributions priced off a NAV series (units derived). */
function monthlySip(startIso, count, amount, series, opts = {}) {
  const out = [];
  for (let k = 0; k < count; k++) {
    if (opts.skipIndexes && opts.skipIndexes.includes(k)) continue;
    const date = addMonthsClamped(startIso, k * (opts.intervalMonths ?? 1));
    const amt = typeof amount === 'function' ? amount(k) : amount;
    const nav = navOnOrAfter(series, date);
    out.push(
      txn({
        transactionDate: date,
        grossAmount: amt,
        units: nav ? Math.round((amt / nav.value) * 1e6) / 1e6 : null,
        transactionType: opts.transactionType ?? 'sip',
        sourceDescription: opts.sourceDescription ?? 'SIP INSTALMENT',
        instrumentId: opts.instrumentId ?? 'INST-1',
        accountId: opts.accountId ?? 'ACC-1',
      })
    );
  }
  return out;
}
function navOnOrAfter(series, date) {
  for (const o of series) {
    if (o.date >= date) {
      const delta = Math.round((Date.parse(o.date + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000);
      return delta <= 10 ? o : null;
    }
  }
  return null;
}
function navAsOf(series, date) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].date <= date) {
      const delta = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(series[i].date + 'T00:00:00Z')) / 86400000);
      return delta <= 10 ? series[i] : null;
    }
  }
  return null;
}

// ===========================================================================
// SIP-001..020 — detection + actual SIP XIRR
// ===========================================================================
const navA = buildSeries('2019-12-01', '2024-06-30', 100, 0.12, 11);
const navFlat = buildSeries('2019-12-01', '2024-06-30', 50, 0.0, 12);
const navDown = buildSeries('2019-12-01', '2024-06-30', 200, -0.15, 13);
const navUp = buildSeries('2019-12-01', '2024-06-30', 80, 0.30, 14);

function sipCase(id, description, transactions, opts = {}) {
  const asOfDate = opts.asOfDate ?? '2024-06-28';
  const series = opts.series ?? navA;
  const navPoint = navAsOf(series, asOfDate);
  cases.push({
    id,
    family: 'sip',
    description,
    input: {
      transactions,
      asOfDate,
      navAtAsOf: opts.navAtAsOf !== undefined ? opts.navAtAsOf : navPoint ? navPoint.value : null,
      attributableInflows: opts.attributableInflows ?? [],
      // Full position transaction set for attribution (defaults to the series itself).
      positionTransactions: opts.positionTransactions ?? transactions,
    },
    certify: opts.certify ?? ['cadence', 'confidence', 'contributionCount', 'actualSipXirr', 'consistencyPct', 'activityStatus'],
  });
}

sipCase('SIP-001', 'Explicit monthly SIP, 36 instalments, source-confirmed', monthlySip('2021-01-05', 36, 5000, navA));
sipCase('SIP-002', 'Explicit quarterly SIP, 12 instalments', monthlySip('2021-01-05', 12, 15000, navA, { intervalMonths: 3 }));
sipCase('SIP-003', 'Irregular manual purchases — must NOT be confirmed as SIP', [
  txn({ transactionDate: '2021-02-11', grossAmount: 20000, units: 190.5, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
  txn({ transactionDate: '2021-05-03', grossAmount: 35000, units: 320.1, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
  txn({ transactionDate: '2021-11-27', grossAmount: 12000, units: 101.7, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
  txn({ transactionDate: '2022-08-14', grossAmount: 50000, units: 401.2, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
]);
sipCase('SIP-004', 'Monthly SIP with ONE missed instalment — must never read as stopped', monthlySip('2021-01-05', 30, 5000, navA, { skipIndexes: [14] }));
sipCase('SIP-005', 'Monthly SIP with several missed instalments', monthlySip('2021-01-05', 30, 5000, navA, { skipIndexes: [10, 11, 12, 20] }));
sipCase('SIP-006', 'Increasing (step-up) contribution amounts', monthlySip('2021-01-05', 36, (k) => 5000 * Math.pow(1.1, Math.floor(k / 12)), navA));
sipCase('SIP-007', 'Decreasing contribution amounts', monthlySip('2021-01-05', 30, (k) => Math.round(8000 * Math.pow(0.9, Math.floor(k / 12))), navA));

{
  // SIP + an independent lump sum in the SAME fund. Units ARE present, so
  // FIFO attribution is genuinely reconstructable.
  const sip = monthlySip('2021-01-05', 24, 5000, navA);
  const lump = txn({ transactionDate: '2021-06-15', grossAmount: 200000, units: 1750.25, transactionType: 'purchase', sourceDescription: 'LUMPSUM PURCHASE' });
  sipCase('SIP-008', 'Fund contains BOTH SIP instalments and an independent lump sum', sip, { positionTransactions: [...sip, lump] });
}
{
  const sip = monthlySip('2021-01-05', 24, 5000, navA);
  const red = txn({ transactionDate: '2022-09-12', grossAmount: 40000, units: 300, transactionType: 'redemption', sourceDescription: 'REDEMPTION' });
  sipCase('SIP-009', 'SIP with a full-lot redemption partway through', sip, {
    positionTransactions: [...sip, red],
    attributableInflows: [{ date: '2022-09-12', amount: 40000 }],
  });
}
{
  const sip = monthlySip('2021-01-05', 30, 5000, navA);
  const red = txn({ transactionDate: '2023-01-20', grossAmount: 15000, units: 95.5, transactionType: 'redemption', sourceDescription: 'PARTIAL REDEMPTION' });
  sipCase('SIP-010', 'SIP with a partial redemption', sip, {
    positionTransactions: [...sip, red],
    attributableInflows: [{ date: '2023-01-20', amount: 15000 }],
  });
}
{
  const sip = monthlySip('2021-01-05', 30, 5000, navA);
  sipCase('SIP-011', 'SIP with an IDCW cash distribution received', sip, {
    attributableInflows: [{ date: '2022-03-15', amount: 3200 }, { date: '2023-03-15', amount: 3500 }],
  });
}
sipCase('SIP-012', 'SIP with a clearly negative outcome (falling NAV)', monthlySip('2021-01-05', 30, 5000, navDown), { series: navDown });
sipCase('SIP-013', 'SIP with a strongly positive outcome', monthlySip('2021-01-05', 30, 5000, navUp), { series: navUp });
sipCase('SIP-014', 'SIP with only 2 recorded instalments — insufficient for inference', [
  txn({ transactionDate: '2023-11-07', grossAmount: 5000, units: 40, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
  txn({ transactionDate: '2023-12-07', grossAmount: 5000, units: 39.4, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
]);
{
  // Units missing on one instalment -> attribution must be UNAVAILABLE and
  // the SIP-specific XIRR must be suppressed, not fabricated.
  const sip = monthlySip('2021-01-05', 24, 5000, navA);
  sip[7] = { ...sip[7], units: null };
  sipCase('SIP-015', 'Missing units on one instalment — SIP-specific XIRR must be suppressed', sip);
}
{
  // Two genuinely different mandates in the same fund and folio.
  const monthly = monthlySip('2021-01-05', 30, 5000, navA);
  const quarterly = monthlySip('2021-02-10', 10, 10000, navA, { intervalMonths: 3 });
  sipCase('SIP-016', 'Two different mandates in the SAME fund (Rs5,000 monthly + Rs10,000 quarterly)', [...monthly, ...quarterly], {
    certify: ['seriesCount', 'cadence', 'confidence', 'contributionCount'],
  });
}
sipCase('SIP-017', 'Same-amount purchases that are NOT a SIP (no stable interval)', [
  txn({ transactionDate: '2021-03-02', grossAmount: 10000, units: 90, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
  txn({ transactionDate: '2021-03-19', grossAmount: 10000, units: 89, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
  txn({ transactionDate: '2021-09-08', grossAmount: 10000, units: 85, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
  txn({ transactionDate: '2022-06-21', grossAmount: 10000, units: 78, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
]);
sipCase('SIP-018', 'Weekly SIP cadence — must not be forced to monthly', monthlySip('2021-01-05', 1, 1000, navA).concat(
  (() => {
    const out = [];
    let d = '2021-01-05';
    for (let k = 1; k < 40; k++) {
      d = addDays(d, 7);
      const nav = navOnOrAfter(navA, d);
      out.push(txn({ transactionDate: d, grossAmount: 1000, units: nav ? round2(1000 / nav.value) : null }));
    }
    return out;
  })()
));
sipCase('SIP-019', 'Long 40-month history ending well before the as-of date (dormant)', monthlySip('2020-01-06', 40, 5000, navA), { asOfDate: '2024-06-28' });
sipCase('SIP-020', 'Monthly SIP still active right up to the as-of date', monthlySip('2022-01-05', 29, 6000, navA), { asOfDate: '2024-06-05' });

// ===========================================================================
// SIP-BENCH-001..010 — identical-cash-flow benchmark SIP
// ===========================================================================
const bmA = buildSeries('2019-12-01', '2024-06-30', 15000, 0.11, 21);
const bmFlat = buildSeries('2019-12-01', '2024-06-30', 10000, 0.0, 22);
const bmDown = buildSeries('2019-12-01', '2024-06-30', 20000, -0.08, 23);

function benchCase(id, description, contributions, benchmarkSeries, opts = {}) {
  cases.push({
    id,
    family: 'benchmark_sip',
    description,
    input: {
      contributions,
      benchmarkSeries,
      asOfDate: opts.asOfDate ?? '2024-06-28',
    },
    certify: opts.certify ?? ['benchmarkSipStatus', 'benchmarkSipXirr', 'syntheticUnits', 'terminalValue'],
  });
}
function contribList(startIso, count, amount, intervalMonths = 1) {
  const out = [];
  for (let k = 0; k < count; k++) out.push({ date: addMonthsClamped(startIso, k * intervalMonths), amount: typeof amount === 'function' ? amount(k) : amount });
  return out;
}

benchCase('SIP-BENCH-001', 'Identical dates and amounts against a rising benchmark', contribList('2021-01-05', 36, 5000), bmA);
benchCase('SIP-BENCH-002', 'Contribution falling on a weekend (non-trading date)', contribList('2021-01-02', 30, 5000), bmA);
benchCase('SIP-BENCH-003', 'Benchmark history missing entirely — must return MISSING_BENCHMARK', contribList('2021-01-05', 24, 5000), []);
benchCase(
  'SIP-BENCH-004',
  'Benchmark history starts AFTER the first contribution — must return INCOMPLETE_BENCHMARK_HISTORY',
  contribList('2020-02-05', 30, 5000),
  buildSeries('2021-06-01', '2024-06-30', 15000, 0.11, 24)
);
benchCase('SIP-BENCH-005', 'Benchmark clearly outperforming', contribList('2021-01-05', 30, 5000), buildSeries('2019-12-01', '2024-06-30', 12000, 0.25, 25));
benchCase('SIP-BENCH-006', 'Benchmark clearly underperforming', contribList('2021-01-05', 30, 5000), bmDown);
benchCase('SIP-BENCH-007', 'Perfectly flat benchmark — XIRR must be ~0', contribList('2021-01-05', 30, 5000), bmFlat);
benchCase('SIP-BENCH-008', 'Negative benchmark period', contribList('2022-01-05', 24, 5000), bmDown);
benchCase(
  'SIP-BENCH-009',
  'Benchmark ends BEFORE the as-of date beyond the alignment window',
  contribList('2021-01-05', 24, 5000),
  buildSeries('2019-12-01', '2023-12-15', 15000, 0.11, 26),
  { asOfDate: '2024-06-28' }
);
benchCase('SIP-BENCH-010', 'Quarterly contributions with a stepped-up amount', contribList('2021-01-05', 12, (k) => 10000 + k * 500, 3), bmA);

// ===========================================================================
// STEP-001..008 — historical flat / step-up simulations
// ===========================================================================
function stepCase(id, description, opts) {
  cases.push({
    id,
    family: 'simulation',
    description,
    input: {
      series: opts.series ?? navA,
      startDate: opts.startDate ?? '2021-01-05',
      endDate: opts.endDate ?? '2024-06-28',
      startingContribution: opts.startingContribution ?? 5000,
      annualStepUpPct: opts.annualStepUpPct ?? 0,
      contributionIntervalMonths: opts.contributionIntervalMonths ?? 1,
    },
    certify: ['simulationStatus', 'contributionCount', 'totalContributed', 'unitsAccumulated', 'terminalValue', 'simulationXirr'],
  });
}
stepCase('STEP-001', 'Flat monthly contribution, no step-up', { annualStepUpPct: 0 });
stepCase('STEP-002', '5% annual step-up', { annualStepUpPct: 0.05 });
stepCase('STEP-003', '10% annual step-up', { annualStepUpPct: 0.1 });
stepCase('STEP-004', 'Step-up producing fractional amounts (rounding treatment)', { annualStepUpPct: 0.07, startingContribution: 3333 });
stepCase('STEP-005', 'Start date on a weekend (non-trading date handling)', { startDate: '2021-01-02', annualStepUpPct: 0.05 });
stepCase('STEP-006', 'Simulation across a falling market', { series: navDown, annualStepUpPct: 0.05 });
stepCase('STEP-007', 'Long 4.5-year history', { startDate: '2020-01-06', endDate: '2024-06-28', annualStepUpPct: 0.1 });
stepCase('STEP-008', 'Start-date boundary: start equals the first available observation', { startDate: '2019-12-02', endDate: '2022-12-30', annualStepUpPct: 0 });

// ===========================================================================
// XRAY-001..015 — weighted look-through
// ===========================================================================
let snapSeq = 0;
function snap(fundId, asOf, holdings, over = {}) {
  snapSeq += 1;
  return {
    snapshotId: `SNAP-${String(snapSeq).padStart(4, '0')}`,
    fundInstrumentId: fundId,
    holdingsAsOfDate: asOf,
    sourceKey: 'certification_fixture',
    sourceDataVersion: 'v1',
    classificationVersion: 'cert-classification-v1',
    holdings,
    ...over,
  };
}
function h(canonicalId, displayName, weightPct, over = {}) {
  return { canonicalId, displayName, weightPct, assetKind: 'security', sectorCode: null, industryCode: null, marketCapClass: null, ...over };
}
function xrayCase(id, description, positions, snapshots, opts = {}) {
  cases.push({
    id,
    family: 'xray',
    description,
    input: {
      positions,
      snapshots,
      asOfDate: opts.asOfDate ?? '2024-06-30',
      portfolioAsOfDate: opts.portfolioAsOfDate ?? '2024-06-30',
    },
    certify: opts.certify ?? ['lookThroughStatus', 'exposures', 'effectiveCoverage', 'cashWeight', 'unresolvedWeight', 'noSnapshotWeight', 'freshness'],
  });
}
const pos = (fundId, name, value, over = {}) => ({ fundInstrumentId: fundId, fundName: name, value, currencyCode: 'INR', amcId: null, amcName: null, ...over });

xrayCase('XRAY-001', 'One fund holding one security at 100%', [pos('F1', 'Fund One', 100000)], [snap('F1', '2024-06-01', [h('S1', 'Security One', 100)])]);
xrayCase(
  'XRAY-002',
  'One fund holding ten securities at 10% each',
  [pos('F1', 'Fund One', 250000)],
  [snap('F1', '2024-06-01', Array.from({ length: 10 }, (_, i) => h(`S${i + 1}`, `Security ${i + 1}`, 10)))]
);
xrayCase(
  'XRAY-003',
  'Two funds with NO overlapping securities',
  [pos('F1', 'Fund One', 600000), pos('F2', 'Fund Two', 400000)],
  [
    snap('F1', '2024-06-01', [h('S1', 'Security One', 60), h('S2', 'Security Two', 40)]),
    snap('F2', '2024-06-01', [h('S3', 'Security Three', 70), h('S4', 'Security Four', 30)]),
  ]
);
xrayCase(
  'XRAY-004',
  'Two funds with partial overlap',
  [pos('F1', 'Fund One', 500000), pos('F2', 'Fund Two', 500000)],
  [
    snap('F1', '2024-06-01', [h('S1', 'Security One', 50), h('S2', 'Security Two', 30), h('S3', 'Security Three', 20)]),
    snap('F2', '2024-06-01', [h('S2', 'Security Two', 40), h('S3', 'Security Three', 35), h('S5', 'Security Five', 25)]),
  ]
);
xrayCase(
  'XRAY-005',
  'Two funds with IDENTICAL holdings',
  [pos('F1', 'Fund One', 300000), pos('F2', 'Fund Two', 700000)],
  [
    snap('F1', '2024-06-01', [h('S1', 'Security One', 40), h('S2', 'Security Two', 60)]),
    snap('F2', '2024-06-01', [h('S1', 'Security One', 40), h('S2', 'Security Two', 60)]),
  ]
);
{
  const positions = [];
  const snapshots = [];
  for (let i = 1; i <= 5; i++) {
    positions.push(pos(`F${i}`, `Fund ${i}`, 100000 * i));
    const hs = [];
    for (let j = 1; j <= 8; j++) hs.push(h(`S${((i + j) % 12) + 1}`, `Security ${((i + j) % 12) + 1}`, 12.5));
    snapshots.push(snap(`F${i}`, '2024-06-01', hs));
  }
  xrayCase('XRAY-006', 'Five-fund portfolio with interleaved holdings', positions, snapshots);
}
xrayCase(
  'XRAY-007',
  'Same security disclosed under DIFFERENT provider names but the same canonical id',
  [pos('F1', 'Fund One', 400000), pos('F2', 'Fund Two', 600000)],
  [
    snap('F1', '2024-06-01', [h('S-REL', 'RELIANCE INDUSTRIES LTD.', 30), h('S2', 'Security Two', 70)]),
    snap('F2', '2024-06-01', [h('S-REL', 'Reliance Industries Limited', 20), h('S3', 'Security Three', 80)]),
  ]
);
xrayCase(
  'XRAY-008',
  'THE EXACT WEIGHTED IDENTITY: Fund A 60% holding X at 10%, Fund B 40% holding X at 20% -> exactly 14%',
  [pos('FA', 'Fund A', 600000), pos('FB', 'Fund B', 400000)],
  [
    snap('FA', '2024-06-01', [h('X', 'Security X', 10), h('OA', 'Other A', 90)]),
    snap('FB', '2024-06-01', [h('X', 'Security X', 20), h('OB', 'Other B', 80)]),
  ],
  { certify: ['lookThroughStatus', 'exposures', 'effectiveCoverage', 'exactExposureX'] }
);
xrayCase(
  'XRAY-009',
  'Unresolved holding retained as explicit unresolved exposure',
  [pos('F1', 'Fund One', 1000000)],
  [snap('F1', '2024-06-01', [h('S1', 'Security One', 70), h(null, 'UNIDENTIFIED HOLDING', 30)])]
);
xrayCase(
  'XRAY-010',
  'Cash exposure preserved, never redistributed across equities',
  [pos('F1', 'Fund One', 1000000)],
  [snap('F1', '2024-06-01', [h('S1', 'Security One', 85), h(null, 'CASH & EQUIVALENTS', 15, { assetKind: 'cash' })])]
);
xrayCase(
  'XRAY-011',
  'Incomplete fund holdings summing to 87% — must NOT be rescaled to 100%',
  [pos('F1', 'Fund One', 1000000)],
  [snap('F1', '2024-06-01', [h('S1', 'Security One', 50), h('S2', 'Security Two', 37)])]
);
xrayCase(
  'XRAY-012',
  'Portfolio where one fund has NO holdings snapshot at all',
  [pos('F1', 'Fund One', 600000), pos('F2', 'Fund Two', 400000)],
  [snap('F1', '2024-06-01', [h('S1', 'Security One', 100)])]
);
xrayCase(
  'XRAY-013',
  'Stale holdings (disclosure far older than the as-of date)',
  [pos('F1', 'Fund One', 1000000)],
  [snap('F1', '2023-04-30', [h('S1', 'Security One', 100)])]
);
xrayCase(
  'XRAY-014',
  'Mixed holdings dates across contributing funds',
  [pos('F1', 'Fund One', 500000), pos('F2', 'Fund Two', 500000)],
  [snap('F1', '2024-06-01', [h('S1', 'Security One', 100)]), snap('F2', '2023-09-30', [h('S2', 'Security Two', 100)])]
);
xrayCase(
  'XRAY-015',
  'A newer snapshot supersedes an older one; a FUTURE snapshot must be ignored',
  [pos('F1', 'Fund One', 1000000)],
  [
    snap('F1', '2024-01-31', [h('S1', 'Security One', 100)]),
    snap('F1', '2024-05-31', [h('S2', 'Security Two', 100)]),
    snap('F1', '2024-09-30', [h('S3', 'Security Three (FUTURE - must be ignored)', 100)]),
  ],
  { asOfDate: '2024-06-30' }
);

// ===========================================================================
// OVERLAP-001..010
// ===========================================================================
function overlapCase(id, description, snapshots, opts = {}) {
  cases.push({
    id,
    family: 'overlap',
    description,
    input: { snapshots, asOfDate: opts.asOfDate ?? '2024-06-30' },
    certify: opts.certify ?? ['overlapStatus', 'weightedOverlap', 'commonSecurityCount', 'symmetry'],
  });
}
overlapCase('OVERLAP-001', 'Identical portfolios -> overlap exactly 100%', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 40), h('S2', 'S2', 35), h('S3', 'S3', 25)]),
  snap('FB', '2024-06-01', [h('S1', 'S1', 40), h('S2', 'S2', 35), h('S3', 'S3', 25)]),
]);
overlapCase('OVERLAP-002', 'No common securities -> overlap exactly 0%', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 50), h('S2', 'S2', 50)]),
  snap('FB', '2024-06-01', [h('S3', 'S3', 50), h('S4', 'S4', 50)]),
]);
overlapCase('OVERLAP-003', 'THE WORKED EXAMPLE: X at 5% in A and 8% in B contributes exactly 5%', [
  snap('FA', '2024-06-01', [h('X', 'Security X', 5), h('A1', 'A1', 95)]),
  snap('FB', '2024-06-01', [h('X', 'Security X', 8), h('B1', 'B1', 92)]),
]);
overlapCase('OVERLAP-004', 'Multiple common holdings', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 30), h('S2', 'S2', 25), h('S3', 'S3', 20), h('S4', 'S4', 25)]),
  snap('FB', '2024-06-01', [h('S1', 'S1', 15), h('S2', 'S2', 35), h('S5', 'S5', 30), h('S3', 'S3', 20)]),
]);
overlapCase('OVERLAP-005', 'Strongly asymmetric weights on the common names', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 2), h('S2', 'S2', 98)]),
  snap('FB', '2024-06-01', [h('S1', 'S1', 60), h('S2', 'S2', 40)]),
]);
overlapCase('OVERLAP-006', 'Unresolved securities must be EXCLUDED from matching', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 40), h(null, 'UNKNOWN HOLDING', 60)]),
  snap('FB', '2024-06-01', [h('S1', 'S1', 30), h(null, 'UNKNOWN HOLDING', 70)]),
]);
overlapCase('OVERLAP-007', 'Cash must not participate in security overlap', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 80), h(null, 'CASH', 20, { assetKind: 'cash' })]),
  snap('FB', '2024-06-01', [h('S1', 'S1', 70), h(null, 'CASH', 30, { assetKind: 'cash' })]),
]);
overlapCase('OVERLAP-008', 'Stale holdings on one side -> warning must be raised', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 100)]),
  snap('FB', '2022-11-30', [h('S1', 'S1', 100)]),
], { certify: ['overlapStatus', 'weightedOverlap', 'commonSecurityCount', 'symmetry', 'hasQualityWarning'] });
overlapCase('OVERLAP-009', 'Different snapshot dates -> mixed-date warning', [
  snap('FA', '2024-06-01', [h('S1', 'S1', 55), h('S2', 'S2', 45)]),
  snap('FB', '2024-04-30', [h('S1', 'S1', 45), h('S2', 'S2', 55)]),
], { certify: ['overlapStatus', 'weightedOverlap', 'commonSecurityCount', 'symmetry', 'hasQualityWarning'] });
{
  const snaps = [];
  for (let i = 1; i <= 10; i++) {
    const hs = [];
    for (let j = 0; j < 6; j++) hs.push(h(`S${((i + j) % 15) + 1}`, `S${((i + j) % 15) + 1}`, [30, 25, 15, 12, 10, 8][j]));
    snaps.push(snap(`F${i}`, '2024-06-01', hs));
  }
  overlapCase('OVERLAP-010', 'Ten-fund pairwise overlap matrix (45 pairs, symmetry + bounds)', snaps, {
    certify: ['matrixSize', 'matrixSymmetric', 'matrixBounded', 'matrixValues'],
  });
}

// ===========================================================================
// CONC-001..008
// ===========================================================================
function concCase(id, description, positions, snapshots, opts = {}) {
  cases.push({
    id,
    family: 'concentration',
    description,
    input: { positions, snapshots, asOfDate: opts.asOfDate ?? '2024-06-30', portfolioAsOfDate: '2024-06-30' },
    certify: opts.certify ?? ['top1', 'top5', 'top10', 'hhi'],
  });
}
concCase('CONC-001', 'Single security at 100% -> HHI exactly 1.0', [pos('F1', 'Fund One', 100000)], [snap('F1', '2024-06-01', [h('S1', 'S1', 100)])]);
concCase(
  'CONC-002',
  'Ten equally-weighted securities -> HHI exactly 0.1',
  [pos('F1', 'Fund One', 100000)],
  [snap('F1', '2024-06-01', Array.from({ length: 10 }, (_, i) => h(`S${i + 1}`, `S${i + 1}`, 10)))]
);
concCase(
  'CONC-003',
  'Top-5 concentration across twenty securities',
  [pos('F1', 'Fund One', 100000)],
  [snap('F1', '2024-06-01', [
    h('S1', 'S1', 15), h('S2', 'S2', 12), h('S3', 'S3', 10), h('S4', 'S4', 9), h('S5', 'S5', 8),
    ...Array.from({ length: 15 }, (_, i) => h(`S${i + 6}`, `S${i + 6}`, 46 / 15)),
  ])]
);
concCase(
  'CONC-004',
  'HHI convention check on an uneven distribution',
  [pos('F1', 'Fund One', 100000), pos('F2', 'Fund Two', 300000)],
  [
    snap('F1', '2024-06-01', [h('S1', 'S1', 55), h('S2', 'S2', 45)]),
    snap('F2', '2024-06-01', [h('S2', 'S2', 20), h('S3', 'S3', 30), h('S4', 'S4', 50)]),
  ]
);
concCase(
  'CONC-005',
  'Sector aggregation across two funds',
  [pos('F1', 'Fund One', 400000), pos('F2', 'Fund Two', 600000)],
  [
    snap('F1', '2024-06-01', [h('S1', 'S1', 50, { sectorCode: 'FIN' }), h('S2', 'S2', 50, { sectorCode: 'TECH' })]),
    snap('F2', '2024-06-01', [h('S3', 'S3', 40, { sectorCode: 'FIN' }), h('S4', 'S4', 60, { sectorCode: 'ENERGY' })]),
  ],
  { certify: ['sectorBuckets', 'sectorClassifiedWeight', 'sectorUnclassifiedWeight'] }
);
concCase(
  'CONC-006',
  'Market-cap aggregation from security-level classification only',
  [pos('F1', 'Fund One', 500000), pos('F2', 'Fund Two', 500000)],
  [
    snap('F1', '2024-06-01', [h('S1', 'S1', 60, { marketCapClass: 'LARGE' }), h('S2', 'S2', 40, { marketCapClass: 'MID' })]),
    snap('F2', '2024-06-01', [h('S3', 'S3', 30, { marketCapClass: 'SMALL' }), h('S4', 'S4', 70, { marketCapClass: 'LARGE' })]),
  ],
  { certify: ['marketCapBuckets', 'marketCapClassifiedWeight', 'marketCapUnclassifiedWeight'] }
);
concCase(
  'CONC-007',
  'Partly unclassified holdings — unclassified weight retained, never redistributed',
  [pos('F1', 'Fund One', 1000000)],
  [snap('F1', '2024-06-01', [h('S1', 'S1', 40, { sectorCode: 'FIN' }), h('S2', 'S2', 35), h('S3', 'S3', 25, { sectorCode: 'TECH' })])],
  { certify: ['sectorBuckets', 'sectorClassifiedWeight', 'sectorUnclassifiedWeight'] }
);
cases.push({
  id: 'CONC-008',
  family: 'amc_concentration',
  description: 'AMC concentration by portfolio VALUE, not by scheme count',
  input: {
    positions: [
      pos('F1', 'Fund One', 500000, { amcId: 'AMC-A', amcName: 'AMC Alpha' }),
      pos('F2', 'Fund Two', 200000, { amcId: 'AMC-A', amcName: 'AMC Alpha' }),
      pos('F3', 'Fund Three', 300000, { amcId: 'AMC-B', amcName: 'AMC Beta' }),
      pos('F4', 'Fund Four', 100000),
    ],
  },
  certify: ['amcBuckets', 'amcUnattributedWeight'],
});

// ===========================================================================
// DEBT-001..008
// ===========================================================================
function debtCase(id, description, lines, opts = {}) {
  cases.push({
    id,
    family: 'debt',
    description,
    input: { lines, asOfDate: opts.asOfDate ?? '2024-06-30', consolidationMethodology: opts.consolidationMethodology ?? null },
    certify: opts.certify ?? ['creditStatus', 'creditBuckets', 'maturityStatus', 'maturityBuckets', 'durationStatus', 'weightedDuration', 'issuerBuckets'],
  });
}
const dl = (id, name, w, over = {}) => ({ canonicalId: id, displayName: name, effectiveWeight: w, ...over });

debtCase('DEBT-001', 'Issuer concentration across five bonds', [
  dl('B1', 'Bond 1', 0.3, { issuerId: 'ISS-A', issuerName: 'Issuer A', creditRatingBand: 'AAA', maturityDate: '2026-03-31', modifiedDuration: 1.6 }),
  dl('B2', 'Bond 2', 0.2, { issuerId: 'ISS-A', issuerName: 'Issuer A', creditRatingBand: 'AAA', maturityDate: '2027-06-30', modifiedDuration: 2.7 }),
  dl('B3', 'Bond 3', 0.2, { issuerId: 'ISS-B', issuerName: 'Issuer B', creditRatingBand: 'AA', maturityDate: '2029-01-15', modifiedDuration: 4.1 }),
  dl('B4', 'Bond 4', 0.2, { issuerId: 'ISS-C', issuerName: 'Issuer C', creditRatingBand: 'AA', maturityDate: '2031-12-31', modifiedDuration: 6.3 }),
  dl('B5', 'Bond 5', 0.1, { issuerId: 'ISS-C', issuerName: 'Issuer C', creditRatingBand: 'A', maturityDate: '2035-07-01', modifiedDuration: 8.4 }),
]);
debtCase('DEBT-002', 'Sovereign and corporate mix', [
  dl('G1', 'GOI 2030', 0.5, { issuerId: 'GOI', issuerName: 'Government of India', creditRatingBand: 'SOVEREIGN', maturityDate: '2030-04-30', modifiedDuration: 4.9 }),
  dl('C1', 'Corp 1', 0.3, { issuerId: 'ISS-A', issuerName: 'Issuer A', creditRatingBand: 'AAA', maturityDate: '2026-08-31', modifiedDuration: 2.0 }),
  dl('C2', 'Corp 2', 0.2, { issuerId: 'ISS-B', issuerName: 'Issuer B', creditRatingBand: 'AA', maturityDate: '2028-02-28', modifiedDuration: 3.3 }),
]);
debtCase('DEBT-003', 'Full rating distribution across all bands', [
  dl('B1', 'B1', 0.2, { issuerId: 'I1', creditRatingBand: 'SOVEREIGN', maturityDate: '2027-01-31', modifiedDuration: 2.4 }),
  dl('B2', 'B2', 0.2, { issuerId: 'I2', creditRatingBand: 'AAA', maturityDate: '2028-01-31', modifiedDuration: 3.2 }),
  dl('B3', 'B3', 0.2, { issuerId: 'I3', creditRatingBand: 'AA', maturityDate: '2029-01-31', modifiedDuration: 4.0 }),
  dl('B4', 'B4', 0.2, { issuerId: 'I4', creditRatingBand: 'A', maturityDate: '2030-01-31', modifiedDuration: 4.8 }),
  dl('B5', 'B5', 0.2, { issuerId: 'I5', creditRatingBand: 'BELOW_A', maturityDate: '2031-01-31', modifiedDuration: 5.5 }),
]);
debtCase('DEBT-004', 'Unrated securities — must land in UNRATED, never a credit band', [
  dl('B1', 'B1', 0.4, { issuerId: 'I1', creditRatingBand: 'AAA', maturityDate: '2027-01-31', modifiedDuration: 2.4 }),
  dl('B2', 'B2', 0.6, { issuerId: 'I2', maturityDate: '2028-01-31', modifiedDuration: 3.2 }),
]);
debtCase('DEBT-005', 'Maturity buckets spanning every band', [
  dl('B1', 'B1', 0.15, { issuerId: 'I1', creditRatingBand: 'AAA', maturityDate: '2024-11-30', modifiedDuration: 0.4 }),
  dl('B2', 'B2', 0.2, { issuerId: 'I2', creditRatingBand: 'AAA', maturityDate: '2026-06-30', modifiedDuration: 1.8 }),
  dl('B3', 'B3', 0.2, { issuerId: 'I3', creditRatingBand: 'AA', maturityDate: '2028-06-30', modifiedDuration: 3.5 }),
  dl('B4', 'B4', 0.25, { issuerId: 'I4', creditRatingBand: 'AA', maturityDate: '2032-06-30', modifiedDuration: 6.1 }),
  dl('B5', 'B5', 0.2, { issuerId: 'I5', creditRatingBand: 'A', maturityDate: '2040-06-30', modifiedDuration: 10.2 }),
]);
debtCase('DEBT-006', 'Missing duration on every line — duration must be UNAVAILABLE, never estimated', [
  dl('B1', 'B1', 0.5, { issuerId: 'I1', creditRatingBand: 'AAA', maturityDate: '2027-01-31' }),
  dl('B2', 'B2', 0.5, { issuerId: 'I2', creditRatingBand: 'AA', maturityDate: '2030-01-31' }),
]);
debtCase('DEBT-007', 'Conflicting multi-agency ratings, no approved consolidation -> SUPPRESSED', [
  dl('B1', 'B1', 0.5, { issuerId: 'I1', creditRatingBand: 'AAA', maturityDate: '2027-01-31', modifiedDuration: 2.4, agencyRatings: [{ agency: 'CRISIL', rating: 'AAA' }, { agency: 'ICRA', rating: 'AA' }] }),
  dl('B2', 'B2', 0.5, { issuerId: 'I2', creditRatingBand: 'AA', maturityDate: '2029-01-31', modifiedDuration: 4.0 }),
]);
debtCase('DEBT-008', 'Incomplete debt metadata: partial duration coverage below threshold', [
  dl('B1', 'B1', 0.3, { issuerId: 'I1', creditRatingBand: 'AAA', maturityDate: '2027-01-31', modifiedDuration: 2.4 }),
  dl('B2', 'B2', 0.7, { issuerId: 'I2', creditRatingBand: 'AA', maturityDate: '2029-01-31' }),
]);

// ===========================================================================
// DQ-R5-001..010 — data-quality and NO-FABRICATION proofs
// ===========================================================================
function dqCase(id, description, kind, input, certify) {
  cases.push({ id, family: 'data_quality', description, input: { kind, ...input }, certify });
}
dqCase('DQ-R5-001', 'No holdings at all -> must be MISSING_HOLDINGS, never an all-zero sector chart', 'xray',
  { positions: [pos('F1', 'Fund One', 1000000)], snapshots: [], asOfDate: '2024-06-30', portfolioAsOfDate: '2024-06-30' },
  ['lookThroughStatus', 'noFabricatedZeroSectors', 'effectiveCoverage']);
dqCase('DQ-R5-002', '50% holdings coverage reported accurately', 'xray',
  { positions: [pos('F1', 'Fund One', 500000), pos('F2', 'Fund Two', 500000)], snapshots: [snap('F1', '2024-06-01', [h('S1', 'S1', 100)])], asOfDate: '2024-06-30', portfolioAsOfDate: '2024-06-30' },
  ['lookThroughStatus', 'effectiveCoverage', 'noSnapshotWeight']);
dqCase('DQ-R5-003', '95% coverage reported accurately', 'xray',
  { positions: [pos('F1', 'Fund One', 950000), pos('F2', 'Fund Two', 50000)], snapshots: [snap('F1', '2024-06-01', [h('S1', 'S1', 100)])], asOfDate: '2024-06-30', portfolioAsOfDate: '2024-06-30' },
  ['lookThroughStatus', 'effectiveCoverage', 'noSnapshotWeight']);
dqCase('DQ-R5-004', 'Stale holdings must be flagged STALE, never presented as current', 'xray',
  { positions: [pos('F1', 'Fund One', 1000000)], snapshots: [snap('F1', '2023-06-30', [h('S1', 'S1', 100)])], asOfDate: '2024-06-30', portfolioAsOfDate: '2024-06-30' },
  ['freshness', 'hasStaleStatus']);
dqCase('DQ-R5-005', 'Mixed holdings dates disclosed explicitly', 'xray',
  { positions: [pos('F1', 'F1', 500000), pos('F2', 'F2', 500000)], snapshots: [snap('F1', '2024-06-01', [h('S1', 'S1', 100)]), snap('F2', '2023-11-30', [h('S2', 'S2', 100)])], asOfDate: '2024-06-30', portfolioAsOfDate: '2024-06-30' },
  ['mixedDateWarning', 'mixedDateSpreadDays', 'oldestHoldingsDate', 'newestHoldingsDate']);
dqCase('DQ-R5-006', 'Unresolved security surfaced as unresolved, not silently dropped', 'xray',
  { positions: [pos('F1', 'F1', 1000000)], snapshots: [snap('F1', '2024-06-01', [h('S1', 'S1', 55), h(null, 'MYSTERY HOLDING', 45)])], asOfDate: '2024-06-30', portfolioAsOfDate: '2024-06-30' },
  ['unresolvedWeight', 'hasUnresolvedStatus', 'weightIdentity']);
dqCase('DQ-R5-007', 'Missing benchmark for a SIP -> no fabricated benchmark result', 'benchmark_sip',
  { contributions: contribList('2021-01-05', 24, 5000), benchmarkSeries: [], asOfDate: '2024-06-28' },
  ['benchmarkSipStatus', 'benchmarkSipReason', 'noFabricatedBenchmarkRate']);
dqCase('DQ-R5-008', 'Insufficient SIP history -> AMBIGUOUS/NOT_SIP, never CONFIRMED', 'sip',
  { transactions: [txn({ transactionDate: '2024-05-06', grossAmount: 5000, units: 40, transactionType: 'purchase', sourceDescription: 'PURCHASE' })], asOfDate: '2024-06-28', navAtAsOf: 130, attributableInflows: [], positionTransactions: [] },
  ['confidence', 'notConfirmed']);
dqCase('DQ-R5-009', 'Ambiguous SIP classification never labelled CONFIRMED_SOURCE', 'sip',
  {
    transactions: [
      txn({ transactionDate: '2022-01-11', grossAmount: 7000, units: 60, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
      txn({ transactionDate: '2022-01-28', grossAmount: 7000, units: 59, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
      txn({ transactionDate: '2022-08-03', grossAmount: 7000, units: 55, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
      txn({ transactionDate: '2023-05-19', grossAmount: 7000, units: 50, transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
    ],
    asOfDate: '2024-06-28', navAtAsOf: 140, attributableInflows: [], positionTransactions: [],
  },
  ['confidence', 'notConfirmed']);
dqCase('DQ-R5-010', 'Missing credit ratings must not become a fabricated 0% credit-risk profile', 'debt',
  { lines: [dl('B1', 'B1', 0.6, { issuerId: 'I1', maturityDate: '2028-01-31' }), dl('B2', 'B2', 0.4, { issuerId: 'I2', maturityDate: '2030-01-31' })], asOfDate: '2024-06-30', consolidationMethodology: null },
  ['creditStatus', 'creditBuckets', 'durationStatus', 'noFabricatedDuration']);

// ===========================================================================
writeFileSync(path.join(__dirname, 'cases.json'), JSON.stringify({ generatedBy: 'ii-r5-certification/generate_cases.mjs', seed: 20260821, caseCount: cases.length, cases }, null, 2));
const byFamily = cases.reduce((acc, c) => ({ ...acc, [c.family]: (acc[c.family] ?? 0) + 1 }), {});
console.log(`Wrote ${cases.length} cases to cases.json`);
console.log('By family:', JSON.stringify(byFamily, null, 2));
