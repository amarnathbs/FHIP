/**
 * Financial Data Hub — the concrete repositories.
 *
 * Grouped by bounded context rather than collected into one giant
 * `financialDataService.ts`: accounts, documents, transactions, review/quality,
 * provenance and master data. Each is a thin, typed wrapper — no query
 * builder, no cache, no unit of work.
 */

import { createClient } from '@/lib/supabase/server';
import type {
  FdhCategory,
  FdhClassificationHistory,
  FdhClassificationRule,
  FdhCsvMappingTemplate,
  FdhDataProvenance,
  FdhDataQualityResult,
  FdhDuplicateCandidate,
  FdhEvidenceLink,
  FdhFinancialAccount,
  FdhFinancialInstitution,
  FdhIngestionJob,
  FdhMerchant,
  FdhMerchantAlias,
  FdhParserRegistry,
  FdhParserVersion,
  FdhReconciliationResult,
  FdhRecurringTransaction,
  FdhReviewItem,
  FdhSourceTypeRow,
  FdhStatementUpload,
  FdhSubcategory,
  FdhTransaction,
  FdhTransactionAllocation,
  FdhTransactionCorrection,
  FdhTransactionLink,
  FdhUserClassificationRule,
} from '../domain/types';
import type {
  FdhClassificationHistoryInput,
  FdhUserClassificationRuleInput,
} from '../validation/classification';
import type { FdhFinancialAccountInput } from '../validation/accounts';
import type {
  FdhIngestionJobInput,
  FdhStatementUploadCreateInput,
} from '../validation/documents';
import type { FdhDocumentAuditEvent, FdhUploadSession } from '../domain/types';
import type {
  FdhDataProvenanceInput,
  FdhDataQualityResultInput,
  FdhEvidenceLinkInput,
  FdhReconciliationResultInput,
  FdhReviewItemInput,
} from '../validation/review';
import type {
  FdhDuplicateCandidateInput,
  FdhRecurringTransactionInput,
  FdhTransactionAllocationInput,
  FdhTransactionInput,
  FdhTransactionLinkInput,
} from '../validation/transactions';
import { makeMasterDataRepository, makeUserOwnedRepository } from './base';

// --- Accounts ---------------------------------------------------------------
export const financialAccountsRepository = makeUserOwnedRepository<
  FdhFinancialAccount,
  FdhFinancialAccountInput
>('fdh_financial_accounts');

// --- Documents / jobs -------------------------------------------------------
export const statementUploadsRepository = makeUserOwnedRepository<
  FdhStatementUpload,
  FdhStatementUploadCreateInput
>('fdh_statement_uploads');

export const ingestionJobsRepository = makeUserOwnedRepository<
  FdhIngestionJob,
  FdhIngestionJobInput
>('fdh_ingestion_jobs');

/** FDH-3 (migration 0058). A generic CRUD repository is appropriate here — a
 * user may read, create and update (never re-parent) their own upload
 * sessions through ordinary RLS-scoped queries; no service-role client is
 * needed for this table. */
export const uploadSessionsRepository = makeUserOwnedRepository<
  FdhUploadSession,
  Omit<FdhUploadSession, 'id' | 'user_id' | 'created_at' | 'completed_at' | 'expired_at'>
>('fdh_upload_sessions');

/**
 * FDH-3 (migration 0058). READ-ONLY from the RLS-scoped client's point of
 * view: `fdh_document_audit_events` carries no INSERT/UPDATE/DELETE policy
 * for the authenticated role at all, so `makeUserOwnedRepository`'s write
 * methods would simply fail against Postgres if exposed here — they are
 * deliberately not exposed. Writing an event is
 * `lib/financial-data-hub/services/auditLog.ts`'s job, via the service-role
 * client, after the caller has already established ownership.
 */
export const documentAuditEventsRepository = {
  table: 'fdh_document_audit_events' as const,

  async listForUser(userId: string, limit = 200) {
    const supabase = await createClient();
    return supabase
      .from('fdh_document_audit_events')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<FdhDocumentAuditEvent[]>();
  },
};

// --- Transactions -----------------------------------------------------------
export const transactionsRepository = makeUserOwnedRepository<
  FdhTransaction,
  FdhTransactionInput
>('fdh_transactions');

export const transactionAllocationsRepository = makeUserOwnedRepository<
  FdhTransactionAllocation,
  FdhTransactionAllocationInput
>('fdh_transaction_allocations');

export const transactionLinksRepository = makeUserOwnedRepository<
  FdhTransactionLink,
  FdhTransactionLinkInput
>('fdh_transaction_links');

export const duplicateCandidatesRepository = makeUserOwnedRepository<
  FdhDuplicateCandidate,
  FdhDuplicateCandidateInput
>('fdh_duplicate_candidates', { hasUpdatedAtColumn: false });

export const recurringTransactionsRepository = makeUserOwnedRepository<
  FdhRecurringTransaction,
  FdhRecurringTransactionInput
>('fdh_recurring_transactions');

// --- Classification ---------------------------------------------------------
export const userClassificationRulesRepository = makeUserOwnedRepository<
  FdhUserClassificationRule,
  FdhUserClassificationRuleInput
>('fdh_user_classification_rules');

/**
 * Classification history is APPEND-ONLY. The table grants SELECT and INSERT to
 * the owner and no UPDATE or DELETE policy at all, so the generic `update` and
 * `remove` methods below would be refused by Postgres. They are removed from
 * the exported surface so no caller can even reach for them.
 */
const classificationHistoryBase = makeUserOwnedRepository<
  FdhClassificationHistory,
  FdhClassificationHistoryInput
>('fdh_classification_history');

export const classificationHistoryRepository = {
  table: classificationHistoryBase.table,
  listForUser: classificationHistoryBase.listForUser,
  getForUser: classificationHistoryBase.getForUser,
  append: classificationHistoryBase.create,
};

// --- Review / quality / reconciliation --------------------------------------
export const reviewItemsRepository = makeUserOwnedRepository<FdhReviewItem, FdhReviewItemInput>(
  'fdh_review_items',
);

export const reconciliationResultsRepository = makeUserOwnedRepository<
  FdhReconciliationResult,
  FdhReconciliationResultInput
>('fdh_reconciliation_results');

export const dataQualityResultsRepository = makeUserOwnedRepository<
  FdhDataQualityResult,
  FdhDataQualityResultInput
>('fdh_data_quality_results');

// --- Provenance -------------------------------------------------------------
export const dataProvenanceRepository = makeUserOwnedRepository<
  FdhDataProvenance,
  FdhDataProvenanceInput
>('fdh_data_provenance');

export const evidenceLinksRepository = makeUserOwnedRepository<
  FdhEvidenceLink,
  FdhEvidenceLinkInput
>('fdh_evidence_links');

// --- R7 — Bank CSV Engine (migration 0064) -----------------------------------
export const csvMappingTemplatesRepository = makeUserOwnedRepository<
  FdhCsvMappingTemplate,
  Omit<FdhCsvMappingTemplate, 'id' | 'user_id' | 'created_at' | 'updated_at'>
>('fdh_csv_mapping_templates');

export const transactionCorrectionsRepository = makeUserOwnedRepository<
  FdhTransactionCorrection,
  Omit<FdhTransactionCorrection, 'id' | 'user_id' | 'created_at'>
>('fdh_transaction_corrections', { hasUpdatedAtColumn: false });

// --- Master data (read-only) ------------------------------------------------
export const institutionsRepository = makeMasterDataRepository<FdhFinancialInstitution>(
  'fdh_financial_institutions',
);
export const categoriesRepository = makeMasterDataRepository<FdhCategory>('fdh_categories');
export const subcategoriesRepository = makeMasterDataRepository<FdhSubcategory>('fdh_subcategories');
export const merchantsRepository = makeMasterDataRepository<FdhMerchant>('fdh_merchants');
export const merchantAliasesRepository = makeMasterDataRepository<FdhMerchantAlias>(
  'fdh_merchant_aliases',
);
export const globalClassificationRulesRepository = makeMasterDataRepository<FdhClassificationRule>(
  'fdh_classification_rules',
);
export const parserRegistryRepository = makeMasterDataRepository<FdhParserRegistry>(
  'fdh_parser_registry',
);

/**
 * `fdh_parser_versions` has no `active` column — a version's availability is
 * its four-state `status` (development / certified / deprecated / disabled), so
 * the generic master-data repository does not fit and is not used here.
 * "Usable in production" means `certified`, not merely "present".
 */
export const parserVersionsRepository = {
  table: 'fdh_parser_versions' as const,

  async listCertifiedForParser(parserId: string) {
    const supabase = await createClient();
    return supabase
      .from('fdh_parser_versions')
      .select('*')
      .eq('parser_id', parserId)
      .eq('status', 'certified')
      .order('created_at', { ascending: false })
      .returns<FdhParserVersion[]>();
  },

  async getById(id: string) {
    const supabase = await createClient();
    return supabase
      .from('fdh_parser_versions')
      .select('*')
      .eq('id', id)
      .maybeSingle<FdhParserVersion>();
  },
};

/**
 * `fdh_source_types` is keyed on `source_type_key`, not a uuid `id`, so it too
 * gets a bespoke reader rather than the generic one.
 */
export const sourceTypesRepository = {
  table: 'fdh_source_types' as const,

  async listActive() {
    const supabase = await createClient();
    return supabase
      .from('fdh_source_types')
      .select('*')
      .eq('active', true)
      .returns<FdhSourceTypeRow[]>();
  },

  async getByKey(sourceTypeKey: string) {
    const supabase = await createClient();
    return supabase
      .from('fdh_source_types')
      .select('*')
      .eq('source_type_key', sourceTypeKey)
      .maybeSingle<FdhSourceTypeRow>();
  },
};
