// Investment Intelligence R6-P1 — independent certification input generator.
//
// Pure, dependency-free, deterministic (fixed-seed PRNG). Imports NOTHING
// from production code. Writes cases.json, the single shared input consumed
// by BOTH sides of the certification:
//
//   * the production harness  -> tests/unit/iiR6P1Certification.test.ts
//   * the independent oracle  -> scripts/ii_r6p1_independent_reconciliation.py
//
// Neither side sees the other's output while computing. Expected values are
// NEVER generated using production code — the oracle derives them
// independently in Python from these raw inputs.
//
// Families (120 cases total):
//   FIFO-001..020       multi-lot partial consumption, exact-lot-boundary consumption
//   GRAND-001..015       grandfathering three-way min/max/cap logic (all 3 branches)
//   BOUND-001..015        12-month STCG/LTCG boundary (at / -1 day / +1 day)
//   DEBT-001..010        debt/specified-mutual-fund always-short-term rule
//   FYAGG-001..015        taxpayer-level LTCG exemption aggregation within one FY
//   CROSSFY-001..010      redemptions straddling the 31 March FY boundary
//   EXIT-001..015         exit-load holding-period-dependent computation
//   AMBIG-001..010        ambiguous/missing classification -> must flag, not guess
//   RATE-001..010         effective-dated rule-version resolution (1961/2025 Act)
//
// Run: node scripts/ii-r6p1-certification/generate_cases.mjs

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x52365031); // fixed seed "R6P1" leetspeak-ish

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
function randRange(min, max) {
  return min + rnd() * (max - min);
}
function randInt(min, max) {
  return Math.floor(randRange(min, max + 1));
}
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

const cases = [];

// ===========================================================================
// FIFO-001..020 — multi-lot partial consumption, exact-lot-boundary cases
// ===========================================================================
for (let i = 1; i <= 20; i++) {
  const id = `FIFO-${String(i).padStart(3, '0')}`;
  const instrumentKey = `SCH-FIFO-${i}`;
  const numLots = randInt(2, 4);
  let cursorDate = '2019-01-01';
  const acquisitions = [];
  for (let l = 0; l < numLots; l++) {
    cursorDate = addDays(cursorDate, randInt(30, 200));
    const units = round2(randRange(50, 500));
    const costPerUnit = round2(randRange(10, 100));
    acquisitions.push({
      sourceEventId: `${id}-acq-${l}`,
      instrumentKey,
      kind: 'purchase',
      acquisitionDate: cursorDate,
      units,
      costPerUnit,
    });
  }
  const totalUnits = acquisitions.reduce((s, a) => s + a.units, 0);

  // Every 4th case is an EXACT lot-boundary disposal (consumes exactly the
  // first N lots' units, no partial remainder) to specifically exercise the
  // "must never consume more units than a lot actually holds" / exact
  // boundary path distinctly from the general partial-consumption path.
  let disposalUnits;
  if (i % 4 === 0) {
    const boundaryLots = randInt(1, numLots - 1 || 1);
    disposalUnits = round2(acquisitions.slice(0, boundaryLots).reduce((s, a) => s + a.units, 0));
  } else {
    disposalUnits = round2(randRange(totalUnits * 0.2, totalUnits * 0.9));
  }
  const disposalDate = addDays(cursorDate, randInt(60, 400));
  const saleValue = round2(disposalUnits * randRange(15, 130));

  cases.push({
    id,
    family: 'fifo',
    acquisitions,
    disposals: [{ sourceEventId: `${id}-disp-0`, instrumentKey, disposalDate, units: disposalUnits, saleValue }],
  });
}

// ===========================================================================
// GRAND-001..015 — grandfathering three-way comparison, all three branches
// ===========================================================================
// Branch (a): fmv > actualCost AND fmv < salePrice -> fmv becomes basis
// Branch (b): fmv > salePrice -> basis capped at salePrice (never a manufactured loss)
// Branch (c): fmv <= actualCost -> no effect, actualCost used
// Plus a couple of "real pre-existing loss preserved" edge cases and
// "fmv unavailable" cases.
const grandBranches = ['fmv_benefit', 'fmv_benefit', 'fmv_benefit', 'fmv_benefit',
  'capped_at_sale', 'capped_at_sale', 'capped_at_sale', 'capped_at_sale',
  'no_effect', 'no_effect', 'no_effect', 'no_effect',
  'real_loss_preserved', 'real_loss_preserved', 'fmv_unavailable'];
for (let i = 1; i <= 15; i++) {
  const id = `GRAND-${String(i).padStart(3, '0')}`;
  const branch = grandBranches[i - 1];
  const acquisitionDate = '2016-06-15'; // before cutoff 2018-02-01
  let actualCostPerUnit, salePricePerUnit, fmvPerUnit;
  if (branch === 'fmv_benefit') {
    actualCostPerUnit = round2(randRange(20, 40));
    fmvPerUnit = round2(randRange(actualCostPerUnit + 10, actualCostPerUnit + 40));
    salePricePerUnit = round2(fmvPerUnit + randRange(10, 50));
  } else if (branch === 'capped_at_sale') {
    actualCostPerUnit = round2(randRange(20, 40));
    salePricePerUnit = round2(randRange(actualCostPerUnit + 5, actualCostPerUnit + 30));
    fmvPerUnit = round2(salePricePerUnit + randRange(10, 40)); // fmv exceeds sale price
  } else if (branch === 'no_effect') {
    fmvPerUnit = round2(randRange(10, 30));
    actualCostPerUnit = round2(fmvPerUnit + randRange(5, 30)); // actual cost already exceeds fmv
    salePricePerUnit = round2(actualCostPerUnit + randRange(5, 40));
  } else if (branch === 'real_loss_preserved') {
    salePricePerUnit = round2(randRange(20, 40));
    actualCostPerUnit = round2(salePricePerUnit + randRange(10, 30)); // real loss: cost > sale price
    fmvPerUnit = round2(randRange(actualCostPerUnit * 0.5, actualCostPerUnit * 0.9)); // fmv below actual cost, doesn't matter
  } else {
    // fmv_unavailable
    actualCostPerUnit = round2(randRange(20, 60));
    salePricePerUnit = round2(actualCostPerUnit + randRange(5, 40));
    fmvPerUnit = null;
  }
  cases.push({
    id,
    family: 'grandfathering',
    branch,
    acquisitionDate,
    actualCostPerUnit,
    salePricePerUnit,
    fmvPerUnit,
    isEquityOriented: true,
  });
}

// ===========================================================================
// BOUND-001..015 — 12-month STCG/LTCG boundary: exactly at, -1 day, +1 day
// ===========================================================================
const boundaryAcqDates = [
  '2021-04-01', '2021-06-15', '2020-02-29', // leap-year Feb 29 acquisition (clamp edge case)
  '2022-01-31', '2019-12-01',
];
let bIdx = 0;
for (let i = 1; i <= 15; i++) {
  const id = `BOUND-${String(i).padStart(3, '0')}`;
  const acquisitionDate = boundaryAcqDates[bIdx % boundaryAcqDates.length];
  bIdx++;
  const anniversary = addMonthsClamped(acquisitionDate, 12);
  const offset = i % 3; // 0 = exactly at anniversary, 1 = one day before, 2 = one day after
  let disposalDate;
  let expectLongTerm;
  if (offset === 0) {
    disposalDate = anniversary;
    expectLongTerm = false; // exactly 12 months = still short-term
  } else if (offset === 1) {
    disposalDate = addDays(anniversary, -1);
    expectLongTerm = false;
  } else {
    disposalDate = addDays(anniversary, 1);
    expectLongTerm = true;
  }
  cases.push({ id, family: 'boundary', acquisitionDate, disposalDate, thresholdMonths: 12, expectLongTerm });
}

// ===========================================================================
// DEBT-001..010 — debt/specified mutual fund: always short-term, any holding
// ===========================================================================
for (let i = 1; i <= 10; i++) {
  const id = `DEBT-${String(i).padStart(3, '0')}`;
  const acquisitionDate = `202${randInt(3, 4)}-0${randInt(4, 9)}-1${randInt(0, 5)}`;
  const holdYears = randInt(1, 6); // even held 6 years, still STCG
  const disposalDate = addMonthsClamped(acquisitionDate, holdYears * 12 + randInt(0, 6));
  const unitsConsumed = round2(randRange(50, 400));
  const costPerUnit = round2(randRange(10, 50));
  const salePricePerUnit = round2(costPerUnit + randRange(-5, 20));
  cases.push({
    id,
    family: 'debt',
    instrumentKey: `SCH-DEBT-${i}`,
    acquisitionDate,
    disposalDate,
    unitsConsumed,
    costPerUnit,
    salePricePerUnit,
  });
}

// ===========================================================================
// FYAGG-001..015 — taxpayer-level LTCG exemption aggregation within one FY
// ===========================================================================
for (let i = 1; i <= 15; i++) {
  const id = `FYAGG-${String(i).padStart(3, '0')}`;
  const fyStartYear = 2023 + (i % 3); // keep every FY's end date >= 2023-04-01, the earliest seeded rule version's effective_from
  const numDisposals = randInt(2, 5);
  const disposals = [];
  for (let d = 0; d < numDisposals; d++) {
    // Spread across the FY (1 Apr fyStartYear .. 31 Mar fyStartYear+1),
    // always within FY2024-25 or later for cases i%5===0 to hit the mid-FY
    // rate-change straddle deliberately.
    const monthOffset = randInt(0, 11);
    const day = randInt(1, 27);
    const month = ((3 + monthOffset) % 12) + 1;
    const year = month >= 4 ? fyStartYear : fyStartYear + 1;
    const disposalDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const taxableGain = round2(randRange(-20000, 150000));
    disposals.push({ disposalDate, classification: 'equity_oriented', gainType: 'ltcg', taxableGain });
  }
  cases.push({ id, family: 'fy_aggregation', disposals });
}

// ===========================================================================
// CROSSFY-001..010 — redemptions straddling the 31 March FY boundary
// ===========================================================================
for (let i = 1; i <= 10; i++) {
  const id = `CROSSFY-${String(i).padStart(3, '0')}`;
  const year = 2024 + (i % 3); // ${year}-03-31's FY-end (itself) stays >= 2023-04-01 rule coverage
  const disposals = [
    { disposalDate: `${year}-03-31`, classification: 'equity_oriented', gainType: 'ltcg', taxableGain: round2(randRange(30000, 90000)) },
    { disposalDate: `${year + 1}-04-01`, classification: 'equity_oriented', gainType: 'ltcg', taxableGain: round2(randRange(30000, 90000)) },
    { disposalDate: `${year}-03-15`, classification: 'equity_oriented', gainType: 'ltcg', taxableGain: round2(randRange(10000, 50000)) },
    { disposalDate: `${year + 1}-04-15`, classification: 'equity_oriented', gainType: 'ltcg', taxableGain: round2(randRange(10000, 50000)) },
  ];
  cases.push({ id, family: 'cross_fy', disposals });
}

// ===========================================================================
// EXIT-001..015 — exit-load holding-period-dependent computation
// ===========================================================================
for (let i = 1; i <= 15; i++) {
  const id = `EXIT-${String(i).padStart(3, '0')}`;
  const tiers = [
    { uptoDays: 90, loadPct: 2 },
    { uptoDays: 365, loadPct: 1 },
    { uptoDays: 1095, loadPct: 0.5 },
  ];
  const acquisitionDate = '2023-01-01';
  const holdingDaysChoices = [30, 89, 90, 91, 364, 365, 366, 1094, 1095, 1096, 2000, 1, 45, 500, 800];
  const holdingDays = holdingDaysChoices[i - 1];
  const disposalDate = addDays(acquisitionDate, holdingDays);
  const saleValueApportioned = round2(randRange(5000, 50000));
  cases.push({ id, family: 'exit_load', tiers, acquisitionDate, disposalDate, saleValueApportioned });
}

// ===========================================================================
// AMBIG-001..010 — ambiguous/missing classification: must flag, never guess
// ===========================================================================
const ambigBases = ['unresolved_no_data', 'unresolved_stale_data'];
for (let i = 1; i <= 10; i++) {
  const id = `AMBIG-${String(i).padStart(3, '0')}`;
  const basis = pick(ambigBases);
  cases.push({
    id,
    family: 'ambiguous',
    basis,
    acquisitionDate: '2022-01-10',
    disposalDate: '2023-08-20',
    unitsConsumed: round2(randRange(50, 300)),
    costPerUnit: round2(randRange(10, 60)),
    salePricePerUnit: round2(randRange(15, 90)),
  });
}

// ===========================================================================
// RATE-001..010 — effective-dated rule-version resolution
// ===========================================================================
const rateDates = [
  '2023-04-01', '2024-01-15', '2024-07-22', '2024-07-23', '2024-07-24',
  '2025-03-31', '2026-03-31', '2026-04-01', '2026-04-02', '2027-01-01',
];
for (let i = 1; i <= 10; i++) {
  const id = `RATE-${String(i).padStart(3, '0')}`;
  const disposalDate = rateDates[i - 1];
  cases.push({ id, family: 'rate_version', disposalDate });
}

// ---------------------------------------------------------------------------
const total = cases.length;
if (total !== 120) {
  console.error(`Expected exactly 120 cases, generated ${total}`);
  process.exit(1);
}

const outPath = path.join(__dirname, 'cases.json');
writeFileSync(outPath, JSON.stringify({ generatedAt: '2026-08-21', seed: '0x52365031', totalCases: total, cases }, null, 2));
console.log(`Wrote ${total} cases to ${outPath}`);

const byFamily = {};
for (const c of cases) byFamily[c.family] = (byFamily[c.family] || 0) + 1;
console.log('By family:', byFamily);
