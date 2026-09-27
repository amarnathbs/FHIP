/**
 * Canonical-cert UI journey (DEV, 2026-09-27): a payslip upload that the upload step REJECTED (garbage
 * bytes -> `failed` / `file_corrupt`, nothing stored) was then sent to /process by the Income panel.
 * `failed` is retryable, so processing re-queued it, found no stored file, and overwrote the truthful
 * `file_corrupt` with `internal_error` ("missing storage reference"); the user saw "Something went wrong"
 * instead of "This file appears to be corrupted or unreadable."
 *
 * Rule: a `failed` document with NO stored bytes is a rejected upload, not a retryable attempt. Processing
 * refuses it (invalid_state, with the rejection's own words) and leaves the document untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/financial-data-hub/bank-pdf/textExtraction', () => ({ extractPdfPages: vi.fn() }));

const downloadDocumentObject = vi.fn();
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: (...args: unknown[]) => downloadDocumentObject(...args),
}));

let ownedDocument: Record<string, unknown> | null = null;
vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: { getForUser: async () => ({ data: ownedDocument }) },
  documentAuditEventsRepository: { listForUser: async () => ({ data: [] }) },
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));

const adminUpdates: Array<Record<string, unknown>> = [];
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        update: (patch: Record<string, unknown>) => { adminUpdates.push(patch); return chain; },
        eq: self, select: self, in: self, delete: self, order: self, limit: self,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (r: (v: unknown) => void) => r({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, neq: self, in: self, is: self, delete: self, order: self, limit: self,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (r: (v: unknown) => void) => r({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));

import { processPayslipDocument, PayslipProcessingError, PAYSLIP_FAILURE_MESSAGES } from '@/lib/financial-data-hub/services/payslipProcessingService';

const rejected = {
  id: 'doc-rejected', user_id: 'u1', document_type: 'payslip', processing_status: 'failed',
  error_code: 'file_corrupt', malware_scan_status: 'not_required', raw_document_storage_reference: null, country_code: 'AU',
};

beforeEach(() => {
  downloadDocumentObject.mockReset();
  adminUpdates.length = 0;
  ownedDocument = null;
});

describe('a rejected payslip upload is never re-processed', () => {
  it('[NC] refuses with the rejection\'s own words and leaves file_corrupt in place (was: internal_error "missing storage reference")', async () => {
    ownedDocument = rejected;
    const err = await processPayslipDocument('u1', 'doc-rejected').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PayslipProcessingError);
    expect((err as PayslipProcessingError).code).toBe('invalid_state');
    expect((err as PayslipProcessingError).message).toBe(PAYSLIP_FAILURE_MESSAGES.file_corrupt);
    expect(adminUpdates, 'the document is not re-queued, re-processed or re-labelled').toEqual([]);
    expect(downloadDocumentObject).not.toHaveBeenCalled();
  });

  it('control: a failed attempt WITH stored bytes (e.g. a password was missing) is still retried and reaches the download', async () => {
    ownedDocument = { ...rejected, error_code: 'password_required', raw_document_storage_reference: 'fdh/u1/doc/x.pdf' };
    downloadDocumentObject.mockResolvedValue({ ok: false, message: 'stop here' });
    await processPayslipDocument('u1', 'doc-rejected').catch(() => undefined);
    expect(downloadDocumentObject).toHaveBeenCalledTimes(1);
  });

  it('[NC] the Income panel stops when the upload step already failed, instead of calling /process', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'components/income/PayslipImportPanel.tsx'), 'utf8');
    const complete = src.indexOf('const docId = completeJson.data.document_id');
    const process_ = src.indexOf('/api/financial-data-hub/payslip/${docId}/process');
    const guard = src.indexOf("completeJson.data.processing_status === 'failed'");
    expect(guard, 'a check of the upload step\'s own failed status').toBeGreaterThan(complete);
    expect(guard, 'made before /process is called').toBeLessThan(process_);
  });
});
