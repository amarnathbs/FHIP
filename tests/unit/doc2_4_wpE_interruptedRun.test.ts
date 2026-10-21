/**
 * Document2 (4) F15 -- the bank-statement import that "extracts transactions for a while, then errors".
 *
 * Measured in DEV with the real routes (docs/reviews/DOCUMENT2_4_TRUTH_WP-E.md): upload, owner choice, account assignment, malware
 * admission and the native CSV / certified PDF parsers all work; what fails is the PROCESS request itself. It runs inside one HTTP request
 * and a real bank PDF that falls to the AI reading takes longer than the platform's 28 s (DEV: 29.6 s for 25 lines, 66 s for 120). The
 * platform ends the request WITHOUT letting the handler run its catch, which leaves the document in `processing`; the browser got a gateway
 * page and said "We could not process this bank statement."
 *
 * These tests pin what the server does with the debris, and what the browser does with "no answer":
 *   - a document in `processing` that is LIVE is not started twice (409 in_progress), nothing is written;
 *   - a document in `processing` whose run is DEAD is cleaned up and read again; before this the PDF service refused every retry with
 *     "cannot process while the document is processing", and the CSV service re-ran on top of the partial rows;
 *   - the partial rows of a dead run are removed before the dedup index is read, so a fresh upload of the same file cannot lose them;
 *   - the browser asks again (bounded) on a gateway error / dropped connection / in-progress answer, and only a real refusal is final.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb> }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));

const download = vi.fn(async () => ({ ok: false as const, message: 'stop here: the run got past the state check' }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({ downloadDocumentObject: () => download() }));
vi.mock('@/lib/aie/adapters/shared/fallbackGate', () => ({ evaluateAiFallbackGate: () => ({ ok: false, reason: 'adapter_disabled' }) }));
vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: {
    getForUser: async (userId: string, id: string) => ({ data: (h.db.tables.fdh_statement_uploads ?? []).find((d) => d.id === id && d.user_id === userId) ?? null }),
  },
  documentAuditEventsRepository: { listForUser: async () => ({ data: [] }) },
  parserRegistryRepository: { getById: async () => ({ data: null }) },
  parserVersionsRepository: { listCertifiedForParser: async () => ({ data: [] }) },
  csvMappingTemplatesRepository: { getForUser: async () => ({ data: null }) },
  ingestionJobsRepository: { listForUser: async () => ({ data: [] }), update: async () => ({}) },
  reviewItemsRepository: { create: async () => ({}) },
}));

import { processBankPdfDocument, BankPdfProcessingError } from '@/lib/financial-data-hub/services/bankPdfProcessingService';
import { processBankCsvDocument, BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';
import { loadDedupIndexForAccount } from '@/lib/financial-data-hub/bank-csv/repository';
import { processingRunState, PROCESSING_RUN_DEAD_AFTER_MS, STATEMENT_STILL_BEING_READ_MESSAGE } from '@/lib/financial-data-hub/services/interruptedRun';
import {
  isResumableProcessAttempt,
  PROCESS_RESUME_MAX_ATTEMPTS,
  PROCESS_RESUME_WAIT_MS,
  PROCESS_TOO_LONG_MESSAGE,
} from '@/components/expenses/processResume';

h.db = createInMemoryDb();

const U = 'user-1';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const doc = (over: Row): Row => ({
  id: 'doc-1', user_id: U, file_hash: 'HASH-1', document_type: 'bank_statement', processing_status: 'processing', processing_started_at: ago(600_000),
  malware_scan_status: 'clean', error_code: null, raw_document_storage_reference: 'fdh/user-1/x.bin', mime_type: 'application/pdf', country_code: 'AU',
  currency_code: 'AUD', duplicate_of_document_id: null, certification_status: null, processing_completed_at: null, financial_account_id: 'acct-1',
  detection_status: 'detected', created_at: '2026-10-20T10:00:00Z', ...over,
});
const partialTx = (docId: string, n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${docId}-t${i}`, user_id: U, statement_upload_id: docId, financial_account_id: 'acct-1', economic_fingerprint: `${docId}-fp${i}`, source_reference: null, balance_after: 1, created_at: '2026-10-20T10:01:00Z' }));

beforeEach(() => {
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
  download.mockClear();
});

describe('F15 processingRunState', () => {
  it('is live inside the window, dead after it, dead when there is no start time, and not_processing for any other status', () => {
    const now = Date.now();
    expect(processingRunState({ processing_status: 'processing', processing_started_at: new Date(now - 5_000).toISOString() }, now)).toBe('live');
    expect(processingRunState({ processing_status: 'processing', processing_started_at: new Date(now - PROCESSING_RUN_DEAD_AFTER_MS - 1).toISOString() }, now)).toBe('dead');
    expect(processingRunState({ processing_status: 'processing', processing_started_at: null }, now)).toBe('dead');
    expect(processingRunState({ processing_status: 'queued', processing_started_at: null }, now)).toBe('not_processing');
    expect(processingRunState({ processing_status: 'approved', processing_started_at: ago(1) }, now)).toBe('not_processing');
  });

  it('the dead-run window is longer than a process request may live (the routes declare maxDuration = 60)', () => {
    expect(PROCESSING_RUN_DEAD_AFTER_MS).toBeGreaterThan(60_000);
  });
});

describe('F15 bank PDF: a retry after the platform killed the run', () => {
  it('LIVE run: refused with in_progress, nothing written, the file is not read again', async () => {
    h.db.reset({ fdh_statement_uploads: [doc({ processing_started_at: ago(5_000) })], fdh_transactions: partialTx('doc-1', 3) });
    const err = await processBankPdfDocument(U, 'doc-1').catch((e) => e);
    expect(err).toBeInstanceOf(BankPdfProcessingError);
    expect((err as BankPdfProcessingError).code).toBe('in_progress');
    expect((err as Error).message).toBe(STATEMENT_STILL_BEING_READ_MESSAGE);
    expect(download).not.toHaveBeenCalled();
    expect(h.db.tables.fdh_transactions).toHaveLength(3);
  });

  it('DEAD run: no longer the dead end "cannot process while the document is processing"; partial rows removed, the file is read again', async () => {
    h.db.reset({ fdh_statement_uploads: [doc({})], fdh_transactions: [...partialTx('doc-1', 3), ...partialTx('other-doc', 2)] });
    const err = await processBankPdfDocument(U, 'doc-1').catch((e) => e);
    expect(String((err as Error).message)).not.toMatch(/cannot process while the document is processing/);
    expect(download).toHaveBeenCalledTimes(1); // it got past the state check and started reading
    expect((h.db.tables.fdh_transactions ?? []).filter((t) => t.statement_upload_id === 'doc-1')).toHaveLength(0);
    expect((h.db.tables.fdh_transactions ?? []).filter((t) => t.statement_upload_id === 'other-doc')).toHaveLength(2); // another statement is never touched
  });
});

describe('F15 bank CSV: a retry after the platform killed the run', () => {
  it('LIVE run: refused with in_progress and nothing is written', async () => {
    h.db.reset({ fdh_statement_uploads: [doc({ mime_type: 'text/csv', processing_started_at: ago(3_000) })], fdh_transactions: partialTx('doc-1', 3) });
    const err = await processBankCsvDocument(U, 'doc-1').catch((e) => e);
    expect(err).toBeInstanceOf(BankCsvProcessingError);
    expect((err as BankCsvProcessingError).code).toBe('in_progress');
    expect(download).not.toHaveBeenCalled();
    expect(h.db.tables.fdh_transactions).toHaveLength(3);
  });

  it('DEAD run: the partial rows are removed and the file is read again from the top (not run on top of the debris)', async () => {
    h.db.reset({ fdh_statement_uploads: [doc({ mime_type: 'text/csv' })], fdh_transactions: [...partialTx('doc-1', 500), ...partialTx('other-doc', 2)] });
    await processBankCsvDocument(U, 'doc-1').catch(() => undefined);
    expect(download).toHaveBeenCalledTimes(1);
    expect((h.db.tables.fdh_transactions ?? []).filter((t) => t.statement_upload_id === 'doc-1')).toHaveLength(0);
    expect((h.db.tables.fdh_transactions ?? []).filter((t) => t.statement_upload_id === 'other-doc')).toHaveLength(2);
  });
});

describe('F15 a fresh upload of the same file after a dead run loses nothing', () => {
  it('the dedup index no longer contains the dead run\'s partial rows, but keeps live runs and finished statements', async () => {
    h.db.reset({
      fdh_statement_uploads: [
        doc({ id: 'dead', processing_started_at: ago(600_000) }),
        doc({ id: 'live', processing_started_at: ago(5_000) }),
        doc({ id: 'done', processing_status: 'approved', processing_started_at: ago(900_000), certification_status: 'certified', processing_completed_at: ago(800_000) }),
      ],
      fdh_transactions: [...partialTx('dead', 4), ...partialTx('live', 2), ...partialTx('done', 3)],
    });
    const index = await loadDedupIndexForAccount(U, 'acct-1');
    const fps = Array.from(index.keys());
    expect(fps.filter((f) => f.startsWith('dead-'))).toHaveLength(0);
    expect(fps.filter((f) => f.startsWith('live-'))).toHaveLength(2);
    expect(fps.filter((f) => f.startsWith('done-'))).toHaveLength(3);
  });
});

describe('F15 what the browser does with "no answer"', () => {
  const attempt = (status: number, json: Record<string, unknown> | null, ok = false) => ({ ok, status, json });

  it('asks again on: gateway errors, a dropped connection, a 5xx without JSON, and the server\'s own "still being read"', () => {
    expect(isResumableProcessAttempt(attempt(504, null))).toBe(true);
    expect(isResumableProcessAttempt(attempt(502, {}))).toBe(true);
    expect(isResumableProcessAttempt(attempt(503, {}))).toBe(true);
    expect(isResumableProcessAttempt(attempt(0, {}))).toBe(true);
    expect(isResumableProcessAttempt(attempt(500, {}))).toBe(true);
    expect(isResumableProcessAttempt(attempt(409, { error: 'statement_in_progress', message: STATEMENT_STILL_BEING_READ_MESSAGE }))).toBe(true);
  });

  it('does NOT ask again on a real refusal: our own 500 with a code, 400/403/404/422/429, a different 409, or success', () => {
    expect(isResumableProcessAttempt(attempt(500, { error: 'process_failed', message: 'We could not process this bank statement.' }))).toBe(false);
    for (const s of [400, 403, 404, 422, 429]) expect(isResumableProcessAttempt(attempt(s, { error: 'x' }))).toBe(false);
    expect(isResumableProcessAttempt(attempt(409, { error: 'account_owner_conflict' }))).toBe(false);
    expect(isResumableProcessAttempt(attempt(200, { data: {} }, true))).toBe(false);
  });

  it('is bounded, and its closing message names what happened and what to do', () => {
    expect(PROCESS_RESUME_MAX_ATTEMPTS * PROCESS_RESUME_WAIT_MS).toBeGreaterThan(PROCESSING_RUN_DEAD_AFTER_MS); // covers one restart of a dead run
    expect(PROCESS_RESUME_MAX_ATTEMPTS * PROCESS_RESUME_WAIT_MS).toBeLessThan(5 * 60_000);
    expect(PROCESS_TOO_LONG_MESSAGE).toMatch(/Nothing was lost/);
    expect(PROCESS_TOO_LONG_MESSAGE).toMatch(/CSV/);
  });
});

describe('F15 the process routes answer with a stable code (real route handlers)', () => {
  it('an unexpected failure is a 500 with error=process_failed and the plain sentence in message; the in-progress answer is a 409', async () => {
    vi.resetModules();
    vi.doMock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), requireCountryConfirmedUser: async () => ({ user: { id: U }, unauthenticated: null }) }));
    vi.doMock('@/lib/entitlements/financialDataImport', () => ({ refuseUnlessImportRunMayStart: async () => null }));
    vi.doMock('@/lib/financial-data-hub/services/importRunPosition', () => ({ fdhDocumentRunPosition: async () => 'queued' }));
    vi.doMock('@/lib/financial-data-hub/constants/featureFlags', async (o) => ({ ...(await o<typeof import('@/lib/financial-data-hub/constants/featureFlags')>()), isFdhDocumentUploadEnabled: () => true }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const kind of ['bank-csv', 'bank-pdf'] as const) {
      // WP-G: the process routes ADMIT the statement (bankImportAdmission) instead of reading it; the stable-code contract is unchanged.
      let mode: 'boom' | 'busy' = 'boom';
      vi.doMock('@/lib/financial-data-hub/services/bankImportAdmission', () => ({
        admitBankImport: async () => {
          if (mode === 'busy') return { kind: 'error', status: 409, code: 'statement_in_progress', message: STATEMENT_STILL_BEING_READ_MESSAGE };
          throw new Error('relation "x" does not exist');
        },
      }));
      const { POST } = kind === 'bank-csv'
        ? await import('@/app/api/financial-data-hub/bank-csv/[documentId]/process/route')
        : await import('@/app/api/financial-data-hub/bank-pdf/[documentId]/process/route');
      const call = () => POST(new Request('http://x.test/p', { method: 'POST' }), { params: Promise.resolve({ documentId: '12345678-aaaa-bbbb-cccc-1234567890ab' }) });
      let res = await call();
      let body = await res.json();
      expect(res.status).toBe(500);
      expect(body).toEqual({ error: 'process_failed', message: 'We could not process this bank statement.' });
      expect(spy).toHaveBeenCalled(); // the failing stage is now in the server log
      mode = 'busy';
      res = await call();
      body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toBe('statement_in_progress');
      vi.resetModules();
    }
    spy.mockRestore();
  });
});
