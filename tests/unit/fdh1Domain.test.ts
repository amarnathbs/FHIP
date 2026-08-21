/**
 * FDH-1 — domain contract, validation, state machine, allocation and
 * financial-precision tests.
 *
 * These are pure: no database, no network, in keeping with the existing
 * `tests/unit/**` suite, which runs 124 tests in under seven seconds without
 * any infrastructure.
 */

import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_STATUS_TRANSITIONS,
  FdhInvalidTransitionError,
  PURGE_STATUS_TRANSITIONS,
  assertDocumentTransition,
  assertPurgeTransition,
  isAllowedDocumentTransition,
  isPurgeEligible,
} from '@/lib/financial-data-hub/domain/documentLifecycle';
import {
  FDH_MAX_MONEY,
  fitsMoneyColumn,
  fromMinorUnits,
  moneyEquals,
  smallestUnit,
  sumMoney,
  toMinorUnits,
  toSignedAmount,
} from '@/lib/financial-data-hub/domain/money';
import {
  assertAllocationsReconcile,
  checkAllocationsReconcile,
  isValidAllocationDraft,
} from '@/lib/financial-data-hub/domain/allocations';
import {
  buildStatementUploadPurgePatch,
  buildTransactionPurgePatch,
  isTransactionSafeToPurgeRaw,
} from '@/lib/financial-data-hub/domain/privacy';
import { fdhFinancialAccountSchema } from '@/lib/financial-data-hub/validation/accounts';
import {
  fdhDocumentTransitionSchema,
  fdhPurgeTransitionSchema,
  fdhSanitisedFilename,
  fdhStatementUploadCreateSchema,
} from '@/lib/financial-data-hub/validation/documents';
import {
  fdhTransactionAllocationSchema,
  fdhTransactionLinkSchema,
  fdhTransactionSchema,
} from '@/lib/financial-data-hub/validation/transactions';
import {
  fdhDataProvenanceSchema,
  fdhReconciliationResultSchema,
  fdhReviewItemSchema,
} from '@/lib/financial-data-hub/validation/review';
import {
  fdhClassificationHistorySchema,
  fdhUserClassificationRuleSchema,
} from '@/lib/financial-data-hub/validation/classification';
import { FDH_ECONOMIC_TRANSACTION_TYPES } from '@/lib/financial-data-hub/constants/enums';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const TXN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_TXN_ID = '44444444-4444-4444-8444-444444444444';
const RULE_ID = '55555555-5555-4555-8555-555555555555';

function validTransaction(overrides: Record<string, unknown> = {}) {
  return {
    financial_account_id: ACCOUNT_ID,
    transaction_date: '2026-03-14',
    amount_original: 180.5,
    currency_original: 'AUD',
    credit_debit: 'debit',
    economic_transaction_type: 'expense',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe('FDH-1 transaction validation', () => {
  it('accepts a well-formed transaction', () => {
    expect(fdhTransactionSchema.safeParse(validTransaction()).success).toBe(true);
  });

  it('rejects an unsupported currency', () => {
    const r = fdhTransactionSchema.safeParse(validTransaction({ currency_original: 'GBP' }));
    expect(r.success).toBe(false);
  });

  it('rejects a zero or negative amount — amount_original is a magnitude', () => {
    expect(fdhTransactionSchema.safeParse(validTransaction({ amount_original: 0 })).success)
      .toBe(false);
    expect(fdhTransactionSchema.safeParse(validTransaction({ amount_original: -12 })).success)
      .toBe(false);
  });

  it('rejects an amount with more precision than the column can hold', () => {
    expect(fdhTransactionSchema.safeParse(validTransaction({ amount_original: 1.23456 })).success)
      .toBe(false);
    expect(fdhTransactionSchema.safeParse(validTransaction({ amount_original: 1.2345 })).success)
      .toBe(true);
  });

  it('rejects a confidence outside [0,1]', () => {
    expect(
      fdhTransactionSchema.safeParse(validTransaction({ extraction_confidence: 1.01 })).success,
    ).toBe(false);
    expect(
      fdhTransactionSchema.safeParse(validTransaction({ classification_confidence: -0.01 })).success,
    ).toBe(false);
    expect(
      fdhTransactionSchema.safeParse(validTransaction({ classification_confidence: 0.9375 })).success,
    ).toBe(true);
  });

  it('rejects a reporting amount without its currency, and the reverse', () => {
    expect(
      fdhTransactionSchema.safeParse(validTransaction({ amount_reporting_currency: 100 })).success,
    ).toBe(false);
    expect(
      fdhTransactionSchema.safeParse(validTransaction({ reporting_currency: 'AUD' })).success,
    ).toBe(false);
    expect(
      fdhTransactionSchema.safeParse(
        validTransaction({ amount_reporting_currency: 100, reporting_currency: 'AUD' }),
      ).success,
    ).toBe(true);
  });

  it('rejects an FX rate with no date — a rate that cannot be reproduced is not evidence', () => {
    const withRate = validTransaction({
      amount_reporting_currency: 9800,
      reporting_currency: 'INR',
      fx_rate: 54.3,
    });
    expect(fdhTransactionSchema.safeParse(withRate).success).toBe(false);
    expect(
      fdhTransactionSchema.safeParse({ ...withRate, fx_rate_date: '2026-03-14' }).success,
    ).toBe(true);
  });

  it('rejects a posting date earlier than the transaction date', () => {
    expect(
      fdhTransactionSchema.safeParse(validTransaction({ posting_date: '2026-03-13' })).success,
    ).toBe(false);
  });

  it('never accepts a user_id from the caller', () => {
    const parsed = fdhTransactionSchema.parse(
      validTransaction({ user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    );
    expect('user_id' in parsed).toBe(false);
  });

  it('accepts a raw description of null — the purge lifecycle depends on it', () => {
    expect(
      fdhTransactionSchema.safeParse(
        validTransaction({ description_raw: null, merchant_raw: null, description_clean: 'Groceries' }),
      ).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 keeps direction and economic meaning independent', () => {
  it('accepts every economic type in both directions', () => {
    // The point of the test: nothing in the contract forbids a credit that is
    // an expense (a fee reversal recorded oddly by a bank) or a debit that is
    // income (a negative-income adjustment). Meaning is never inferred.
    for (const type of FDH_ECONOMIC_TRANSACTION_TYPES) {
      for (const direction of ['credit', 'debit'] as const) {
        const r = fdhTransactionSchema.safeParse(
          validTransaction({ credit_debit: direction, economic_transaction_type: type }),
        );
        expect(r.success, `${direction}/${type} was rejected`).toBe(true);
      }
    }
  });

  it('derives the signed amount from direction only, in one place', () => {
    expect(toSignedAmount(180.5, 'debit')).toBe(-180.5);
    expect(toSignedAmount(180.5, 'credit')).toBe(180.5);
  });

  it('refuses to sign a non-positive magnitude', () => {
    expect(() => toSignedAmount(0, 'credit')).toThrow(RangeError);
    expect(() => toSignedAmount(-5, 'debit')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 financial precision', () => {
  it('round-trips AUD cents exactly', () => {
    for (const amount of [0.01, 0.1, 1.05, 19.99, 1234.56, 999999.99]) {
      expect(fromMinorUnits(toMinorUnits(amount, 'AUD'), 'AUD')).toBe(amount);
    }
  });

  it('round-trips INR paise exactly, including crore-scale amounts', () => {
    for (const amount of [0.01, 12345.67, 10000000, 12345678.9, 999999999.99]) {
      expect(fromMinorUnits(toMinorUnits(amount, 'INR'), 'INR')).toBe(amount);
    }
  });

  it('sums exactly where naive float addition does not', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMoney([0.1, 0.2], 'AUD')).toBe(0.3);
    // A hundred 0.01 values.
    expect(sumMoney(Array(100).fill(0.01), 'AUD')).toBe(1);
  });

  it('compares money with an explicit minor-unit tolerance', () => {
    expect(moneyEquals(10.0, 10.01, 'AUD')).toBe(false);
    expect(moneyEquals(10.0, 10.01, 'AUD', 1)).toBe(true);
    expect(smallestUnit('AUD')).toBe(0.01);
    expect(smallestUnit('INR')).toBe(0.01);
  });

  it('knows what numeric(20,4) can and cannot hold', () => {
    expect(fitsMoneyColumn(FDH_MAX_MONEY)).toBe(true);
    expect(fitsMoneyColumn(1e17)).toBe(false);
    expect(fitsMoneyColumn(Number.POSITIVE_INFINITY)).toBe(false);
    expect(fitsMoneyColumn(Number.NaN)).toBe(false);
  });

  it('represents both directions of a large amount without loss', () => {
    const large = 98765432109.87;
    expect(toSignedAmount(large, 'credit')).toBe(large);
    expect(toSignedAmount(large, 'debit')).toBe(-large);
    expect(fromMinorUnits(toMinorUnits(large, 'INR'), 'INR')).toBe(large);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 transaction allocations', () => {
  const parent = { amount_original: 180.5, currency_original: 'AUD' };

  it('accepts allocations that reconcile exactly', () => {
    const result = checkAllocationsReconcile(parent, [
      { allocation_sequence: 1, amount: 120.25, currency_code: 'AUD' },
      { allocation_sequence: 2, amount: 60.25, currency_code: 'AUD' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.allocatedTotal).toBe(180.5);
    expect(result.difference).toBe(0);
  });

  it('accepts many allocations that reconcile', () => {
    const allocations = Array.from({ length: 10 }, (_, i) => ({
      allocation_sequence: i + 1,
      amount: 18.05,
      currency_code: 'AUD',
    }));
    expect(checkAllocationsReconcile(parent, allocations).ok).toBe(true);
  });

  it('rejects an under-allocation at finalisation', () => {
    const result = checkAllocationsReconcile(parent, [
      { allocation_sequence: 1, amount: 100, currency_code: 'AUD' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('under_allocated');
    expect(result.difference).toBe(80.5);
  });

  it('rejects an over-allocation at finalisation', () => {
    const result = checkAllocationsReconcile(parent, [
      { allocation_sequence: 1, amount: 200, currency_code: 'AUD' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('over_allocated');
  });

  it('absorbs exactly one minor unit of percentage-split rounding, and no more', () => {
    // Three-way split of 100.00 -> 33.33 + 33.33 + 33.34 is exact; the
    // tolerance covers the case where a UI rounds to 33.33 three times.
    const hundred = { amount_original: 100, currency_original: 'AUD' };
    const rounded = [1, 2, 3].map((n) => ({
      allocation_sequence: n,
      amount: 33.33,
      currency_code: 'AUD',
    }));
    expect(checkAllocationsReconcile(hundred, rounded).ok).toBe(true);
    const tooFar = [
      { allocation_sequence: 1, amount: 33.33, currency_code: 'AUD' },
      { allocation_sequence: 2, amount: 33.33, currency_code: 'AUD' },
      { allocation_sequence: 3, amount: 33.32, currency_code: 'AUD' },
    ];
    expect(checkAllocationsReconcile(hundred, tooFar).ok).toBe(false);
  });

  it('rejects an allocation in a different currency', () => {
    const result = checkAllocationsReconcile(parent, [
      { allocation_sequence: 1, amount: 180.5, currency_code: 'INR' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('currency_mismatch');
  });

  it('rejects a duplicate allocation sequence', () => {
    const result = checkAllocationsReconcile(parent, [
      { allocation_sequence: 1, amount: 90.25, currency_code: 'AUD' },
      { allocation_sequence: 1, amount: 90.25, currency_code: 'AUD' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain('duplicate_sequence');
  });

  it('treats an empty set as unreconciled at finalisation', () => {
    expect(checkAllocationsReconcile(parent, []).ok).toBe(false);
    expect(() => assertAllocationsReconcile(parent, [])).toThrow(/allocation integrity/);
  });

  it('allows an incomplete DRAFT but never an invalid one', () => {
    // The reason completeness is not a database constraint: a half-entered
    // split must still be saveable.
    expect(isValidAllocationDraft(parent, [])).toBe(true);
    expect(
      isValidAllocationDraft(parent, [{ allocation_sequence: 1, amount: 50, currency_code: 'AUD' }]),
    ).toBe(true);
    expect(
      isValidAllocationDraft(parent, [{ allocation_sequence: 1, amount: 500, currency_code: 'AUD' }]),
    ).toBe(false);
    expect(
      isValidAllocationDraft(parent, [{ allocation_sequence: 1, amount: 50, currency_code: 'INR' }]),
    ).toBe(false);
  });

  it('validates one allocation row on its own', () => {
    expect(
      fdhTransactionAllocationSchema.safeParse({
        transaction_id: TXN_ID,
        allocation_sequence: 1,
        economic_transaction_type: 'expense',
        amount: 10,
        currency_code: 'AUD',
      }).success,
    ).toBe(true);
    expect(
      fdhTransactionAllocationSchema.safeParse({
        transaction_id: TXN_ID,
        allocation_sequence: 0,
        economic_transaction_type: 'expense',
        amount: 10,
        currency_code: 'AUD',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 document lifecycle state machine', () => {
  it('walks the full happy path', () => {
    const path = [
      'created', 'uploaded', 'validating', 'queued', 'processing', 'extracted',
      'review_required', 'ready_for_approval', 'approved', 'purge_pending', 'purged',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(isAllowedDocumentTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`)
        .toBe(true);
    }
  });

  it('refuses arbitrary status changes', () => {
    expect(isAllowedDocumentTransition('created', 'approved')).toBe(false);
    expect(isAllowedDocumentTransition('approved', 'processing')).toBe(false);
    expect(isAllowedDocumentTransition('purged', 'processing')).toBe(false);
    expect(isAllowedDocumentTransition('rejected', 'approved')).toBe(false);
    expect(() => assertDocumentTransition('created', 'purged')).toThrow(FdhInvalidTransitionError);
  });

  it('lets a failure be retried but never silently approved', () => {
    expect(isAllowedDocumentTransition('failed', 'queued')).toBe(true);
    expect(isAllowedDocumentTransition('failed', 'approved')).toBe(false);
  });

  it('has terminal states with no outgoing edge', () => {
    expect(DOCUMENT_STATUS_TRANSITIONS.rejected).toHaveLength(0);
    expect(DOCUMENT_STATUS_TRANSITIONS.purged).toHaveLength(0);
  });

  it('declares an edge list for every declared status and no other', () => {
    for (const [from, targets] of Object.entries(DOCUMENT_STATUS_TRANSITIONS)) {
      for (const to of targets) {
        expect(Object.keys(DOCUMENT_STATUS_TRANSITIONS), `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it('validates a transition through the schema, requiring an error code on failure', () => {
    expect(
      fdhDocumentTransitionSchema.safeParse({ from: 'queued', to: 'processing' }).success,
    ).toBe(true);
    expect(
      fdhDocumentTransitionSchema.safeParse({ from: 'queued', to: 'approved' }).success,
    ).toBe(false);
    expect(
      fdhDocumentTransitionSchema.safeParse({ from: 'processing', to: 'failed' }).success,
    ).toBe(false);
    expect(
      fdhDocumentTransitionSchema.safeParse({
        from: 'processing', to: 'failed', error_code: 'layout_unsupported',
      }).success,
    ).toBe(true);
  });

  it('only allows a raw-document purge after the user has approved', () => {
    expect(isPurgeEligible('approved')).toBe(true);
    for (const status of ['extracted', 'review_required', 'ready_for_approval', 'rejected'] as const) {
      expect(isPurgeEligible(status), status).toBe(false);
    }
  });

  it('runs the purge machine independently of the processing machine', () => {
    expect(PURGE_STATUS_TRANSITIONS.not_required).toContain('pending');
    expect(PURGE_STATUS_TRANSITIONS.in_progress).toContain('purged');
    expect(PURGE_STATUS_TRANSITIONS.failed).toContain('pending');
    expect(PURGE_STATUS_TRANSITIONS.purged).toHaveLength(0);
    expect(PURGE_STATUS_TRANSITIONS.legal_hold).toHaveLength(0);
    expect(() => assertPurgeTransition('purged', 'pending')).toThrow(FdhInvalidTransitionError);
    expect(fdhPurgeTransitionSchema.safeParse({ from: 'in_progress', to: 'purged' }).success)
      .toBe(false);
    expect(
      fdhPurgeTransitionSchema.safeParse({
        from: 'in_progress', to: 'purged', purged_at: '2026-08-21T00:00:00+00:00',
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 privacy lifecycle', () => {
  it('builds a purge patch that clears the storage reference', () => {
    const patch = buildStatementUploadPurgePatch('2026-08-21T00:00:00+00:00');
    expect(patch.raw_document_storage_reference).toBeNull();
    expect(patch.original_filename_sanitised).toBeNull();
    expect(patch.raw_document_purge_status).toBe('purged');
  });

  it('builds a transaction purge patch that clears only the raw strings', () => {
    const patch = buildTransactionPurgePatch();
    expect(patch).toEqual({ description_raw: null, merchant_raw: null });
    // The retained facts are untouched.
    expect('amount_original' in patch).toBe(false);
    expect('description_clean' in patch).toBe(false);
    expect('user_override' in patch).toBe(false);
  });

  it('refuses to purge a raw description before a clean one exists', () => {
    expect(
      isTransactionSafeToPurgeRaw({ description_clean: null, merchant_id: null, merchant_raw: null }),
    ).toBe(false);
    expect(
      isTransactionSafeToPurgeRaw({ description_clean: '   ', merchant_id: null, merchant_raw: null }),
    ).toBe(false);
    expect(
      isTransactionSafeToPurgeRaw({
        description_clean: 'Groceries', merchant_id: null, merchant_raw: 'SUPAMKT 1234',
      }),
    ).toBe(false);
    expect(
      isTransactionSafeToPurgeRaw({
        description_clean: 'Groceries', merchant_id: ACCOUNT_ID, merchant_raw: 'SUPAMKT 1234',
      }),
    ).toBe(true);
  });

  it('accepts a statement upload with a null storage reference', () => {
    expect(
      fdhStatementUploadCreateSchema.safeParse({
        source_type: 'pdf_native',
        original_filename_sanitised: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a filename carrying a path, a traversal or a control character', () => {
    expect(fdhSanitisedFilename.safeParse('statement-2026-03.pdf').success).toBe(true);
    expect(fdhSanitisedFilename.safeParse('../../etc/passwd').success).toBe(false);
    expect(fdhSanitisedFilename.safeParse('a/b.pdf').success).toBe(false);
    expect(fdhSanitisedFilename.safeParse('a\\b.pdf').success).toBe(false);
    expect(fdhSanitisedFilename.safeParse('a\u0000b.pdf').success).toBe(false);
    expect(fdhSanitisedFilename.safeParse('a\nb.pdf').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 account contract', () => {
  it('accepts a masked identifier but never a full account number', () => {
    const base = {
      account_type: 'transaction',
      country_code: 'AU',
      currency_code: 'AUD',
      display_name: 'Everyday',
    };
    expect(fdhFinancialAccountSchema.safeParse({ ...base, masked_identifier: '****1234' }).success)
      .toBe(true);
    expect(fdhFinancialAccountSchema.safeParse({ ...base, masked_identifier: 'XXXX-4321' }).success)
      .toBe(true);
    // An Indian account number.
    expect(
      fdhFinancialAccountSchema.safeParse({ ...base, masked_identifier: '50100123456789' }).success,
    ).toBe(false);
    // An AU BSB + account number.
    expect(
      fdhFinancialAccountSchema.safeParse({ ...base, masked_identifier: '062000123456789' }).success,
    ).toBe(false);
  });

  it('has no field for a full account identifier at all', () => {
    const parsed = fdhFinancialAccountSchema.parse({
      account_type: 'savings',
      country_code: 'IN',
      currency_code: 'INR',
      display_name: 'Savings',
      full_account_number: '50100123456789',
      ifsc: 'HDFC0001234',
    });
    expect('full_account_number' in parsed).toBe(false);
    expect('ifsc' in parsed).toBe(false);
    expect('account_fingerprint' in parsed).toBe(false);
  });

  it('supports both countries and both currencies from the foundation', () => {
    for (const [country, currency] of [['AU', 'AUD'], ['IN', 'INR']] as const) {
      expect(
        fdhFinancialAccountSchema.safeParse({
          account_type: 'transaction',
          country_code: country,
          currency_code: currency,
          display_name: 'Account',
        }).success,
      ).toBe(true);
    }
    expect(
      fdhFinancialAccountSchema.safeParse({
        account_type: 'transaction', country_code: 'US', currency_code: 'USD', display_name: 'x',
      }).success,
    ).toBe(false);
  });

  it('rejects a closed account with no closing date', () => {
    const base = {
      account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'x',
    };
    expect(fdhFinancialAccountSchema.safeParse({ ...base, status: 'closed' }).success).toBe(false);
    expect(
      fdhFinancialAccountSchema.safeParse({ ...base, status: 'closed', closed_at: '2026-01-01' })
        .success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 links, review, reconciliation and provenance contracts', () => {
  it('records a transfer whose counterpart has not been imported yet', () => {
    const r = fdhTransactionLinkSchema.safeParse({
      transaction_id_from: TXN_ID,
      link_type: 'internal_transfer',
      created_by_method: 'algorithm',
      confidence: 0.72,
    });
    expect(r.success).toBe(true);
    // ...but a CONFIRMED link must name both sides.
    expect(
      fdhTransactionLinkSchema.safeParse({
        transaction_id_from: TXN_ID,
        link_type: 'internal_transfer',
        created_by_method: 'user_manual',
        status: 'confirmed',
      }).success,
    ).toBe(false);
    expect(
      fdhTransactionLinkSchema.safeParse({
        transaction_id_from: TXN_ID,
        transaction_id_to: OTHER_TXN_ID,
        link_type: 'internal_transfer',
        created_by_method: 'user_manual',
        status: 'confirmed',
      }).success,
    ).toBe(true);
  });

  it('refuses a self-link', () => {
    expect(
      fdhTransactionLinkSchema.safeParse({
        transaction_id_from: TXN_ID,
        transaction_id_to: TXN_ID,
        link_type: 'duplicate',
        created_by_method: 'algorithm',
      }).success,
    ).toBe(false);
  });

  it('keeps raw document text out of a review item context', () => {
    expect(
      fdhReviewItemSchema.safeParse({
        statement_upload_id: UPLOAD_ID,
        review_type: 'missing_counterpart_account',
        title_code: 'missing_counterpart_account',
        context_json: { related_transaction_ids: [TXN_ID], confidence: 0.6 },
      }).success,
    ).toBe(true);
    // A free-text key is rejected outright by the strict shape.
    expect(
      fdhReviewItemSchema.safeParse({
        statement_upload_id: UPLOAD_ID,
        review_type: 'unknown_merchant',
        title_code: 'unknown_merchant',
        context_json: { raw_narrative: 'VISA DEBIT PURCHASE ACME PTY LTD 1234' },
      }).success,
    ).toBe(false);
  });

  it('requires a review item to be about something', () => {
    expect(
      fdhReviewItemSchema.safeParse({ review_type: 'other', title_code: 'other' }).success,
    ).toBe(false);
  });

  it('never lets a failed reconciliation be recorded as successful', () => {
    const base = { statement_upload_id: UPLOAD_ID, currency_code: 'AUD' };
    expect(
      fdhReconciliationResultSchema.safeParse({ ...base, status: 'reconciled', variance: 0 }).success,
    ).toBe(true);
    // A variance beyond the (default zero) tolerance cannot be 'reconciled'.
    expect(
      fdhReconciliationResultSchema.safeParse({ ...base, status: 'reconciled', variance: 12.5 })
        .success,
    ).toBe(false);
    // ...unless a tolerance was deliberately stated.
    expect(
      fdhReconciliationResultSchema.safeParse({
        ...base, status: 'reconciled', variance: 0.01, variance_tolerance: 0.01,
      }).success,
    ).toBe(true);
    // A reconciled result with no variance at all is meaningless.
    expect(
      fdhReconciliationResultSchema.safeParse({ ...base, status: 'reconciled' }).success,
    ).toBe(false);
    // Recording the same discrepancy honestly is always allowed.
    expect(
      fdhReconciliationResultSchema.safeParse({ ...base, status: 'failed', variance: 12.5 }).success,
    ).toBe(true);
    expect(
      fdhReconciliationResultSchema.safeParse({
        ...base, status: 'user_accepted_exception', variance: 12.5,
      }).success,
    ).toBe(true);
  });

  it('links a transaction to the document and parser version it came from', () => {
    const r = fdhDataProvenanceSchema.safeParse({
      entity_type: 'fdh_transaction',
      entity_id: TXN_ID,
      source_type: 'pdf_native',
      source_statement_id: UPLOAD_ID,
      source_transaction_id: TXN_ID,
      parser_id: RULE_ID,
      parser_version_id: ACCOUNT_ID,
      evidence_completeness: 0.5,
    });
    expect(r.success).toBe(true);
  });

  it('refuses a parser version with no parser — provenance must be attributable', () => {
    expect(
      fdhDataProvenanceSchema.safeParse({
        entity_type: 'fdh_transaction',
        entity_id: TXN_ID,
        source_type: 'csv',
        parser_version_id: ACCOUNT_ID,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 classification contracts', () => {
  it('accepts a structured user rule', () => {
    expect(
      fdhUserClassificationRuleSchema.safeParse({
        rule_type: 'merchant_exact',
        match_definition: { match_kind: 'merchant_exact', merchant_id: RULE_ID },
        action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' },
      }).success,
    ).toBe(true);
  });

  it('rejects a rule whose type and match do not agree', () => {
    expect(
      fdhUserClassificationRuleSchema.safeParse({
        rule_type: 'mcc',
        match_definition: { match_kind: 'merchant_exact', merchant_id: RULE_ID },
        action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' },
      }).success,
    ).toBe(false);
  });

  it('rejects an executable or regex rule definition outright', () => {
    for (const match of [
      { match_kind: 'regex', pattern: '.*' },
      { match_kind: 'expression', expression: 'amount > 100' },
      { match_kind: 'sql', sql: 'select 1' },
    ]) {
      expect(
        fdhUserClassificationRuleSchema.safeParse({
          rule_type: 'description_contains',
          match_definition: match,
          action_definition: { action_kind: 'classify', category_id: RULE_ID },
        }).success,
        JSON.stringify(match),
      ).toBe(false);
    }
  });

  it('rejects a classify action that changes nothing', () => {
    expect(
      fdhUserClassificationRuleSchema.safeParse({
        rule_type: 'merchant_exact',
        match_definition: { match_kind: 'merchant_exact', merchant_id: RULE_ID },
        action_definition: { action_kind: 'classify' },
      }).success,
    ).toBe(false);
  });

  it('keeps a user correction attributable and distinct from an automatic one', () => {
    expect(
      fdhClassificationHistorySchema.safeParse({
        transaction_id: TXN_ID,
        new_economic_transaction_type: 'expense',
        classification_method: 'user_manual',
        changed_by_type: 'user',
        changed_by_user: RULE_ID,
      }).success,
    ).toBe(true);
    // A user_manual change cannot be attributed to the system.
    expect(
      fdhClassificationHistorySchema.safeParse({
        transaction_id: TXN_ID,
        new_economic_transaction_type: 'expense',
        classification_method: 'user_manual',
        changed_by_type: 'system',
      }).success,
    ).toBe(false);
    // A rule-driven change must name the rule.
    expect(
      fdhClassificationHistorySchema.safeParse({
        transaction_id: TXN_ID,
        new_economic_transaction_type: 'expense',
        classification_method: 'user_rule',
        changed_by_type: 'system',
      }).success,
    ).toBe(false);
    // A change cannot come from a global rule and a user rule at once.
    expect(
      fdhClassificationHistorySchema.safeParse({
        transaction_id: TXN_ID,
        new_economic_transaction_type: 'expense',
        classification_method: 'global_rule',
        changed_by_type: 'system',
        global_rule_id: RULE_ID,
        user_rule_id: ACCOUNT_ID,
      }).success,
    ).toBe(false);
  });
});
