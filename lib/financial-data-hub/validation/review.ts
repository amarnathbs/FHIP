/**
 * Financial Data Hub — validation for the review queue, reconciliation,
 * data-quality results, provenance and evidence.
 */

import { z } from 'zod';
import {
  FDH_DATA_QUALITY_CHECKS,
  FDH_DATA_QUALITY_STATUSES,
  FDH_EVIDENCE_TYPES,
  FDH_PROVENANCE_ENTITY_TYPES,
  FDH_RECONCILIATION_METHODS,
  FDH_RECONCILIATION_STATUSES,
  FDH_REVIEW_ITEM_STATUSES,
  FDH_REVIEW_SEVERITIES,
  FDH_REVIEW_TYPES,
  FDH_SOURCE_TYPES,
} from '../constants/enums';
import {
  fdhCurrencyCode,
  fdhDate,
  fdhMachineKey,
  fdhMoneyNonNegative,
  fdhMoneySigned,
  fdhOwnershipInput,
  fdhUnitInterval,
  fdhUuid,
  refineDateOrder,
} from './primitives';

/**
 * A review item's context.
 *
 * CLOSED SHAPE, and deliberately so. There is no free-text field anywhere in
 * it. If a raw statement narrative could be stashed here, it would survive the
 * raw-document purge and quietly defeat the retention model. `.strict()`
 * rejects any key not listed.
 */
export const fdhReviewItemContextSchema = z
  .object({
    related_transaction_ids: z.array(fdhUuid).max(50).optional(),
    related_statement_upload_ids: z.array(fdhUuid).max(50).optional(),
    check_codes: z.array(z.enum(FDH_DATA_QUALITY_CHECKS)).max(20).optional(),
    counts: z.record(z.string().max(60), z.number().int()).optional(),
    confidence: fdhUnitInterval.optional(),
  })
  .strict();

export const fdhReviewItemSchema = fdhOwnershipInput
  .extend({
    statement_upload_id: fdhUuid.nullish(),
    transaction_id: fdhUuid.nullish(),
    review_type: z.enum(FDH_REVIEW_TYPES),
    severity: z.enum(FDH_REVIEW_SEVERITIES).default('info'),
    status: z.enum(FDH_REVIEW_ITEM_STATUSES).default('open'),
    // A message key resolved to copy in the UI, never a sentence containing a
    // merchant name, an amount or a narrative.
    title_code: fdhMachineKey,
    context_json: fdhReviewItemContextSchema.nullish(),
    resolution_code: fdhMachineKey.nullish(),
  })
  .superRefine((v, ctx) => {
    if (!v.statement_upload_id && !v.transaction_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transaction_id'],
        message: 'a review item must reference a document or a transaction',
      });
    }
  });

/**
 * A reconciliation result.
 *
 * NEVER SILENTLY PASS. `reconciled` is refused unless a variance was actually
 * computed and falls within the explicitly-stored tolerance. Any larger
 * discrepancy must be recorded as `failed` or as a deliberate
 * `user_accepted_exception` — there is no third option and no default fudge.
 */
export const fdhReconciliationResultSchema = z
  .object({
    statement_upload_id: fdhUuid,
    opening_balance: fdhMoneySigned.nullish(),
    extracted_credits: fdhMoneyNonNegative.nullish(),
    extracted_debits: fdhMoneyNonNegative.nullish(),
    expected_closing_balance: fdhMoneySigned.nullish(),
    reported_closing_balance: fdhMoneySigned.nullish(),
    variance: fdhMoneySigned.nullish(),
    variance_tolerance: z.number().finite().min(0).default(0),
    currency_code: fdhCurrencyCode.nullish(),
    status: z.enum(FDH_RECONCILIATION_STATUSES).default('pending'),
    reconciliation_method: z.enum(FDH_RECONCILIATION_METHODS).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.status !== 'reconciled') return;
    if (v.variance === null || v.variance === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variance'],
        message: 'a reconciled result must state the variance it achieved',
      });
      return;
    }
    if (Math.abs(v.variance) > v.variance_tolerance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message:
          'a variance beyond the stated tolerance cannot be recorded as reconciled; '
          + 'use failed or user_accepted_exception',
      });
    }
  });

export const fdhDataQualityResultSchema = z.object({
  statement_upload_id: fdhUuid,
  check_code: z.enum(FDH_DATA_QUALITY_CHECKS),
  status: z.enum(FDH_DATA_QUALITY_STATUSES),
  score: fdhUnitInterval.nullish(),
  // Operator-safe explanation. Bounded, and never a stack trace or verbatim
  // document text.
  details_sanitised: z.string().max(500).nullish(),
});

/**
 * A provenance record — "where did this number come from?".
 *
 * `evidence_completeness` is stored, not computed: FDH-1 hardcodes no scoring
 * rule (no 0.5-for-bank-only, no 1.0-for-payslip). The model is FDH-9 scope.
 */
export const fdhDataProvenanceSchema = fdhOwnershipInput
  .extend({
    entity_type: z.enum(FDH_PROVENANCE_ENTITY_TYPES),
    entity_id: fdhUuid,
    source_type: z.enum(FDH_SOURCE_TYPES),
    source_id: fdhUuid.nullish(),
    source_statement_id: fdhUuid.nullish(),
    source_transaction_id: fdhUuid.nullish(),
    calculation_period_start: fdhDate.nullish(),
    calculation_period_end: fdhDate.nullish(),
    as_of_date: fdhDate.nullish(),
    parser_id: fdhUuid.nullish(),
    parser_version_id: fdhUuid.nullish(),
    mapping_rule_version: z.string().max(60).nullish(),
    evidence_completeness: fdhUnitInterval.nullish(),
    user_verified: z.boolean().default(false),
    manual_override: z.boolean().default(false),
  })
  .superRefine(refineDateOrder('calculation_period_start', 'calculation_period_end'))
  .superRefine((v, ctx) => {
    // "Institution support is not one successful document": a parser version
    // is only interpretable alongside the parser it belongs to.
    if (v.parser_version_id && !v.parser_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parser_id'],
        message: 'a parser_version_id must name its parser',
      });
    }
  });

/** One evidence source supporting one provenance record. Many-to-one. */
export const fdhEvidenceLinkSchema = z
  .object({
    provenance_id: fdhUuid,
    evidence_type: z.enum(FDH_EVIDENCE_TYPES),
    evidence_statement_upload_id: fdhUuid.nullish(),
    evidence_transaction_id: fdhUuid.nullish(),
    evidence_weight: fdhUnitInterval.nullish(),
    note_sanitised: z.string().max(300).nullish(),
  })
  .superRefine((v, ctx) => {
    const documentBacked = v.evidence_type === 'payslip_document'
      || v.evidence_type === 'statement_document';
    if (documentBacked && !v.evidence_statement_upload_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence_statement_upload_id'],
        message: 'document-backed evidence must name the document',
      });
    }
    if (v.evidence_type === 'bank_transaction' && !v.evidence_transaction_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence_transaction_id'],
        message: 'transaction-backed evidence must name the transaction',
      });
    }
  });

export type FdhReviewItemInput = z.infer<typeof fdhReviewItemSchema>;
export type FdhReconciliationResultInput = z.infer<typeof fdhReconciliationResultSchema>;
export type FdhDataQualityResultInput = z.infer<typeof fdhDataQualityResultSchema>;
export type FdhDataProvenanceInput = z.infer<typeof fdhDataProvenanceSchema>;
export type FdhEvidenceLinkInput = z.infer<typeof fdhEvidenceLinkSchema>;
