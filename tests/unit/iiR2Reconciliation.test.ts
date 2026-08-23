import { describe, it, expect } from 'vitest';
import { reconcilePosition, unitDeltaForTransaction, determineHistoryCompleteness, type ReconciliationTransactionInput } from '@/lib/services/investment-intelligence/reconciliation';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { parseExactDecimal, scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

function u(s: string): bigint {
  const r = parseExactDecimal(s);
  if (!r.ok) throw new Error('bad');
  return r.scaled;
}

describe('unitDeltaForTransaction — direction table', () => {
  it('treats purchase/sip/switch_in/stp_in/transfer_in/reinvestment as inflow (positive)', () => {
    for (const type of ['purchase', 'sip', 'switch_in', 'stp_in', 'transfer_in', 'reinvestment'] as const) {
      const delta = unitDeltaForTransaction({ canonicalType: type, unitsScaled: u('10.000') });
      expect(scaledToDecimalString(delta, 3)).toBe('10.000');
    }
  });
  it('treats redemption/switch_out/stp_out/swp/transfer_out as outflow (negative), regardless of the raw parsed sign', () => {
    for (const type of ['redemption', 'switch_out', 'stp_out', 'swp', 'transfer_out'] as const) {
      const delta = unitDeltaForTransaction({ canonicalType: type, unitsScaled: u('10.000') });
      expect(scaledToDecimalString(delta, 3)).toBe('-10.000');
    }
  });
  it('treats dividend/fee/tax as cash-only (zero unit impact)', () => {
    for (const type of ['dividend', 'fee', 'tax'] as const) {
      const delta = unitDeltaForTransaction({ canonicalType: type, unitsScaled: u('10.000') });
      expect(scaledToDecimalString(delta, 3)).toBe('0.000');
    }
  });
  it('a null units value always contributes zero regardless of type', () => {
    expect(scaledToDecimalString(unitDeltaForTransaction({ canonicalType: 'purchase', unitsScaled: null }), 3)).toBe('0.000');
    expect(scaledToDecimalString(unitDeltaForTransaction({ canonicalType: 'redemption', unitsScaled: null }), 3)).toBe('0.000');
  });
  it('passthrough types (reversal/adjustment/transfer/merger/segregation/unclassified) use the raw signed value as-is', () => {
    const delta = unitDeltaForTransaction({ canonicalType: 'reversal', unitsScaled: u('-5.000') });
    expect(scaledToDecimalString(delta, 3)).toBe('-5.000');
  });
});

describe('reconcilePosition (spec sections 24-25 — Portfolio Truth reconciliation)', () => {
  it('REC-001: exact unit reconciliation — opening + inflows - outflows == statement closing, zero variance', () => {
    const transactions: ReconciliationTransactionInput[] = [
      { canonicalType: 'purchase', unitsScaled: u('100.000') },
      { canonicalType: 'redemption', unitsScaled: u('20.000') },
    ];
    const result = reconcilePosition({
      openingUnitsScaled: u('0.000'),
      transactions,
      statementClosingUnitsScaled: u('80.000'),
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.withinTolerance).toBe(true);
    expect(scaledToDecimalString(result.unitVarianceScaled!, 6)).toBe('0.000000');
  });

  it('REC-002: a variance within the configured tolerance (0.0001) still certifies as within-tolerance', () => {
    const transactions: ReconciliationTransactionInput[] = [{ canonicalType: 'purchase', unitsScaled: u('100.00005') }];
    const result = reconcilePosition({
      openingUnitsScaled: u('0.000'),
      transactions,
      statementClosingUnitsScaled: u('100.00000'), // statement rounds slightly differently — well within 0.0001 tolerance
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.withinTolerance).toBe(true);
  });

  it('REC-003: a material mismatch (variance exceeding tolerance) is correctly flagged, never concealed by a wide tolerance', () => {
    const transactions: ReconciliationTransactionInput[] = [{ canonicalType: 'purchase', unitsScaled: u('100.000') }];
    const result = reconcilePosition({
      openingUnitsScaled: u('0.000'),
      transactions,
      statementClosingUnitsScaled: u('95.000'), // 5 units unexplained
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.withinTolerance).toBe(false);
    expect(scaledToDecimalString(result.unitVarianceScaled!, 3)).toBe('5.000');
  });

  it('REC-004: missing opening history but a valid closing snapshot — reconciliation is correctly marked "cannot evaluate" (null), never fabricated as passing', () => {
    const result = reconcilePosition({
      openingUnitsScaled: null,
      transactions: [{ canonicalType: 'purchase', unitsScaled: u('10.000') }],
      statementClosingUnitsScaled: u('500.000'), // a large pre-existing balance we have no history for
      historyCompleteness: 'partial_history',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.withinTolerance).toBeNull();
    expect(result.reconciledClosingUnitsScaled).toBeNull();
    expect(result.reconciledOpeningUnitsScaled).toBeNull();
  });

  it('complete_from_inception with no explicit opening balance implies opening=0 (a fund first purchased within this statement)', () => {
    const result = reconcilePosition({
      openingUnitsScaled: null,
      transactions: [{ canonicalType: 'purchase', unitsScaled: u('50.000') }],
      statementClosingUnitsScaled: u('50.000'),
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.withinTolerance).toBe(true);
    expect(scaledToDecimalString(result.reconciledOpeningUnitsScaled!, 3)).toBe('0.000');
  });

  it('a switch-out/switch-in pair nets to zero unit impact on the OVERALL portfolio when reconciled per scheme independently (each leg reconciles on its own side)', () => {
    const outLeg = reconcilePosition({
      openingUnitsScaled: u('100.000'),
      transactions: [{ canonicalType: 'switch_out', unitsScaled: u('40.000') }],
      statementClosingUnitsScaled: u('60.000'),
      historyCompleteness: 'complete_from_known_opening_balance',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    const inLeg = reconcilePosition({
      openingUnitsScaled: u('0.000'),
      transactions: [{ canonicalType: 'switch_in', unitsScaled: u('55.000') }],
      statementClosingUnitsScaled: u('55.000'),
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outLeg.withinTolerance).toBe(true);
    expect(inLeg.withinTolerance).toBe(true);
  });
});

describe('determineHistoryCompleteness (spec section 46)', () => {
  it('returns complete_from_inception only when the statement explicitly covers from inception', () => {
    expect(determineHistoryCompleteness({ hasExplicitOpeningBalanceTransaction: false, hasAnyTransactionHistory: true, hasClosingHoldingSnapshot: true, statementCoversFromInception: true })).toBe(
      'complete_from_inception'
    );
  });
  it('returns complete_from_known_opening_balance when an explicit opening balance anchors the history', () => {
    expect(
      determineHistoryCompleteness({ hasExplicitOpeningBalanceTransaction: true, hasAnyTransactionHistory: true, hasClosingHoldingSnapshot: true, statementCoversFromInception: false })
    ).toBe('complete_from_known_opening_balance');
  });
  it('returns partial_history when transactions exist but no opening balance is known', () => {
    expect(determineHistoryCompleteness({ hasExplicitOpeningBalanceTransaction: false, hasAnyTransactionHistory: true, hasClosingHoldingSnapshot: true, statementCoversFromInception: false })).toBe(
      'partial_history'
    );
  });
  it('returns holdings_only when there is a closing snapshot but zero transaction history at all', () => {
    expect(
      determineHistoryCompleteness({ hasExplicitOpeningBalanceTransaction: false, hasAnyTransactionHistory: false, hasClosingHoldingSnapshot: true, statementCoversFromInception: false })
    ).toBe('holdings_only');
  });
  it('never returns complete_from_inception merely because a value happens to be present', () => {
    const result = determineHistoryCompleteness({ hasExplicitOpeningBalanceTransaction: false, hasAnyTransactionHistory: true, hasClosingHoldingSnapshot: true, statementCoversFromInception: false });
    expect(result).not.toBe('complete_from_inception');
  });
});
