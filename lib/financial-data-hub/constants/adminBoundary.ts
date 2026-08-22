/**
 * Financial Data Hub — the admin financial-data boundary.
 *
 * PRODUCT OWNER DECISION 3 (hard rule): a normal application administrator has
 * NO standing access to raw user financial documents. There is no admin
 * document viewer, no download, no generic raw-file access and no
 * unrestricted service endpoint. FDH-1 builds none of those.
 *
 * What a future admin surface MAY show is OPERATIONAL METADATA only. This file
 * is the machine-readable definition of that boundary. It is deliberately an
 * ALLOWLIST, not a denylist: a column added to `fdh_statement_uploads` later
 * is invisible to admins until somebody deliberately adds it here, and
 * `tests/unit/fdh1AdminBoundary.test.ts` fails if any forbidden column ever
 * appears in the allowlist.
 *
 * FDH-1 SCOPE NOTE. No admin route, no admin UI and no service that reads
 * another user's FDH rows is implemented in FDH-1. This is the permission
 * CONCEPT, ready for FDH-13 (Admin Intelligence Centre) to consume.
 *
 * A future temporary support-access mechanism (an admin viewing a specific
 * document with the user's explicit, time-boxed, logged consent) requires its
 * own consent architecture and its own approved phase. It is NOT implemented
 * here and must not be improvised on top of this allowlist.
 */

import type { FdhStatementUpload } from '../domain/types';

/**
 * The only `fdh_statement_uploads` columns an administrator may ever see.
 * Every entry is operational: it describes the processing of a document, not
 * its contents, and none of it identifies a person.
 */
export const ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS = [
  'id',
  'institution_id',
  'document_type',
  'source_type',
  'country_code',
  'processing_status',
  'review_status',
  'parser_id',
  'parser_version_id',
  'processing_method',
  'reconciliation_status',
  'overall_quality_status',
  'error_code',
  'raw_document_purge_status',
  'raw_document_purge_due_at',
  'raw_document_purged_at',
  'purge_attempt_count',
  'created_at',
  'updated_at',
  'approved_at',
] as const satisfies readonly (keyof FdhStatementUpload)[];

export type AdminVisibleStatementUploadColumn =
  (typeof ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS)[number];

/**
 * Columns that must NEVER appear in an admin projection, with the reason.
 *
 * `user_id` and `household_id` are here because an admin surface must show a
 * PSEUDONYMOUS reference, not a directly-joinable identity. The pseudonym is
 * produced by `toPseudonymousReference()` below.
 */
export const ADMIN_FORBIDDEN_STATEMENT_UPLOAD_COLUMNS: Record<string, string> = {
  user_id: 'Direct identity. Admins see a pseudonymous reference instead.',
  household_id: 'Direct identity. Admins see a pseudonymous reference instead.',
  financial_account_id: "Joins to the user's account list, which is household financial data.",
  original_filename_sanitised: 'A filename frequently carries the account holder\'s name.',
  file_hash: 'Content-derived. Permits confirming whether a specific known document was uploaded.',
  raw_document_storage_reference: 'A pointer to the raw document itself. This is the whole point of Decision 3.',
  statement_period_start: 'Reveals the shape of a specific person\'s financial history.',
  statement_period_end: 'Reveals the shape of a specific person\'s financial history.',
  statement_as_of_date: 'Reveals the shape of a specific person\'s financial history.',
  currency_code: 'Combined with country, narrows an individual household.',
  mime_type: 'Not needed operationally; leaks document provenance detail.',
  file_size_bytes: 'Not needed operationally; a size is a weak content fingerprint.',
  purge_reason: 'Free text; may contain a support-conversation detail about the user.',
  last_purge_error_sanitised: 'Free text; sanitisation is best-effort, so it is not admin-visible.',
};

/**
 * Tables an administrator has NO standing read access to at all, at any
 * granularity. There is no allowlist for these — an admin surface must not
 * project them, aggregate them, or count over them per-user.
 */
export const ADMIN_NO_STANDING_ACCESS_TABLES = [
  'fdh_transactions',
  'fdh_transaction_allocations',
  'fdh_transaction_links',
  'fdh_duplicate_candidates',
  'fdh_user_classification_rules',
  'fdh_classification_history',
  'fdh_recurring_transactions',
  'fdh_review_items',
  'fdh_reconciliation_results',
  'fdh_data_provenance',
  'fdh_evidence_links',
  'fdh_financial_accounts',
] as const;

/**
 * Reduce a statement-upload row to the operational-metadata projection, adding
 * a pseudonymous owner reference.
 *
 * This is a pure function with no database access. It exists so that when
 * FDH-13 builds an admin surface it has exactly one correct way to produce the
 * projection, rather than each route hand-picking columns.
 *
 * `pseudonymise` is supplied by the caller. FDH-1 does not ship a keyed
 * pseudonymisation implementation because no key-management infrastructure
 * exists in this repository yet (the same reason `account_fingerprint` is
 * unpopulated) — see FDH1_PRIVACY_DATA_LIFECYCLE.md section 3.
 */
export function toAdminOperationalMetadata(
  row: FdhStatementUpload,
  pseudonymise: (userId: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    owner_reference: pseudonymise(row.user_id),
  };
  for (const column of ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS) {
    out[column] = row[column];
  }
  return out;
}
