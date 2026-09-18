import { describe, it, expect } from 'vitest';
import { computeCostValue } from '@/lib/services/investment-intelligence/costBasis';

describe('computeCostValue (Holdings table Cost Value — average-cost, display only)', () => {
  it('returns null when there are no transactions at all', () => {
    expect(computeCostValue([])).toEqual({ costValue: null, unitsAtCost: 0 });
  });

  it('a pure buy-and-hold position with no disposal: cost value is exactly the sum of purchases', () => {
    const result = computeCostValue([
      { grossAmount: 1000, unitDelta: 6.078 },
      { grossAmount: 1000, unitDelta: 6.306 },
      { grossAmount: 1000, unitDelta: 6.184 },
      { grossAmount: 1000, unitDelta: 6.397 },
    ]);
    expect(result.costValue).toBeCloseTo(4000, 6);
    expect(result.unitsAtCost).toBeCloseTo(6.078 + 6.306 + 6.184 + 6.397, 6);
  });

  it('a reversal is removed at the average cost basis at that point, not naively netted against its own original amount', () => {
    // Buy 3 lots of 1000/6.x units each, then a same-shaped "reversal" with
    // a negative amount/units. Average-cost treats this identically to any
    // other disposal — it removes units at the average cost per unit
    // accumulated SO FAR, which need not exactly equal the original
    // purchase this reversal is undoing once other purchases at slightly
    // different prices have already blended into the average. This is a
    // deliberate, standard average-cost property, not a bug — computed by
    // hand here so a future change to the formula is caught.
    const result = computeCostValue([
      { grossAmount: 1000, unitDelta: 6.078 },
      { grossAmount: 1000, unitDelta: 6.306 },
      { grossAmount: 1000, unitDelta: 6.184 },
      { grossAmount: 1000, unitDelta: 6.397 }, // cost=4000, units=24.965
      { grossAmount: -1000, unitDelta: -6.397 }, // avg=4000/24.965=160.2243...; removes 6.397*avg=1025.05...
      { grossAmount: 1000, unitDelta: 6.397 },
    ]);
    const avgAtReversal = 4000 / (6.078 + 6.306 + 6.184 + 6.397);
    const expectedCost = 4000 - avgAtReversal * 6.397 + 1000;
    expect(result.costValue).toBeCloseTo(expectedCost, 6);
    expect(result.unitsAtCost).toBeCloseTo(6.078 + 6.306 + 6.184 + 6.397, 6);
  });

  it('a fee/tax event (zero unit delta) affects neither cost nor units', () => {
    const result = computeCostValue([
      { grossAmount: 1000, unitDelta: 10 },
      { grossAmount: 0.05, unitDelta: 0 }, // stamp duty, cash-only
    ]);
    expect(result.costValue).toBe(1000);
    expect(result.unitsAtCost).toBe(10);
  });

  it('a partial disposal reduces cost basis proportionally at the average cost per unit', () => {
    // Buy 100 units for ₹1,000 (₹10/unit avg), then sell 40 units.
    // Remaining: 60 units at the same ₹10/unit average = ₹600 cost basis.
    const result = computeCostValue([
      { grossAmount: 1000, unitDelta: 100 },
      { grossAmount: -400, unitDelta: -40 },
    ]);
    expect(result.costValue).toBeCloseTo(600, 6);
    expect(result.unitsAtCost).toBeCloseTo(60, 6);
  });

  it('a full disposal brings cost value to exactly zero, not negative', () => {
    const result = computeCostValue([
      { grossAmount: 1000, unitDelta: 100 },
      { grossAmount: -1200, unitDelta: -100 }, // sold at a gain, but cost basis removed is still the average cost, not the sale proceeds
    ]);
    expect(result.costValue).toBeCloseTo(0, 6);
    expect(result.unitsAtCost).toBe(0);
  });

  it('a disposal larger than the running balance clamps rather than going negative', () => {
    const result = computeCostValue([
      { grossAmount: 500, unitDelta: 50 },
      { grossAmount: -600, unitDelta: -60 }, // more units removed than were ever acquired — a data-quality condition, not this function's job to fix
    ]);
    expect(result.costValue).toBeCloseTo(0, 6);
    expect(result.unitsAtCost).toBe(0);
  });

  it('averages correctly across two purchases at different prices, then a disposal', () => {
    // 10 units @ ₹100 + 10 units @ ₹200 = ₹3,000 for 20 units (avg ₹150/unit).
    // Sell 5 units -> remove 5 * ₹150 = ₹750 -> ₹2,250 left for 15 units.
    const result = computeCostValue([
      { grossAmount: 1000, unitDelta: 10 },
      { grossAmount: 2000, unitDelta: 10 },
      { grossAmount: -750, unitDelta: -5 },
    ]);
    expect(result.costValue).toBeCloseTo(2250, 6);
    expect(result.unitsAtCost).toBeCloseTo(15, 6);
  });
});
