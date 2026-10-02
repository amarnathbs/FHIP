import { describe, it, expect } from 'vitest';
import { evaluateDerivedZeroUnitClosure, type DerivedZeroUnitClosureInput } from '@/lib/services/investment-intelligence/reconciliation';
import { parseExactDecimal } from '@/lib/services/investment-intelligence/decimal';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';

// Document2 final non-benchmark closure #6 (2026-09-30) — the fully-redeemed
// / zero-unit position defect. This is the PURE decision function
// (documentProcessing.ts's `ensureDerivedZeroUnitClosingSnapshot` is the thin
// DB-I/O wrapper around it) — see reconciliation.ts's own header for the
// full root-cause narrative. Covers the mission's own negative-control list
// (section 7, A-I) at the level this pure function can prove; the DB-facing
// parts (idempotent upsert, publish-once) are covered by the existing
// investmentPublicationService/portfolio-truth test suites, unchanged by
// this fix.

function units(v: string): bigint {
  const p = parseExactDecimal(v);
  if (!p.ok) throw new Error(`bad test fixture: ${v}`);
  return p.scaled;
}

function txn(canonicalType: DerivedZeroUnitClosureInput['transactionsSinceBaseline'][number]['canonicalType'], unitsScaled: bigint | null) {
  return { canonicalType, unitsScaled };
}

describe('evaluateDerivedZeroUnitClosure (Document2 #6 — fully-redeemed/zero-unit position fix)', () => {
  it('A. genuine full redemption (buy 100, redeem 100) from a zero baseline (no existing snapshot) — certifiable, closed, zero', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: false,
      existingSnapshotUnitsScaled: null,
      transactionsSinceBaseline: [txn('purchase', units('100')), txn('redemption', units('100'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('fully_redeemed');
    if (outcome.kind === 'fully_redeemed') {
      expect(outcome.finalUnitsScaled).toBe(units('0'));
      expect(outcome.asOfTransactionIndex).toBe(1); // the LAST transaction — as-of date is the redemption's date
    }
  });

  it('A2. genuine full redemption from an existing non-zero baseline snapshot (100 units) — certifiable, closed, zero', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [txn('redemption', units('100'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('fully_redeemed');
    if (outcome.kind === 'fully_redeemed') expect(outcome.finalUnitsScaled).toBe(units('0'));
  });

  it('B. erroneous negative units (over-redemption) — NOT certifiable as fully redeemed; a real reconciliation error, left untouched', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [txn('redemption', units('150'))], // redeeming more than held
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('not_fully_redeemed');
    if (outcome.kind === 'not_fully_redeemed') expect(outcome.finalUnitsScaled).toBe(units('-50'));
  });

  it('C. apparent zero due to rounding only — within the canonical unit tolerance counts as fully redeemed', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100.00005'), // a hair above zero after redemption, inside the 0.0001 tolerance
      transactionsSinceBaseline: [txn('redemption', units('100'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('fully_redeemed');
  });

  it('C2. a residual just OUTSIDE tolerance is NOT treated as fully redeemed', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100.01'),
      transactionsSinceBaseline: [txn('redemption', units('100'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('not_fully_redeemed');
  });

  it('D. partial redemption — remaining units retained, NOT treated as fully redeemed', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [txn('redemption', units('40'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('not_fully_redeemed');
    if (outcome.kind === 'not_fully_redeemed') expect(outcome.finalUnitsScaled).toBe(units('60'));
  });

  it('E. fully redeemed then repurchased later in the SAME window — nets to the repurchase, never collapsed to zero', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [txn('redemption', units('100')), txn('purchase', units('50'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('not_fully_redeemed');
    if (outcome.kind === 'not_fully_redeemed') expect(outcome.finalUnitsScaled).toBe(units('50'));
  });

  it('E2. fully redeemed, repurchased, THEN fully redeemed again — correctly zero, as-of the true last transaction', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [txn('redemption', units('100')), txn('purchase', units('50')), txn('redemption', units('50'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('fully_redeemed');
    if (outcome.kind === 'fully_redeemed') expect(outcome.asOfTransactionIndex).toBe(2);
  });

  it('F. fully redeemed with no current NAV needed — units=0 implies value=0 regardless of NAV availability (this function never even looks at NAV)', () => {
    // The absence of a `nav`/`price` field anywhere in DerivedZeroUnitClosureInput
    // IS the proof: this function can reach 'fully_redeemed' purely from the
    // unit ledger, with no NAV lookup of any kind.
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: false,
      existingSnapshotUnitsScaled: null,
      transactionsSinceBaseline: [txn('purchase', units('10')), txn('redemption', units('10'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('fully_redeemed');
  });

  it('no existing snapshot AND the stream opens with an outflow — insufficient history, never assumed complete', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: false,
      existingSnapshotUnitsScaled: null,
      transactionsSinceBaseline: [txn('redemption', units('100'))], // opens with an outflow -- missing earlier history
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('insufficient_history');
  });

  it('no transactions since baseline — no new activity, leaves existing state untouched', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('no_new_activity');
  });

  it('existing snapshot units cannot be parsed — malformed, never guessed at', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: null,
      transactionsSinceBaseline: [txn('redemption', units('10'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('malformed_existing_units');
  });

  it('H. repeated evaluation of the identical fully-redeemed stream is idempotent — same outcome every time', () => {
    const input: DerivedZeroUnitClosureInput = {
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [txn('redemption', units('100'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    };
    const first = evaluateDerivedZeroUnitClosure(input);
    const second = evaluateDerivedZeroUnitClosure(input);
    expect(first).toEqual(second);
    expect(first.kind).toBe('fully_redeemed');
  });

  it('a switch_out that fully exits a position is treated the same as a redemption', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('75'),
      transactionsSinceBaseline: [txn('switch_out', units('75'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('fully_redeemed');
  });

  it('a bonus-unit inflow after redemption prevents a false zero (bonus is an inflow, not cash-only)', () => {
    const outcome = evaluateDerivedZeroUnitClosure({
      hasExistingSnapshot: true,
      existingSnapshotUnitsScaled: units('100'),
      transactionsSinceBaseline: [txn('redemption', units('100')), txn('bonus', units('5'))],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(outcome.kind).toBe('not_fully_redeemed');
    if (outcome.kind === 'not_fully_redeemed') expect(outcome.finalUnitsScaled).toBe(units('5'));
  });
});
