/**
 * FDH-6 — centralised thresholds (gap G4) pin every value to the exact
 * number the pre-refactor R8 modules used (spec section 84's "pure
 * refactor, no behaviour change" claim, made testable), and rule-conflict
 * detection (gap G3, spec section 57). Pure functions, no database.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_CONFIDENCE_SCORE,
  RECURRING_FREQUENCY_BUCKETS,
  RECURRING_THRESHOLDS,
  REFUND_THRESHOLDS,
  TRANSFER_THRESHOLDS,
} from '@/lib/financial-data-hub/classification/thresholds';
import { classifyTransaction } from '@/lib/financial-data-hub/classification/economicTypeEngine';
import { matchInternalTransfers, type TransferCandidateTxn } from '@/lib/financial-data-hub/classification/transferMatching';
import { matchRefundsToOriginals, type RefundCandidateTxn } from '@/lib/financial-data-hub/classification/refundReversalMatching';
import { detectRecurringSeries, type RecurringCandidateTxn } from '@/lib/financial-data-hub/classification/recurringDetection';
import type { ClassifiableTransaction, ClassificationReferenceData } from '@/lib/financial-data-hub/classification/types';
import type { FdhClassificationRule, FdhUserClassificationRule } from '@/lib/financial-data-hub/domain/types';

describe('FDH-6 thresholds.ts — pinned to R8\'s original pre-refactor values (spec section 84)', () => {
  it('transfer thresholds', () => {
    expect(TRANSFER_THRESHOLDS.DATE_WINDOW_DAYS).toBe(3);
    expect(TRANSFER_THRESHOLDS.HIGH_CONFIDENCE_DAY_THRESHOLD).toBe(1);
    expect(TRANSFER_THRESHOLDS.CONFIDENCE_SCORE).toEqual({ HIGH: 1, MEDIUM: 0.6 });
    expect(TRANSFER_THRESHOLDS.OPEN_CANDIDATE_CONFIDENCE).toBe(0.3);
  });

  it('refund thresholds', () => {
    expect(REFUND_THRESHOLDS.LOOKBACK_DAYS).toBe(90);
    expect(REFUND_THRESHOLDS.HIGH_CONFIDENCE_DAY_THRESHOLD).toBe(7);
    expect(REFUND_THRESHOLDS.CONFIDENCE_SCORE).toEqual({ FULL_MATCH: 1, PARTIAL_OR_WIDER: 0.6 });
  });

  it('recurring frequency buckets', () => {
    expect(RECURRING_FREQUENCY_BUCKETS).toEqual([
      { frequency: 'weekly', nominalDays: 7, toleranceDays: 2 },
      { frequency: 'fortnightly', nominalDays: 14, toleranceDays: 3 },
      { frequency: 'monthly', nominalDays: 30, toleranceDays: 5 },
      { frequency: 'quarterly', nominalDays: 91, toleranceDays: 10 },
      { frequency: 'annual', nominalDays: 365, toleranceDays: 15 },
    ]);
    expect(RECURRING_THRESHOLDS.MIN_OCCURRENCES_FOR_ESTABLISHED).toBe(3);
    expect(RECURRING_THRESHOLDS.TIGHT_AMOUNT_RATIO).toBe(0.01);
    expect(RECURRING_THRESHOLDS.TIGHT_AMOUNT_FLOOR).toBe(0.01);
    expect(RECURRING_THRESHOLDS.PAUSED_AFTER_CYCLE_MULTIPLE).toBe(1.5);
  });

  it('classification confidence score buckets', () => {
    expect(CLASSIFICATION_CONFIDENCE_SCORE).toEqual({ HIGH: 1, MEDIUM: 0.6, LOW: 0.3, UNRESOLVED: 0 });
  });
});

describe('FDH-6 thresholds.ts — engines still produce IDENTICAL results after the refactor (negative-control proof)', () => {
  it('transferMatching still pairs a same-day opposite-direction match as HIGH and rejects a >3-day gap', () => {
    const base: TransferCandidateTxn = {
      id: 'a', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 500,
      currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'TRANSFER', sourceReference: null,
    };
    const near: TransferCandidateTxn = { ...base, id: 'b', financialAccountId: 'acc-b', creditDebit: 'credit', transactionDate: '2026-03-01' };
    const far: TransferCandidateTxn = { ...base, id: 'c', financialAccountId: 'acc-c', creditDebit: 'credit', transactionDate: '2026-03-10' };

    const paired = matchInternalTransfers([base, near], new Map());
    expect(paired).toHaveLength(1);
    expect(paired[0].confidenceState).toBe('HIGH');

    const unpaired = matchInternalTransfers([base, far], new Map());
    expect(unpaired).toHaveLength(0); // still rejected beyond the 3-day window
  });

  it('refundReversalMatching still requires the original within 90 days and grades <=7 days as full-confidence', () => {
    const refund: RefundCandidateTxn = {
      id: 'r1', financialAccountId: 'acc-1', transactionDate: '2026-03-10', amountOriginal: 100,
      currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true,
    };
    const originalClose: RefundCandidateTxn = {
      id: 'o1', financialAccountId: 'acc-1', transactionDate: '2026-03-05', amountOriginal: 100,
      currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false,
    };
    const links = matchRefundsToOriginals([refund, originalClose]);
    expect(links).toHaveLength(1);
    expect(links[0].confidence).toBe(1); // <=7 days, full match

    const tooOld: RefundCandidateTxn = { ...originalClose, id: 'o2', transactionDate: '2025-11-01' }; // > 90 days back
    const noLink = matchRefundsToOriginals([refund, tooOld]);
    expect(noLink).toHaveLength(0);
  });

  it('recurringDetection still requires 3+ occurrences for an established (non-insufficient-history) series', () => {
    const mk = (date: string): RecurringCandidateTxn => ({
      id: date, transactionDate: date, amountOriginal: 15, currencyOriginal: 'AUD', creditDebit: 'debit',
      merchantId: 'netflix', descriptionClean: 'NETFLIX', financialAccountId: 'acc-1',
    });
    const twoOnly = detectRecurringSeries([mk('2026-01-01'), mk('2026-02-01')]);
    expect(twoOnly[0].insufficientHistory).toBe(true);

    const three = detectRecurringSeries([mk('2026-01-01'), mk('2026-02-01'), mk('2026-03-01')]);
    expect(three[0].insufficientHistory).toBe(false);
  });
});

// --- Rule-conflict detection (gap G3, spec section 57) ----------------------

function txn(overrides: Partial<ClassifiableTransaction> = {}): ClassifiableTransaction {
  return {
    id: 't1', financial_account_id: 'acc-1', transaction_date: '2026-03-01',
    description_clean: 'ACME PTY LTD PAYMENT', merchant_raw: null, amount_original: 50,
    currency_original: 'AUD', credit_debit: 'debit', transaction_type_hint: 'unknown',
    user_override: false, ...overrides,
  };
}

function emptyRef(overrides: Partial<ClassificationReferenceData> = {}): ClassificationReferenceData {
  return { categories: [], subcategories: [], merchants: [], merchantAliases: [], globalRules: [], userRules: [], ...overrides };
}

function userRule(overrides: Partial<FdhUserClassificationRule> = {}): FdhUserClassificationRule {
  return {
    id: 'u1', user_id: 'user-1', household_id: null, rule_type: 'description_contains',
    match_definition: { match_kind: 'description_contains', needle_normalised: 'ACME' },
    action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' },
    priority: 100, active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function globalRule(overrides: Partial<FdhClassificationRule> = {}): FdhClassificationRule {
  return {
    id: 'g1', rule_key: 'test_rule', rule_type: 'narrative_pattern', country_applicability: ['AU', 'IN'],
    match_definition: { match_kind: 'narrative_pattern', required_terms_normalised: ['ACME'] },
    action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' },
    priority: 200, status: 'approved', active: true, version: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...overrides,
  } as FdhClassificationRule;
}

describe('FDH-6 economicTypeEngine — rule-conflict detection (spec section 57)', () => {
  it('two user rules at the SAME priority with DIFFERENT outcomes -> RULE_CONFLICT, never an arbitrary pick', () => {
    const a = userRule({ id: 'u-a', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } });
    const b = userRule({ id: 'u-b', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' } });
    const result = classifyTransaction(txn(), null, emptyRef({ userRules: [a, b] }));
    expect(result.economicTransactionType).toBe('unknown');
    expect(result.source.kind).toBe('rule_conflict');
    expect(result.source.conflictingRuleIds).toEqual(expect.arrayContaining(['u-a', 'u-b']));
    expect(result.classificationMethod).toBe('unclassified');
    expect(result.confidence).toBe('UNRESOLVED');
  });

  it('two user rules at the SAME priority with the IDENTICAL outcome are redundant, not a conflict — no arbitrary pick needed', () => {
    const a = userRule({ id: 'u-a', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense', category_id: 'cat-1' } });
    const b = userRule({ id: 'u-b', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense', category_id: 'cat-1' } });
    const result = classifyTransaction(txn(), null, emptyRef({ userRules: [a, b] }));
    expect(result.economicTransactionType).toBe('expense');
    expect(result.source.kind).toBe('user_rule');
  });

  it('DIFFERENT priorities never conflict — the higher-precedence (lower-number) rule simply wins, exactly as before', () => {
    const higher = userRule({ id: 'u-higher', priority: 50, action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' } });
    const lower = userRule({ id: 'u-lower', priority: 200, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } });
    const result = classifyTransaction(txn(), null, emptyRef({ userRules: [higher, lower] }));
    expect(result.economicTransactionType).toBe('transfer');
    expect(result.source.kind).toBe('user_rule');
    expect(result.source.ruleId).toBe('u-higher');
  });

  it('a user-tier conflict short-circuits EVEN when a lower-precedence merchant/global match would otherwise resolve cleanly (spec: highest-precedence signal wins the ambiguity, never silently bypassed)', () => {
    const a = userRule({ id: 'u-a', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } });
    const b = userRule({ id: 'u-b', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' } });
    const result = classifyTransaction(
      txn(),
      null,
      emptyRef({ userRules: [a, b], globalRules: [globalRule()] }),
    );
    expect(result.source.kind).toBe('rule_conflict');
  });

  it('two GLOBAL rules at the same priority with different outcomes -> RULE_CONFLICT when no higher tier resolves it', () => {
    const g1 = globalRule({ id: 'g-a', priority: 200, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } });
    const g2 = globalRule({ id: 'g-b', priority: 200, action_definition: { action_kind: 'classify', economic_transaction_type: 'fee' } });
    const result = classifyTransaction(txn(), null, emptyRef({ globalRules: [g1, g2] }));
    expect(result.source.kind).toBe('rule_conflict');
    expect(result.source.conflictingRuleIds).toEqual(expect.arrayContaining(['g-a', 'g-b']));
  });

  it('a GLOBAL-tier conflict is moot when a HIGHER tier (user rule) already resolved the transaction', () => {
    const winningUserRule = userRule({ id: 'u-win', priority: 50, action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' } });
    const g1 = globalRule({ id: 'g-a', priority: 200, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } });
    const g2 = globalRule({ id: 'g-b', priority: 200, action_definition: { action_kind: 'classify', economic_transaction_type: 'fee' } });
    const result = classifyTransaction(txn(), null, emptyRef({ userRules: [winningUserRule], globalRules: [g1, g2] }));
    expect(result.economicTransactionType).toBe('transfer');
    expect(result.source.kind).toBe('user_rule');
  });

  it('NEGATIVE CONTROL — reverting to "take the first match after sort" (the pre-fix behaviour) would silently and non-deterministically pick a winner; this test fails if pickTopTierOrConflict is ever removed', () => {
    // Two conflicting user rules in one array order...
    const order1 = [
      userRule({ id: 'u-a', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } }),
      userRule({ id: 'u-b', priority: 100, action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' } }),
    ];
    // ...and the reverse order. Both MUST produce the same RULE_CONFLICT
    // outcome — proving the result does not depend on array order (the
    // exact defect this gap closure fixes).
    const order2 = [...order1].reverse();
    const r1 = classifyTransaction(txn(), null, emptyRef({ userRules: order1 }));
    const r2 = classifyTransaction(txn(), null, emptyRef({ userRules: order2 }));
    expect(r1.source.kind).toBe('rule_conflict');
    expect(r2.source.kind).toBe('rule_conflict');
    expect(r1.economicTransactionType).toBe(r2.economicTransactionType);
  });
});
