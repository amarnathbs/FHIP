// Document2 (4) WP-H2 -- the process route at the malware gate: a missing / wrong password is the ordinary password step (nothing deleted),
// every refusal has its own honest status, code and wording, and the password reaches only the gate.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>,
  gate: null as unknown,
  gateCalls: [] as { id: string; password?: string }[],
  processCalls: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => ({ user: { id: 'user-1', email: null }, unauthenticated: null }),
}));
vi.mock('@/lib/entitlements/financialDataImport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/financialDataImport')>()),
  refuseUnlessImportRunMayStart: async () => null,
}));
vi.mock('@/lib/services/investment-intelligence/importRunPosition', () => ({ iiSourceDocumentRunPosition: async () => ({}) }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: () => undefined }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({
  processSourceDocument: async (input: Record<string, unknown>) => {
    h.processCalls.push(input);
    return { ok: true, status: 'parsed', parseRunId: 'run1', error: null };
  },
  openReconciliationCase: vi.fn(),
}));
vi.mock('@/lib/services/investment-intelligence/reconciliationCases', () => ({
  openReconciliationCase: async (_u: string, input: Record<string, unknown>) => {
    h.db.tables.ii_reconciliation_cases.push({ id: `case${h.db.tables.ii_reconciliation_cases.length + 1}`, discrepancy_type: input.discrepancyType, status: 'open', source_document_id: input.sourceDocumentId, details: input.details });
    return 'case';
  },
}));
vi.mock('@/lib/services/investment-intelligence/realScanAdmission', () => ({
  ensureIiRealScanAdmissible: async (_u: string, id: string, opts: { password?: string } = {}) => {
    h.gateCalls.push({ id, password: opts.password });
    return h.gate;
  },
}));

import { POST } from '@/app/api/investment-intelligence/source-documents/[id]/process/route';

const params = { params: Promise.resolve({ id: 'doc1' }) };
const post = (body: Record<string, unknown>) => new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const doc = (over: Row = {}): Row => ({ id: 'doc1', user_id: 'user-1', status: 'uploaded', storage_path: 'user-1/a.pdf', storage_purged_at: null, ...over });

beforeEach(() => {
  h.db = createInMemoryDb();
  h.db.reset({ ii_source_documents: [doc()], ii_audit_events: [], ii_reconciliation_cases: [] });
  h.gateCalls.length = 0;
  h.processCalls.length = 0;
});

describe('process route at the malware gate', () => {
  it.each([
    ['password_required', /password protected/i],
    ['wrong_password', /did not open the statement/i],
  ])('%s -> 200 with the ordinary password state: document flips to password_required, one blocking case, NOTHING deleted, the parser is never reached', async (reason, wording) => {
    h.gate = { admitted: false, reason };
    const res = await POST(post({ password: reason === 'wrong_password' ? 'wrong-pw-for-test' : undefined }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ ok: false, status: 'password_required', parseRunId: null });
    expect(body.data.error).toMatch(wording);
    expect(h.db.tables.ii_source_documents[0]).toMatchObject({ status: 'password_required', storage_path: 'user-1/a.pdf', storage_purged_at: null });
    expect(h.db.tables.ii_reconciliation_cases).toHaveLength(1);
    expect(h.db.tables.ii_reconciliation_cases[0]).toMatchObject({ discrepancy_type: 'document_password_required', status: 'open' });
    expect(h.processCalls).toEqual([]);
    expect(JSON.stringify([body, h.db.writes, h.db.tables.ii_audit_events])).not.toContain('wrong-pw-for-test');
  });

  it('a statement that was already read successfully keeps its status when a password attempt fails', async () => {
    h.db.tables.ii_source_documents[0].status = 'parsed';
    h.gate = { admitted: false, reason: 'wrong_password' };
    await POST(post({ password: 'x-wrong' }), params);
    expect(h.db.tables.ii_source_documents[0].status).toBe('parsed');
  });

  it.each([
    [{ admitted: false, reason: 'blocked', status: 'malicious', code: 'threats_found' }, 422, 'malware_scan_blocked', /could not be cleared by our security scan.*deleted/],
    [{ admitted: false, reason: 'blocked', status: 'suspicious', code: 'unsupported' }, 422, 'malware_scan_unsupported', /cannot check this kind of file.*enter its password/],
    [{ admitted: false, reason: 'scanner_unavailable', code: 'scan_timeout' }, 503, 'malware_scan_incomplete', /not a finding about your file.*has not been deleted/],
    [{ admitted: false, reason: 'scanner_unavailable', code: 'scanner_not_configured' }, 503, 'malware_scan_unavailable', /temporarily unavailable/],
    [{ admitted: false, reason: 'pending' }, 409, 'malware_scan_pending', /still being scanned.*nothing was deleted/i],
    [{ admitted: false, reason: 'unreadable_protection' }, 422, 'unreadable_protection', /protection we cannot open.*Nothing was deleted/],
    [{ admitted: false, reason: 'password_rate_limited' }, 429, 'password_rate_limited', /Too many password attempts/],
    [{ admitted: false, reason: 'not_found' }, 404, undefined, /not found/i],
  ])('%j -> %s %s', async (gate, status, code, wording) => {
    h.gate = gate;
    const res = await POST(post({}), params);
    expect(res.status).toBe(status);
    const body = await res.json();
    if (code) expect(body.error).toBe(code);
    expect(String(body.message ?? body.error)).toMatch(wording);
    expect(h.processCalls).toEqual([]);
    expect(h.db.tables.ii_source_documents[0].storage_path).toBe('user-1/a.pdf'); // the route itself never deletes anything
  });

  it('admitted: the password goes to the gate and then to the parser, and is not echoed back', async () => {
    h.gate = { admitted: true };
    const res = await POST(post({ password: 'pw-for-gate-test' }), params);
    expect(h.gateCalls).toEqual([{ id: 'doc1', password: 'pw-for-gate-test' }]);
    expect(h.processCalls[0]).toMatchObject({ userId: 'user-1', sourceDocumentId: 'doc1', password: 'pw-for-gate-test' });
    expect(JSON.stringify(await res.json())).not.toContain('pw-for-gate-test');
  });
});
