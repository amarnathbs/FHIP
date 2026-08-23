// R4 — 50-case independent certification pack input generator (spec
// sections 71-72, 90). Pure, dependency-free, deterministic (fixed-seed
// PRNG) — imports NOTHING from production code. Writes cases.json, which
// is the single shared input both the production-engine test harness
// (tests/unit/iiR4Certification50Case.test.ts) and the independent Python
// oracle (scripts/ii_r4_independent_reconciliation.py) consume, so both
// sides are guaranteed to be looking at the identical input data.
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
const rand = mulberry32(20260820);

function isoDate(y, m, dd) {
  return new Date(Date.UTC(y, m - 1, dd)).toISOString().slice(0, 10);
}
function addDays(iso, days) {
  const dt = new Date(iso + 'T00:00:00.000Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

const cases = [];

// ---------------------------------------------------------------------
// TC001-010 — simple lump-sum / NAV point-to-point / CAGR cases
// ---------------------------------------------------------------------
for (let i = 1; i <= 10; i++) {
  const beginValue = 100 + Math.floor(rand() * 900);
  const years = 1 + Math.floor(rand() * 9);
  const growthFactor = 1 + rand() * 1.5; // up to 2.5x
  const endValue = Math.round(beginValue * Math.pow(growthFactor, 1) * 100) / 100;
  const beginDate = isoDate(2010 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 27));
  const endDate = addDays(beginDate, Math.round(years * 365.25));
  cases.push({
    id: `TC${String(i).padStart(3, '0')}`,
    family: 'cagr',
    description: `Lump-sum point-to-point / CAGR case ${i}`,
    input: { beginningValue: beginValue, beginningDate: beginDate, endingValue: endValue, endingDate: endDate },
  });
}

// ---------------------------------------------------------------------
// TC011-020 — irregular cash flows / XIRR cases
// ---------------------------------------------------------------------
for (let i = 11; i <= 20; i++) {
  const numFlows = 2 + Math.floor(rand() * 4);
  const flows = [];
  let cursor = isoDate(2015 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 27));
  let invested = 0;
  for (let f = 0; f < numFlows; f++) {
    const amount = -(500 + Math.floor(rand() * 4500));
    flows.push({ date: cursor, amount });
    invested += -amount;
    cursor = addDays(cursor, 30 + Math.floor(rand() * 300));
  }
  const endValue = Math.round(invested * (0.7 + rand() * 1.1) * 100) / 100;
  flows.push({ date: cursor, amount: endValue });
  cases.push({
    id: `TC${i}`,
    family: 'xirr',
    description: `Irregular multi-flow XIRR case ${i}`,
    input: { cashFlows: flows },
  });
}

// ---------------------------------------------------------------------
// TC021-030 — multi-scheme portfolio / TWRR cases
// ---------------------------------------------------------------------
for (let i = 21; i <= 30; i++) {
  const nSubPeriods = 2 + Math.floor(rand() * 3);
  let cursor = isoDate(2018, 1, 1);
  let value = 1000 + Math.floor(rand() * 4000);
  const valuations = [{ date: cursor, value }];
  const externalFlows = [];
  for (let p = 0; p < nSubPeriods; p++) {
    const marketReturn = -0.15 + rand() * 0.4; // -15% to +25%
    const preFlowValue = Math.round(value * (1 + marketReturn) * 100) / 100;
    const flowAmount = Math.round((rand() < 0.5 ? -1 : 1) * value * (0.05 + rand() * 0.3) * 100) / 100;
    const reportedValue = Math.round((preFlowValue + flowAmount) * 100) / 100;
    cursor = addDays(cursor, 60 + Math.floor(rand() * 200));
    valuations.push({ date: cursor, value: reportedValue });
    externalFlows.push({ date: cursor, amount: flowAmount });
    value = reportedValue;
  }
  cases.push({
    id: `TC${i}`,
    family: 'twrr',
    description: `Multi-sub-period TWRR case ${i}`,
    input: { valuations, externalFlows },
  });
}

// ---------------------------------------------------------------------
// TC031-040 — benchmark / rolling / active-return cases
// ---------------------------------------------------------------------
for (let i = 31; i <= 40; i++) {
  if (i <= 35) {
    // Blended benchmark, 1-3 holdings, 3-6 monthly periods.
    const nHoldings = 1 + Math.floor(rand() * 3);
    const nPeriods = 3 + Math.floor(rand() * 4);
    const holdingIds = Array.from({ length: nHoldings }, (_, k) => `H${k}`);
    const rawWeights = holdingIds.map(() => rand());
    const weightSum = rawWeights.reduce((a, b) => a + b, 0);
    const weights = rawWeights.map((w) => Math.round((w / weightSum) * 10000) / 10000);
    const periods = [];
    let cursor = isoDate(2020, 1, 1);
    for (let p = 0; p < nPeriods; p++) {
      const next = addDays(cursor, 30);
      const benchmarkReturnsByInstrument = {};
      holdingIds.forEach((h) => (benchmarkReturnsByInstrument[h] = Math.round((-0.08 + rand() * 0.16) * 1e6) / 1e6));
      periods.push({
        periodStart: cursor,
        periodEnd: next,
        weights: holdingIds.map((h, idx) => ({ instrumentId: h, weight: weights[idx], hasBenchmarkMapping: true })),
        benchmarkReturnsByInstrument,
      });
      cursor = next;
    }
    cases.push({ id: `TC${i}`, family: 'blendedBenchmark', description: `Blended benchmark case ${i}`, input: { periods } });
  } else {
    // Active return: same-family metric comparison.
    const portfolioMetric = Math.round((-0.1 + rand() * 0.3) * 1e6) / 1e6;
    const benchmarkMetric = Math.round((-0.1 + rand() * 0.3) * 1e6) / 1e6;
    cases.push({
      id: `TC${i}`,
      family: 'activeReturn',
      description: `Active return (same-family) case ${i}`,
      input: { portfolioMetric, benchmarkMetric, metricFamily: 'TWRR' },
    });
  }
}

// ---------------------------------------------------------------------
// TC041-045 — risk metric cases
// ---------------------------------------------------------------------
function genReturns(n, meanR, volR) {
  const out = [];
  for (let k = 0; k < n; k++) {
    // Box-Muller for approx-normal synthetic returns, deterministic PRNG.
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(Math.round((meanR + volR * z) * 1e6) / 1e6);
  }
  return out;
}
for (let i = 41; i <= 45; i++) {
  const n = 18 + Math.floor(rand() * 18);
  const fundReturns = genReturns(n, 0.008, 0.04);
  const benchReturns = genReturns(n, 0.006, 0.035);
  cases.push({
    id: `TC${i}`,
    family: 'riskBundle',
    description: `Risk metrics bundle case ${i} (volatility/beta/Sharpe/tracking error/max drawdown)`,
    input: { fundReturns, benchReturns, periodsPerYear: 12, annualisedRiskFreeRate: 0.065 },
  });
}

// ---------------------------------------------------------------------
// TC046-050 — incomplete-data / pathological edge cases (both
// implementations must agree the result is UNAVAILABLE, not just agree
// on a number).
// ---------------------------------------------------------------------
cases.push({ id: 'TC046', family: 'xirr', description: 'All-outflow cash flows (no positive flow) — must be unavailable', input: { cashFlows: [{ date: '2021-01-01', amount: -100 }, { date: '2021-06-01', amount: -50 }] } });
cases.push({ id: 'TC047', family: 'twrr', description: 'Missing boundary valuation at an external-flow date — must be unavailable', input: { valuations: [{ date: '2021-01-01', value: 1000 }, { date: '2022-01-01', value: 1200 }], externalFlows: [{ date: '2021-06-15', amount: 200 }] } });
cases.push({ id: 'TC048', family: 'cagr', description: 'Zero beginning value — must be unavailable', input: { beginningValue: 0, beginningDate: '2021-01-01', endingValue: 100, endingDate: '2022-01-01' } });
cases.push({ id: 'TC049', family: 'riskBundle', description: 'Too few observations for beta/volatility (n=3) — must be unavailable', input: { fundReturns: [0.01, 0.02, -0.01], benchReturns: [0.01, 0.02, -0.01], periodsPerYear: 12, annualisedRiskFreeRate: 0.065 } });
cases.push({ id: 'TC050', family: 'xirr', description: 'Single cash flow only — insufficient history, must be unavailable', input: { cashFlows: [{ date: '2021-01-01', amount: -1000 }] } });

writeFileSync(path.join(__dirname, 'cases.json'), JSON.stringify(cases, null, 2));
console.log(`Wrote ${cases.length} cases to cases.json`);
