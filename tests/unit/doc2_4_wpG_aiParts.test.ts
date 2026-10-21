/**
 * Document2 (4) WP-G (F15) -- a LONG bank PDF read through the AI fallback in PARTS across short slices.
 *
 * Evidence label: UNIT-TESTED (the AI provider is a fake that reads the synthetic lines of the part it is given; no real provider call,
 * no DEV). The real provider timings are measured in the DEV driver (scripts/doc2_4_wp_g_dev_run.ts).
 *
 * Proven: the page text is cut into small masked parts (every line exactly once, in order); the parts are read a few at a time, one
 * short slice after another; each part is read ONCE even if a slice is killed; a part that fails is retried by a later slice; the cap
 * and a lapsed plan stop the reading and keep what was read; the merged draft waits for the person; confirming it queues the writing
 * (idempotently) and a 120 and a 3,000-line statement end with exactly that many stored lines and a reconciled statement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBankImportFake, type BankImportFake } from './support/bankImportFake';
import type { Row } from './support/inMemorySupabase';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { AI_PAGE_SEPARATOR, aiPartPrompt, mergePartReadings, splitMaskedPagesIntoParts, type MappedPartReading } from '@/lib/financial-data-hub/bankImport/aiChunking';

const h = vi.hoisted(() => ({
  fake: null as unknown as BankImportFake,
  files: new Map<string, Uint8Array>(),
  audits: [] as string[],
  aiCalls: [] as number[], // part seq per provider call
  aiMode: { outcome: 'ok' as 'ok' | 'timeout_once' | 'cap_after' , failSeq: new Set<number>(), capAfterCalls: 0 },
  egressOk: true,
  gateOk: true,
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.fake.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.fake.client }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async (key: string) => (h.files.has(key) ? { ok: true as const, bytes: h.files.get(key)! } : { ok: false as const, message: 'gone' }),
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: async (e: { eventType: string }) => { h.audits.push(e.eventType); } }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ purgeRawDocumentAfterAiConfirm: async () => ({ status: 'skipped' }) }));
vi.mock('@/lib/financial-data-hub/services/identicalUpload', async (orig) => ({
  ...(await orig<typeof import('@/lib/financial-data-hub/services/identicalUpload')>()),
  findEarlierIdenticalUpload: async () => null,
}));
vi.mock('@/lib/aie/adapters/bankStatement/featureFlags', () => ({ isAieBankStatementAiFallbackEnabled: () => true }));
vi.mock('@/lib/aie/adapters/shared/fallbackGate', () => ({
  evaluateAiFallbackGate: async (p: { extractedText: string }) => (h.gateOk ? { ok: true, maskedText: p.extractedText, coverageByType: {}, totalMatches: 0 } : { ok: false, reason: 'premium_required' }),
  evaluateAiEgressPreconditions: async () => (h.egressOk ? { ok: true } : { ok: false, reason: 'premium_required' }),
}));

const f = (value: string | null) => ({ value, missingReasonCode: null });
vi.mock('@/lib/aie/adapters/bankStatement/gateway', () => ({
  BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT: 'x',
  // A fake reader: it reads the dated lines of the part it is given ("DD/09/2026 | text | withdrawal | deposit | balance").
  requestBankStatementAiExtraction: async (p: { maskedText: string; requestId?: string }) => {
    const seq = Number(/part(\d+)$/.exec(p.requestId ?? '')?.[1] ?? -1);
    h.aiCalls.push(seq);
    if (h.aiMode.outcome === 'cap_after' && h.aiCalls.length > h.aiMode.capAfterCalls) return { outcome: 'user_daily_cap_reached' };
    if (h.aiMode.failSeq.has(seq)) {
      h.aiMode.failSeq.delete(seq);
      return { outcome: 'timeout' };
    }
    const lines = p.maskedText.split('\n');
    const tx: Array<Record<string, unknown>> = [];
    let opening: string | null = null;
    let closing: string | null = null;
    for (const l of lines) {
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
      facts: {
        schemaVersion: '1', documentMissingReasonCode: null, institutionName: f(seq === 0 ? 'EXAMPLE CREDIT UNION' : null), maskedAccountIdentifier: f(seq === 0 ? 'ending 4321' : null),
        statementPeriodStart: f(seq === 0 ? '2026-09-01' : null), statementPeriodEnd: f(closing ? '2026-09-30' : null),
        declaredOpeningBalance: f(opening), declaredClosingBalance: f(closing), allTransactionsListed: true, transactions: tx,
      },
      evidence: { idempotencyKey: 'k', providerRequestIds: [], model: 'gpt-4o-mini' },
    };
  },
}));

import { admitBankImport, confirmAiDraftIntoJob } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { advanceBankImportJob } from '@/lib/financial-data-hub/services/bankImportWorker';

const U1 = 'user-1';
const ACCT = 'acct-1';
const DOC = 'doc-ai';

/** An unrecognised layout (so the certified readers refuse it and the AI reading takes over), n transaction lines, 55 lines a page. */
function unrecognisedStatementPdf(n: number): { bytes: Uint8Array; lines: string[]; closing: string } {
  let bal = 20000;
  const lines = ['EXAMPLE CREDIT UNION', 'Everyday account statement', 'Account ending 4321', 'Period: 01/09/2026 to 30/09/2026', 'Opening balance 20000.00', 'Date | Details | Withdrawals | Deposits | Balance'];
  for (let i = 0; i < n; i += 1) {
    const dr = i % 7 !== 0;
    const amt = Math.round((10 + ((i * 7919) % 900) + 0.35) * 100) / 100;
    bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
    lines.push(`${String(1 + (i % 28)).padStart(2, '0')}/09/2026 | PURCHASE ${i + 1} | ${dr ? amt.toFixed(2) : ''} | ${dr ? '' : amt.toFixed(2)} | ${bal.toFixed(2)}`);
  }
  lines.push(`Closing balance ${bal.toFixed(2)}`);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
  return { bytes: new Uint8Array(buildMinimalTextPdf(pages)), lines, closing: bal.toFixed(2) };
}

function seedPdfDocument(n: number, docId = DOC) {
  const built = unrecognisedStatementPdf(n);
  h.files.set(`fdh/${docId}.pdf`, built.bytes);
  h.fake.db.tables.fdh_statement_uploads = [
    ...(h.fake.db.tables.fdh_statement_uploads ?? []),
    {
      id: docId, user_id: U1, household_id: null, financial_account_id: ACCT, currency_code: 'AUD', country_code: 'AU', document_type: 'bank_statement',
      processing_status: 'queued', processing_started_at: null, processing_completed_at: null, certification_status: null, error_code: null,
      detection_status: null, adapter_key: null, malware_scan_status: 'clean', raw_document_storage_reference: `fdh/${docId}.pdf`, raw_document_purge_status: 'not_required',
      statement_period_start: null, statement_period_end: null, duplicate_of_document_id: null, parser_id: null, parser_version_id: null, mime_type: 'application/pdf', page_count: null,
    },
  ];
  return built;
}
const txFor = (docId = DOC) => h.fake.rows('fdh_transactions').filter((t) => t.statement_upload_id === docId);
const doc = (docId = DOC) => h.fake.rows('fdh_statement_uploads').find((d) => d.id === docId) as Row;
const job = () => h.fake.jobs()[0];

async function driveUntil(stop: (j: Row) => boolean, maxSlices = 300, jobId?: string): Promise<{ slices: number; job: Row }> {
  const id = jobId ?? String(job().id);
  let slices = 0;
  while (slices < maxSlices) {
    const out = await advanceBankImportJob(id, { userId: U1, sliceBudgetMs: 0 });
    slices += 1;
    if (out.kind === 'not_found') throw new Error('job not found');
    if (stop(out.job as unknown as Row)) return { slices, job: out.job as unknown as Row };
    if (['completed', 'failed', 'review_required'].includes(String(out.job.status)) && !stop(out.job as unknown as Row)) return { slices, job: out.job as unknown as Row };
  }
  throw new Error('did not reach the expected state');
}

beforeEach(() => {
  h.fake = createBankImportFake();
  h.files.clear();
  h.audits.length = 0;
  h.aiCalls.length = 0;
  h.aiMode = { outcome: 'ok', failSeq: new Set(), capAfterCalls: 0 };
  h.egressOk = true;
  h.gateOk = true;
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
});

describe('splitting the masked text into parts (pure)', () => {
  it('every line appears exactly once, in order, in parts of a few dozen lines, with ascending page ranges', () => {
    const { lines } = unrecognisedStatementPdf(3000);
    const pages: string[] = [];
    for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55).join('\n'));
    const parts = splitMaskedPagesIntoParts(pages);
    expect(parts.length).toBeGreaterThan(80);
    expect(parts.map((p) => p.seq)).toEqual(parts.map((_, i) => i));
    expect(parts.flatMap((p) => p.text.split('\n'))).toEqual(lines);
    for (const p of parts) {
      expect(p.lineCount).toBeLessThanOrEqual(42); // 28 target, 1.5x for an unsplittable page tail
      expect(p.text.length).toBeLessThanOrEqual(5500);
    }
    for (let i = 1; i < parts.length; i += 1) expect(parts[i].pageFrom).toBeGreaterThanOrEqual(parts[i - 1].pageTo);
  });

  it('a small statement is one part; blank pages are skipped; the prompt names the part and its pages', () => {
    const parts = splitMaskedPagesIntoParts(['a\nb\nc', '', 'd\ne']);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ seq: 0, pageFrom: 1, pageTo: 3, lineCount: 5 });
    expect(aiPartPrompt(parts[0], 1)).toMatch(/part 1 of 1 .*pages 1 to 3/);
  });

  it('merging: opening balance from the first part, closing from the last, a part that did not list every line makes the whole reading incomplete', () => {
    const md = (o: number | null, c: number | null) => ({ declaredOpeningBalance: o, declaredClosingBalance: c, maskedAccountIdentifier: null, statementPeriodStart: null, statementPeriodEnd: null });
    const row = (n: number) => ({ sourceRowNumber: n, transactionDate: '2026-09-01', descriptionRaw: `r${n}`, amountOriginal: n, creditDebit: 'debit' as const, balanceAfter: null });
    const parts: MappedPartReading[] = [
      { seq: 1, rows: [row(2)], statementMetadata: md(999, 111), allTransactionsListed: true, institutionName: null, warnings: ['x'] },
      { seq: 0, rows: [row(1)], statementMetadata: md(100, null), allTransactionsListed: true, institutionName: 'Bank', warnings: [] },
      { seq: 2, rows: [row(3)], statementMetadata: md(null, 300), allTransactionsListed: false, institutionName: null, warnings: [] },
    ];
    const merged = mergePartReadings(parts);
    expect(merged.rows.map((r) => r.descriptionRaw)).toEqual(['r1', 'r2', 'r3']);
    expect(merged.statementMetadata.declaredOpeningBalance).toBe(100); // not the "carried forward" 999 of a middle part
    expect(merged.statementMetadata.declaredClosingBalance).toBe(300);
    expect(merged.allTransactionsListed).toBe(false);
    expect(merged.warnings).toContain('part_2:x');
    expect(merged.institutionName).toBe('Bank');
    void AI_PAGE_SEPARATOR;
  });
});

describe('the AI reading in parts, end to end', () => {
  async function admitAndRead(n: number) {
    seedPdfDocument(n);
    const adm = await admitBankImport({ userId: U1, documentId: DOC, kind: 'pdf' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    expect(txFor()).toHaveLength(0); // the admission request read nothing
    return adm.job;
  }

  it('a 120-line statement: parts read a few at a time, one short slice each; the merged draft waits for the person; nothing is written yet', async () => {
    await admitAndRead(120);
    const { slices, job: j } = await driveUntil((x) => x.status === 'review_required');
    expect({ s: j.status, e: j.error_code, m: j.error_message_sanitised }).toEqual({ s: 'review_required', e: null, m: null });
    expect(j).toMatchObject({ status: 'review_required', review_reason: 'ai_draft', phase: 'ai_review' });
    const parts = Number((j.checkpoint as Record<string, unknown>).parts_total);
    expect(parts).toBeGreaterThan(3);
    expect(h.aiCalls).toHaveLength(parts); // each part was read once
    expect(new Set(h.aiCalls).size).toBe(parts);
    expect(slices).toBeLessThanOrEqual(parts + 2); // never more than one slice per part, in fact ~parts/4
    const draft = h.fake.rows('fdh_ai_fallback_drafts')[0];
    expect((draft.payload as { rows: unknown[] }).rows).toHaveLength(120);
    expect(draft.status).toBe('pending_review');
    expect(txFor()).toHaveLength(0);
    expect(h.fake.rows('fdh_bank_import_job_chunks')).toHaveLength(0); // the parts did their job and are gone
    expect(doc().processing_status).toBe('processing'); // parked, as before, until the person confirms
    // asking to process again returns the waiting draft inline; it does not read anything again
    const again = await admitBankImport({ userId: U1, documentId: DOC, kind: 'pdf' });
    expect(again.kind).toBe('result');
    expect(h.aiCalls).toHaveLength(parts);
  });

  it('confirming queues the writing (replays find the same job); the lines end exact and the statement reconciles', async () => {
    await admitAndRead(120);
    await driveUntil((x) => x.status === 'review_required');
    const draft = h.fake.rows('fdh_ai_fallback_drafts')[0].payload as { rows: Array<Record<string, unknown>>; statementPeriodStart: string; statementPeriodEnd: string; declaredOpeningBalance: number; declaredClosingBalance: number; maskedAccountIdentifier: string | null };
    const reviewed = {
      rows: draft.rows.map((r, i) => ({ ...(r as object), sourceRowNumber: i + 1 })) as never,
      statementPeriodStart: draft.statementPeriodStart, statementPeriodEnd: draft.statementPeriodEnd,
      declaredOpeningBalance: draft.declaredOpeningBalance, declaredClosingBalance: draft.declaredClosingBalance, maskedAccountIdentifier: null,
    };
    const first = await confirmAiDraftIntoJob({ userId: U1, documentId: DOC, reviewed });
    const second = await confirmAiDraftIntoJob({ userId: U1, documentId: DOC, reviewed });
    expect(first.kind).toBe('job');
    expect(second.kind).toBe('job');
    expect(h.fake.jobs()).toHaveLength(1);
    expect(h.fake.rows('fdh_ai_fallback_drafts').filter((d) => d.status === 'confirmed')).toHaveLength(1);
    const { job: end } = await driveUntil((x) => x.status === 'completed');
    expect(end.status).toBe('completed');
    expect(txFor()).toHaveLength(120);
    expect(new Set(txFor().map((t) => t.source_row)).size).toBe(120);
    expect(doc()).toMatchObject({ processing_status: 'approved', certification_status: 'certified', reconciliation_status: 'reconciled' });
    expect((end.result_summary as Record<string, unknown>).transactions_created).toBe(120);
    // a third confirm after completion returns the stored result and writes nothing
    const third = await confirmAiDraftIntoJob({ userId: U1, documentId: DOC, reviewed });
    expect(third.kind).toBe('result');
    expect(txFor()).toHaveLength(120);
  });

  it('a 3,000-line statement (55 pages): ends with exactly 3,000 stored lines, none twice, reconciled; every slice is one short unit', async () => {
    await admitAndRead(3000);
    const { slices, job: j } = await driveUntil((x) => x.status === 'review_required');
    const parts = Number((j.checkpoint as Record<string, unknown>).parts_total);
    expect(parts).toBeGreaterThan(80);
    expect(h.aiCalls).toHaveLength(parts);
    const draft = h.fake.rows('fdh_ai_fallback_drafts')[0].payload as { rows: Array<Record<string, unknown>>; statementPeriodStart: string; statementPeriodEnd: string; declaredOpeningBalance: number; declaredClosingBalance: number };
    expect(draft.rows).toHaveLength(3000);
    expect(slices).toBeLessThan(parts); // several parts per slice
    const reviewed = {
      rows: draft.rows.map((r, i) => ({ ...(r as object), sourceRowNumber: i + 1 })) as never,
      statementPeriodStart: draft.statementPeriodStart, statementPeriodEnd: draft.statementPeriodEnd,
      declaredOpeningBalance: draft.declaredOpeningBalance, declaredClosingBalance: draft.declaredClosingBalance, maskedAccountIdentifier: null,
    };
    await confirmAiDraftIntoJob({ userId: U1, documentId: DOC, reviewed });
    const { job: end } = await driveUntil((x) => x.status === 'completed', 400);
    expect(end.status).toBe('completed');
    expect(txFor()).toHaveLength(3000);
    expect(new Set(txFor().map((t) => t.source_row)).size).toBe(3000);
    expect(doc()).toMatchObject({ certification_status: 'certified', reconciliation_status: 'reconciled' });
  }, 120_000);

  it('a slice killed mid-reading is taken over: parts already read are NOT read (or paid for) again', async () => {
    await admitAndRead(300);
    await advanceBankImportJob(String(job().id), { userId: U1, sliceBudgetMs: 0 }); // read -> stages parts
    await advanceBankImportJob(String(job().id), { userId: U1, sliceBudgetMs: 0 }); // first batch of parts
    const readSoFar = [...h.aiCalls];
    expect(readSoFar.length).toBeGreaterThan(0);
    Object.assign(job(), { status: 'processing', lease_owner: 'dead-owner-ai-1', lease_expires_at: new Date(Date.now() - 1000).toISOString() });
    await driveUntil((x) => x.status === 'review_required');
    const parts = Number((job().checkpoint as Record<string, unknown>).parts_total);
    expect(h.aiCalls).toHaveLength(parts);
    expect(new Set(h.aiCalls).size).toBe(parts); // no part twice
  });

  it('a part that fails is retried by a later slice (and only that part)', async () => {
    await admitAndRead(120);
    h.aiMode.failSeq = new Set([1]);
    await driveUntil((x) => x.status === 'review_required');
    expect(h.aiCalls.filter((s) => s === 1)).toHaveLength(2);
    const others = h.aiCalls.filter((s) => s !== 1);
    expect(new Set(others).size).toBe(others.length);
  });

  it('the daily AI cap stops the reading, keeps what was read, says so plainly, and a later retry reads only the missing parts', async () => {
    await admitAndRead(300);
    h.aiMode = { outcome: 'cap_after', failSeq: new Set(), capAfterCalls: 4 };
    const { job: failed } = await driveUntil((x) => x.status === 'failed');
    expect(failed.error_code).toBe('ai_daily_limit');
    expect(String(failed.error_message_sanitised)).toMatch(/today/i);
    expect((failed.result_summary as Record<string, unknown>).ai_fallback_refusal).toBe('daily_limit_reached');
    const kept = h.fake.rows('fdh_bank_import_job_chunks').filter((c) => c.kind === 'ai_result').length;
    expect(kept).toBe(4);
    h.aiMode = { outcome: 'ok', failSeq: new Set(), capAfterCalls: 0 };
    h.aiCalls.length = 0;
    const retry = await admitBankImport({ userId: U1, documentId: DOC, kind: 'pdf' });
    expect(retry.kind).toBe('job');
    await driveUntil((x) => x.status === 'review_required');
    const parts = Number((job().checkpoint as Record<string, unknown>).parts_total);
    expect(h.aiCalls).toHaveLength(parts - kept); // only the parts that were never read
  });

  it('a plan that lapses part-way stops the next step (Premium is re-checked before EVERY step) and keeps what was read', async () => {
    await admitAndRead(300);
    await advanceBankImportJob(String(job().id), { userId: U1, sliceBudgetMs: 0 });
    await advanceBankImportJob(String(job().id), { userId: U1, sliceBudgetMs: 0 });
    const before = h.aiCalls.length;
    h.egressOk = false;
    const { job: failed } = await driveUntil((x) => x.status === 'failed');
    expect(h.aiCalls.length).toBe(before); // no further part was sent
    expect(failed.error_code).toBe('ai_premium_required');
    expect((failed.result_summary as Record<string, unknown>).ai_fallback_refusal).toBe('premium_required');
  });

  it('a Free user (gate refuses before anything is read): the statement is refused with the upgrade note, nothing is sent to the AI', async () => {
    seedPdfDocument(120);
    h.gateOk = false;
    const adm = await admitBankImport({ userId: U1, documentId: DOC, kind: 'pdf' });
    if (adm.kind !== 'job') throw new Error('expected a job');
    const { job: end } = await driveUntil((x) => x.status === 'failed', 20, adm.job.id);
    expect(h.aiCalls).toHaveLength(0);
    expect((end.result_summary as Record<string, unknown>).ai_fallback_refusal).toBe('premium_required');
    expect(doc()).toMatchObject({ processing_status: 'rejected', error_code: 'layout_unsupported' });
  });

  it('tenancy: another user can neither confirm nor advance this reading', async () => {
    await admitAndRead(120);
    await driveUntil((x) => x.status === 'review_required');
    const out = await confirmAiDraftIntoJob({ userId: 'user-2', documentId: DOC, reviewed: { rows: [{ sourceRowNumber: 1, transactionDate: '2026-09-01', descriptionRaw: 'x', amountOriginal: 1, creditDebit: 'debit', balanceAfter: null }], statementPeriodStart: null, statementPeriodEnd: null, declaredOpeningBalance: null, declaredClosingBalance: null, maskedAccountIdentifier: null } });
    expect(out).toMatchObject({ kind: 'error', status: 404 });
    expect(h.fake.rows('fdh_ai_fallback_drafts').filter((d) => d.status === 'confirmed')).toHaveLength(0);
  });
});
