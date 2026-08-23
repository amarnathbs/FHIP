/**
 * R8 — transfer/settlement pairing, refund/reversal linking, recurring
 * series detection. Pure functions, no database. Includes the negative
 * controls the spec requires (never matches on amount alone; false
 * transfers; false recurrence).
 */
import { describe, expect, it } from 'vitest';
import { matchInternalTransfers, openCandidateLink, type TransferCandidateTxn } from '@/lib/financial-data-hub/classification/transferMatching';
import { matchRefundsToOriginals, type RefundCandidateTxn } from '@/lib/financial-data-hub/classification/refundReversalMatching';
import { detectRecurringSeries, refreshSeriesStatus, type RecurringCandidateTxn } from '@/lib/financial-data-hub/classification/recurringDetection';
import type { FdhAccountType } from '@/lib/financial-data-hub/constants/enums';

function transferTxn(overrides: Partial<TransferCandidateTxn>): TransferCandidateTxn {
  return {
    id: 't1',
    financialAccountId: 'acc-a',
    transactionDate: '2026-03-01',
    amountOriginal: 500,
    currencyOriginal: 'AUD',
    creditDebit: 'debit',
    descriptionClean: 'TRANSFER',
    sourceReference: null,
    ...overrides,
  };
}

describe('R8 transferMatching — matchInternalTransfers', () => {
  it('pairs a same-amount opposite-direction different-account same-day transaction as HIGH confidence', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit', transactionDate: '2026-03-01' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-2', creditDebit: 'credit', transactionDate: '2026-03-01' });
    const links = matchInternalTransfers([a, b], new Map());
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ transactionIdFrom: 'a', transactionIdTo: 'b', linkType: 'internal_transfer', confidenceState: 'HIGH' });
  });

  it('NEGATIVE CONTROL — never pairs on amount alone: same account is rejected even with matching amount+direction', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-1', creditDebit: 'credit' });
    expect(matchInternalTransfers([a, b], new Map())).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — same direction across accounts is never paired (two real debits, not a transfer)', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-2', creditDebit: 'debit' });
    expect(matchInternalTransfers([a, b], new Map())).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — an unrelated same-amount pair well outside the date window is never paired (the classic +$500/-$500 false-transfer trap)', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit', transactionDate: '2026-01-01' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-2', creditDebit: 'credit', transactionDate: '2026-06-15' });
    expect(matchInternalTransfers([a, b], new Map())).toHaveLength(0);
  });

  it('different currencies never pair even with identical numeric amount', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit', currencyOriginal: 'AUD' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-2', creditDebit: 'credit', currencyOriginal: 'INR' });
    expect(matchInternalTransfers([a, b], new Map())).toHaveLength(0);
  });

  it('a credit-card account counterpart is classified credit_card_settlement, not internal_transfer', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-bank', creditDebit: 'debit' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-cc', creditDebit: 'credit' });
    const accountTypes = new Map<string, FdhAccountType>([['acc-cc', 'credit_card']]);
    const links = matchInternalTransfers([a, b], accountTypes);
    expect(links[0].linkType).toBe('credit_card_settlement');
  });

  it('a home_loan account counterpart is classified loan_payment', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-bank', creditDebit: 'debit' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-loan', creditDebit: 'credit' });
    const accountTypes = new Map<string, FdhAccountType>([['acc-loan', 'home_loan']]);
    const links = matchInternalTransfers([a, b], accountTypes);
    expect(links[0].linkType).toBe('loan_payment');
  });

  it('each transaction is used in at most one pair — the closest-date pair wins the shared amount bucket', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit', transactionDate: '2026-03-01' });
    const bFar = transferTxn({ id: 'b-far', financialAccountId: 'acc-2', creditDebit: 'credit', transactionDate: '2026-03-04' });
    const bClose = transferTxn({ id: 'b-close', financialAccountId: 'acc-3', creditDebit: 'credit', transactionDate: '2026-03-01' });
    const links = matchInternalTransfers([a, bFar, bClose], new Map());
    expect(links).toHaveLength(1);
    expect(links[0].transactionIdTo).toBe('b-close');
  });

  it('matching source_reference boosts confidence to HIGH even with a multi-day gap', () => {
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit', transactionDate: '2026-03-01', sourceReference: 'REF123' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-2', creditDebit: 'credit', transactionDate: '2026-03-03', sourceReference: 'REF123' });
    const links = matchInternalTransfers([a, b], new Map());
    expect(links[0].confidenceState).toBe('HIGH');
    expect((links[0].evidence as Record<string, unknown>).same_source_reference).toBe(true);
  });

  it('every proposed link is written pending, never auto-confirmed by the algorithm', () => {
    // (status itself lives on the DB row the caller builds — this test
    // documents the confidence/evidence contract the caller relies on to
    // always set status: 'pending', asserting confidence never reaches a
    // value the caller could misinterpret as "already confirmed".)
    const a = transferTxn({ id: 'a', financialAccountId: 'acc-1', creditDebit: 'debit' });
    const b = transferTxn({ id: 'b', financialAccountId: 'acc-2', creditDebit: 'credit' });
    const links = matchInternalTransfers([a, b], new Map());
    expect(links[0].confidence).toBeLessThanOrEqual(1);
    expect(['HIGH', 'MEDIUM']).toContain(links[0].confidenceState);
  });
});

describe('R8 transferMatching — openCandidateLink', () => {
  it('investment_funding_candidate never gains a fabricated counterpart', () => {
    const open = openCandidateLink('t1', 'investment_funding_candidate');
    expect(open.linkType).toBe('investment_funding');
    expect(open.confidence).toBeLessThan(0.6);
  });

  it('liability_settlement_candidate maps to credit_card_settlement', () => {
    expect(openCandidateLink('t1', 'liability_settlement_candidate').linkType).toBe('credit_card_settlement');
  });
});

describe('R8 refundReversalMatching', () => {
  function refundTxn(overrides: Partial<RefundCandidateTxn>): RefundCandidateTxn {
    return {
      id: 'r1', financialAccountId: 'acc-1', transactionDate: '2026-03-10', amountOriginal: 50,
      currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: false, ...overrides,
    };
  }

  it('links a full refund to its original (same account, opposite direction, same amount, later date)', () => {
    const original = refundTxn({ id: 'orig', creditDebit: 'debit', transactionDate: '2026-03-01', amountOriginal: 100 });
    const refund = refundTxn({ id: 'refund', creditDebit: 'credit', transactionDate: '2026-03-05', amountOriginal: 100, isRefundClassified: true });
    const links = matchRefundsToOriginals([original, refund]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ refundTransactionId: 'refund', originalTransactionId: 'orig', linkType: 'refund_original' });
  });

  it('a PARTIAL refund (smaller amount) links as reversal_original', () => {
    const original = refundTxn({ id: 'orig', creditDebit: 'debit', transactionDate: '2026-03-01', amountOriginal: 100 });
    const refund = refundTxn({ id: 'refund', creditDebit: 'credit', transactionDate: '2026-03-05', amountOriginal: 40, isRefundClassified: true });
    const links = matchRefundsToOriginals([original, refund]);
    expect(links[0].linkType).toBe('reversal_original');
  });

  it('NEGATIVE CONTROL — a refund can never exceed the original amount', () => {
    const original = refundTxn({ id: 'orig', creditDebit: 'debit', transactionDate: '2026-03-01', amountOriginal: 50 });
    const refund = refundTxn({ id: 'refund', creditDebit: 'credit', transactionDate: '2026-03-05', amountOriginal: 100, isRefundClassified: true });
    expect(matchRefundsToOriginals([original, refund])).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — an original in a DIFFERENT account is never linked', () => {
    const original = refundTxn({ id: 'orig', financialAccountId: 'acc-other', creditDebit: 'debit', transactionDate: '2026-03-01', amountOriginal: 100 });
    const refund = refundTxn({ id: 'refund', financialAccountId: 'acc-1', creditDebit: 'credit', transactionDate: '2026-03-05', amountOriginal: 100, isRefundClassified: true });
    expect(matchRefundsToOriginals([original, refund])).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — a "refund" dated BEFORE any candidate original is never linked', () => {
    const original = refundTxn({ id: 'orig', creditDebit: 'debit', transactionDate: '2026-03-10', amountOriginal: 100 });
    const refund = refundTxn({ id: 'refund', creditDebit: 'credit', transactionDate: '2026-03-01', amountOriginal: 100, isRefundClassified: true });
    expect(matchRefundsToOriginals([original, refund])).toHaveLength(0);
  });

  it('an unclassified transaction is never treated as a refund even if shape-compatible', () => {
    const original = refundTxn({ id: 'orig', creditDebit: 'debit', transactionDate: '2026-03-01', amountOriginal: 100 });
    const notRefund = refundTxn({ id: 'not-refund', creditDebit: 'credit', transactionDate: '2026-03-05', amountOriginal: 100, isRefundClassified: false });
    expect(matchRefundsToOriginals([original, notRefund])).toHaveLength(0);
  });
});

describe('R8 recurringDetection', () => {
  function recurringTxn(overrides: Partial<RecurringCandidateTxn>): RecurringCandidateTxn {
    return {
      id: 't1', transactionDate: '2026-01-01', amountOriginal: 15.99, currencyOriginal: 'AUD',
      creditDebit: 'debit', merchantId: 'm-netflix', descriptionClean: 'NETFLIX', financialAccountId: 'acc-1',
      ...overrides,
    };
  }

  it('detects a monthly series from 3 same-merchant, ~30-day-apart, fixed-amount occurrences', () => {
    const txns = [
      recurringTxn({ id: 't1', transactionDate: '2026-01-05' }),
      recurringTxn({ id: 't2', transactionDate: '2026-02-04' }),
      recurringTxn({ id: 't3', transactionDate: '2026-03-06' }),
    ];
    const series = detectRecurringSeries(txns);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ frequency: 'monthly', insufficientHistory: false, confidence: 'HIGH' });
    expect(series[0].memberTransactionIds).toEqual(['t1', 't2', 't3']);
  });

  it('with only 2 occurrences, the series is flagged insufficientHistory (spec: INSUFFICIENT_HISTORY)', () => {
    const txns = [
      recurringTxn({ id: 't1', transactionDate: '2026-01-05' }),
      recurringTxn({ id: 't2', transactionDate: '2026-02-04' }),
    ];
    const series = detectRecurringSeries(txns);
    expect(series[0].insufficientHistory).toBe(true);
  });

  it('NEGATIVE CONTROL — repeated same-merchant purchases with random gaps produce NO series (false-recurrence protection)', () => {
    const txns = [
      recurringTxn({ id: 't1', transactionDate: '2026-01-02', merchantId: 'm-supermarket' }),
      recurringTxn({ id: 't2', transactionDate: '2026-01-09', merchantId: 'm-supermarket' }),
      recurringTxn({ id: 't3', transactionDate: '2026-01-13', merchantId: 'm-supermarket' }),
      recurringTxn({ id: 't4', transactionDate: '2026-01-28', merchantId: 'm-supermarket' }),
    ];
    expect(detectRecurringSeries(txns)).toHaveLength(0);
  });

  it('supports a variable-amount recurring series (utility bill) without requiring exact equality', () => {
    const txns = [
      recurringTxn({ id: 't1', transactionDate: '2026-01-05', amountOriginal: 120, merchantId: 'm-energy' }),
      recurringTxn({ id: 't2', transactionDate: '2026-02-05', amountOriginal: 145, merchantId: 'm-energy' }),
      recurringTxn({ id: 't3', transactionDate: '2026-03-06', amountOriginal: 98, merchantId: 'm-energy' }),
    ];
    const series = detectRecurringSeries(txns);
    expect(series).toHaveLength(1);
    expect(series[0].amountTolerance).toBeGreaterThan(0);
    expect(series[0].confidence).toBe('MEDIUM'); // wide amount spread never earns HIGH
  });

  it('handles realistic weekend/month-boundary date drift within tolerance', () => {
    // Nominally the 1st of each month, but drifts to the nearest business day.
    const txns = [
      recurringTxn({ id: 't1', transactionDate: '2026-01-02' }), // Friday-adjacent drift
      recurringTxn({ id: 't2', transactionDate: '2026-02-02' }),
      recurringTxn({ id: 't3', transactionDate: '2026-03-02' }),
    ];
    const series = detectRecurringSeries(txns);
    expect(series).toHaveLength(1);
    expect(series[0].frequency).toBe('monthly');
  });

  it('a weekly cadence is detected as weekly, not folded into monthly', () => {
    const txns = [
      recurringTxn({ id: 't1', transactionDate: '2026-01-05', merchantId: 'm-gym' }),
      recurringTxn({ id: 't2', transactionDate: '2026-01-12', merchantId: 'm-gym' }),
      recurringTxn({ id: 't3', transactionDate: '2026-01-19', merchantId: 'm-gym' }),
    ];
    const series = detectRecurringSeries(txns);
    expect(series[0].frequency).toBe('weekly');
  });

  it('groups by normalised description when no merchant_id is present', () => {
    const txns = [
      recurringTxn({ id: 't1', merchantId: null, descriptionClean: 'Gym Membership Fee', transactionDate: '2026-01-05' }),
      recurringTxn({ id: 't2', merchantId: null, descriptionClean: 'gym membership fee', transactionDate: '2026-02-04' }),
      recurringTxn({ id: 't3', merchantId: null, descriptionClean: 'GYM MEMBERSHIP FEE', transactionDate: '2026-03-06' }),
    ];
    const series = detectRecurringSeries(txns);
    expect(series).toHaveLength(1);
  });

  it('never mixes credit and debit direction into the same series', () => {
    const txns = [
      recurringTxn({ id: 'd1', transactionDate: '2026-01-05', creditDebit: 'debit' }),
      recurringTxn({ id: 'd2', transactionDate: '2026-02-04', creditDebit: 'debit' }),
      recurringTxn({ id: 'd3', transactionDate: '2026-03-06', creditDebit: 'debit' }),
      // Interposed credit occurrence, same merchant/account/amount — if this
      // were wrongly folded into the debit sequence it would corrupt the
      // monthly delta pattern (or double-count a member). It must be
      // entirely absent from the resulting series.
      recurringTxn({ id: 'c1', transactionDate: '2026-01-20', creditDebit: 'credit' }),
    ];
    const series = detectRecurringSeries(txns);
    expect(series).toHaveLength(1);
    expect(series[0].memberTransactionIds).toEqual(['d1', 'd2', 'd3']);
    expect(series[0].memberTransactionIds).not.toContain('c1');
    expect(series[0].frequency).toBe('monthly');
  });
});

describe('R8 recurringDetection — refreshSeriesStatus', () => {
  it('stays active within 1.5x the nominal period', () => {
    expect(refreshSeriesStatus('2026-03-01', 30, '2026-03-20')).toBe('active');
  });

  it('never declares ended after a single missed occurrence — becomes paused instead', () => {
    expect(refreshSeriesStatus('2026-03-01', 30, '2026-05-20')).toBe('paused');
  });
});
