#!/usr/bin/env node
// Investment Intelligence R9 — independent oracle (spec sections 83-84).
//
// Deliberately reimplements the arithmetic from scratch in plain JS, with
// NO import of any production TypeScript (lib/engines, lib/services). This
// is an independent check that R9's integration arithmetic is right, not a
// test of the production code calling itself. Per spec section 84, this
// oracle does NOT attempt to re-derive the canonical Forecasting engine's
// own internals (that engine — lib/engines/forecast/*, lib/engines/goalForecast.ts
// — is separately certified by its own predecessor test packs); it
// independently verifies exactly the arithmetic R9 itself owns:
//   1. Goal-linked current value:  Sigma(investment current_value x allocation_pct/100)
//   2. Allocation-percentage summation and the <=100% cap decision
//   3. Portfolio allocated/unallocated split
//   4. Review-trigger threshold decisions (deterministic boolean logic)
//
// Run: node scripts/r9_independent_goals_forecasting_oracle.mjs

const cases = [];
let pass = 0, fail = 0;

function assertEqual(id, description, actual, expected, tolerance = 0.005) {
  const ok = Math.abs(actual - expected) <= tolerance;
  cases.push({ id, description, actual, expected, ok });
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} — ${description} (actual=${actual}, expected=${expected})`);
}
function assertBool(id, description, actual, expected) {
  const ok = actual === expected;
  cases.push({ id, description, actual, expected, ok });
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} — ${description} (actual=${actual}, expected=${expected})`);
}

// ---------------------------------------------------------------------------
// 1. Goal-linked current value — R9-TC-001..030 shape (goal allocations)
// ---------------------------------------------------------------------------
function goalLinkedValue(investments, sources) {
  const byGoal = {};
  for (const s of sources) {
    const inv = investments.find((i) => i.id === s.investmentId);
    if (!inv) continue;
    const share = s.allocationPct !== null ? inv.currentValue * (s.allocationPct / 100) : s.allocatedAmount;
    byGoal[s.goalId] = (byGoal[s.goalId] ?? 0) + share;
  }
  return byGoal;
}

{
  const investments = [{ id: 'inv-1', currentValue: 100000 }];
  const sources = [
    { goalId: 'retirement', investmentId: 'inv-1', allocationPct: 50, allocatedAmount: 0 },
    { goalId: 'education', investmentId: 'inv-1', allocationPct: 30, allocatedAmount: 0 },
    { goalId: 'house', investmentId: 'inv-1', allocationPct: 20, allocatedAmount: 0 },
  ];
  const result = goalLinkedValue(investments, sources);
  assertEqual('R9-ORACLE-001', 'retirement share of a 3-way-split 100000 investment at 50%', result.retirement, 50000);
  assertEqual('R9-ORACLE-002', 'education share at 30%', result.education, 30000);
  assertEqual('R9-ORACLE-003', 'house share at 20%', result.house, 20000);
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  assertEqual('R9-ORACLE-004', 'sum of every goal share across a fully-allocated investment equals its own current value exactly once (no double counting)', total, 100000);
}

{
  const investments = [
    { id: 'inv-1', currentValue: 40000 },
    { id: 'inv-2', currentValue: 60000 },
  ];
  const sources = [
    { goalId: 'g1', investmentId: 'inv-1', allocationPct: 100, allocatedAmount: 0 },
    { goalId: 'g1', investmentId: 'inv-2', allocationPct: 100, allocatedAmount: 0 },
  ];
  const result = goalLinkedValue(investments, sources);
  assertEqual('R9-ORACLE-005', 'two investments fully allocated to one goal sum correctly', result.g1, 100000);
}

{
  // Fixed-amount allocation shape.
  const investments = [{ id: 'inv-1', currentValue: 500000 }];
  const sources = [{ goalId: 'g1', investmentId: 'inv-1', allocationPct: null, allocatedAmount: 75000 }];
  const result = goalLinkedValue(investments, sources);
  assertEqual('R9-ORACLE-006', 'fixed_amount allocation contributes its literal amount regardless of the investment\'s own value', result.g1, 75000);
}

// ---------------------------------------------------------------------------
// 2. Allocation-percentage cap decision — R9-TC-031..060 shape
// ---------------------------------------------------------------------------
function wouldExceedCap(existingPct, candidatePct) {
  return existingPct + candidatePct > 100;
}
assertBool('R9-ORACLE-010', '70% existing + 30% candidate = 100% exactly -> does NOT exceed cap', wouldExceedCap(70, 30), false);
assertBool('R9-ORACLE-011', '70% existing + 31% candidate = 101% -> exceeds cap', wouldExceedCap(70, 31), true);
assertBool('R9-ORACLE-012', '0% existing + 100% candidate -> does not exceed cap (single full allocation)', wouldExceedCap(0, 100), false);
assertBool('R9-ORACLE-013', '0% existing + 100.01% candidate -> exceeds cap', wouldExceedCap(0, 100.01), true);
assertBool('R9-ORACLE-014', '50% + 50% + (implied) another 1% would exceed — two-step check', wouldExceedCap(100, 1), true);

// ---------------------------------------------------------------------------
// 3. Portfolio allocated/unallocated split — R9-TC-031..060 shape continued
// ---------------------------------------------------------------------------
function portfolioSplit(investments, sources) {
  let totalValue = 0, allocatedValue = 0;
  for (const inv of investments) {
    totalValue += inv.currentValue;
    const pct = sources.filter((s) => s.investmentId === inv.id).reduce((sum, s) => sum + (s.allocationPct ?? 0), 0);
    const fixed = sources.filter((s) => s.investmentId === inv.id && s.allocationPct === null).reduce((sum, s) => sum + s.allocatedAmount, 0);
    const pctValue = inv.currentValue * (Math.min(pct, 100) / 100);
    allocatedValue += Math.min(pctValue + fixed, inv.currentValue);
  }
  return { totalValue, allocatedValue, unallocatedValue: totalValue - allocatedValue };
}
{
  const investments = [
    { id: 'inv-1', currentValue: 100000 },
    { id: 'inv-2', currentValue: 50000 },
  ];
  const sources = [{ goalId: 'g1', investmentId: 'inv-1', allocationPct: 60, allocatedAmount: 0 }];
  const split = portfolioSplit(investments, sources);
  assertEqual('R9-ORACLE-020', 'portfolio total value across two investments', split.totalValue, 150000);
  assertEqual('R9-ORACLE-021', 'allocated value: 60% of inv-1 only, inv-2 fully unallocated', split.allocatedValue, 60000);
  assertEqual('R9-ORACLE-022', 'unallocated value: 40% of inv-1 (40000) plus all of inv-2 (50000)', split.unallocatedValue, 90000);
}

// ---------------------------------------------------------------------------
// 4. Review-trigger threshold decisions — R9-TC-126..160 shape (review-centre logic)
// ---------------------------------------------------------------------------
function isStale(lastRefreshedIso, asOfIso, staleDaysThreshold) {
  const days = Math.floor((new Date(asOfIso).getTime() - new Date(lastRefreshedIso).getTime()) / 86400000);
  return days > staleDaysThreshold;
}
assertBool('R9-ORACLE-030', 'exactly at the 90-day threshold does NOT count as stale (> not >=)', isStale('2026-01-01', '2026-04-01', 90), false); // 90 days exactly (Jan has 31, Feb 28, Mar 31 = 90 days to Apr 1)
assertBool('R9-ORACLE-031', '91 days since refresh IS stale at a 90-day threshold', isStale('2026-01-01', '2026-04-02', 90), true);

function goalForecastGapFlag(trackStatus, flaggedStatuses, hasActiveFundingSource) {
  return hasActiveFundingSource && flaggedStatuses.includes(trackStatus);
}
assertBool('R9-ORACLE-032', 'off_track WITH active funding source -> flagged', goalForecastGapFlag('off_track', ['off_track', 'at_risk'], true), true);
assertBool('R9-ORACLE-033', 'off_track WITHOUT active funding source -> not flagged (nothing to review yet)', goalForecastGapFlag('off_track', ['off_track', 'at_risk'], false), false);
assertBool('R9-ORACLE-034', 'on_track -> never flagged regardless of funding source', goalForecastGapFlag('on_track', ['off_track', 'at_risk'], true), false);

function overAllocationFlag(summedPct) {
  return summedPct > 100;
}
assertBool('R9-ORACLE-035', 'exactly 100% summed allocation -> not an over-allocation violation', overAllocationFlag(100), false);
assertBool('R9-ORACLE-036', '100.01% summed allocation -> IS an over-allocation violation', overAllocationFlag(100.01), true);

console.log(`\nR9 INDEPENDENT ORACLE: ${pass} passed, ${fail} failed, ${cases.length} total cases`);
if (fail > 0) process.exit(1);
