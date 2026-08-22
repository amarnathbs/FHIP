/**
 * Financial Data Hub — validation for transactions, allocations, links,
 * duplicates and recurring patterns.
 */

import { z } from 'zod';
import {
  FDH_CLASSIFICATION_METHODS,
  FDH_CREDIT_DEBIT,
  FDH_DUPLICATE_MATCH_METHODS,
  FDH_DUPLICATE_RESOLUTIONS,
  FDH_DUPLICATE_STATUSES,
  FDH_ECONOMIC_TRANSACTION_TYPES,
  FDH_FX_RATE_SOURCES,
  FDH_LINK_CREATION_METHODS,
  FDH_LINK_STATUSES,
  FDH_RECURRING_FREQUENCIES,
  FDH_RECURRING_STATUSES,
  FDH_REVIEW_STATUSES,
  FDH_TRANSACTION_LINK_TYPES,
} from '../constants/enums';
import {
  fdhCurrencyCode,
  fdhDate,
  fdhFxRate,
  fdhMoneyMagnitude,
  fdhOwnershipInput,
  fdhUnitInterval,
  fdhUuid,
} from './primitives';

/**
 * A canonical FDH transaction.
 *
 * DIRECTION AND MEANING ARE INDEPENDENT. `credit_debit` and
 * `economic_transaction_type` are two separate required inputs and this schema
 * derives NEITHER from the other. There is deliberately no refinement here
 * saying "a credit must be income" or "a debit must be an expense", because
 * both statements are false: a credit may be a refund, a transfer in, a loan
 * drawdown or a reversal, and a debit may be a transfer out, an investment
 * purchase or a debt principal repayment.
 *
 * `amount_original` is a positive MAGNITUDE. The signed value is derived by
 * `toSignedAmount()` in `domain/money.ts`.
 *
 * RAW STRINGS ARE OPTIONAL. `description_raw` and `merchant_raw` are nullish
 * because the retention lifecycle nulls them after approval. A schema that
 * required them would make the approved privacy model impossible.
 */
export const fdhTransactionSchema = fdhOwnershipInput
  .extend({
    financial_account_id: fdhUuid,
    statement_upload_id: fdhUuid.nullish(),

    transaction_date: fdhDate,
    posting_date: fdhDate.nullish(),
    value_date: fdhDate.nullish(),

    description_raw: z.string().max(2000).nullish(),
    description_clean: z.string().max(500).nullish(),
    merchant_raw: z.string().max(500).nullish(),
    merchant_id: fdhUuid.nullish(),

    amount_original: fdhMoneyMagnitude,
    currency_original: fdhCurrencyCode,
    amount_reporting_currency: fdhMoneyMagnitude.nullish(),
    reporting_currency: fdhCurrencyCode.nullish(),
    fx_rate: fdhFxRate.nullish(),
    fx_rate_date: fdhDate.nullish(),
    fx_rate_source: z.enum(FDH_FX_RATE_SOURCES).nullish(),

    credit_debit: z.enum(FDH_CREDIT_DEBIT),
    economic_transaction_type: z.enum(FDH_ECONOMIC_TRANSACTION_TYPES).default('unknown'),
    category_id: fdhUuid.nullish(),
    subcategory_id: fdhUuid.nullish(),

    recurring_flag: z.boolean().default(false),
    subscription_flag: z.boolean().default(false),
    transfer_flag: z.boolean().default(false),

    classification_confidence: fdhUnitInterval.nullish(),
    extraction_confidence: fdhUnitInterval.nullish(),
    classification_method: z.enum(FDH_CLASSIFICATION_METHODS).nullish(),

    source_reference: z.string().max(200).nullish(),
    source_page: z.number().int().min(1).nullish(),
    source_row: z.number().int().min(1).nullish(),

    review_status: z.enum(FDH_REVIEW_STATUSES).default('not_required'),
    user_override: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    // A reporting amount without its currency (or the reverse) is meaningless.
    const hasReportingAmount = v.amount_reporting_currency !== null
      && v.amount_reporting_currency !== undefined;
    const hasReportingCurrency = v.reporting_currency !== null
      && v.reporting_currency !== undefined;
    if (hasReportingAmount !== hasReportingCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reporting_currency'],
        message: 'amount_reporting_currency and reporting_currency must be supplied together',
      });
    }
    if ((v.fx_rate ?? null) !== null && !hasReportingCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fx_rate'],
        message: 'an fx_rate is only meaningful alongside a reporting currency',
      });
    }
    // An FX rate without a date cannot be audited or reproduced later. This is
    // the specific gap FDH-0 recorded in the existing platform (one global rate
    // with no date); FDH does not repeat it.
    if ((v.fx_rate ?? null) !== null && !v.fx_rate_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fx_rate_date'],
        message: 'an fx_rate must record the date it applied',
      });
    }
    if (v.posting_date && v.posting_date < v.transaction_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['posting_date'],
        message: 'posting_date must not be earlier than transaction_date',
      });
    }
  });

/** One line of a split transaction. */
export const fdhTransactionAllocationSchema = z.object({
  transaction_id: fdhUuid,
  allocation_sequence: z.number().int().min(1),
  economic_transaction_type: z.enum(FDH_ECONOMIC_TRANSACTION_TYPES),
  category_id: fdhUuid.nullish(),
  subcategory_id: fdhUuid.nullish(),
  amount: fdhMoneyMagnitude,
  currency_code: fdhCurrencyCode,
  percentage: z.number().gt(0).max(100).nullish(),
  note: z.string().max(500).nullish(),
});

/**
 * A relationship between two transactions.
 *
 * `transaction_id_to` is nullish on purpose: a probable transfer whose
 * counterpart account has not been imported yet is recorded now and resolved
 * whenever the other statement arrives.
 */
export const fdhTransactionLinkSchema = z
  .object({
    transaction_id_from: fdhUuid,
    transaction_id_to: fdhUuid.nullish(),
    link_type: z.enum(FDH_TRANSACTION_LINK_TYPES),
    confidence: fdhUnitInterval.nullish(),
    status: z.enum(FDH_LINK_STATUSES).default('pending'),
    created_by_method: z.enum(FDH_LINK_CREATION_METHODS),
    user_confirmed: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.transaction_id_to && v.transaction_id_to === v.transaction_id_from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transaction_id_to'],
        message: 'a transaction cannot be linked to itself',
      });
    }
    if (v.status === 'confirmed' && !v.transaction_id_to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transaction_id_to'],
        message: 'a confirmed link must name both sides',
      });
    }
  });

export const fdhDuplicateCandidateSchema = z
  .object({
    transaction_id_a: fdhUuid,
    transaction_id_b: fdhUuid,
    match_method: z.enum(FDH_DUPLICATE_MATCH_METHODS),
    confidence: fdhUnitInterval.nullish(),
    status: z.enum(FDH_DUPLICATE_STATUSES).default('pending'),
    reason_code: z.string().max(80).nullish(),
    user_resolution: z.enum(FDH_DUPLICATE_RESOLUTIONS).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.transaction_id_a === v.transaction_id_b) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transaction_id_b'],
        message: 'a transaction cannot duplicate itself',
      });
    }
  });

export const fdhRecurringTransactionSchema = fdhOwnershipInput
  .extend({
    merchant_id: fdhUuid.nullish(),
    financial_account_id: fdhUuid.nullish(),
    frequency: z.enum(FDH_RECURRING_FREQUENCIES),
    expected_amount: fdhMoneyMagnitude.nullish(),
    amount_tolerance: z.number().finite().min(0).nullish(),
    currency_code: fdhCurrencyCode.nullish(),
    next_expected_date: fdhDate.nullish(),
    status: z.enum(FDH_RECURRING_STATUSES).default('candidate'),
    confidence: fdhUnitInterval.nullish(),
    user_confirmed: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if ((v.expected_amount ?? null) !== null && !v.currency_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency_code'],
        message: 'an expected amount must state its currency',
      });
    }
  });

export type FdhTransactionInput = z.infer<typeof fdhTransactionSchema>;
export type FdhTransactionAllocationInput = z.infer<typeof fdhTransactionAllocationSchema>;
export type FdhTransactionLinkInput = z.infer<typeof fdhTransactionLinkSchema>;
export type FdhDuplicateCandidateInput = z.infer<typeof fdhDuplicateCandidateSchema>;
export type FdhRecurringTransactionInput = z.infer<typeof fdhRecurringTransactionSchema>;
