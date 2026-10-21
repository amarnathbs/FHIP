/**
 * Document2 (4) WP-G (F15) -- the job ROUTES (two users, every route), the process routes' 202 contract, the scheduled backstop's
 * secret, and the browser-side driver (pure). Evidence label: UNIT-TESTED.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  driveBankImportJob,
  isUnansweredAsk,
  jobProgressPercent,
  JOB_BUSY_WAIT_MS,
  JOB_MAX_CONSECUTIVE_NETWORK_FAILURES,
  type AdvanceAnswer,
  type JobViewLike,
} from '@/components/expenses/bankImportJobDriver';
import { bankImportLiveness, bankImportStatusMessage, normaliseIdempotencyKey, toBankImportJobView, type BankImportJobRow } from '@/lib/financial-data-hub/bankImport/jobModel';
import { createBankImportFake, type BankImportFake } from './support/bankImportFake';

const h = vi.hoisted(() => ({
  fake: null as unknown as BankImportFake,
  user: null as null | { id: string },
  advanceCalls: [] as string[],
  admit: null as null | (() => Promise<unknown>),
}));

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => (h.user ? { user: h.user, unauthenticated: null } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) }),
}));
// The session client is row-level-security shaped: it sees only its own user's rows (the policy of migration 0310).
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const uid = h.user?.id;
    return {
      from: (t: string) => {
        const base = h.fake.client.from(t) as Record<string, (...a: unknown[]) => unknown>;
        return {
          // SELECT only, and always filtered to the signed-in user first: what the row-level-security policy does in the database.
          select: (cols?: string) => (base.select(cols) as Record<string, (...a: unknown[]) => unknown>).eq('user_id', uid),
        };
      },
    };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.fake.client }));
vi.mock('@/lib/financial-data-hub/services/bankImportWorker', () => ({
  advanceBankImportJob: async (jobId: string, opts: { userId?: string }) => {
    h.advanceCalls.push(`${opts.userId}:${jobId}`);
    const job = h.fake.jobs().find((j) => j.id === jobId && j.user_id === opts.userId);
    return job ? { kind: 'advanced', job } : { kind: 'not_found' };
  },
  advanceNextBankImportJob: async () => null,
}));
vi.mock('@/lib/financial-data-hub/services/bankImportAdmission', () => ({ admitBankImport: async () => (h.admit ? h.admit() : { kind: 'error', status: 404, code: 'not_found', message: 'document not found' }) }));
vi.mock('@/lib/entitlements/financialDataImport', () => ({ refuseUnlessImportRunMayStart: async () => null }));
vi.mock('@/lib/financial-data-hub/services/importRunPosition', () => ({ fdhDocumentRunPosition: async () => 'queued' }));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', async (o) => ({ ...(await o<typeof import('@/lib/financial-data-hub/constants/featureFlags')>()), isFdhDocumentUploadEnabled: () => true }));

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const U1 = 'user-1';
const U2 = 'user-2';

function jobRow(over: Record<string, unknown>) {
  return {
    status: 'queued', phase: 'read', review_reason: null, checkpoint: {}, progress_done: 0, progress_total: null, attempt: 1, consecutive_failures: 0, slice_count: 0,
    reclaim_count: 0, lease_owner: 'SECRET-LEASE-TOKEN', lease_expires_at: null, heartbeat_at: null, last_slice_at: null, error_code: null, error_message_sanitised: null,
    result_summary: null, source_kind: 'csv', idempotency_key: 'bank-import:x', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  };
}

beforeEach(() => {
  h.fake = createBankImportFake();
  h.user = { id: U1 };
  h.advanceCalls.length = 0;
  h.admit = null;
  h.fake.db.tables.fdh_bank_import_jobs = [
    jobRow({ id: JOB_A, user_id: U1, statement_upload_id: 'doc-a' }),
    jobRow({ id: JOB_B, user_id: U2, statement_upload_id: 'doc-b' }),
  ];
});

const params = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

describe('job routes: two users, every route', () => {
  it('GET list: each user sees only their own unfinished jobs, and never the lease token', async () => {
    const { GET } = await import('@/app/api/financial-data-hub/bank-import-jobs/route');
    const mine = await (await GET()).json();
    expect(mine.data.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([JOB_A]);
    expect(JSON.stringify(mine)).not.toMatch(/SECRET-LEASE-TOKEN|lease_owner|idempotency_key|checkpoint/);
    h.user = { id: U2 };
    const theirs = await (await GET()).json();
    expect(theirs.data.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([JOB_B]);
  });

  it('GET one: your own job is returned; another user\'s is a 404 exactly like a job that does not exist', async () => {
    const { GET } = await import('@/app/api/financial-data-hub/bank-import-jobs/[jobId]/route');
    expect((await GET(new Request('http://x'), params(JOB_A))).status).toBe(200);
    const cross = await GET(new Request('http://x'), params(JOB_B));
    const missing = await GET(new Request('http://x'), params('33333333-3333-4333-8333-333333333333'));
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await cross.json()).toEqual(await missing.json()); // non-enumerating: indistinguishable
    expect((await GET(new Request('http://x'), params('not-a-uuid'))).status).toBe(404);
  });

  it('POST advance: your own job is advanced; another user\'s is a 404 and the worker is never called for it', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/bank-import-jobs/[jobId]/advance/route');
    const ok = await POST(new Request('http://x', { method: 'POST' }), params(JOB_A));
    expect(ok.status).toBe(200);
    expect(h.advanceCalls).toEqual([`${U1}:${JOB_A}`]);
    const cross = await POST(new Request('http://x', { method: 'POST' }), params(JOB_B));
    expect(cross.status).toBe(404);
    expect(h.advanceCalls).toEqual([`${U1}:${JOB_A}`]); // unchanged
  });

  it('every job route refuses a signed-out caller with 401 and touches nothing', async () => {
    h.user = null;
    const list = await import('@/app/api/financial-data-hub/bank-import-jobs/route');
    const one = await import('@/app/api/financial-data-hub/bank-import-jobs/[jobId]/route');
    const adv = await import('@/app/api/financial-data-hub/bank-import-jobs/[jobId]/advance/route');
    expect((await list.GET()).status).toBe(401);
    expect((await one.GET(new Request('http://x'), params(JOB_A))).status).toBe(401);
    expect((await adv.POST(new Request('http://x', { method: 'POST' }), params(JOB_A))).status).toBe(401);
    expect(h.advanceCalls).toHaveLength(0);
  });

  it('the scheduled backstop needs the shared secret', async () => {
    process.env.CRON_SECRET = 'test-secret-value';
    const { POST } = await import('@/app/api/financial-data-hub/bank-import-jobs/cron/advance/route');
    expect((await POST(new Request('http://x', { method: 'POST' }))).status).toBe(401);
    expect((await POST(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } }))).status).toBe(401);
    const good = await POST(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 'test-secret-value' } }));
    expect(good.status).toBe(200);
  });

  it('NEGATIVE CONTROL: a route that read the job without the user filter WOULD leak (the unscoped read returns the other user\'s row)', async () => {
    const unscoped = h.fake.jobs().filter((j) => j.id === JOB_B);
    expect(unscoped).toHaveLength(1); // proves the cross-tenant tests above are not vacuous: the row exists and only the scoping hides it
  });
});

describe('process routes: 202 + job id, quickly', () => {
  it('CSV and PDF answer 202 with the job, a Location header and no extraction in the request', async () => {
    const view = jobRow({ id: JOB_A, user_id: U1, statement_upload_id: 'doc-a' });
    h.admit = async () => ({ kind: 'job', job: view });
    const csv = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/process/route');
    const pdf = await import('@/app/api/financial-data-hub/bank-pdf/[documentId]/process/route');
    for (const POST of [csv.POST, pdf.POST]) {
      const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-a' }) });
      expect(res.status).toBe(202);
      expect(res.headers.get('location')).toContain(JOB_A);
      const body = await res.json();
      expect(body.data).toMatchObject({ async_job: true, job_id: JOB_A });
      expect(JSON.stringify(body)).not.toMatch(/SECRET-LEASE-TOKEN/);
    }
  });

  it('an already-settled statement still answers 200 inline; a refusal keeps its status and message', async () => {
    const csv = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/process/route');
    h.admit = async () => ({ kind: 'result', payload: { transactions_created: 5 } });
    const settled = await csv.POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'd' }) });
    expect(settled.status).toBe(200);
    expect((await settled.json()).data.transactions_created).toBe(5);
    h.admit = async () => ({ kind: 'error', status: 409, code: 'statement_in_progress', message: 'still being read' });
    const busy = await csv.POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'd' }) });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe('statement_in_progress');
  });
});

describe('job model (pure)', () => {
  const base = { status: 'processing', lease_expires_at: null, slice_count: 0 } as const;
  it('liveness: working while a lease is live, stalled once it ran out (the dead-job rule), idle when never claimed, waiting for a person, finished', () => {
    const now = Date.now();
    expect(bankImportLiveness({ ...base, lease_expires_at: new Date(now + 30_000).toISOString(), slice_count: 1 }, now)).toBe('working');
    expect(bankImportLiveness({ ...base, lease_expires_at: new Date(now - 1).toISOString(), slice_count: 1 }, now)).toBe('stalled');
    expect(bankImportLiveness({ status: 'queued', lease_expires_at: null, slice_count: 0 }, now)).toBe('idle');
    expect(bankImportLiveness({ status: 'review_required', lease_expires_at: null, slice_count: 1 }, now)).toBe('waiting_for_person');
    expect(bankImportLiveness({ status: 'completed', lease_expires_at: null, slice_count: 1 }, now)).toBe('finished');
  });
  it('the view carries the plain message and progress; a failed job carries its sentence and any answer it holds', () => {
    const row = jobRow({ id: JOB_A, user_id: U1, statement_upload_id: 'd', phase: 'persist', status: 'queued', progress_done: 1250, progress_total: 3000 }) as unknown as BankImportJobRow;
    expect(bankImportStatusMessage(row)).toMatch(/Saving your transactions \(1,250 of 3,000\)/);
    expect(jobProgressPercent(toBankImportJobView(row))).toBe(41);
    const failed = toBankImportJobView({ ...row, status: 'failed', error_code: 'x', error_message_sanitised: 'We could not finish.', result_summary: { error_code: 'layout_unsupported' } } as BankImportJobRow);
    expect(failed.error_message).toBe('We could not finish.');
    expect(failed.result).toEqual({ error_code: 'layout_unsupported' });
  });
  it('idempotency keys: opaque, bounded, printable only', () => {
    expect(normaliseIdempotencyKey('abc12345-key')).toBe('abc12345-key');
    expect(normaliseIdempotencyKey('short')).toBeNull();
    expect(normaliseIdempotencyKey('has space in it')).toBeNull();
    expect(normaliseIdempotencyKey('x'.repeat(200))).toBeNull();
    expect(normaliseIdempotencyKey(null)).toBeNull();
  });
});

describe('browser driver (pure)', () => {
  const view = (over: Partial<JobViewLike>): JobViewLike => ({ job_id: 'j', document_id: 'd', status: 'processing', phase: 'persist', review_reason: null, progress_done: 0, progress_total: 10, message: '', error_code: null, error_message: null, result: null, keep_polling: true, ...over });
  const answer = (v: JobViewLike, busy = false): AdvanceAnswer => ({ ok: true, status: 200, json: { data: { job: v, busy } } });
  const noWait = async () => undefined;

  it('keeps asking until completed, reporting each state', async () => {
    const seq = [view({ progress_done: 3 }), view({ progress_done: 7 }), view({ status: 'completed', progress_done: 10, keep_polling: false, result: { transactions_created: 10 } })];
    let i = 0;
    const seen: number[] = [];
    const res = await driveBankImportJob({ jobId: 'j', advance: async () => answer(seq[i++]), wait: noWait, onUpdate: (v) => seen.push(v.progress_done) });
    expect(res.outcome).toBe('completed');
    expect(seen).toEqual([3, 7, 10]);
  });

  it('busy means wait longer, not fail; a gateway error or dropped connection is retried, never reported as a failure', async () => {
    const waits: number[] = [];
    const answers: AdvanceAnswer[] = [
      answer(view({}), true),
      { ok: false, status: 504, json: null },
      { ok: false, status: 0, json: {} },
      answer(view({ status: 'completed', keep_polling: false })),
    ];
    let i = 0;
    const res = await driveBankImportJob({ jobId: 'j', advance: async () => answers[i++], wait: async (ms) => { waits.push(ms); } });
    expect(res.outcome).toBe('completed');
    expect(waits[0]).toBe(JOB_BUSY_WAIT_MS);
    expect(isUnansweredAsk({ ok: false, status: 504, json: null })).toBe(true);
    expect(isUnansweredAsk({ ok: false, status: 404, json: { error: 'not found' } })).toBe(false);
  });

  it('stops for a person (AI reading to check / password) and on a failed job, handing back the final view', async () => {
    const needs = await driveBankImportJob({ jobId: 'j', advance: async () => answer(view({ status: 'review_required', review_reason: 'ai_draft', keep_polling: false })), wait: noWait });
    expect(needs.outcome).toBe('needs_person');
    const failed = await driveBankImportJob({ jobId: 'j', advance: async () => answer(view({ status: 'failed', keep_polling: false, error_message: 'No.' })), wait: noWait });
    expect(failed).toMatchObject({ outcome: 'failed', view: { error_message: 'No.' } });
  });

  it('a refusal (404 not yours / gone) is final; endless silence gives up after a bound; cancel stops at once', async () => {
    expect((await driveBankImportJob({ jobId: 'j', advance: async () => ({ ok: false, status: 404, json: { error: 'not found' } }), wait: noWait })).outcome).toBe('failed');
    let calls = 0;
    const silent = await driveBankImportJob({ jobId: 'j', advance: async () => { calls += 1; return { ok: false, status: 0, json: {} }; }, wait: noWait });
    expect(silent.outcome).toBe('gave_up');
    expect(calls).toBe(JOB_MAX_CONSECUTIVE_NETWORK_FAILURES);
    expect((await driveBankImportJob({ jobId: 'j', advance: async () => answer(view({})), wait: noWait, isCancelled: () => true })).outcome).toBe('cancelled');
  });

  it('an old panel that reloads mid-job simply picks the same job up again: asking is idempotent', async () => {
    // Two drivers on one job (two tabs): both end on the same completed state.
    const final = view({ status: 'completed', keep_polling: false, result: { transactions_created: 1 } });
    const a = await driveBankImportJob({ jobId: 'j', advance: async () => answer(final), wait: noWait });
    const b = await driveBankImportJob({ jobId: 'j', advance: async () => answer(final), wait: noWait });
    expect(a.view?.result).toEqual(b.view?.result);
  });
});
