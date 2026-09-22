// NAV 1 R1 — unit tests for the report NAV-dependency manifest computation
// (reportNavDependencyManifest.ts). Pure function, no I/O; exercises every
// basis kind's grounded rule and its fail-closed defaults explicitly.

import { describe, it, expect } from 'vitest';
import {
  computeReportNavDependencyRange,
  computeReportNavDependencyManifest,
  type ReportNavDependencyInput,
} from '@/lib/services/investment-intelligence/pc6/reportNavDependencyManifest';
import { BENCHMARK_LOOKBACK_DAYS } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const INSTRUMENT = '37a3d60e-47db-4fb9-af8b-4a174dfa1f2f';
const AS_OF = '2026-09-18';

function subtractDaysForTest(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe('computeReportNavDependencyRange', () => {
  it('xirr_since_inception: bounds at the known earliest transaction date', () => {
    const r = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      basis: 'xirr_since_inception',
      reportAsOfDate: AS_OF,
      earliestTransactionDate: '2020-01-15',
    });
    expect(r).toEqual({ instrumentId: INSTRUMENT, basis: 'xirr_since_inception', navDateFrom: '2020-01-15', navDateTo: AS_OF });
  });

  it('xirr_since_inception: unknown earliest transaction date fails closed (unbounded), never assumes "not needed"', () => {
    const r = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      basis: 'xirr_since_inception',
      reportAsOfDate: AS_OF,
      earliestTransactionDate: null,
    });
    expect(r.navDateFrom).toBeNull();
    expect(r.navDateTo).toBe(AS_OF);
  });

  it('twr_since_opening_balance behaves identically to xirr_since_inception on the transaction-date binding', () => {
    const r = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      basis: 'twr_since_opening_balance',
      reportAsOfDate: AS_OF,
      earliestTransactionDate: '2021-06-01',
    });
    expect(r.navDateFrom).toBe('2021-06-01');
  });

  it('sip_xray_transaction_history: bounds at the earliest transaction date', () => {
    const r = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      basis: 'sip_xray_transaction_history',
      reportAsOfDate: AS_OF,
      earliestTransactionDate: '2019-03-10',
    });
    expect(r.navDateFrom).toBe('2019-03-10');
  });

  it('tax_lot_fifo: bounds at the earliest transaction date (needs every lot for correct FIFO matching)', () => {
    const r = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      basis: 'tax_lot_fifo',
      reportAsOfDate: AS_OF,
      earliestTransactionDate: '2018-11-02',
    });
    expect(r.navDateFrom).toBe('2018-11-02');
  });

  it('rolling_return_window: uses the SAME grounded BENCHMARK_LOOKBACK_DAYS constant navRetentionPolicy.ts uses, not a re-derived number', () => {
    const r = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      basis: 'rolling_return_window',
      reportAsOfDate: AS_OF,
    });
    expect(r.navDateFrom).toBe(subtractDaysForTest(AS_OF, BENCHMARK_LOOKBACK_DAYS));
    expect(r.navDateTo).toBe(AS_OF);
  });

  it('rolling_return_window ignores earliestTransactionDate entirely (it is not a transaction-driven basis)', () => {
    const withTxn = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      basis: 'rolling_return_window',
      reportAsOfDate: AS_OF,
      earliestTransactionDate: '2026-09-01', // deliberately recent -- must not shrink the window
    });
    expect(withTxn.navDateFrom).toBe(subtractDaysForTest(AS_OF, BENCHMARK_LOOKBACK_DAYS));
  });

  it('other (unrecognised basis): fails closed -- unbounded, never "no dependency"', () => {
    const r = computeReportNavDependencyRange({
      instrumentId: INSTRUMENT,
      // @ts-expect-error -- deliberately exercising the unrecognised-kind default path
      basis: 'some_future_report_kind_not_yet_added',
      reportAsOfDate: AS_OF,
    });
    expect(r.basis).toBe('other');
    expect(r.navDateFrom).toBeNull();
    expect(r.navDateTo).toBe(AS_OF);
  });

  it('navDateTo never exceeds the report own as-of date for any basis', () => {
    const bases: ReportNavDependencyInput['basis'][] = [
      'xirr_since_inception',
      'twr_since_opening_balance',
      'rolling_return_window',
      'sip_xray_transaction_history',
      'tax_lot_fifo',
      'other',
    ];
    for (const basis of bases) {
      const r = computeReportNavDependencyRange({ instrumentId: INSTRUMENT, basis, reportAsOfDate: AS_OF, earliestTransactionDate: '2015-01-01' });
      expect(r.navDateTo).toBe(AS_OF);
    }
  });
});

describe('computeReportNavDependencyManifest', () => {
  it('maps a list of per-instrument inputs to their computed ranges, preserving order and count', () => {
    const inputs: ReportNavDependencyInput[] = [
      { instrumentId: 'aaaa', basis: 'xirr_since_inception', reportAsOfDate: AS_OF, earliestTransactionDate: '2020-01-01' },
      { instrumentId: 'bbbb', basis: 'rolling_return_window', reportAsOfDate: AS_OF },
    ];
    const manifest = computeReportNavDependencyManifest(inputs);
    expect(manifest).toHaveLength(2);
    expect(manifest[0].instrumentId).toBe('aaaa');
    expect(manifest[0].navDateFrom).toBe('2020-01-01');
    expect(manifest[1].instrumentId).toBe('bbbb');
    expect(manifest[1].navDateFrom).toBe(subtractDaysForTest(AS_OF, BENCHMARK_LOOKBACK_DAYS));
  });

  it('an empty input list produces an empty manifest, not a fabricated default row', () => {
    expect(computeReportNavDependencyManifest([])).toEqual([]);
  });
});
