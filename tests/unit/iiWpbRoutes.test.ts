// Document2 (4) WP-B -- route-level behaviour of the new / changed endpoints, against an in-memory database:
//   replacement upload (Premium gate order, validation, hand-off), close-stale (single and bulk: confirm required, cross-tenant 404,
//   non-stale 409), re-evaluate all, review sync, the Review list carrying the live lifecycle, and the statements list / summary
//   exposing `has_stored_file` without leaking the storage path.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>,
  userId: 'user-1',
  denyImport: false,
  replaceCalls: [] as unknown[],
  recertified: [] as string[],
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => ({ user: { id: h.userId, email: null }, unauthenticated: null }),
}));
vi.mock('@/lib/entitlements/financialDataImport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/financialDataImport')>()),
  refuseUnlessFinancialImportAllowed: async () => (h.denyImport ? Response.json({ error: 'premium_required' }, { status: 403 }) : null),
}));
// Document2 (4) WP-J: re-evaluate is admitted as a job. These in-memory tests have no job tables, which is the documented fallback to the
// earlier one-request behaviour; the job path is covered by the PGlite suite.
vi.mock('@/lib/services/investment-intelligence/statementJob/admission', async () => {
  const store = await import('@/lib/services/investment-intelligence/statementJob/store');
  return {
    admitStatementJob: async () => {
      throw new store.StatementJobsUnavailableError();
    },
  };
});
vi.mock('@/lib/services/investment-intelligence/sourceDocumentReplacement', () => ({
  replaceSourceDocumentFile: async (input: unknown) => {
    h.replaceCalls.push(input);
    return { ok: true, sourceDocumentId: (input as { sourceDocumentId: string }).sourceDocumentId, status: 'parsed', checksumChanged: true, previousFilename: 'old.pdf', scanPending: false };
  },
}));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({
  recertifyPosition: async (_u: string, a: string, i: string) => {
    h.recertified.push(`${a}:${i}`);
    return { ok: true, error: null };
  },
  processSourceDocument: vi.fn(),
  openReconciliationCase: vi.fn(),
}));

import { POST as replacementPOST } from '@/app/api/investment-intelligence/source-documents/[id]/replacement/route';
import { POST as closeOnePOST } from '@/app/api/investment-intelligence/reconciliation-cases/[id]/close-stale/route';
import { POST as closeBulkPOST } from '@/app/api/investment-intelligence/reconciliation-cases/close-stale/route';
import { POST as reevaluatePOST } from '@/app/api/investment-intelligence/source-documents/[id]/reevaluate/route';
import { POST as syncPOST } from '@/app/api/investment-intelligence/review/sync/route';
import { GET as reviewGET } from '@/app/api/investment-intelligence/review/route';
import { GET as listGET } from '@/app/api/investment-intelligence/source-documents/route';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';

function seed(t: Record<string, Row[]> = {}) {
  h.db.reset({
    ii_source_documents: [],
    ii_reconciliation_cases: [],
    ii_holding_snapshots: [],
    ii_transactions: [],
    ii_accounts: [],
    ii_ownership_allocation: [],
    ii_audit_events: [],
    ii_review_items: [],
    ii_portfolio_truth_status: [],
    ii_fhip_publications: [],
    ...t,
  });
  h.replaceCalls.length = 0;
  h.recertified.length = 0;
}

const staleDoc: Row = { id: 'doc1', user_id: 'user-1', status: 'password_required', storage_path: 'user-1/a.pdf', storage_purged_at: '2026-10-02T00:00:00Z', original_filename: 'a.pdf', uploaded_at: '2026-10-01T00:00:00Z', checksum: 'c', document_type: 'cas_statement', country_code: 'IN' };
const staleCase = (id: string, over: Row = {}): Row => ({ id, user_id: 'user-1', subject_type: 'account', subject_id: 'doc1', discrepancy_type: 'document_password_required', severity: 'blocking', status: 'open', source_document_id: 'doc1', discrepancy_details: {}, opened_at: '2026-10-01T00:00:00Z', ...over });

const post = (body: unknown) => new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  h.db = createInMemoryDb();
  h.userId = 'user-1';
  h.denyImport = false;
  seed();
});

describe('replacement route', () => {
  const upload = (name = 'new.pdf') => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([37, 80, 68, 70])], name, { type: 'application/pdf' }));
    return new Request('http://t/x', { method: 'POST', body: form });
  };

  it('hands the file to the replacement service for THIS user and this statement', async () => {
    const res = await replacementPOST(upload(), params({ id: 'doc1' }));
    expect(res.status).toBe(200);
    expect(h.replaceCalls).toHaveLength(1);
    expect(h.replaceCalls[0]).toMatchObject({ userId: 'user-1', sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf' });
    expect((await res.json()).data).toMatchObject({ sourceDocumentId: 'doc1', checksumChanged: true });
  });

  it('is Premium-gated BEFORE the body is read: a refused user reaches neither the service nor storage', async () => {
    h.denyImport = true;
    const res = await replacementPOST(upload(), params({ id: 'doc1' }));
    expect(res.status).toBe(403);
    expect(h.replaceCalls).toEqual([]);
  });

  it('answers 422 with a plain message when no file was sent', async () => {
    const res = await replacementPOST(new Request('http://t/x', { method: 'POST', body: new FormData() }), params({ id: 'doc1' }));
    expect(res.status).toBe(422);
    expect(h.replaceCalls).toEqual([]);
  });
});

describe('close-stale routes', () => {
  it('single: requires an explicit confirmation', async () => {
    seed({ ii_source_documents: [staleDoc], ii_reconciliation_cases: [staleCase(C1)] });
    const res = await closeOnePOST(post({}), params({ id: C1 }));
    expect(res.status).toBe(422);
    expect(h.db.tables.ii_reconciliation_cases[0].status).toBe('open');
  });

  it('single: closes a stale case, keeps it as history, archives the empty statement', async () => {
    seed({ ii_source_documents: [staleDoc], ii_reconciliation_cases: [staleCase(C1)] });
    const res = await closeOnePOST(post({ confirm: true }), params({ id: C1 }));
    expect(res.status).toBe(200);
    expect(h.db.tables.ii_reconciliation_cases[0]).toMatchObject({ status: 'resolved', resolution_method: 'user_closed_stale_case' });
    expect(h.db.tables.ii_source_documents[0].status).toBe('archived');
    expect((await res.json()).data.closedCaseIds).toEqual([C1]);
  });

  it("single: another user's case is a non-enumerating 404 and is untouched (cross-tenant)", async () => {
    seed({ ii_source_documents: [{ ...staleDoc, user_id: 'user-2' }], ii_reconciliation_cases: [staleCase(C1, { user_id: 'user-2' })] });
    const res = await closeOnePOST(post({ confirm: true }), params({ id: C1 }));
    expect(res.status).toBe(404);
    expect(h.db.tables.ii_reconciliation_cases[0].status).toBe('open');
  });

  it('single: a case that can still be resolved directly is 409, not closed', async () => {
    seed({ ii_source_documents: [{ ...staleDoc, status: 'parsed' }], ii_reconciliation_cases: [staleCase(C1, { discrepancy_type: 'owner_unmatched' })] });
    const res = await closeOnePOST(post({ confirm: true }), params({ id: C1 }));
    expect(res.status).toBe(409);
    expect(h.db.tables.ii_reconciliation_cases[0].status).toBe('open');
  });

  it('bulk: requires confirmation, then closes only the stale ones', async () => {
    seed({
      ii_source_documents: [staleDoc, { ...staleDoc, id: 'doc2', status: 'parsed' }],
      ii_holding_snapshots: [{ id: 's', user_id: 'user-1', source_document_id: 'doc2', account_id: 'a1', instrument_id: 'i1' }],
      ii_reconciliation_cases: [staleCase(C1), staleCase(C2, { subject_id: 'a1', discrepancy_type: 'owner_unmatched', source_document_id: 'doc2' }), staleCase(C3, { subject_id: 'a1', discrepancy_type: 'value_mismatch', source_document_id: 'doc2' })],
    });
    expect((await closeBulkPOST(post({}))).status).toBe(422);
    const res = await closeBulkPOST(post({ confirm: true }));
    const data = (await res.json()).data;
    expect(data.closedCaseIds.sort()).toEqual([C1, C3].sort());
    expect(h.db.tables.ii_reconciliation_cases.find((c) => c.id === C2)?.status).toBe('open'); // the owner question is untouched
    expect(h.recertified).toEqual(['a1:i1']); // the statement that has data had its position re-evaluated from retained data
  });
});

describe('re-evaluate all (works from retained data, never the raw file)', () => {
  it('re-evaluates each distinct position of the statement', async () => {
    seed({
      ii_source_documents: [{ ...staleDoc, status: 'parsed' }],
      ii_holding_snapshots: [
        { id: 's1', user_id: 'user-1', source_document_id: 'doc1', account_id: 'a1', instrument_id: 'i1' },
        { id: 's2', user_id: 'user-1', source_document_id: 'doc1', account_id: 'a1', instrument_id: 'i1' },
        { id: 's3', user_id: 'user-1', source_document_id: 'doc1', account_id: 'a2', instrument_id: 'i2' },
      ],
    });
    const res = await reevaluatePOST(post({}), params({ id: 'doc1' }));
    expect((await res.json()).data).toMatchObject({ evaluated: 2, failed: 0 });
    expect(h.recertified.sort()).toEqual(['a1:i1', 'a2:i2']);
  });

  it("is 404 for another user's statement and re-evaluates nothing", async () => {
    seed({ ii_source_documents: [{ ...staleDoc, user_id: 'user-2' }], ii_holding_snapshots: [{ id: 's1', user_id: 'user-2', source_document_id: 'doc1', account_id: 'a1', instrument_id: 'i1' }] });
    const res = await reevaluatePOST(post({}), params({ id: 'doc1' }));
    expect(res.status).toBe(404);
    expect(h.recertified).toEqual([]);
  });

  it('a statement with no positions says so instead of claiming success', async () => {
    seed({ ii_source_documents: [staleDoc] });
    const res = await reevaluatePOST(post({}), params({ id: 'doc1' }));
    const d = (await res.json()).data;
    expect(d.evaluated).toBe(0);
    expect(d.message).toMatch(/nothing to re-evaluate/);
  });
});

describe('review sync and the Review list', () => {
  it('sync resolves the item of a case that is no longer open', async () => {
    seed({
      ii_reconciliation_cases: [staleCase(C1, { status: 'resolved' })],
      ii_review_items: [{ id: 'r1', user_id: 'user-1', rule_key: 'reconciliation_open', status: 'open', evidence: { caseId: C1 } }],
    });
    const res = await syncPOST();
    expect((await res.json()).data.resolvedItems).toBe(1);
    expect(h.db.tables.ii_review_items[0].status).toBe('resolved');
  });

  it('the Review list returns each reconciliation item with its live lifecycle (file deleted -> replacement first, stale-closable)', async () => {
    seed({
      ii_source_documents: [staleDoc],
      ii_reconciliation_cases: [staleCase(C1)],
      ii_review_items: [{ id: 'r1', user_id: 'user-1', rule_key: 'reconciliation_open', status: 'open', evidence: { caseId: C1, discrepancyType: 'document_password_required' }, created_at: '2026-10-01T00:00:00Z' }],
    });
    const res = await reviewGET(new Request('http://t/api/investment-intelligence/review?status=open'));
    const [item] = (await res.json()).data.items;
    expect(item.lifecycle).toMatchObject({ primary: 'upload_replacement', staleClosable: true, fileStored: false });
  });
});

describe('statements list exposes has_stored_file without leaking the storage path', () => {
  it('false for a deleted file, true for a stored one; no storage_path / purge columns in the payload', async () => {
    seed({ ii_source_documents: [staleDoc, { ...staleDoc, id: 'doc2', storage_purged_at: null, uploaded_at: '2026-10-03T00:00:00Z' }] });
    const res = await listGET();
    const docs = (await res.json()).data as Row[];
    expect(docs.find((d) => d.id === 'doc1')?.has_stored_file).toBe(false);
    expect(docs.find((d) => d.id === 'doc2')?.has_stored_file).toBe(true);
    for (const d of docs) {
      expect('storage_path' in d).toBe(false);
      expect('storage_purged_at' in d).toBe(false);
    }
  });
});
