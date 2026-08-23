/**
 * R7 — Bank CSV Engine independent certification: reconciliation (spec
 * section 64, cases R7-TC096-R7-TC115) including negative controls NC2
 * (sign) and NC3 (date), spec section 70-71.
 */
import { describe, expect, it } from 'vitest';
import { reconcileBalances, computeDateCoverage, rangesOverlap } from '@/lib/financial-data-hub/bank-csv/reconciliation';
import type { ReconciliationTxnInput } from '@/lib/financial-data-hub/bank-csv/reconciliation';
import { normalizeRow, adapterToRowFormat } from '@/lib/financial-data-hub/bank-csv/normalize';
import { AU_CBA_DEBIT_CREDIT_V1 } from '@/lib/financial-data-hub/bank-csv/adapters/registry';

function txn(sourceRowNumber: number, amount: number, creditDebit: 'credit' | 'debit', balanceAfter: number | null): ReconciliationTxnInput {
  return { sourceRowNumber, amountOriginal: amount, creditDebit, balanceAfter };
}

describe('R7-TC096-101 — opening/closing balance rollforward (spec 42-43)', () => {
  it('R7-TC096 opening + credits - debits = closing reconciles exactly when the arithmetic is correct', () => {
    const rows = [txn(1, 1000, 'credit', 1000), txn(2, 200, 'debit', 800), txn(3, 50, 'debit', 750)];
    const r = reconcileBalances(rows, 'AUD');
    expect(r.status).toBe('reconciled');
    expect(r.openingBalance).toBe(0);
    expect(r.expectedClosingBalance).toBe(750);
    expect(r.reportedClosingBalance).toBe(750);
    expect(r.variance).toBe(0);
  });
  it('R7-TC097 a genuine balance break (row 2 balance does not follow from row 1) resolves FAILED, never RECONCILED', () => {
    const rows = [txn(1, 1000, 'credit', 1000), txn(2, 200, 'debit', 850)]; // should be 800, not 850
    const r = reconcileBalances(rows, 'AUD');
    expect(r.status).toBe('failed');
    expect(r.firstBreakRowNumber).toBe(2);
  });
  it('R7-TC098 no balance column present at all -> NOT_AVAILABLE, never fabricated', () => {
    const rows = [txn(1, 1000, 'credit', null), txn(2, 200, 'debit', null)];
    const r = reconcileBalances(rows, 'AUD');
    expect(r.status).toBe('not_available');
    expect(r.method).toBe('none');
  });
  it('R7-TC099 balance present on only SOME rows -> pending (partial coverage), never silently RECONCILED', () => {
    const rows = [txn(1, 1000, 'credit', 1000), txn(2, 200, 'debit', null)];
    const r = reconcileBalances(rows, 'AUD');
    expect(r.status).toBe('pending');
  });
  it('R7-TC100 zero transactions -> not_available, not a fabricated reconciled-with-nothing', () => {
    const r = reconcileBalances([], 'AUD');
    expect(r.status).toBe('not_available');
  });
  it('R7-TC101 variance is computed exactly at currency precision, not approximated', () => {
    const rows = [txn(1, 100.01, 'credit', 100.01), txn(2, 0.02, 'debit', 99.98)]; // deliberately off by 0.01
    const r = reconcileBalances(rows, 'AUD');
    expect(r.status).toBe('failed');
    expect(r.variance).toBeCloseTo(0.01, 4);
  });
});

describe('R7-TC102-106 — row-level running-balance continuity (spec 42)', () => {
  it('R7-TC102 a long, fully-consistent run of rows reconciles cleanly', () => {
    const rows: ReconciliationTxnInput[] = [];
    let balance = 5000;
    for (let i = 1; i <= 50; i++) {
      balance -= 10;
      rows.push(txn(i, 10, 'debit', balance));
    }
    const r = reconcileBalances(rows, 'AUD');
    expect(r.status).toBe('reconciled');
  });
  it('R7-TC103 a break in the MIDDLE of a long run is caught at the exact row it occurs', () => {
    const rows: ReconciliationTxnInput[] = [];
    let balance = 5000;
    for (let i = 1; i <= 20; i++) {
      balance -= 10;
      if (i === 12) balance += 100; // inject an error
      rows.push(txn(i, 10, 'debit', balance));
    }
    const r = reconcileBalances(rows, 'AUD');
    expect(r.status).toBe('failed');
    expect(r.firstBreakRowNumber).toBe(12);
  });
  it('R7-TC104 credits and debits interleave correctly through the rollforward', () => {
    const rows = [txn(1, 500, 'credit', 500), txn(2, 100, 'debit', 400), txn(3, 200, 'credit', 600), txn(4, 50, 'debit', 550)];
    expect(reconcileBalances(rows, 'AUD').status).toBe('reconciled');
  });
  it('R7-TC105 extractedCredits/extractedDebits sum matches the individual amounts exactly', () => {
    const rows = [txn(1, 500, 'credit', 500), txn(2, 100, 'debit', 400), txn(3, 200, 'credit', 600)];
    const r = reconcileBalances(rows, 'AUD');
    expect(r.extractedCredits).toBe(700);
    expect(r.extractedDebits).toBe(100);
  });
  it('R7-TC106 first-break detection reports only the FIRST break, not every subsequent (correctly cascading) discrepancy', () => {
    const rows = [txn(1, 100, 'credit', 100), txn(2, 10, 'debit', 999), txn(3, 10, 'debit', 979)]; // break at row 2, row 3 continues from the (wrong) row 2 balance
    const r = reconcileBalances(rows, 'AUD');
    expect(r.firstBreakRowNumber).toBe(2);
  });
});

describe('R7-TC107-111 — date-coverage reconciliation (spec 44)', () => {
  it('R7-TC107 earliest/latest transaction dates are computed correctly regardless of source row order', () => {
    const c = computeDateCoverage(['2026-01-15', '2026-01-02', '2026-01-28'], null, null);
    expect(c.earliestDate).toBe('2026-01-02');
    expect(c.latestDate).toBe('2026-01-28');
  });
  it('R7-TC108 a declared period that fully contains the transactions is withinDeclaredPeriod=true', () => {
    const c = computeDateCoverage(['2026-01-05', '2026-01-20'], '2026-01-01', '2026-01-31');
    expect(c.withinDeclaredPeriod).toBe(true);
  });
  it('R7-TC109 a transaction OUTSIDE the declared period is flagged, never silently accepted (spec 44 — never assume filename-derived coverage)', () => {
    const c = computeDateCoverage(['2026-02-05'], '2026-01-01', '2026-01-31');
    expect(c.withinDeclaredPeriod).toBe(false);
  });
  it('R7-TC110 no declared period at all -> withinDeclaredPeriod is null, not fabricated true/false', () => {
    const c = computeDateCoverage(['2026-01-05'], null, null);
    expect(c.withinDeclaredPeriod).toBeNull();
  });
  it('R7-TC111 zero transactions -> null coverage, not a fabricated single-day range', () => {
    const c = computeDateCoverage([], null, null);
    expect(c.earliestDate).toBeNull();
    expect(c.latestDate).toBeNull();
  });
});

describe('R7-TC112-115 — overlap detection between statements (spec 44)', () => {
  it('R7-TC112 two ranges that share at least one day overlap', () => {
    expect(rangesOverlap({ start: '2026-01-01', end: '2026-01-31' }, { start: '2026-01-15', end: '2026-02-28' })).toBe(true);
  });
  it('R7-TC113 adjacent but non-overlapping ranges do not overlap', () => {
    expect(rangesOverlap({ start: '2026-01-01', end: '2026-01-31' }, { start: '2026-02-01', end: '2026-02-28' })).toBe(false);
  });
  it('R7-TC114 a range fully contained within another overlaps', () => {
    expect(rangesOverlap({ start: '2026-01-01', end: '2026-12-31' }, { start: '2026-06-01', end: '2026-06-30' })).toBe(true);
  });
  it('R7-TC115 identical single-day ranges overlap', () => {
    expect(rangesOverlap({ start: '2026-01-01', end: '2026-01-01' }, { start: '2026-01-01', end: '2026-01-01' })).toBe(true);
  });
});

describe('NC2 — sign negative control (spec 70): inverted debit/credit convention breaks reconciliation', () => {
  it('R7-TC116 RED: inverting the sign convention for a known-correct statement causes reconciliation to FAIL', () => {
    const rows = [txn(1, 1000, 'credit', 1000), txn(2, 200, 'debit', 800)];
    // Deliberately invert credit_debit before reconciling, simulating the
    // exact NC2 mutation the spec describes ("temporarily invert
    // debit/credit sign convention for one adapter").
    const inverted = rows.map((r) => ({ ...r, creditDebit: r.creditDebit === 'credit' ? ('debit' as const) : ('credit' as const) }));
    const result = reconcileBalances(inverted, 'AUD');
    expect(result.status).toBe('failed'); // proves the sign convention is load-bearing for reconciliation
  });
  it('R7-TC117 GREEN: the correct (non-inverted) sign convention reconciles cleanly (restored)', () => {
    const rows = [txn(1, 1000, 'credit', 1000), txn(2, 200, 'debit', 800)];
    expect(reconcileBalances(rows, 'AUD').status).toBe('reconciled');
  });
});

describe('NC3 — date negative control (spec 71): DD/MM misread as MM/DD breaks a boundary case', () => {
  const rowFormat = adapterToRowFormat(AU_CBA_DEBIT_CREDIT_V1); // dateFormat: DD/MM/YYYY
  const header = ['Date', 'Description', 'Debit Amount', 'Credit Amount', 'Balance'];

  it('R7-TC118 RED: interpreting 25/12/2026 as MM/DD (month 25) fails to parse at all — proves the format assumption is load-bearing', () => {
    const wrongFormatRow = normalizeRow(header, ['25/12/2026', 'Xmas', '10.00', '', '100.00'], 1, { ...rowFormat, dateFormat: 'MM/DD/YYYY' });
    expect(wrongFormatRow.ok).toBe(false);
  });
  it('R7-TC119 RED: a genuinely swappable date (03/04/2026) parses to a DIFFERENT calendar date under the wrong format — silent corruption', () => {
    const correct = normalizeRow(header, ['03/04/2026', 'X', '10.00', '', '100.00'], 1, rowFormat); // DD/MM -> 3 April
    const wrong = normalizeRow(header, ['03/04/2026', 'X', '10.00', '', '100.00'], 1, { ...rowFormat, dateFormat: 'MM/DD/YYYY' }); // MM/DD -> 4 March
    expect(correct.ok && wrong.ok).toBe(true);
    if (correct.ok && wrong.ok) {
      expect(correct.transaction.transactionDate).not.toBe(wrong.transaction.transactionDate);
      expect(correct.transaction.transactionDate).toBe('2026-04-03');
      expect(wrong.transaction.transactionDate).toBe('2026-03-04');
    }
  });
  it('R7-TC120 GREEN: the adapter-proven DD/MM/YYYY format parses correctly (restored)', () => {
    const r = normalizeRow(header, ['25/12/2026', 'Xmas', '10.00', '', '100.00'], 1, rowFormat);
    expect(r.ok && r.transaction.transactionDate).toBe('2026-12-25');
  });
});
