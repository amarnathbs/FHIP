/**
 * Re-uploads and resumes across every statement type (2026-09-25).
 *
 * The payslip panel's first real production AI journey found three defects:
 * a re-upload paid for a second AI read, then dead-ended on the copy (which
 * has no evidence of its own), and a waiting item could not be reached after
 * a reload. These tests pin the same rule for the liability, retirement,
 * investment and bank statement services:
 *
 *   1. a byte-identical re-upload carries on with the ORIGINAL upload -- the
 *      OLDEST one that holds a result -- before any download, parse or AI
 *      call. Before, the check followed `duplicate_of_document_id`, which
 *      points at the NEWEST earlier copy: a third upload pointed at the
 *      second (a copy with no evidence), and was read -- and on the AI path
 *      paid for -- all over again;
 *   2. a copy of an upload whose AI reading still awaits review carries on
 *      with THAT reading (never a second provider call);
 *   3. resuming an upload's own AI reading never reads the file again (the
 *      raw file may already have been purged by the backstop).
 *
 * "No download" is the proof of "no parse and no AI call": neither can happen
 * without the bytes. The download stub FAILS if reached, so the pre-fix code
 * cannot pass by accident.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb> }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));

const download = vi.fn(async () => ({ ok: false as const, message: 'the file must not be read for this upload' }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({ downloadDocumentObject: () => download() }));
const aiGate = vi.fn(() => ({ ok: false, reason: 'adapter_disabled' }));
vi.mock('@/lib/aie/adapters/shared/fallbackGate', () => ({ evaluateAiFallbackGate: () => aiGate() }));
vi.mock('@/lib/aie/pilotCohortEmail', () => ({ resolveEmailForAiePilotCohort: async () => null }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: {
    getForUser: async (userId: string, id: string) => ({ data: (h.db.tables.fdh_statement_uploads ?? []).find((d) => d.id === id && d.user_id === userId) ?? null }),
  },
  documentAuditEventsRepository: { listForUser: async () => ({ data: [] }) },
  parserRegistryRepository: { getById: async () => ({ data: null }) },
  parserVersionsRepository: { listCertifiedForParser: async () => ({ data: [] }) },
  csvMappingTemplatesRepository: { getForUser: async () => ({ data: null }) },
}));

import { continueLiabilityStatementProcessing } from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import { continueRetirementStatementProcessing } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import { continueAuInvestmentStatementProcessing } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { processBankPdfDocument } from '@/lib/financial-data-hub/services/bankPdfProcessingService';
import { processBankCsvDocument, detectBankCsvDocument } from '@/lib/financial-data-hub/services/bankCsvProcessingService';

h.db = createInMemoryDb();

const U = 'user-1';
const upload = (over: Row): Row => ({
  user_id: U, file_hash: 'HASH-A', processing_status: 'queued', malware_scan_status: 'clean', error_code: null,
  raw_document_storage_reference: 'fdh/user-1/x.bin', mime_type: 'text/csv', country_code: 'AU', currency_code: 'AUD',
  duplicate_of_document_id: null, certification_status: null, processing_completed_at: null, ...over,
});

/** orig (holds the result) <- copy1 (a copy, nothing of its own) <- copy2.
 * `duplicate_of_document_id` is set the way the upload lifecycle sets it: to
 * the NEWEST earlier upload with the same hash. */
function seedChain(documentType: string, extra: Row = {}) {
  return [
    upload({ id: 'orig', document_type: documentType, created_at: '2026-09-25T10:00:00Z', ...extra }),
    upload({ id: 'copy1', document_type: documentType, created_at: '2026-09-25T10:05:00Z', duplicate_of_document_id: 'orig' }),
    upload({ id: 'copy2', document_type: documentType, created_at: '2026-09-25T10:10:00Z', duplicate_of_document_id: 'copy1' }),
    // Same bytes, but another user / another document type: never a match.
    upload({ id: 'other-user', user_id: 'user-2', document_type: documentType, created_at: '2026-09-25T09:00:00Z' }),
    upload({ id: 'other-type', document_type: 'bank_statement_other', created_at: '2026-09-25T09:30:00Z' }),
  ];
}

const draftRow = (documentId: string, documentType: string, payload: unknown, over: Row = {}): Row => ({
  id: `draft-${documentId}`, user_id: U, statement_upload_id: documentId, document_type: documentType,
  status: 'pending_review', payload, created_at: '2026-09-25T10:01:00Z', ...over,
});

beforeEach(() => {
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
  download.mockClear();
  aiGate.mockClear();
});

// ---------------------------------------------------------------------------
describe('credit card / loan statements', () => {
  const meta = { statementType: 'credit_card' as const, countryCode: 'AU' as const, currencyCode: 'AUD' };

  it('a THIRD upload of the same bytes carries on with the original statement -- not the copy it was flagged against', async () => {
    h.db.reset({
      fdh_statement_uploads: seedChain('credit_card_statement'),
      fdh_liability_statements: [{ id: 'stmt-orig', user_id: U, statement_upload_id: 'orig' }],
    });
    const r = await continueLiabilityStatementProcessing(U, 'copy2', meta);
    expect(r.pipelineStatus).toBe('duplicate_statement');
    expect(r.statementId).toBe('stmt-orig');
    expect(r.duplicateOfDocumentId).toBe('orig');
    expect(download).not.toHaveBeenCalled();
    expect(h.db.writes).toEqual([]);
  });

  it("a copy of a statement whose AI reading awaits review carries on with THAT reading -- no read, no AI call", async () => {
    const payload = { activities: [{ activityType: 'PURCHASE', activityDate: '2026-08-02', amount: 12.5 }], header: {}, allActivitiesListed: true, warnings: [] };
    h.db.reset({
      fdh_statement_uploads: seedChain('credit_card_statement'),
      fdh_ai_fallback_drafts: [draftRow('orig', 'liability_statement', payload)],
    });
    const r = await continueLiabilityStatementProcessing(U, 'copy1', meta);
    expect(r.pipelineStatus).toBe('ai_fallback_available');
    expect(r.aiFallbackDraft).toEqual(payload);
    expect(r.duplicateOfDocumentId).toBe('orig');
    expect(download).not.toHaveBeenCalled();
    expect(aiGate).not.toHaveBeenCalled();
  });

  it('resuming an upload with its own AI reading returns it without reading the file again', async () => {
    const payload = { activities: [], header: {}, allActivitiesListed: true, warnings: [] };
    h.db.reset({
      fdh_statement_uploads: [upload({ id: 'orig', document_type: 'credit_card_statement', created_at: '2026-09-25T10:00:00Z' })],
      fdh_ai_fallback_drafts: [draftRow('orig', 'liability_statement', payload)],
    });
    const r = await continueLiabilityStatementProcessing(U, 'orig', meta);
    expect(r.pipelineStatus).toBe('ai_fallback_available');
    expect(r.aiFallbackDraft).toEqual(payload);
    expect(r.duplicateOfDocumentId).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });

  it("never carries on with another user's upload, another document type's, or a discarded reading", async () => {
    h.db.reset({
      fdh_statement_uploads: [
        upload({ id: 'mine', document_type: 'credit_card_statement', created_at: '2026-09-25T11:00:00Z' }),
        upload({ id: 'theirs', user_id: 'user-2', document_type: 'credit_card_statement', created_at: '2026-09-25T10:00:00Z' }),
        upload({ id: 'loan', document_type: 'loan_statement', created_at: '2026-09-25T10:00:00Z' }),
        upload({ id: 'discarded', document_type: 'credit_card_statement', created_at: '2026-09-25T10:30:00Z' }),
      ],
      fdh_liability_statements: [
        { id: 's-theirs', user_id: 'user-2', statement_upload_id: 'theirs' },
        { id: 's-loan', user_id: U, statement_upload_id: 'loan' },
      ],
      fdh_ai_fallback_drafts: [draftRow('discarded', 'liability_statement', {}, { status: 'discarded' })],
    });
    // Nothing to carry on with, so the upload is genuinely read (and the
    // failing download stub proves it got that far).
    await expect(continueLiabilityStatementProcessing(U, 'mine', meta)).rejects.toThrow(/must not be read/);
    expect(download).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('retirement statements', () => {
  const meta = { jurisdiction: 'AU' as const, currencyCode: 'AUD' };

  it('a third upload carries on with the original statement', async () => {
    h.db.reset({
      fdh_statement_uploads: seedChain('super_statement'),
      fdh_retirement_statements: [{ id: 'rs-orig', user_id: U, statement_upload_id: 'orig' }],
    });
    const r = await continueRetirementStatementProcessing(U, 'copy2', meta);
    expect(r.pipelineStatus).toBe('duplicate_statement');
    expect(r.statementId).toBe('rs-orig');
    expect(r.duplicateOfDocumentId).toBe('orig');
    expect(download).not.toHaveBeenCalled();
  });

  it("a copy carries on with the original's AI reading, and an upload's own reading resumes without a read", async () => {
    const payload = { statementType: 'super_statement', jurisdiction: 'AU', accountType: 'unknown', currencyCode: 'AUD', activities: [], positions: [], warnings: [] };
    h.db.reset({
      fdh_statement_uploads: seedChain('super_statement'),
      fdh_ai_fallback_drafts: [draftRow('orig', 'retirement_statement', payload)],
    });
    const copy = await continueRetirementStatementProcessing(U, 'copy1', meta);
    expect(copy).toMatchObject({ pipelineStatus: 'ai_fallback_available', duplicateOfDocumentId: 'orig', aiFallbackDraft: payload });
    const own = await continueRetirementStatementProcessing(U, 'orig', meta);
    expect(own).toMatchObject({ pipelineStatus: 'ai_fallback_available', aiFallbackDraft: payload });
    expect(download).not.toHaveBeenCalled();
    expect(aiGate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('Australian investment statements', () => {
  const meta = { csvKind: 'transaction' as const, currencyCode: 'AUD' };

  it('a third upload carries on with the original statement', async () => {
    h.db.reset({
      fdh_statement_uploads: seedChain('investment_statement'),
      fdh_investment_statements: [{ id: 'is-orig', user_id: U, statement_upload_id: 'orig' }],
    });
    const r = await continueAuInvestmentStatementProcessing(U, 'copy2', meta);
    expect(r.pipelineStatus).toBe('duplicate_statement');
    expect(r.statementId).toBe('is-orig');
    expect(r.duplicateOfDocumentId).toBe('orig');
    expect(download).not.toHaveBeenCalled();
  });

  it("a copy carries on with the original's AI reading, and an upload's own reading resumes without a read", async () => {
    const payload = { holdings: [], activities: [], institutionName: 'Synthetic Broker', statementDate: null, statementPeriodStart: null, statementPeriodEnd: null, allRowsListed: true, warnings: [] };
    h.db.reset({
      fdh_statement_uploads: seedChain('investment_statement'),
      fdh_ai_fallback_drafts: [draftRow('orig', 'investment_statement', payload)],
    });
    expect(await continueAuInvestmentStatementProcessing(U, 'copy1', meta)).toMatchObject({ pipelineStatus: 'ai_fallback_available', duplicateOfDocumentId: 'orig', aiFallbackDraft: payload });
    expect(await continueAuInvestmentStatementProcessing(U, 'orig', meta)).toMatchObject({ pipelineStatus: 'ai_fallback_available', aiFallbackDraft: payload });
    expect(download).not.toHaveBeenCalled();
    expect(aiGate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('bank statements (PDF)', () => {
  const settled = { certification_status: 'certified', processing_completed_at: '2026-09-25T10:02:00Z', processing_status: 'ready_for_approval', certified_row_count: 42, reconciliation_status: 'reconciled', financial_account_id: 'acct-1' };

  it('a re-upload of an imported statement answers with the original -- nothing read, nothing created', async () => {
    h.db.reset({ fdh_statement_uploads: seedChain('bank_statement', settled).map((d) => ({ ...d, mime_type: 'application/pdf' })) });
    const r = await processBankPdfDocument(U, 'copy2');
    expect(r.pipelineStatus).toBe('duplicate_statement');
    expect(r.duplicateOfDocumentId).toBe('orig');
    expect(r.transactionsCreated).toBe(0);
    expect(r.duplicatesSkipped).toBe(42);
    expect(download).not.toHaveBeenCalled();
    expect(h.db.writes).toEqual([]);
  });

  it("a copy of a statement whose AI reading awaits review carries on with that reading", async () => {
    const payload = { rows: [], institutionName: null, maskedAccountIdentifier: null, statementPeriodStart: null, statementPeriodEnd: null, declaredOpeningBalance: null, declaredClosingBalance: null, allTransactionsListed: true, warnings: [] };
    h.db.reset({
      fdh_statement_uploads: seedChain('bank_statement', { processing_status: 'processing', financial_account_id: 'acct-1' }),
      fdh_ai_fallback_drafts: [draftRow('orig', 'bank_statement', payload)],
    });
    const r = await processBankPdfDocument(U, 'copy1');
    expect(r).toMatchObject({ pipelineStatus: 'ai_fallback_available', duplicateOfDocumentId: 'orig', aiFallbackDraft: payload });
    expect(download).not.toHaveBeenCalled();
    expect(aiGate).not.toHaveBeenCalled();
  });

  it('resuming a statement parked in processing with its AI reading returns the reading (it used to be refused as invalid_state)', async () => {
    const payload = { rows: [], institutionName: 'Synthetic Bank', maskedAccountIdentifier: null, statementPeriodStart: null, statementPeriodEnd: null, declaredOpeningBalance: null, declaredClosingBalance: null, allTransactionsListed: true, warnings: [] };
    h.db.reset({
      fdh_statement_uploads: [upload({ id: 'orig', document_type: 'bank_statement', processing_status: 'processing', created_at: '2026-09-25T10:00:00Z', financial_account_id: 'acct-1' })],
      fdh_ai_fallback_drafts: [draftRow('orig', 'bank_statement', payload)],
    });
    const r = await processBankPdfDocument(U, 'orig');
    expect(r).toMatchObject({ pipelineStatus: 'ai_fallback_available', aiFallbackDraft: payload });
    expect(download).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('bank statements (CSV)', () => {
  const settled = { certification_status: 'review_required', processing_completed_at: '2026-09-25T10:02:00Z', processing_status: 'ready_for_approval', certified_row_count: 7, financial_account_id: 'acct-1', detection_status: 'detected' };

  it('neither detection nor processing reads a copy of an imported CSV; processing answers with the original', async () => {
    h.db.reset({ fdh_statement_uploads: seedChain('bank_statement', settled) });
    const detected = await detectBankCsvDocument(U, 'copy2');
    expect(detected.id).toBe('copy2');
    const r = await processBankCsvDocument(U, 'copy2');
    expect(r.duplicateOfDocumentId).toBe('orig');
    expect(r.transactionsCreated).toBe(0);
    expect(r.duplicatesSkipped).toBe(7);
    expect(download).not.toHaveBeenCalled();
    expect(h.db.writes).toEqual([]);
  });

  it('a REJECTED original is not a result: re-uploading it is how a user retries, so the copy is read', async () => {
    h.db.reset({
      fdh_statement_uploads: [
        upload({ id: 'orig', document_type: 'bank_statement', created_at: '2026-09-25T10:00:00Z', certification_status: 'rejected', processing_completed_at: '2026-09-25T10:02:00Z', processing_status: 'rejected' }),
        upload({ id: 'copy1', document_type: 'bank_statement', created_at: '2026-09-25T10:05:00Z' }),
      ],
    });
    await expect(detectBankCsvDocument(U, 'copy1')).rejects.toThrow();
    expect(download).toHaveBeenCalledTimes(1);
  });
});
