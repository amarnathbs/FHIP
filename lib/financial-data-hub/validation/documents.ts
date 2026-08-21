/**
 * Financial Data Hub — validation for statement/import metadata, ingestion
 * jobs, and document state transitions.
 */

import { z } from 'zod';
import {
  FDH_DOCUMENT_TYPES,
  FDH_ERROR_CODES,
  FDH_JOB_STATUSES,
  FDH_JOB_TYPES,
  FDH_PROCESSING_METHODS,
  FDH_PROCESSING_STATUSES,
  FDH_PURGE_STATUSES,
  FDH_QUALITY_STATUSES,
  FDH_RECONCILIATION_STATUSES,
  FDH_REVIEW_STATUSES,
  FDH_SOURCE_TYPES,
} from '../constants/enums';
import { isAllowedDocumentTransition, isAllowedPurgeTransition } from '../domain/documentLifecycle';
import {
  fdhCountryCode,
  fdhCurrencyCode,
  fdhDate,
  fdhOwnershipInput,
  fdhTimestamp,
  fdhUuid,
  refineDateOrder,
} from './primitives';
import { fdhSanitisedFilename } from './filename';

export { fdhSanitisedFilename };

/** Lowercase sha-256 hex digest. */
export const fdhFileHash = z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha-256 hex digest');

/**
 * Creating a statement-upload record.
 *
 * FDH-1 SHIPS NO UPLOAD ROUTE. This schema describes the metadata record and
 * exists so FDH-3 has a validated contract to build against.
 *
 * `processing_status` is not accepted from a caller: a new record always
 * begins at `created` and moves only through the state machine.
 */
export const fdhStatementUploadCreateSchema = fdhOwnershipInput
  .extend({
    financial_account_id: fdhUuid.nullish(),
    institution_id: fdhUuid.nullish(),
    source_type: z.enum(FDH_SOURCE_TYPES),
    document_type: z.enum(FDH_DOCUMENT_TYPES).nullish(),
    country_code: fdhCountryCode.nullish(),
    currency_code: fdhCurrencyCode.nullish(),
    original_filename_sanitised: fdhSanitisedFilename.nullish(),
    file_hash: fdhFileHash.nullish(),
    mime_type: z.string().max(120).nullish(),
    file_size_bytes: z.number().int().positive().nullish(),
    statement_period_start: fdhDate.nullish(),
    statement_period_end: fdhDate.nullish(),
    statement_as_of_date: fdhDate.nullish(),
  })
  .superRefine(refineDateOrder('statement_period_start', 'statement_period_end'));

/** Patching processing metadata. Still no arbitrary status change — see below. */
export const fdhStatementUploadPatchSchema = z.object({
  financial_account_id: fdhUuid.nullish(),
  institution_id: fdhUuid.nullish(),
  document_type: z.enum(FDH_DOCUMENT_TYPES).nullish(),
  country_code: fdhCountryCode.nullish(),
  currency_code: fdhCurrencyCode.nullish(),
  statement_period_start: fdhDate.nullish(),
  statement_period_end: fdhDate.nullish(),
  statement_as_of_date: fdhDate.nullish(),
  review_status: z.enum(FDH_REVIEW_STATUSES).optional(),
  parser_id: fdhUuid.nullish(),
  parser_version_id: fdhUuid.nullish(),
  processing_method: z.enum(FDH_PROCESSING_METHODS).nullish(),
  reconciliation_status: z.enum(FDH_RECONCILIATION_STATUSES).optional(),
  overall_quality_status: z.enum(FDH_QUALITY_STATUSES).optional(),
  error_code: z.enum(FDH_ERROR_CODES).nullish(),
});

/**
 * A document status change, validated against the state machine.
 *
 * This is what makes "no arbitrary status changes" real at the application
 * boundary: the transition is checked, not merely the vocabulary.
 */
export const fdhDocumentTransitionSchema = z
  .object({
    from: z.enum(FDH_PROCESSING_STATUSES),
    to: z.enum(FDH_PROCESSING_STATUSES),
    error_code: z.enum(FDH_ERROR_CODES).nullish(),
  })
  .superRefine((v, ctx) => {
    if (!isAllowedDocumentTransition(v.from, v.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `transition ${v.from} -> ${v.to} is not allowed`,
      });
    }
    if (v.to === 'failed' && !v.error_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error_code'],
        message: 'a failure must record a controlled error code',
      });
    }
  });

/** A raw-document purge status change, validated against the purge machine. */
export const fdhPurgeTransitionSchema = z
  .object({
    from: z.enum(FDH_PURGE_STATUSES),
    to: z.enum(FDH_PURGE_STATUSES),
    purged_at: fdhTimestamp.nullish(),
  })
  .superRefine((v, ctx) => {
    if (!isAllowedPurgeTransition(v.from, v.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `purge transition ${v.from} -> ${v.to} is not allowed`,
      });
    }
    if (v.to === 'purged' && !v.purged_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['purged_at'],
        message: 'a purge must record when it completed',
      });
    }
  });

/** An ingestion job. No worker is implemented in FDH-1. */
export const fdhIngestionJobSchema = z.object({
  statement_upload_id: fdhUuid,
  job_type: z.enum(FDH_JOB_TYPES),
  status: z.enum(FDH_JOB_STATUSES).default('queued'),
  attempt: z.number().int().min(0).default(0),
  max_attempts: z.number().int().min(1).max(10).default(3),
  error_code: z.enum(FDH_ERROR_CODES).nullish(),
  // Bounded and code-adjacent. A stack trace must never be persisted here.
  error_message_sanitised: z.string().max(500).nullish(),
  worker_reference: z.string().max(120).nullish(),
});

export type FdhStatementUploadCreateInput = z.infer<typeof fdhStatementUploadCreateSchema>;
export type FdhStatementUploadPatchInput = z.infer<typeof fdhStatementUploadPatchSchema>;
export type FdhIngestionJobInput = z.infer<typeof fdhIngestionJobSchema>;
