/**
 * Document2 (4) WP-J -- the statement job ROUTES, with two users and the contract a browser relies on (UNIT-TESTED, in-memory database):
 *   - list / read: only the caller's own jobs; another user's job is indistinguishable from a missing one (404, non-enumerating); no lease
 *     token, no checkpoint, no password in any answer,
 *   - advance: 401 signed out, 404 for another user's job WITHOUT calling the worker, the password from the body reaches the worker and
 *     nothing else, busy and advanced are reported,
 *   - backstop: refused without the shared secret, runs with it,
 *   - process admission: 202 with the job (resumed or new), the Idempotency-Key is forwarded when valid and dropped when not, the
 *     password goes to the malware gate and to admission and is in no answer, an immediate answer stays 200, rate limit 429, a missing
 *     job table falls back to the earlier one-request behaviour,
 *   - re-evaluate: 404 for another user's statement, 202 with a job, the fallback where the tables are absent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>,
  userId: 'user-1' as string | null,
  gate: { admitted: true } as unknown,
  gateCalls: [] as Array<{ id: string; password?: string }>,
  advanceCalls: [] as Array<{ jobId: string; opts: Record<string, unknown> }>,
  advanceOutcome: null as unknown,
  admitCalls: [] as Array<Record<string, unknown>>,
  admitResult: null as unknown,
  admitThrows: null as unknown,
  processCalls: [] as Array<Record<string, unknown>>,
  recertified: [] as string[],
  nextCalls: 0,
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () =>
    h.userId
      ? { user: { id: h.userId, email: null }, unauthenticated: null }
      : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));
vi.mock('@/lib/entitlements/financialDataImport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/financialDataImport')>()),
  refuseUnlessImportRunMayStart: async () => null,
}));
vi.mock('@/lib/services/investment-intelligence/importRunPosition', () => ({ iiSourceDocumentRunPosition: async () => ({}) }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: () => undefined }));
vi.mock('@/lib/services/investment-intelligence/realScanAdmission', () => ({
  ensureIiRealScanAdmissible: async (_u: string, id: string, opts: { password?: string } = {}) => {
    h.gateCalls.push({ id, password: opts.password });
    return h.gate;
  },
}));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({
  processSourceDocument: async (input: Record<string, unknown>) => {
    h.processCalls.push(input);
    return { ok: true, status: 'parsed', parseRunId: 'run1', summary: { transactionsFound: 1 }, error: null };
  },
  recertifyPosition: async (_u: string, a: string, i: string) => {
    h.recertified.push(`${a}:${i}`);
    return { ok: true, error: null };
  },
  openReconciliationCase: vi.fn(),
}));
vi.mock('@/lib/services/investment-intelligence/statementJob/admission', async () => {
  return {
    admitStatementJob: async (p: Record<string, unknown>) => {
      h.admitCalls.push(p);
      if (h.admitThrows) throw h.admitThrows;
      return h.admitResult;
    },
  };
});
vi.mock('@/lib/services/investment-intelligence/statementJob/worker', () => ({
  advanceStatementJob: async (jobId: string, opts: Record<string, unknown>) => {
    h.advanceCalls.push({ jobId, opts });
    return h.advanceOutcome;
  },
  advanceNextStatementJob: async () => {
    h.nextCalls += 1;
    return null;
  },
}));
vi.mock('@/lib/services/investment-intelligence/statementJob/deadRuns', () => ({ closeAllDeadParseRuns: async () => 3 }));

import { GET as listGET } from '@/app/api/investment-intelligence/statement-jobs/route';
import { GET as oneGET } from '@/app/api/investment-intelligence/statement-jobs/[jobId]/route';
import { POST as advancePOST } from '@/app/api/investment-intelligence/statement-jobs/[jobId]/advance/route';
import { POST as cronPOST } from '@/app/api/investment-intelligence/statement-jobs/cron/advance/route';
import { POST as processPOST } from '@/app/api/investment-intelligence/source-documents/[id]/process/route';
import { POST as reevaluatePOST } from '@/app/api/investment-intelligence/source-documents/[id]/reevaluate/route';
import { StatementJobsUnavailableError } from '@/lib/services/investment-intelligence/statementJob/store';

const J1 = '11111111-1111-4111-8111-111111111111';
const J2 = '22222222-2222-4222-8222-222222222222';
const J3 = '33333333-3333-4333-8333-333333333333';
const J4 = '44444444-4444-4444-8444-444444444444';
const SECRET_LEASE = 'lease-token-do-not-leak';
const PASSWORD = 'my-document-password-9';

const job = (over: Row = {}): Row => ({
  id: J1,
  user_id: 'user-1',
  source_document_id: 'doc1',
  job_kind: 'process',
  idempotency_key: 'key-00000001',
  status: 'processing',
  phase: 'transactions',
  review_reason: null,
  checkpoint: { v: 1, internal: 'checkpoint-do-not-leak' },
  progress_done: 40,
  progress_total: 100,
  attempt: 1,
  consecutive_failures: 0,
  slice_count: 3,
  reclaim_count: 0,
  lease_owner: SECRET_LEASE,
  lease_expires_at: '2099-01-01T00:00:00Z',
  heartbeat_at: null,
  last_slice_at: null,
  error_code: null,
  error_message_sanitised: null,
  result_summary: null,
  started_at: null,
  completed_at: null,
  created_at: '2026-10-25T10:00:00.000Z',
  updated_at: '2026-10-25T10:00:00.000Z',
  ...over,
});
const post = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Request('http://t/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const jobParams = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const doc = (over: Row = {}): Row => ({ id: 'doc1', user_id: 'user-1', status: 'uploaded', storage_path: 'user-1/a.pdf', storage_purged_at: null, ...over });

beforeEach(() => {
  h.db = createInMemoryDb();
  h.db.reset({ ii_statement_jobs: [], ii_source_documents: [doc()], ii_holding_snapshots: [] });
  h.userId = 'user-1';
  h.gate = { admitted: true };
  h.gateCalls.length = 0;
  h.advanceCalls.length = 0;
  h.admitCalls.length = 0;
  h.processCalls.length = 0;
  h.recertified.length = 0;
  h.admitThrows = null;
  h.admitResult = null;
  h.advanceOutcome = null;
  h.nextCalls = 0;
  process.env.CRON_SECRET = 'cron-secret-value';
});

describe('GET statement-jobs (list) and GET statement-jobs/{id}', () => {
  it('lists only the caller\'s unfinished jobs, newest per statement, and never another user\'s', async () => {
    h.db.reset({
      ii_statement_jobs: [
        job({ id: J1, source_document_id: 'doc1', status: 'processing', created_at: '2026-10-25T10:00:00.000Z' }),
        job({ id: J2, source_document_id: 'doc1', status: 'completed', created_at: '2026-10-25T09:00:00.000Z' }), // older, ended
        job({ id: J3, source_document_id: 'doc2', status: 'review_required', review_reason: 'password', created_at: '2026-10-25T08:00:00.000Z' }),
        job({ id: J4, user_id: 'user-2', source_document_id: 'doc9', status: 'processing' }),
      ],
    });
    const res = await listGET();
    const jobs = (await res.json()).data.jobs as Array<{ job_id: string }>;
    expect(jobs.map((j) => j.job_id).sort()).toEqual([J1, J3].sort());
    const text = JSON.stringify(jobs);
    expect(text).not.toContain(SECRET_LEASE);
    expect(text).not.toContain('checkpoint-do-not-leak');
  });

  it('an ended latest job leaves nothing to resume', async () => {
    h.db.reset({ ii_statement_jobs: [job({ id: J1, status: 'completed', created_at: '2026-10-25T10:00:00.000Z' }), job({ id: J2, status: 'processing', created_at: '2026-10-25T09:00:00.000Z' })] });
    expect(((await (await listGET()).json()).data.jobs as unknown[]).length).toBe(0);
  });

  it('reads one own job; another user\'s job and a malformed id are the same 404', async () => {
    h.db.reset({ ii_statement_jobs: [job({ id: J1 }), job({ id: J4, user_id: 'user-2' })] });
    const own = await oneGET(new Request('http://t/x'), jobParams(J1));
    expect(own.status).toBe(200);
    const text = JSON.stringify(await own.json());
    expect(text).not.toContain(SECRET_LEASE);
    expect(text).not.toContain('checkpoint-do-not-leak');
    expect((await oneGET(new Request('http://t/x'), jobParams(J4))).status).toBe(404);
    expect((await oneGET(new Request('http://t/x'), jobParams('not-a-uuid'))).status).toBe(404);
    expect((await oneGET(new Request('http://t/x'), jobParams(J3))).status).toBe(404); // does not exist
    h.userId = null;
    expect((await oneGET(new Request('http://t/x'), jobParams(J1))).status).toBe(401);
    expect((await listGET()).status).toBe(401);
  });
});

describe('POST statement-jobs/{id}/advance', () => {
  it('signed out is 401; another user\'s job is 404 and the worker is NEVER called', async () => {
    h.db.reset({ ii_statement_jobs: [job({ id: J1 }), job({ id: J4, user_id: 'user-2' })] });
    h.userId = null;
    expect((await advancePOST(post(), jobParams(J1))).status).toBe(401);
    h.userId = 'user-1';
    expect((await advancePOST(post(), jobParams(J4))).status).toBe(404);
    expect((await advancePOST(post(), jobParams('nope'))).status).toBe(404);
    expect(h.advanceCalls).toEqual([]);
  });

  it('passes the password from the body to the worker for this call only, and answers without it', async () => {
    h.db.reset({ ii_statement_jobs: [job({ id: J1 })] });
    h.advanceOutcome = { kind: 'advanced', job: job({ id: J1, phase: 'schemes' }) };
    const res = await advancePOST(post({ password: PASSWORD }), jobParams(J1));
    expect(res.status).toBe(200);
    expect(h.advanceCalls).toHaveLength(1);
    expect(h.advanceCalls[0].opts).toMatchObject({ userId: 'user-1', password: PASSWORD });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(SECRET_LEASE);
    expect(text).toContain('"advanced":true');
  });

  it('a busy job is reported as busy; a bad body is ignored (no password), never an error', async () => {
    h.db.reset({ ii_statement_jobs: [job({ id: J1 })] });
    h.advanceOutcome = { kind: 'busy', job: job({ id: J1 }) };
    const res = await advancePOST(new Request('http://t/x', { method: 'POST', body: 'not json' }), jobParams(J1));
    expect((await res.json()).data.busy).toBe(true);
    expect(h.advanceCalls[0].opts.password).toBeUndefined();
  });
});

describe('POST statement-jobs/cron/advance (the backstop)', () => {
  it('is refused without the shared secret and runs with it', async () => {
    expect((await cronPOST(new Request('http://t/x', { method: 'POST' }))).status).toBe(401);
    expect((await cronPOST(new Request('http://t/x', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } }))).status).toBe(401);
    expect(h.nextCalls).toBe(0);
    const ok = await cronPOST(new Request('http://t/x', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret-value' } }));
    expect(ok.status).toBe(200);
    const data = (await ok.json()).data;
    expect(data).toMatchObject({ slices: 0, dead_runs_closed: 3 });
    expect(h.nextCalls).toBe(1);
  });
});

describe('POST source-documents/{id}/process (admission)', () => {
  const view = (j: Row) => ({ kind: 'job', job: j, resumed: false });

  it('a new job is 202 with the job and no secret anywhere; the password goes to the malware gate and to admission only', async () => {
    h.admitResult = view(job({ status: 'queued', phase: 'read', progress_done: 0 }));
    const res = await processPOST(post({ password: PASSWORD, forceReparse: true }, { 'Idempotency-Key': 'client-key-0001' }), idParams('doc1'));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toMatchObject({ async_job: true, job_id: J1, resumed: false });
    const text = JSON.stringify(body);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(SECRET_LEASE);
    expect(res.headers.get('Location')).toBe(`/api/investment-intelligence/statement-jobs/${J1}`);
    expect(h.gateCalls).toEqual([{ id: 'doc1', password: PASSWORD }]);
    expect(h.admitCalls[0]).toMatchObject({ userId: 'user-1', documentId: 'doc1', kind: 'process', forceReparse: true, password: PASSWORD, idempotencyKey: 'client-key-0001' });
  });

  it('an unfinished job is resumed (202, resumed true); a malformed Idempotency-Key is dropped, not trusted', async () => {
    h.admitResult = { kind: 'job', job: job(), resumed: true };
    const res = await processPOST(post({}, { 'Idempotency-Key': 'bad key!' }), idParams('doc1'));
    expect(res.status).toBe(202);
    expect((await res.json()).data.resumed).toBe(true);
    expect(h.admitCalls[0].idempotencyKey).toBeNull();
  });

  it('an answer that needs no work is 200 as before; not found is 404; the attempt limiter is 429; a reused key is 409', async () => {
    h.admitResult = { kind: 'answer', result: { ok: true, status: 'parsed', parseRunId: 'r', summary: { transactionsFound: 3 }, error: null } };
    const ok = await processPOST(post({}), idParams('doc1'));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ ok: true, status: 'parsed' });
    h.admitResult = { kind: 'answer', result: { ok: false, status: 'not_found', parseRunId: null, error: 'Source document not found.' } };
    expect((await processPOST(post({}), idParams('doc1'))).status).toBe(404);
    h.admitResult = { kind: 'answer', result: { ok: false, status: 'password_rate_limited', parseRunId: null, error: 'Too many password attempts for this document recently.' } };
    expect((await processPOST(post({ password: 'x' }), idParams('doc1'))).status).toBe(429);
    h.admitResult = { kind: 'conflict', code: 'idempotency_key_in_use' };
    expect((await processPOST(post({}, { 'Idempotency-Key': 'client-key-0002' }), idParams('doc1'))).status).toBe(409);
  });

  it('a file still being scanned is 409 retryable and admits nothing; signed out is 401', async () => {
    h.gate = { admitted: false, reason: 'pending' };
    const res = await processPOST(post({}), idParams('doc1'));
    expect(res.status).toBe(409);
    expect(h.admitCalls).toEqual([]);
    h.userId = null;
    expect((await processPOST(post({}), idParams('doc1'))).status).toBe(401);
  });

  it('where the job tables do not exist yet the earlier one-request behaviour answers (a deployment that runs ahead of the database)', async () => {
    h.admitThrows = new StatementJobsUnavailableError();
    const res = await processPOST(post({ password: PASSWORD }), idParams('doc1'));
    expect(res.status).toBe(200);
    expect(h.processCalls).toEqual([{ userId: 'user-1', sourceDocumentId: 'doc1', password: PASSWORD, forceReparse: undefined }]);
    expect(JSON.stringify(await res.json())).not.toContain(PASSWORD);
  });
});

describe('POST source-documents/{id}/reevaluate', () => {
  const snaps = [
    { id: 's1', user_id: 'user-1', source_document_id: 'doc1', account_id: 'a1', instrument_id: 'i1' },
    { id: 's2', user_id: 'user-1', source_document_id: 'doc1', account_id: 'a2', instrument_id: 'i2' },
  ];

  it('another user\'s statement is 404 and nothing is admitted or evaluated', async () => {
    h.db.reset({ ii_source_documents: [doc({ user_id: 'user-2' })], ii_holding_snapshots: snaps.map((s) => ({ ...s, user_id: 'user-2' })) });
    const res = await reevaluatePOST(post(), idParams('doc1'));
    expect(res.status).toBe(404);
    expect(h.admitCalls).toEqual([]);
    expect(h.recertified).toEqual([]);
  });

  it('a statement with positions is admitted as a job (202); one without says so plainly (200, nothing admitted)', async () => {
    h.db.reset({ ii_source_documents: [doc({ status: 'parsed' })], ii_holding_snapshots: snaps });
    h.admitResult = { kind: 'job', job: job({ job_kind: 'reevaluate', phase: 'certify' }), resumed: false };
    const res = await reevaluatePOST(post(), idParams('doc1'));
    expect(res.status).toBe(202);
    expect((await res.json()).data).toMatchObject({ async_job: true, positions: 2 });
    expect(h.admitCalls[0]).toMatchObject({ kind: 'reevaluate', documentId: 'doc1' });
    h.admitCalls.length = 0;
    h.db.reset({ ii_source_documents: [doc({ status: 'parsed' })], ii_holding_snapshots: [] });
    const none = await reevaluatePOST(post(), idParams('doc1'));
    expect((await none.json()).data).toMatchObject({ evaluated: 0 });
    expect(h.admitCalls).toEqual([]);
  });

  it('where the job tables do not exist yet the positions are evaluated in the request, as before', async () => {
    h.db.reset({ ii_source_documents: [doc({ status: 'parsed' })], ii_holding_snapshots: snaps });
    h.admitThrows = new StatementJobsUnavailableError();
    const res = await reevaluatePOST(post(), idParams('doc1'));
    expect((await res.json()).data).toMatchObject({ evaluated: 2, failed: 0 });
    expect(h.recertified.sort()).toEqual(['a1:i1', 'a2:i2']);
  });
});
