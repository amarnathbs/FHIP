// Investment Intelligence — unit tests for
// lib/services/investment-intelligence/unitWeightedValuation.ts.
//
// Production defect found 2026-09-29 (PO report: XIRR/TWRR and
// active-return-vs-benchmark showing "not enough history" on holdings that
// plainly have years of NAV price history): confirmed live against
// production that EVERY row in ii_holding_snapshots carries exactly one
// as_of_date per (user, instrument) -- the analytics engine's
// SchemeDataset.valuationSeries was therefore always a single point,
// regardless of how much daily NAV history NAV1 had actually hydrated for
// the instrument, so portfolio TWRR (needs a start AND end valuation) could
// never be computed for any household. This module replays the position's
// own certified, signed unit ledger (the same taxonomy
// reconciliation.ts's unitDeltaForTransaction already certifies) against
// the daily NAV feed to reconstruct a genuine multi-point valuation series.

import { describe, it, expect } from 'vitest';
import { buildUnitWeightedValuationSeries, type UnitLedgerTransaction } from '@/lib/services/investment-intelligence/unitWeightedValuation';
import type { SeriesPoint } from '@/lib/engines/investment-intelligence/benchmarkService';

function nav(dateStr: string, value: number): SeriesPoint {
  return { date: new Date(`${dateStr}T00:00:00.000Z`), value };
}

function tx(dateStr: string, transactionType: UnitLedgerTransaction['transactionType'], units: number | null): UnitLedgerTransaction {
  return { date: new Date(`${dateStr}T00:00:00.000Z`), transactionType, units };
}

describe('UWVS-001: a single from-inception purchase, replayed against daily NAV, produces a full multi-point series', () => {
  it('one point per NAV date from the purchase date onward, each valued at units-held x that day\'s NAV', () => {
    const transactions: UnitLedgerTransaction[] = [tx('2020-01-01', 'purchase', 100)];
    const navSeries: SeriesPoint[] = [
      nav('2019-12-31', 9.5), // before the purchase -- must be excluded
      nav('2020-01-01', 10),
      nav('2020-01-02', 10.5),
      nav('2020-01-03', 11),
    ];
    const series = buildUnitWeightedValuationSeries(transactions, navSeries);
    expect(series.map((p) => p.value)).toEqual([1000, 1050, 1100]);
    expect(series[0].date.toISOString().slice(0, 10)).toBe('2020-01-01');
  });
});

describe('UWVS-002: a subsequent SIP top-up increases the running balance from its own date forward', () => {
  it('valuation reflects 100 units before the top-up date and 150 units from it onward', () => {
    const transactions: UnitLedgerTransaction[] = [tx('2020-01-01', 'purchase', 100), tx('2020-01-03', 'sip', 50)];
    const navSeries: SeriesPoint[] = [nav('2020-01-01', 10), nav('2020-01-02', 10), nav('2020-01-03', 10), nav('2020-01-04', 10)];
    const series = buildUnitWeightedValuationSeries(transactions, navSeries);
    expect(series.map((p) => p.value)).toEqual([1000, 1000, 1500, 1500]);
  });
});

describe('UWVS-003: a full redemption drops all later NAV points -- no phantom position after exit', () => {
  it('produces no valuation points after the units-held balance reaches zero', () => {
    const transactions: UnitLedgerTransaction[] = [tx('2020-01-01', 'purchase', 100), tx('2020-01-03', 'redemption', 100)];
    const navSeries: SeriesPoint[] = [nav('2020-01-01', 10), nav('2020-01-02', 10), nav('2020-01-03', 10), nav('2020-01-04', 10)];
    const series = buildUnitWeightedValuationSeries(transactions, navSeries);
    expect(series.map((p) => p.date.toISOString().slice(0, 10))).toEqual(['2020-01-01', '2020-01-02']);
  });
});

describe('UWVS-004: cash-only transaction types (fee, tax, non-reinvested dividend) never move the unit balance', () => {
  it('a fee/tax/dividend line with a units figure on it is ignored for balance purposes', () => {
    const transactions: UnitLedgerTransaction[] = [
      tx('2020-01-01', 'purchase', 100),
      tx('2020-01-02', 'fee', 0),
      tx('2020-01-02', 'tax', 0),
      tx('2020-01-02', 'dividend', 5), // a non-reinvested payout: cash-only, must not add units
    ];
    const navSeries: SeriesPoint[] = [nav('2020-01-01', 10), nav('2020-01-02', 10)];
    const series = buildUnitWeightedValuationSeries(transactions, navSeries);
    expect(series.map((p) => p.value)).toEqual([1000, 1000]);
  });
});

describe('UWVS-005: no unit-acquiring transaction at all -- refuse rather than fabricate a series', () => {
  it('returns [] when the transaction list never acquires a single unit (e.g. only fee/tax lines, or a malformed ledger)', () => {
    const transactions: UnitLedgerTransaction[] = [tx('2020-01-01', 'fee', 0), tx('2020-01-02', 'tax', 0)];
    const navSeries: SeriesPoint[] = [nav('2020-01-01', 10), nav('2020-01-02', 10)];
    expect(buildUnitWeightedValuationSeries(transactions, navSeries)).toEqual([]);
  });

  it('returns [] for an empty transaction list or an empty NAV series', () => {
    expect(buildUnitWeightedValuationSeries([], [nav('2020-01-01', 10)])).toEqual([]);
    expect(buildUnitWeightedValuationSeries([tx('2020-01-01', 'purchase', 100)], [])).toEqual([]);
  });
});

describe('UWVS-006: a switch_in (an internal transfer, still a real unit-count inflow at the single-scheme level) is replayed correctly', () => {
  it('increases the running balance exactly like a purchase', () => {
    const transactions: UnitLedgerTransaction[] = [tx('2020-01-01', 'switch_in', 100)];
    const navSeries: SeriesPoint[] = [nav('2020-01-01', 10)];
    const series = buildUnitWeightedValuationSeries(transactions, navSeries);
    expect(series).toEqual([{ date: navSeries[0].date, value: 1000 }]);
  });
});
