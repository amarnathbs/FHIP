/**
 * Payslip re-uploads and waiting proposals (production, 2026-09-25).
 *
 * A pilot re-uploaded an already-imported payslip: it paid for a second AI
 * read, was then (correctly) recognised as a duplicate, and dead-ended with
 * "No payroll evidence has been extracted from this document yet." -- and the
 * ORIGINAL payslip's ready proposal could not be reached, because nothing on
 * screen listed waiting proposals. These tests pin the three fixes:
 *   1. a byte-identical re-upload short-circuits to the original's payroll
 *      event before any download, parse or AI call;
 *   2. the proposal step answers a copy with 409 + the original upload;
 *   3. the waiting-proposal list carries the source upload and a summary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- a tiny in-memory Supabase: eq / neq / in / order / limit / maybeSingle / update ----
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const adminUpdates: Array<{ table: string; patch: Row }> = [];

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let orderBy: { col: string; asc: boolean } | null = null;
  let limitN: number | null = null;
  let patch: Row | null = null;
  const run = () => {
    let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (orderBy) {
      const { col, asc } = orderBy;
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (limitN !== null) rows = rows.slice(0, limitN);
    if (patch) { adminUpdates.push({ table, patch }); for (const r of rows) Object.assign(r, patch); }
    return rows;
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (p: Row) => { patch = p; return chain; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
    neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return chain; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return chain; },
    order: (col: string, o?: { ascending?: boolean }) => { orderBy = { col, asc: o?.ascending !== false }; return chain; },
    limit: (n: number) => { limitN = n; return chain; },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    single: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
  };
  return chain;
}
const fakeClient = { from: (t: string) => query(t) };

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeClient }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient }));

const downloadDocumentObject = vi.fn();
vi.mock('@/lib/financial-data-hub/services/storage', () => ({ downloadDocumentObject: (...a: unknown[]) => downloadDocumentObject(...a) }));
const extractPdfPages = vi.fn();
vi.mock('@/lib/financial-data-hub/bank-pdf/textExtraction', () => ({ extractPdfPages: (...a: unknown[]) => extractPdfPages(...a) }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: { getForUser: async (_u: string, id: string) => ({ data: (db.fdh_statement_uploads ?? []).find((d) => d.id === id) ?? null }) },
  documentAuditEventsRepository: { listForUser: async () => ({ data: [] }) },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => ({ user: { id: 'u1' }, unauthenticated: null }),
}));

import { processPayslipDocument, findEarlierIdenticalPayslip } from '@/lib/financial-data-hub/services/payslipProcessingService';
import { listReadyIncomeProposalsWithSource } from '@/lib/import-bridge/incomeProposalService';
import { POST as proposalPOST } from '@/app/api/financial-data-hub/payslip/[documentId]/proposal/route';

const upload = (over: Row): Row => ({
  user_id: 'u1', document_type: 'payslip', file_hash: 'HASH-A', processing_status: 'extracted',
  malware_scan_status: 'clean', error_code: null, raw_document_storage_reference: 'fdh/u1/x.bin', country_code: 'AU', ...over,
});

beforeEach(() => {
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
  downloadDocumentObject.mockReset();
  extractPdfPages.mockReset();
  adminUpdates.length = 0;
  db.fdh_statement_uploads = [
    upload({ id: 'doc-orig', created_at: '2026-09-25T13:19:06Z' }),
    upload({ id: 'doc-copy', created_at: '2026-09-25T13:34:31Z', processing_status: 'queued' }),
    upload({ id: 'doc-other-user', user_id: 'u2', created_at: '2026-09-25T13:40:00Z', processing_status: 'queued' }),
    upload({ id: 'doc-different', file_hash: 'HASH-B', created_at: '2026-09-25T13:41:00Z', processing_status: 'queued' }),
  ];
  db.fdh_payroll_events = [{ id: 'ev-orig', user_id: 'u1', statement_upload_id: 'doc-orig', employer_name: 'Quillfeather Studio Pty Ltd', gross_pay: 3200, net_pay: 2488, pay_frequency: 'fortnightly', payment_date: '2026-08-15', currency_code: 'AUD' }];
  db.fhip_import_proposals = [{ id: 'prop-1', user_id: 'u1', target_domain: 'income', status: 'ready', source_payroll_event_id: 'ev-orig', recommended_apply_mode: 'add_new', generated_at: '2026-09-25T13:33:59Z' }];
});

describe('a byte-identical re-upload goes straight to the original', () => {
  it('finds the original upload and its payroll event', async () => {
    expect(await findEarlierIdenticalPayslip('u1', 'doc-copy')).toEqual({ documentId: 'doc-orig', payrollEventId: 'ev-orig' });
  });

  it('processing the copy never downloads, parses or reaches the AI -- and reports the duplicate', async () => {
    const r = await processPayslipDocument('u1', 'doc-copy');
    expect(r.pipelineStatus).toBe('duplicate_payslip');
    expect(r.payrollEventId).toBe('ev-orig');
    expect(downloadDocumentObject).not.toHaveBeenCalled();
    expect(extractPdfPages).not.toHaveBeenCalled();
    expect(adminUpdates.some((u) => u.patch.processing_status === 'extracted')).toBe(true);
  });

  it('never matches across users, different bytes, or an original with no payroll event', async () => {
    expect(await findEarlierIdenticalPayslip('u2', 'doc-other-user')).toBeNull();
    expect(await findEarlierIdenticalPayslip('u1', 'doc-different')).toBeNull();
    db.fdh_payroll_events = [];
    expect(await findEarlierIdenticalPayslip('u1', 'doc-copy')).toBeNull();
  });

  it('with several earlier copies, the ORIGINAL (oldest with evidence) wins', async () => {
    db.fdh_statement_uploads!.push(upload({ id: 'doc-older', created_at: '2026-09-25T13:00:00Z' }));
    db.fdh_payroll_events!.push({ id: 'ev-older', user_id: 'u1', statement_upload_id: 'doc-older' });
    expect(await findEarlierIdenticalPayslip('u1', 'doc-copy')).toEqual({ documentId: 'doc-older', payrollEventId: 'ev-older' });
  });
});

describe('the proposal step answers a copy with the original, not a dead end', () => {
  it('409 duplicate_payslip + duplicate_of_document_id for a copy with no evidence of its own', async () => {
    const res = await proposalPOST(new Request('http://x'), { params: Promise.resolve({ documentId: 'doc-copy' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'duplicate_payslip', duplicate_of_document_id: 'doc-orig' });
  });

  it('a genuinely unprocessed document still gets the plain 404', async () => {
    const res = await proposalPOST(new Request('http://x'), { params: Promise.resolve({ documentId: 'doc-different' }) });
    expect(res.status).toBe(404);
  });
});

describe('waiting proposals carry their source upload and a summary', () => {
  it('lists the ready proposal with the upload to resume and the payslip figures', async () => {
    const list = await listReadyIncomeProposalsWithSource('u1');
    expect(list).toEqual([
      expect.objectContaining({
        id: 'prop-1', proposal_id: 'prop-1', document_id: 'doc-orig', employer_name: 'Quillfeather Studio Pty Ltd',
        gross_pay: 3200, pay_frequency: 'fortnightly', payment_date: '2026-08-15', currency_code: 'AUD',
      }),
    ]);
  });

  it('a decided (not ready) proposal is not offered again', async () => {
    db.fhip_import_proposals![0].status = 'applied';
    expect(await listReadyIncomeProposalsWithSource('u1')).toEqual([]);
  });
});
