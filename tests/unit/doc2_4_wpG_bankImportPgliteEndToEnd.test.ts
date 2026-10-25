/**
 * Document2 (4) WP-G (F15) -- the whole bank-import job against a REAL Postgres (PGlite, this repository's full migration chain
 * including 0310 and 0311): admission, the lease functions, the staged plan, the writing, finalize, the AI reading in parts, kill and
 * resume, duplicate admission, concurrent polling and retry. The unit suites prove the logic on an in-memory fake; this proves it
 * against the real schema, constraints, unique index and triggers.
 *
 * Evidence label: PGLITE-VERIFIED (a real Postgres engine; NOT DEV-verified, NOT production-verified). The AI provider is a fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildDb } from './support/fdh10LedgerPgliteHarness';
import { pgliteSupabase } from './support/pgliteSupabaseJobs';
import { detectBankCsvFormat } from '@/lib/financial-data-hub/bank-csv/detection';
import { scaleBankStatement, parseMonth } from '../../scripts/canonical_cert/documents/builders';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';

const h = vi.hoisted(() => ({ db: null as unknown as PGlite, client: null as unknown, files: new Map<string, Uint8Array>(), aiCalls: 0 }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async (key: string) => (h.files.has(key) ? { ok: true as const, bytes: h.files.get(key)! } : { ok: false as const, message: 'gone' }),
}));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ purgeRawDocumentAfterAiConfirm: async () => ({ status: 'skipped' }) }));
vi.mock('@/lib/aie/adapters/bankStatement/featureFlags', () => ({ isAieBankStatementAiFallbackEnabled: () => true }));
vi.mock('@/lib/aie/adapters/shared/fallbackGate', () => ({
  evaluateAiFallbackGate: async (p: { extractedText: string }) => ({ ok: true, maskedText: p.extractedText, coverageByType: {}, totalMatches: 0 }),
  evaluateAiEgressPreconditions: async () => ({ ok: true }),
}));
const f = (value: string | null) => ({ value, missingReasonCode: null });
vi.mock('@/lib/aie/adapters/bankStatement/gateway', () => ({
  BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT: 'x',
  requestBankStatementAiExtraction: async (p: { maskedText: string; requestId?: string }) => {
    h.aiCalls += 1;
    const seq = Number(/part(\d+)$/.exec(p.requestId ?? '')?.[1] ?? -1);
    const tx: Array<Record<string, unknown>> = [];
    let opening: string | null = null;
    let closing: string | null = null;
    for (const l of p.maskedText.split('\n')) {
      const cells = l.split('|').map((x) => x.trim());
      const dm = /^(\d{2})\/09\/2026$/.exec(cells[0] ?? '');
      if (dm && cells.length >= 5) {
        const debit = cells[2] !== '';
        tx.push({ transactionDate: `2026-09-${dm[1]}`, descriptionRaw: cells[1], amount: debit ? cells[2] : cells[3], creditDebit: debit ? 'debit' : 'credit', balanceAfter: cells[4] });
      }
      const o = /^Opening balance ([\d.]+)$/.exec(l);
      if (o) opening = o[1];
      const c = /^Closing balance ([\d.]+)$/.exec(l);
      if (c) closing = c[1];
    }
    return {
      outcome: 'success',
      facts: { schemaVersion: '1', documentMissingReasonCode: null, institutionName: f(seq === 0 ? 'EXAMPLE CREDIT UNION' : null), maskedAccountIdentifier: f(null), statementPeriodStart: f(seq === 0 ? '2026-09-01' : null), statementPeriodEnd: f(closing ? '2026-09-30' : null), declaredOpeningBalance: f(opening), declaredClosingBalance: f(closing), allTransactionsListed: true, transactions: tx },
      evidence: { idempotencyKey: 'k', providerRequestIds: [], model: 'gpt-4o-mini' },
    };
  },
}));

import { admitBankImport, confirmAiDraftIntoJob } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { advanceBankImportJob, advanceNextBankImportJob } from '@/lib/financial-data-hub/services/bankImportWorker';

const U1 = '00000000-0000-4000-8000-0000000000b1';
const U2 = '00000000-0000-4000-8000-0000000000b2';
const MONTH = parseMonth('2026-09');
let counter = 0;
let accountId = '';

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.db.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

async function seedUser(id: string) {
  await h.db.query(`insert into auth.users(id,email) values ($1,$2) on conflict do nothing`, [id, `${id}@t.test`]);
  await h.db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [id]);
}
async function seedAccount(userId: string): Promise<string> {
  return (await one<{ id: string }>(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','Everyday') returning id`, [userId])).id;
}
async function seedCsv(userId: string, n: number): Promise<string> {
  counter += 1;
  const built = scaleBankStatement(MONTH, n, `P${counter}`);
  const det = detectBankCsvFormat(built.bytes);
  const key = `fdh/${counter}.csv`;
  h.files.set(key, built.bytes);
  const acc = userId === U1 ? accountId : await seedAccount(userId);
  return (await one<{ id: string }>(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, financial_account_id, detection_status, adapter_key, adapter_version,
       malware_scan_status, raw_document_storage_reference)
     values ($1,'csv','bank_statement','AU','AUD','text/csv','queued',$2,'detected',$3,'1','clean',$4) returning id`,
    [userId, acc, det.adapter!.id, key],
  )).id;
}
async function seedPdf(userId: string, lines: string[]): Promise<string> {
  counter += 1;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
  const key = `fdh/${counter}.pdf`;
  h.files.set(key, new Uint8Array(buildMinimalTextPdf(pages)));
  return (await one<{ id: string }>(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, financial_account_id, malware_scan_status, raw_document_storage_reference)
     values ($1,'pdf_native','bank_statement','AU','AUD','application/pdf','queued',$2,'clean',$3) returning id`,
    [userId, accountId, key],
  )).id;
}

async function driveToEnd(jobId: string, userId = U1, maxSlices = 300) {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < maxSlices; i += 1) {
    const out = await advanceBankImportJob(jobId, { userId, sliceBudgetMs: 0 });
    if (out.kind === 'not_found') throw new Error('not found');
    last = out.job as unknown as Record<string, unknown>;
    if (['completed', 'failed', 'review_required'].includes(String(last.status))) return last;
  }
  throw new Error('did not finish');
}
const jobOf = async (docId: string) => (await one(`select * from fdh_bank_import_jobs where statement_upload_id = $1`, [docId]))!;
const txCount = (docId: string) => count(`select count(*) n from fdh_transactions where statement_upload_id = $1`, [docId]);
/** Inserts rows exactly as staged (what a dead slice would have written), letting the database fill the columns the staged rows omit. */
async function insertStaged(rows: Array<Record<string, unknown>>) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((c) => `"${c}"`).join(', ');
  await h.db.query(`insert into fdh_transactions (${cols}) select ${cols} from jsonb_populate_recordset(null::fdh_transactions, $1::jsonb)`, [JSON.stringify(rows)]);
}
const distinctRows = (docId: string) => count(`select count(distinct source_row) n from fdh_transactions where statement_upload_id = $1`, [docId]);

beforeAll(async () => {
  h.db = await buildDb();
  h.client = pgliteSupabase(h.db);
  await h.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await seedUser(U1);
  await seedUser(U2);
  accountId = await seedAccount(U1);
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
}, 600_000);
afterAll(async () => {
  await h.db?.close();
});

describe('real Postgres: CSV scale, exact counts, none twice', () => {
  for (const n of [25, 120, 500, 1500, 3000]) {
    it(`${n} rows -> admitted as one queued job, then exactly ${n} stored lines, certified, staging gone`, async () => {
      const docId = await seedCsv(U1, n);
      const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
      expect(adm.kind).toBe('job');
      if (adm.kind !== 'job') return;
      expect(await txCount(docId)).toBe(0); // the admission request wrote no line
      const end = await driveToEnd(adm.job.id);
      expect(end.status).toBe('completed');
      expect(await txCount(docId)).toBe(n);
      expect(await distinctRows(docId)).toBe(n);
      const doc = await one<{ processing_status: string; certification_status: string; certified_row_count: number }>(`select processing_status, certification_status, certified_row_count from fdh_statement_uploads where id=$1`, [docId]);
      expect(doc).toMatchObject({ processing_status: 'approved', certification_status: 'certified', certified_row_count: n });
      expect(await count(`select count(*) n from fdh_bank_import_job_chunks where job_id=$1`, [adm.job.id])).toBe(0);
      expect(await count(`select count(*) n from fdh_reconciliation_results where statement_upload_id=$1`, [docId])).toBe(1);
      expect(await count(`select count(*) n from fdh_data_provenance where entity_id=$1`, [docId])).toBe(1);
      expect((end.result_summary as Record<string, unknown>).transactions_created).toBe(n);
      // asking again answers with the stored result; nothing new is written
      const again = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
      expect(again.kind).toBe('result');
      expect(await txCount(docId)).toBe(n);
    });
  }
});

describe('real Postgres: duplicate admission, concurrent polling, kill and resume, retry', () => {
  it('duplicate admission (sequential and concurrent) creates ONE job; the unique constraints decide', async () => {
    const docId = await seedCsv(U1, 120);
    const results = await Promise.all([1, 2, 3, 4].map(() => admitBankImport({ userId: U1, documentId: docId, kind: 'csv' })));
    const ids = new Set(results.map((r) => (r.kind === 'job' ? r.job.id : 'x')));
    expect(ids.size).toBe(1);
    expect(await count(`select count(*) n from fdh_bank_import_jobs where statement_upload_id=$1`, [docId])).toBe(1);
    await driveToEnd([...ids][0]);
    expect(await txCount(docId)).toBe(120);
  });

  it('two callers polling at the same moment: the real lease function lets exactly one work', async () => {
    const docId = await seedCsv(U1, 600);
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    const outs = await Promise.all([1, 2, 3].map(() => advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 })));
    expect(outs.filter((o) => o.kind === 'advanced')).toHaveLength(1);
    expect(outs.filter((o) => o.kind === 'busy')).toHaveLength(2);
    await driveToEnd(adm.job.id);
    expect(await txCount(docId)).toBe(600);
  });

  it('a slice killed after writing a batch and before its checkpoint: taken over after the lease runs out, exact result, takeover counted', async () => {
    const docId = await seedCsv(U1, 600);
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    await advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 }); // read
    await advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 }); // batch 1
    // the dead slice also wrote batch 2 (rows 251-500) but never checkpointed, and still holds an unexpired lease
    const staged = await one<{ payload: { rows: Array<Record<string, unknown>> } }>(`select payload from fdh_bank_import_job_chunks where job_id=$1 and kind='plan_rows' and seq=1`, [adm.job.id]);
    await insertStaged(staged.payload.rows);
    expect(await txCount(docId)).toBe(500);
    await h.db.query(`update fdh_bank_import_jobs set status='processing', lease_owner='dead-owner-pg-1', lease_expires_at=now() + interval '40 seconds', progress_done=250 where id=$1`, [adm.job.id]);
    // while the dead slice's lease is still live nobody else may work on it
    expect((await advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 })).kind).toBe('busy');
    await h.db.query(`update fdh_bank_import_jobs set lease_expires_at = now() - interval '1 second' where id=$1`, [adm.job.id]);
    const end = await driveToEnd(adm.job.id);
    expect(end.status).toBe('completed');
    expect(await txCount(docId)).toBe(600);
    expect(await distinctRows(docId)).toBe(600);
    expect(Number((await jobOf(docId)).reclaim_count)).toBeGreaterThanOrEqual(1);
  });

  it('the real unique index stops a double write even if the worker\'s own rule were bypassed', async () => {
    const docId = await seedCsv(U1, 300);
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    await advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 });
    await advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 });
    const staged = await one<{ payload: { rows: Array<Record<string, unknown>> } }>(`select payload from fdh_bank_import_job_chunks where job_id=$1 and kind='plan_rows' and seq=0`, [adm.job.id]);
    let message = '';
    try {
      await insertStaged(staged.payload.rows.slice(0, 3));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/uq_fdh_transactions_statement_source_row|duplicate key/);
    await driveToEnd(adm.job.id);
    expect(await txCount(docId)).toBe(300);
  });

  it('killed in the middle of finalize: redone once, exactly one reconciliation / provenance row, statement certified', async () => {
    const docId = await seedCsv(U1, 120);
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    for (let i = 0; i < 20; i += 1) {
      const out = await advanceBankImportJob(adm.job.id, { userId: U1, sliceBudgetMs: 0 });
      if (out.kind === 'advanced' && out.job.phase === 'finalize') break;
    }
    expect((await jobOf(docId)).phase).toBe('finalize');
    await h.db.query(`insert into fdh_reconciliation_results (user_id, statement_upload_id, status, reconciliation_method) values ($1,$2,'not_available','none')`, [U1, docId]);
    await h.db.query(`insert into fdh_data_provenance (user_id, entity_type, entity_id, source_type, source_statement_id) values ($1,'fdh_statement_upload',$2,'csv',$2)`, [U1, docId]);
    await h.db.query(`update fdh_statement_uploads set processing_status='extracted' where id=$1`, [docId]);
    await h.db.query(`update fdh_bank_import_jobs set status='processing', lease_owner='dead-owner-pg-2', lease_expires_at=now() - interval '1 second', checkpoint = checkpoint || '{"finalize_started": true}'::jsonb where id=$1`, [adm.job.id]);
    const end = await driveToEnd(adm.job.id);
    expect(end.status).toBe('completed');
    expect(await count(`select count(*) n from fdh_reconciliation_results where statement_upload_id=$1`, [docId])).toBe(1);
    expect(await count(`select count(*) n from fdh_data_provenance where entity_id=$1`, [docId])).toBe(1);
    expect(await txCount(docId)).toBe(120);
    expect((await one<{ s: string }>(`select processing_status s from fdh_statement_uploads where id=$1`, [docId])).s).toBe('approved');
  });

  it('retry: a failed job removes its partial lines, restarts as attempt 2 and ends exact', async () => {
    const docId = await seedCsv(U1, 400);
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    const key = (await one<{ k: string }>(`select raw_document_storage_reference k from fdh_statement_uploads where id=$1`, [docId])).k;
    const bytes = h.files.get(key)!;
    h.files.delete(key); // the stored file is unavailable: the read cannot proceed
    const failed = await driveToEnd(adm.job.id);
    expect(failed.status).toBe('failed');
    expect((await one<{ s: string }>(`select processing_status s from fdh_statement_uploads where id=$1`, [docId])).s).toBe('failed');
    h.files.set(key, bytes);
    const retry = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    expect(retry.kind).toBe('job');
    expect(Number((await jobOf(docId)).attempt)).toBe(2);
    const end = await driveToEnd(adm.job.id);
    expect(end.status).toBe('completed');
    expect(await txCount(docId)).toBe(400);
  });

  it('the scheduled backstop finishes an abandoned job with no browser at all', async () => {
    const docId = await seedCsv(U1, 400);
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    for (let i = 0; i < 30; i += 1) {
      const out = await advanceNextBankImportJob({ sliceBudgetMs: 0 });
      if (!out) break;
    }
    expect((await jobOf(docId)).status).toBe('completed');
    expect(await txCount(docId)).toBe(400);
  });
});

describe('real Postgres: tenancy', () => {
  it('another user can neither admit nor advance this statement\'s job, and cannot see it (row-level security)', async () => {
    const docId = await seedCsv(U1, 120);
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    expect(await admitBankImport({ userId: U2, documentId: docId, kind: 'csv' })).toMatchObject({ kind: 'error', status: 404 });
    expect((await advanceBankImportJob(adm.job.id, { userId: U2, sliceBudgetMs: 0 })).kind).toBe('not_found');
    await h.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U2, role: 'authenticated' })]);
    await h.db.exec('set role authenticated;');
    try {
      expect(await count(`select count(*) n from fdh_bank_import_jobs where id=$1`, [adm.job.id])).toBe(0);
      expect(await count(`select count(*) n from fdh_bank_import_job_chunks`)).toBe(0);
    } finally {
      await h.db.exec('reset role;');
      await h.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
    }
    await driveToEnd(adm.job.id);
  });
});

describe('real Postgres: the AI reading in parts (fake provider), confirm, write', () => {
  function pdfLines(n: number) {
    let bal = 20000;
    const lines = ['EXAMPLE CREDIT UNION', 'Everyday account statement', 'Account ending 4321', 'Period: 01/09/2026 to 30/09/2026', 'Opening balance 20000.00', 'Date | Details | Withdrawals | Deposits | Balance'];
    for (let i = 0; i < n; i += 1) {
      const dr = i % 7 !== 0;
      const amt = Math.round((10 + ((i * 7919) % 900) + 0.35) * 100) / 100;
      bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
      lines.push(`${String(1 + (i % 28)).padStart(2, '0')}/09/2026 | PURCHASE ${i + 1} S${n} | ${dr ? amt.toFixed(2) : ''} | ${dr ? '' : amt.toFixed(2)} | ${bal.toFixed(2)}`);
    }
    lines.push(`Closing balance ${bal.toFixed(2)}`);
    return lines;
  }

  for (const n of [120, 1500]) {
    it(`${n}-line unrecognised-layout PDF: read in parts, draft waits, confirm queues the write, exactly ${n} lines, reconciled`, async () => {
      const docId = await seedPdf(U1, pdfLines(n));
      h.aiCalls = 0;
      const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'pdf' });
      if (adm.kind !== 'job') throw new Error('job expected');
      expect(h.aiCalls).toBe(0); // admission read nothing and sent nothing
      const review = await driveToEnd(adm.job.id);
      expect(review).toMatchObject({ status: 'review_required', review_reason: 'ai_draft', phase: 'ai_review' });
      const parts = Number((review.checkpoint as Record<string, unknown>).parts_total);
      expect(h.aiCalls).toBe(parts);
      expect(await txCount(docId)).toBe(0);
      const draft = await one<{ payload: { rows: Array<Record<string, unknown>>; statementPeriodStart: string; statementPeriodEnd: string; declaredOpeningBalance: number; declaredClosingBalance: number }; status: string }>(
        `select payload, status from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
      expect(draft.status).toBe('pending_review');
      expect(draft.payload.rows).toHaveLength(n);
      const reviewed = {
        rows: draft.payload.rows.map((r, i) => ({ ...r, sourceRowNumber: i + 1 })) as never,
        statementPeriodStart: draft.payload.statementPeriodStart, statementPeriodEnd: draft.payload.statementPeriodEnd,
        declaredOpeningBalance: draft.payload.declaredOpeningBalance, declaredClosingBalance: draft.payload.declaredClosingBalance, maskedAccountIdentifier: null,
      };
      const c1 = await confirmAiDraftIntoJob({ userId: U1, documentId: docId, reviewed });
      const c2 = await confirmAiDraftIntoJob({ userId: U1, documentId: docId, reviewed });
      expect([c1.kind, c2.kind]).toEqual(['job', 'job']);
      expect(await count(`select count(*) n from fdh_ai_fallback_drafts where statement_upload_id=$1 and status='confirmed'`, [docId])).toBe(1);
      const end = await driveToEnd(adm.job.id);
      expect(end.status).toBe('completed');
      expect(await txCount(docId)).toBe(n);
      expect(await distinctRows(docId)).toBe(n);
      const doc = await one<{ processing_status: string; certification_status: string; reconciliation_status: string }>(`select processing_status, certification_status, reconciliation_status from fdh_statement_uploads where id=$1`, [docId]);
      expect(doc).toMatchObject({ processing_status: 'approved', certification_status: 'certified', reconciliation_status: 'reconciled' });
    }, 180_000);
  }
});
