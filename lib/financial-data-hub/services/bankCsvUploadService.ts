/**
 * R7 — Bank CSV Engine: upload orchestration (spec sections 16-17, 30-31,
 * 54, 57).
 *
 * REUSES FDH-3's upload/storage/audit plumbing rather than duplicating it
 * (spec section 6) — `createUploadSession()` + `completeUpload()` from
 * `uploadLifecycle.ts` do the actual byte-safe intake, private-storage
 * write, hash/duplicate-file detection and audit trail exactly as an
 * ordinary FDH document upload would. This service composes those two calls
 * into one bounded bank-CSV upload step and layers the R7-specific concern
 * on top: resolving (or safely deferring) the source account BEFORE the
 * document reaches the processing queue.
 */

import { createUploadSession, completeUpload, FdhUploadLifecycleError } from './uploadLifecycle';
import { recordDocumentAuditEvent } from './auditLog';
import {
  assertNoIdenticalUploadWithDifferentOwner,
  assertNoSilentAccountOwnerChange,
  recordBankOwner,
  type BankOwnerWrite,
  type BankUploadOptions,
  type BankUploadOwner,
  NO_OWNER_OUTCOME,
} from './bankOwnerAttribution';
import { financialAccountsRepository, institutionsRepository, reviewItemsRepository, statementUploadsRepository } from '../repositories';
import { loadExistingAccountsForInstitutionCurrency } from '../bank-csv/repository';
import { normaliseMaskedIdentifier, resolveAccountIdentity } from '../bank-csv/accountIdentity';
import type { BankCsvUploadMetadataInput } from '../validation/bankCsv';
import type { FdhStatementUpload } from '../domain/types';

export interface BankCsvUploadOutcome {
  document: FdhStatementUpload;
  accountResolution: 'reused' | 'created' | 'ambiguous';
  /** Owner-before-upload: how the owner the user chose was stored. `account`
   * says what happened to the ACCOUNT's owner (never silently overwritten),
   * `document` whether the owner was recorded on the document itself. */
  owner: { account: BankOwnerWrite | 'no_account'; document: 'recorded' | 'unavailable' | 'failed' };
}

/**
 * Uploads a bank CSV and resolves its source account. Mirrors an ordinary
 * FDH document upload (session create -> complete) and adds:
 *   1. Account identity resolution (spec 30-31) — reuse an existing account,
 *      safely create a new one, or leave `financial_account_id` null and
 *      raise a review item when genuinely ambiguous. NEVER guesses.
 *   2. The `bank_csv_uploaded` audit event (spec 48), additional to the
 *      generic FDH-3 upload events `completeUpload()` already records.
 */
export async function uploadBankCsv(
  userId: string,
  metadata: BankCsvUploadMetadataInput,
  bytes: Uint8Array,
  /** Owner-before-upload. `null` ONLY for the AIE bank intake path, which is a
   * later phase and keeps its previous owner-less behaviour. */
  owner: BankUploadOwner | null = null,
  options: BankUploadOptions = {},
): Promise<BankCsvUploadOutcome> {
  // Owner-before-upload: refuse BEFORE anything is stored when the choice would
  // contradict an earlier upload of the identical file (decision 6) or silently
  // move an existing account to a different owner (decision 2).
  if (owner) {
    await assertNoIdenticalUploadWithDifferentOwner(userId, bytes, owner);
    await assertNoSilentAccountOwnerChange(userId, metadata, owner, options);
  }

  const { session } = await createUploadSession(userId, {
    source_type: 'csv',
    document_type: 'bank_statement',
    institution_id: metadata.institution_id ?? null,
    country_code: metadata.country_code,
    currency_code: metadata.currency_code,
    declared_mime_type: 'text/csv',
    declared_file_size_bytes: bytes.byteLength,
  });

  const completed = await completeUpload(userId, session.id, bytes);

  // Account resolution runs only once the file itself is safely stored and
  // validated — an invalid/rejected upload never creates or touches an
  // account (spec 91: no data effect from a file that never became valid
  // evidence).
  let accountResolution: BankCsvUploadOutcome['accountResolution'] = 'ambiguous';
  let financialAccountId: string | null = null;

  if (completed.processing_status !== 'failed' && completed.processing_status !== 'rejected') {
    const maskedIdentifier = normaliseMaskedIdentifier(metadata.declared_masked_identifier ?? null);
    const existingAccounts = await loadExistingAccountsForInstitutionCurrency(
      userId,
      metadata.institution_id ?? null,
      metadata.currency_code,
    );
    const decision = resolveAccountIdentity({
      userId,
      institutionId: metadata.institution_id ?? null,
      currencyCode: metadata.currency_code,
      maskedIdentifierNormalised: maskedIdentifier,
      existingAccountsForInstitutionAndCurrency: existingAccounts,
    });

    if (decision.outcome === 'reuse') {
      financialAccountId = decision.accountId;
      accountResolution = 'reused';
    } else if (decision.outcome === 'create') {
      const institutionName = metadata.institution_id
        ? (await institutionsRepository.getById(metadata.institution_id)).data?.institution_name ?? 'Imported account'
        : 'Imported account';
      const { data: newAccount, error } = await financialAccountsRepository.create(userId, {
        household_id: null,
        institution_id: metadata.institution_id ?? null,
        account_type: 'transaction',
        country_code: metadata.country_code,
        currency_code: metadata.currency_code,
        display_name: institutionName,
        masked_identifier: maskedIdentifier,
        status: 'active',
      } as never);
      if (error || !newAccount) {
        throw new FdhUploadLifecycleError('session_error', error?.message ?? 'could not create financial account');
      }
      await financialAccountsRepository.update(userId, newAccount.id, { account_fingerprint: decision.fingerprint } as never);
      financialAccountId = newAccount.id;
      accountResolution = 'created';
    } else {
      accountResolution = 'ambiguous';
      await reviewItemsRepository.create(userId, {
        household_id: null,
        statement_upload_id: completed.id,
        transaction_id: null,
        review_type: 'other',
        severity: 'blocking',
        status: 'open',
        title_code: 'bank_csv.account_identity_ambiguous',
        context_json: { related_statement_upload_ids: [completed.id] },
      } as never);
    }
  }

  const { data: finalDoc } = await statementUploadsRepository.update(userId, completed.id, {
    financial_account_id: financialAccountId,
    statement_period_start: metadata.statement_period_start ?? null,
    statement_period_end: metadata.statement_period_end ?? null,
    original_filename_sanitised: metadata.original_filename_sanitised ?? null,
  } as never);

  // Its own update, tolerant of a database one migration behind: the account
  // link above must never be lost to an owner column that does not exist yet.
  const ownerOutcome = owner
    ? await recordBankOwner({ userId, documentId: completed.id, accountId: financialAccountId, owner, options })
    : NO_OWNER_OUTCOME;

  await recordDocumentAuditEvent({
    userId,
    documentId: completed.id,
    eventType: 'bank_csv_uploaded',
    actorType: 'user',
    actorId: userId,
    metadata: { account_resolution: accountResolution, owner_role: owner?.ownerRole ?? null, account_owner: ownerOutcome.account },
  });

  return { document: (finalDoc ?? completed) as FdhStatementUpload, accountResolution, owner: ownerOutcome };
}
