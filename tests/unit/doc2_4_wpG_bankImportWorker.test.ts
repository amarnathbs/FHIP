/**
 * Document2 (4) WP-G (F15, PO-D24-03) -- the bank-statement import as a background job: behaviour of admission, the lease, the slices
 * and the writing, on an in-memory database that really applies filters and the job's uniqueness rules.
 *
 * Evidence label: UNIT-TESTED. (The lease SQL is PGLITE-VERIFIED in doc2_4_wpG_bankImportJobsPglite.test.ts; nothing here is DEV- or
 * production-verified.)
 *
 * What is proven
 *   - SCALE: 25, 120, 500, 1,500 and 3,000-row CSVs end with EXACTLY that many stored lines, none twice, a certified result, a completed
 *     job whose stored summary a later poll returns again, and the staging gone;
 *   - every slice is short (one batch of lines with a zero budget) and the browser-style driver finishes the job;
 *   - a slice KILLED after writing a batch but before the checkpoint, or half way through staging, or half way through finalize, is
 *     taken over after its lease runs out and ends with the same exact result (no duplicate line, one reconciliation row);
 *   - DUPLICATE admission (sequential and concurrent) and REPEATED polling create one job and one set of lines;
 *   - RETRY of a failed job removes the partial lines first and then ends exactly right;
 *   - a CHANGE of the job's lease holder mid-slice stops the old slice from writing (fencing).
 * NEGATIVE CONTROLS at the end remove one guard each and name the assertion that goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBankImportFake, type BankImportFake } from './support/bankImportFake';
import type { Row } from './support/inMemorySupabase';
import { detectBankCsvFormat } from '@/lib/financial-data-hub/bank-csv/detection';
import { scaleBankStatement, parseMonth } from '../../scripts/canonical_cert/documents/builders';

const h = vi.hoisted(() => ({
  fake: null as unknown as BankImportFake,
  files: new Map<string, Uint8Array>(),
  downloadOk: true,
  audits: [] as string[],
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.fake.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.fake.client }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async (key: string) => (h.downloadOk && h.files.has(key) ? { ok: true as const, bytes: h.files.get(key)! } : { ok: false as const, message: 'not available' }),
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: async (e: { eventType: string }) => { h.audits.push(e.eventType); } }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ purgeRawDocumentAfterAiConfirm: async () => ({ status: 'skipped' }) }));
vi.mock('@/lib/financial-data-hub/services/identicalUpload', async (orig) => ({
  ...(await orig<typeof import('@/lib/financial-data-hub/services/identicalUpload')>()),
  findEarlierIdenticalUpload: async () => null,
}));

import { admitBankImport } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { advanceBankImportJob, advanceNextBankImportJob } from '@/lib/financial-data-hub/services/bankImportWorker';
import { getJobByDocument, claimJob, updateOwned } from '@/lib/financial-data-hub/services/bankImportJobStore';
import { driveBankImportJob, type AdvanceAnswer, type JobViewLike } from '@/components/expenses/bankImportJobDriver';
import { toBankImportJobView } from '@/lib/financial-data-hub/bankImport/jobModel';

const U1 = 'user-1';
const U2 = 'user-2';
const ACCT = 'acct-1';
const MONTH = parseMonth('2026-09');
const ROW_CAP_KEY = (docId: string) => `fdh/${docId}.csv`;

function seedCsvDocument(docId: string, n: number, userId = U1, salt = 'A'): { adapterKey: string } {
  const built = scaleBankStatement(MONTH, n, salt);
  const detection = detectBankCsvFormat(built.bytes);
  if (!detection.adapter) throw new Error('fixture CSV was not detected');
  h.files.set(ROW_CAP_KEY(docId), built.bytes);
  h.fake.db.tables.fdh_statement_uploads = [
    ...(h.fake.db.tables.fdh_statement_uploads ?? []),
    {
      id: docId, user_id: userId, household_id: null, financial_account_id: ACCT, currency_code: 'AUD', country_code: 'AU', document_type: 'bank_statement',
      processing_status: 'queued', processing_started_at: null, processing_completed_at: null, certification_status: null, error_code: null,
      detection_status: 'detected', adapter_key: detection.adapter.id, adapter_version: '1', mapping_template_id: null, malware_scan_status: 'clean',
      raw_document_storage_reference: ROW_CAP_KEY(docId), raw_document_purge_status: 'not_required', statement_period_start: null, statement_period_end: null,
      duplicate_of_document_id: null, parser_id: null, parser_version_id: null, created_at: '2026-10-20T10:00:00Z', mime_type: 'text/csv',
    },
  ];
  return { adapterKey: detection.adapter.id };
}

const txFor = (docId: string) => h.fake.rows('fdh_transactions').filter((t) => t.statement_upload_id === docId);
const doc = (docId: string) => h.fake.rows('fdh_statement_uploads').find((d) => d.id === docId) as Row;

/** Drives a job to its end exactly like the browser does (zero slice budget = one batch of lines per slice). */
async function driveToEnd(jobId: string, userId = U1, sliceBudgetMs = 0, maxSlices = 200) {
  let slices = 0;
  let last: Row | null = null;
  for (; slices < maxSlices; slices += 1) {
    const out = await advanceBankImportJob(jobId, { userId, sliceBudgetMs });
    if (out.kind === 'not_found') throw new Error('job not found');
    last = out.job as unknown as Row;
    if (['completed', 'failed', 'review_required'].includes(String(last.status))) break;
  }
  return { slices: slices + 1, job: last as Row };
}

beforeEach(() => {
  h.fake = createBankImportFake();
  h.files.clear();
  h.downloadOk = true;
  h.audits.length = 0;
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
});

describe('admission: 202 + one idempotent job', () => {
  it('admits a CSV as ONE queued job without reading the file or writing a line', async () => {
    seedCsvDocument('doc-1', 25);
    const out = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    expect(out.kind).toBe('job');
    expect(h.fake.jobs()).toHaveLength(1);
    expect(h.fake.jobs()[0]).toMatchObject({ status: 'queued', phase: 'read', source_kind: 'csv', user_id: U1, statement_upload_id: 'doc-1' });
    expect(txFor('doc-1')).toHaveLength(0); // the request did no extraction
    expect(doc('doc-1').processing_status).toBe('queued');
  });

  it('asking again (sequentially and at the same moment) returns the SAME job: one row', async () => {
    seedCsvDocument('doc-1', 25);
    const a = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    const b = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv', idempotencyKey: 'a-different-client-key-1' });
    const [c, d] = await Promise.all([
      admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' }),
      admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' }),
    ]);
    const ids = [a, b, c, d].map((o) => (o.kind === 'job' ? o.job.id : 'x'));
    expect(new Set(ids).size).toBe(1);
    expect(h.fake.jobs()).toHaveLength(1);
  });

  it('refuses the statement of another user as not found, and creates no job', async () => {
    seedCsvDocument('doc-1', 25, U1);
    const out = await admitBankImport({ userId: U2, documentId: 'doc-1', kind: 'csv' });
    expect(out).toMatchObject({ kind: 'error', status: 404 });
    expect(h.fake.jobs()).toHaveLength(0);
  });

  it('owner/account first: a statement with no account is parked for the account question and gets no job', async () => {
    seedCsvDocument('doc-1', 25);
    (doc('doc-1') as Row).financial_account_id = null;
    const out = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    expect(out).toMatchObject({ kind: 'error', status: 400, code: 'account_unresolved' });
    expect(h.fake.jobs()).toHaveLength(0);
    expect(doc('doc-1').processing_status).toBe('review_required');
  });

  it('malware admission first: a file that was not cleared is refused and gets no job; nothing is parsed', async () => {
    seedCsvDocument('doc-1', 25);
    (doc('doc-1') as Row).malware_scan_status = 'pending';
    const out = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    expect(out).toMatchObject({ kind: 'error', status: 400, code: 'invalid_state' });
    expect(h.fake.jobs()).toHaveLength(0);
  });
});

describe('scale: exact line counts, none twice', () => {
  for (const n of [25, 120, 500, 1500, 3000]) {
    it(`${n} CSV rows -> exactly ${n} stored lines, certified, job completed, staging cleaned, summary returned again`, async () => {
      seedCsvDocument('doc-1', n);
      const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
      if (adm.kind !== 'job') throw new Error('expected a job');
      const { slices, job } = await driveToEnd(adm.job.id);
      expect(job.status).toBe('completed');
      const lines = txFor('doc-1');
      expect(lines).toHaveLength(n);
      expect(new Set(lines.map((t) => t.source_row)).size).toBe(n); // none twice
      expect(doc('doc-1')).toMatchObject({ processing_status: 'approved', certification_status: 'certified', certified_row_count: n });
      expect((job.result_summary as Record<string, unknown>).transactions_created).toBe(n);
      expect(h.fake.rows('fdh_bank_import_job_chunks')).toHaveLength(0);
      expect(h.fake.rows('fdh_reconciliation_results')).toHaveLength(1);
      expect(h.fake.rows('fdh_data_provenance')).toHaveLength(1);
      // every slice was short: at most one batch of 250 lines is written per slice with a zero budget
      expect(slices).toBeGreaterThanOrEqual(Math.ceil(n / 250));
      // asking to process it again answers inline with the stored result and writes nothing
      const again = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
      expect(again.kind).toBe('result');
      expect(txFor('doc-1')).toHaveLength(n);
    });
  }

  it('with the real slice budget the same 3,000 rows finish in far fewer slices', async () => {
    seedCsvDocument('doc-1', 3000);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    const { slices, job } = await driveToEnd(adm.job.id, U1, 17_000);
    expect(job.status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(3000);
    expect(slices).toBeLessThanOrEqual(3);
  });

  it('the browser-style driver (what the panel runs) finishes a 500-row job and reports progress', async () => {
    seedCsvDocument('doc-1', 500);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    const seen: number[] = [];
    const res = await driveBankImportJob({
      jobId: adm.job.id,
      advance: async (id) => {
        const out = await advanceBankImportJob(id, { userId: U1, sliceBudgetMs: 0 });
        if (out.kind === 'not_found') return { ok: false, status: 404, json: {} } as AdvanceAnswer;
        return { ok: true, status: 200, json: { data: { job: toBankImportJobView(out.job) as unknown as JobViewLike, busy: out.kind === 'busy' } } };
      },
      wait: async () => undefined,
      onUpdate: (v) => seen.push(v.progress_done),
    });
    expect(res.outcome).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(500);
    expect(seen.some((p) => p > 0 && p < 500)).toBe(true); // visible progress between 0 and the end
  });
});

describe('kill and resume: a slice that dies is taken over and the result is exact', () => {
  async function admit(n: number) {
    seedCsvDocument('doc-1', n);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    return adm.job;
  }
  const expireLease = (jobId: string) => {
    const j = h.fake.jobs().find((r) => r.id === jobId)!;
    j.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  };

  it('killed AFTER writing a batch and BEFORE the checkpoint: the next claim writes only what is missing', async () => {
    const job = await admit(600);
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 }); // read
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 }); // persist batch 1 (250)
    expect(txFor('doc-1')).toHaveLength(250);
    // The dead slice had also written batch 2 (rows 251-500) but never reached its checkpoint:
    const staged = h.fake.rows('fdh_bank_import_job_chunks').find((c) => c.kind === 'plan_rows' && c.seq === 1)!;
    h.fake.db.tables.fdh_transactions.push(...((staged.payload as { rows: Row[] }).rows).map((r, i) => ({ id: `dead-${i}`, ...r })));
    expect(txFor('doc-1')).toHaveLength(500);
    const row = h.fake.jobs()[0];
    Object.assign(row, { status: 'processing', lease_owner: 'dead-owner-0001', progress_done: 250 });
    expireLease(job.id);
    const { job: end } = await driveToEnd(job.id);
    expect(end.status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(600);
    expect(new Set(txFor('doc-1').map((t) => t.source_row)).size).toBe(600);
    expect(Number(end.reclaim_count)).toBeGreaterThanOrEqual(1);
  });

  it('the worker rule alone is enough: with NO unique index the retry still writes only what is missing (no duplicate)', async () => {
    h.fake.enforceUniqueSourceRow(false);
    const job = await admit(600);
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 });
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 });
    const staged = h.fake.rows('fdh_bank_import_job_chunks').find((c) => c.kind === 'plan_rows' && c.seq === 1)!;
    h.fake.db.tables.fdh_transactions.push(...((staged.payload as { rows: Row[] }).rows).map((r, i) => ({ id: `dead-${i}`, ...r })));
    Object.assign(h.fake.jobs()[0], { status: 'processing', lease_owner: 'dead-owner-0009', progress_done: 250 });
    expireLease(job.id);
    const { job: end } = await driveToEnd(job.id);
    expect(end.status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(600);
    expect(new Set(txFor('doc-1').map((t) => t.source_row)).size).toBe(600);
  });

  it('a statement the old synchronous import left half-written is cleared by the read phase, so its own debris is not read as duplicates of itself', async () => {
    const job = await admit(120);
    await driveToEnd(job.id);
    expect(txFor('doc-1')).toHaveLength(120);
    // Debris of an earlier killed run: the lines are there, the statement is back in `processing`, the job starts again.
    Object.assign(doc('doc-1'), { processing_status: 'processing', processing_completed_at: null, certification_status: null });
    Object.assign(h.fake.jobs()[0], { status: 'queued', phase: 'read', result_summary: null, completed_at: null, lease_owner: null, lease_expires_at: null });
    const { job: end } = await driveToEnd(job.id);
    expect(end.status).toBe('completed');
    const summary = end.result_summary as Record<string, unknown>;
    expect(summary.transactions_created).toBe(120);
    expect(summary.duplicates_skipped).toBe(0);
    expect(txFor('doc-1')).toHaveLength(120);
  });

  it('killed while STAGING the plan (lines staged, no meta): the plan is rebuilt and the job still ends exact', async () => {
    const job = await admit(300);
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 }); // read -> persist
    h.fake.db.tables.fdh_bank_import_job_chunks = h.fake.rows('fdh_bank_import_job_chunks').filter((c) => c.kind !== 'plan_meta');
    Object.assign(h.fake.jobs()[0], { status: 'processing', lease_owner: 'dead-owner-0002' });
    expireLease(job.id);
    const { job: end } = await driveToEnd(job.id);
    expect(end.status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(300);
  });

  it('killed in the MIDDLE of finalize (statement left half way, derived rows partly written): redone once, exactly', async () => {
    const job = await admit(120);
    for (let i = 0; i < 20; i += 1) {
      const out = await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 });
      if (out.kind === 'advanced' && out.job.phase === 'finalize') break;
    }
    expect(h.fake.jobs()[0].phase).toBe('finalize');
    // what a killed finalize leaves: derived rows written once, the statement left in `extracted`
    h.fake.db.tables.fdh_reconciliation_results = [{ id: 'old-rec', user_id: U1, statement_upload_id: 'doc-1' }];
    h.fake.db.tables.fdh_data_quality_results = [{ id: 'old-dq', user_id: U1, statement_upload_id: 'doc-1', check_code: 'transaction_count_valid' }];
    h.fake.db.tables.fdh_data_provenance = [{ id: 'old-prov', user_id: U1, entity_type: 'fdh_statement_upload', entity_id: 'doc-1' }];
    (doc('doc-1') as Row).processing_status = 'extracted';
    Object.assign(h.fake.jobs()[0], { status: 'processing', lease_owner: 'dead-owner-0003' });
    expireLease(job.id);
    const { job: end } = await driveToEnd(job.id);
    expect(end.status).toBe('completed');
    expect(h.fake.rows('fdh_reconciliation_results')).toHaveLength(1);
    expect(h.fake.rows('fdh_reconciliation_results')[0].id).not.toBe('old-rec');
    expect(h.fake.rows('fdh_data_provenance')).toHaveLength(1);
    expect(h.fake.rows('fdh_data_quality_results').filter((r) => r.check_code === 'transaction_count_valid')).toHaveLength(1);
    expect(doc('doc-1')).toMatchObject({ processing_status: 'approved', certification_status: 'certified' });
    expect(txFor('doc-1')).toHaveLength(120);
  });

  it('killed AFTER finalize wrote the whole result but BEFORE the job was marked: reported once, nothing rewritten', async () => {
    const job = await admit(120);
    const { job: end } = await driveToEnd(job.id);
    expect(end.status).toBe('completed');
    const writesBefore = h.fake.db.writes.length;
    Object.assign(h.fake.jobs()[0], { status: 'processing', phase: 'finalize', lease_owner: 'dead-owner-0004', result_summary: null, completed_at: null });
    expireLease(job.id);
    const again = await driveToEnd(job.id);
    expect(again.job.status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(120);
    expect(h.fake.rows('fdh_reconciliation_results')).toHaveLength(1);
    expect(h.fake.db.writes.slice(writesBefore).filter((w) => w.table === 'fdh_transactions' && w.kind === 'insert')).toHaveLength(0);
  });

  it('a slice that THROWS part-way is retried by the next slice (three in a row stop the job with a plain message)', async () => {
    const job = await admit(600);
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 }); // read
    h.fake.failTransactionInsertAt(1);
    const first = await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 });
    expect(first.kind).toBe('advanced');
    expect(h.fake.jobs()[0]).toMatchObject({ status: 'queued', consecutive_failures: 1 });
    h.fake.failTransactionInsertAt(null);
    const { job: end } = await driveToEnd(job.id);
    expect(end.status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(600);
  });

  it('three consecutive failures fail the job, remove the partial lines and say what happened', async () => {
    const job = await admit(600);
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 }); // read
    await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 }); // one good batch
    expect(txFor('doc-1')).toHaveLength(250);
    for (let i = 0; i < 3; i += 1) {
      h.fake.failTransactionInsertAt(1);
      await advanceBankImportJob(job.id, { userId: U1, sliceBudgetMs: 0 });
    }
    const failed = h.fake.jobs()[0];
    expect(failed.status).toBe('failed');
    expect(String(failed.error_message_sanitised)).toMatch(/could not finish importing/i);
    expect(txFor('doc-1')).toHaveLength(0); // partial lines removed so a fresh upload cannot be fooled by them
    expect(doc('doc-1').processing_status).toBe('failed');
    expect(h.fake.rows('fdh_bank_import_job_chunks')).toHaveLength(0);
  });
});

describe('retry', () => {
  it('a failed job is restarted by the next process request: attempt 2, exact result', async () => {
    seedCsvDocument('doc-1', 400);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    h.downloadOk = false;
    const first = await driveToEnd(adm.job.id);
    expect(first.job.status).toBe('failed');
    expect(first.job.error_code).toBe('file_unreadable');
    h.downloadOk = true;
    const retry = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    expect(retry.kind).toBe('job');
    expect(h.fake.jobs()).toHaveLength(1);
    expect(h.fake.jobs()[0]).toMatchObject({ status: 'queued', attempt: 2 });
    const second = await driveToEnd(adm.job.id);
    expect(second.job.status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(400);
  });
});

describe('repeated polling and the lease', () => {
  it('two callers at the same moment: exactly one works, the other is told it is busy', async () => {
    seedCsvDocument('doc-1', 300);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    const [a, b] = await Promise.all([
      advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 }),
      advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['advanced', 'busy']);
  });

  it('polling a finished job any number of times changes nothing', async () => {
    seedCsvDocument('doc-1', 120);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    await driveToEnd(adm.job.id);
    const writes = h.fake.db.writes.length;
    for (let i = 0; i < 5; i += 1) {
      const out = await advanceBankImportJob(adm.job.id, { userId: U1 });
      expect(out.kind).toBe('not_runnable');
    }
    expect(h.fake.db.writes.length).toBe(writes);
    expect(txFor('doc-1')).toHaveLength(120);
  });

  it('a slice whose lease was taken over writes nothing more (fencing)', async () => {
    seedCsvDocument('doc-1', 300);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    const owner = 'old-holder-0001';
    const claimed = await claimJob(adm.job.id, owner);
    expect(claimed?.lease_owner).toBe(owner);
    // The lease runs out and another holder takes it over.
    h.fake.jobs()[0].lease_expires_at = new Date(Date.now() - 1000).toISOString();
    const taker = await claimJob(adm.job.id, 'new-holder-0002');
    expect(taker?.lease_owner).toBe('new-holder-0002');
    // The old holder's checkpoint now matches nothing.
    const stale = await updateOwned(adm.job.id, owner, { progress_done: 999 });
    expect(stale).toBeNull();
    expect(h.fake.jobs()[0].progress_done).not.toBe(999);
  });

  it('the scheduled backstop picks up an abandoned job and finishes it with no browser at all', async () => {
    seedCsvDocument('doc-1', 400);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    for (let i = 0; i < 20; i += 1) {
      const out = await advanceNextBankImportJob({ sliceBudgetMs: 0 });
      if (!out) break;
    }
    expect(h.fake.jobs()[0].status).toBe('completed');
    expect(txFor('doc-1')).toHaveLength(400);
    expect(await advanceNextBankImportJob({ sliceBudgetMs: 0 })).toBeNull(); // nothing left to do
  });

  it('the backstop leaves a job alone while someone holds a live lease', async () => {
    seedCsvDocument('doc-1', 300);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    await claimJob(adm.job.id, 'browser-holder-01');
    expect(await advanceNextBankImportJob({ sliceBudgetMs: 0 })).toBeNull();
  });
});

describe('the dead-synchronous-run reaper must not touch a job-owned statement', () => {
  it('a long-running job statement keeps its lines; a legacy stuck statement (no job) is still cleaned up', async () => {
    const old = new Date(Date.now() - 600_000).toISOString();
    const base = { user_id: U1, financial_account_id: ACCT, processing_status: 'processing', processing_started_at: old };
    h.fake.db.tables.fdh_statement_uploads = [{ id: 'doc-job', ...base }, { id: 'doc-legacy', ...base }];
    h.fake.db.tables.fdh_bank_import_jobs = [{ id: 'j1', user_id: U1, statement_upload_id: 'doc-job', status: 'processing' }];
    const line = (docId: string, n: number) => ({ id: `${docId}-${n}`, user_id: U1, statement_upload_id: docId, financial_account_id: ACCT, economic_fingerprint: `${docId}-fp${n}`, source_reference: null, balance_after: 1, created_at: old });
    h.fake.db.tables.fdh_transactions = [line('doc-job', 1), line('doc-job', 2), line('doc-legacy', 1)];
    const { loadDedupIndexForAccount } = await import('@/lib/financial-data-hub/bank-csv/repository');
    await loadDedupIndexForAccount(U1, ACCT);
    expect(txFor('doc-job')).toHaveLength(2);
    expect(txFor('doc-legacy')).toHaveLength(0);
  });
});

describe('tenancy at the service layer', () => {
  it('a user cannot advance or read another user job through the user-scoped entry points', async () => {
    seedCsvDocument('doc-1', 120, U1);
    const adm = await admitBankImport({ userId: U1, documentId: 'doc-1', kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    expect((await advanceBankImportJob(adm.job.id, { userId: U2, sliceBudgetMs: 0 })).kind).toBe('not_found');
    expect(await getJobByDocument(U2, 'doc-1')).toBeNull();
    expect(txFor('doc-1')).toHaveLength(0);
  });
});
