/**
 * Financial Data Hub — the retention / purge contract, as code.
 *
 * The approved principle: once a user has APPROVED a processed document, the
 * raw source material is deleted and only the privacy-safe derived facts are
 * kept.
 *
 * DELETED after approval, per the retention lifecycle:
 *   the uploaded original document, any decrypted temporary file, page images,
 *   OCR artefacts, unnecessary personal identifiers, and raw sensitive
 *   narratives once they are no longer needed.
 *
 * RETAINED:
 *   date, amount, currency, clean description, normalised merchant, economic
 *   type, category, source institution, privacy-safe account fingerprint,
 *   provenance, and the user's own corrections.
 *
 * FDH-1 IMPLEMENTS NO PURGE WORKER and no document vault. What it guarantees
 * is that the schema cannot BLOCK the purge: every field listed below is
 * nullable, and `tests/unit/fdh1PrivacyLifecycle.test.ts` reads the migration
 * SQL and fails if any of them is ever made `not null`.
 */

import type { FdhStatementUpload, FdhTransaction } from './types';

/**
 * Columns on `fdh_statement_uploads` that the purge lifecycle nulls. Each must
 * remain nullable forever.
 */
export const PURGEABLE_STATEMENT_UPLOAD_COLUMNS = [
  'raw_document_storage_reference',
  'original_filename_sanitised',
] as const satisfies readonly (keyof FdhStatementUpload)[];

/**
 * Columns on `fdh_transactions` that the purge lifecycle nulls once
 * normalisation has produced the retained equivalents (`description_clean`,
 * `merchant_id`). Each must remain nullable forever.
 */
export const PURGEABLE_TRANSACTION_COLUMNS = [
  'description_raw',
  'merchant_raw',
] as const satisfies readonly (keyof FdhTransaction)[];

/**
 * Columns that must SURVIVE a purge — the derived, privacy-safe facts the rest
 * of the platform will eventually rely on. Listed explicitly so a future purge
 * implementation cannot quietly widen its blast radius.
 */
export const PURGE_RETAINED_TRANSACTION_COLUMNS = [
  'transaction_date',
  'amount_original',
  'currency_original',
  'credit_debit',
  'description_clean',
  'merchant_id',
  'economic_transaction_type',
  'category_id',
  'subcategory_id',
  'user_override',
] as const satisfies readonly (keyof FdhTransaction)[];

/**
 * Build the patch that nulls a statement upload's raw references.
 *
 * Pure: it returns the patch, it does not write it. The database additionally
 * refuses (`chk_fdh_uploads_purged_reference`) to accept
 * `raw_document_purge_status = 'purged'` while a storage reference is still
 * present, so a purge that forgot to clear the pointer fails loudly instead of
 * silently leaving the document reachable.
 */
export function buildStatementUploadPurgePatch(purgedAt: string): Record<string, unknown> {
  return {
    raw_document_storage_reference: null,
    original_filename_sanitised: null,
    raw_document_purge_status: 'purged',
    raw_document_purged_at: purgedAt,
  };
}

/** Build the patch that nulls a transaction's raw source strings. */
export function buildTransactionPurgePatch(): Record<string, unknown> {
  return {
    description_raw: null,
    merchant_raw: null,
  };
}

/**
 * Whether a transaction can safely lose its raw strings — i.e. normalisation
 * has actually produced something to keep. Purging a raw description before a
 * clean one exists would destroy the only copy of the fact.
 */
export function isTransactionSafeToPurgeRaw(
  transaction: Pick<FdhTransaction, 'description_clean' | 'merchant_id' | 'merchant_raw'>,
): boolean {
  const hasCleanDescription = Boolean(transaction.description_clean?.trim());
  const merchantResolvedOrAbsent = transaction.merchant_id !== null || transaction.merchant_raw === null;
  return hasCleanDescription && merchantResolvedOrAbsent;
}
