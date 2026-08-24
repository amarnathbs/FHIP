/**
 * FDH-5 — Bank PDF Statement Engine: upload orchestration (spec sections
 * 8, 19, 22, 26, 57). Direct PDF analogue of `bankCsvUploadService.ts` —
 * REUSES FDH-3's upload/storage/audit plumbing (`createUploadSession()` +
 * `completeUpload()`) rather than duplicating it, and reuses the EXACT SAME
 * account-identity resolution logic R7 already built
 * (`resolveAccountIdentity`, `loadExistingAccountsForInstitutionCurrency`)
 * — those functions are entirely source-format-agnostic, so there is
 * nothing PDF-specific to change about how an account is resolved.
 */

import { createUploadSession, completeUpload, FdhUploadLifecycleError } from './uploadLifecycle';
import { recordDocumentAuditEvent } from './auditLog';
import { financialAccountsRepository, institutionsRepository, reviewItemsRepository, statementUploadsRepository } from '../repositories';
import { loadExistingAccountsForInstitutionCurrency } from '../bank-csv/repository';
import { normaliseMaskedIdentifier, resolveAccountIdentity } from '../bank-csv/accountIdentity';
import type { BankCsvUploadMetadataInput } from '../validation/bankCsv';
import type { FdhStatementUpload } from '../domain/types';

export interface BankPdfUploadOutcome {
  document: FdhStatementUpload;
  accountResolution: 'reused' | 'created' | 'ambiguous';
}

/**
 * Uploads a bank PDF and resolves its source account. Mirrors an ordinary
 * FDH document upload (session create -> complete) and adds:
 *   1. Account identity resolution (same logic R7 uses for CSV, unchanged).
 *   2. The `bank_csv_uploaded`-equivalent PDF audit event — FDH-5 does not
 *      introduce a SEPARATE `bank_pdf_uploaded` event type: the generic
 *      `document_upload_completed` event `completeUpload()` already records
 *      carries `source_type` in its own metadata-free design (the
 *      document row's own `source_type` column is the record); a
 *      PDF-specific "uploaded" event would duplicate that fact for no
 *      operational benefit R7's CSV-specific event did not already need
 *      solved differently. What FDH-5 DOES add is `pdf_validated`, recorded
 *      here once the file is confirmed to be a plausible PDF (spec 85).
 */
export async function uploadBankPdf(
  userId: string,
  metadata: BankCsvUploadMetadataInput,
  bytes: Uint8Array,
): Promise<BankPdfUploadOutcome> {
  const { session } = await createUploadSession(userId, {
    source_type: 'pdf_native',
    document_type: 'bank_statement',
    institution_id: metadata.institution_id ?? null,
    country_code: metadata.country_code,
    currency_code: metadata.currency_code,
    declared_mime_type: 'application/pdf',
    declared_file_size_bytes: bytes.byteLength,
  });

  const completed = await completeUpload(userId, session.id, bytes);

  if (completed.processing_status !== 'failed' && completed.processing_status !== 'rejected') {
    await recordDocumentAuditEvent({
      userId,
      documentId: completed.id,
      eventType: 'pdf_validated',
      actorType: 'system',
    });
  }

  let accountResolution: BankPdfUploadOutcome['accountResolution'] = 'ambiguous';
  let financialAccountId: string | null = null;

  // Account resolution runs only once the file itself is safely stored and
  // validated (spec 91: no data effect from a file that never became valid
  // evidence) — including the case where it is QUEUED awaiting a password
  // (spec 22): the account can and should still be resolved so the user
  // sees where the statement will land once decrypted.
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
        title_code: 'bank_pdf.account_identity_ambiguous',
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

  return { document: (finalDoc ?? completed) as FdhStatementUpload, accountResolution };
}
