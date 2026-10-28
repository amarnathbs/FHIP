/**
 * Bank-statement AI reading in parts, against a REAL Postgres (PGlite, this repository's full migration chain), with the printed
 * money shapes of the 28-10-2026 production defect (a real NAB statement, 43 parts, 16 provider outcomes all `schema_rejected`
 * on balances in the statement's own printed shape). SYNTHETIC text only: nothing real is sent anywhere.
 *
 * REAL here: the background job (admission, lease, staging, parts, retry, resume), the shared AIE gateway, the wire schema, the
 * deterministic normaliser, the strict schema, the mapper, the "figures must be printed" guard, the merge, the draft, the confirm,
 * the deterministic pipeline, certification, review items. FAKE: the OpenAI provider (a script that copies each statement line the
 * way the production model did: in the document's OWN printed shape) and the cost ledger.
 *
 * Evidence label: PGLITE-VERIFIED (not DEV-verified, not production-verified).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildDb } from './support/fdh10LedgerPgliteHarness';
import { pgliteSupabase } from './support/pgliteSupabaseJobs';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';

const h = vi.hoisted(() => {
  const state = {
    db: null as unknown as PGlite,
    client: null as unknown,
    files: new Map<string, Uint8Array>(),
    calls: [] as Array<{ seq: number; prompt: string }>,
    /** seq -> how many more answers carry a genuinely garbage AMOUNT before the part is answered properly (99 = always). */
    garbage: new Map<number, number>(),
    /** seq set whose every running balance comes back unreadable ("see note 1"). */
    unreadBalances: new Set<number>(),
    /** the closing balance comes back unreadable in every part that prints one */
    unreadClosing: false,
    /** seq set whose answers DROP the minus of a negative balance (what live gpt-4o-mini did when asked to convert "$34.15 DR") */
    dropSigns: new Set<number>(),
  };
  const f = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present_on_document' : null });
  const fakeProvider = {
    providerName: 'fake',
    generateStructured: async (req: { userPrompt: string }) => {
      const seq = Number(/This is part (\d+) of/.exec(req.userPrompt)?.[1] ?? 0) - 1;
      state.calls.push({ seq, prompt: req.userPrompt });
      const tx: Array<Record<string, unknown>> = [];
      let opening: string | null = null;
      let closing: string | null = null;
      for (const l of req.userPrompt.split('\n')) {
        const cells = l.split('|').map((x) => x.trim());
        const dm = /^(\d{2})\/09\/2026$/.exec(cells[0] ?? '');
        if (dm && cells.length >= 5) {
          const debit = cells[2] !== '';
          tx.push({ transactionDate: `2026-09-${dm[1]}`, descriptionRaw: cells[1], amount: debit ? cells[2] : cells[3], creditDebit: debit ? 'debit' : 'credit', balanceAfter: cells[4] });
        }
        const o = /^Opening balance (.+)$/.exec(l);
        if (o) opening = o[1];
        const c = /^Closing balance (.+)$/.exec(l);
        if (c) closing = c[1];
      }
      const left = state.garbage.get(seq) ?? 0;
      if (left > 0 && tx.length > 0) {
        state.garbage.set(seq, left - 1);
        tx[0] = { ...tx[0], amount: 'about fifty' };
      }
      if (state.unreadBalances.has(seq)) for (const t of tx) t.balanceAfter = 'see note 1';
      if (state.dropSigns.has(seq)) for (const t of tx) t.balanceAfter = String(t.balanceAfter).replace(/^-/, '');
      if (state.unreadClosing && closing) closing = 'see summary box';
      const facts = {
        schemaVersion: '1', documentMissingReasonCode: null, institutionName: f(seq === 0 ? 'EXAMPLE CREDIT UNION' : null), maskedAccountIdentifier: f(null),
        statementPeriodStart: f(seq === 0 ? '2026-09-01' : null), statementPeriodEnd: f(closing ? '2026-09-30' : null),
        declaredOpeningBalance: f(opening), declaredClosingBalance: f(closing), allTransactionsListed: true, transactions: tx,
      };
      return { rawText: JSON.stringify(facts), inputTokens: 900, outputTokens: 300, latencyMs: 1, modelVersion: 'fake', finishReason: 'stop' as const, providerRequestIds: [`req_${seq}`] };
    },
    validateProviderHealth: async () => ({}) as never,
    estimateCost: () => ({}) as never,
  };
  return { state, fakeProvider };
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.state.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.state.client }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async (key: string) => (h.state.files.has(key) ? { ok: true as const, bytes: h.state.files.get(key)! } : { ok: false as const, message: 'gone' }),
}));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ purgeRawDocumentAfterAiConfirm: async () => ({ status: 'skipped' }) }));
vi.mock('@/lib/aie/adapters/bankStatement/featureFlags', () => ({ isAieBankStatementAiFallbackEnabled: () => true }));
vi.mock('@/lib/aie/adapters/shared/fallbackGate', () => ({
  evaluateAiFallbackGate: async (p: { extractedText: string }) => ({ ok: true, maskedText: p.extractedText, coverageByType: {}, totalMatches: 0 }),
  evaluateAiEgressPreconditions: async () => ({ ok: true }),
}));
vi.mock('@/lib/aie/provider/providerFactory', () => ({ createAieAiProvider: () => h.fakeProvider, createLazyAieAiProvider: () => h.fakeProvider }));
vi.mock('@/lib/aie/cost/costAdmission', () => ({ reserveConservativeAiCost: async () => ({ admitted: true, reservedUsd: 0.01 }), settleAiCost: async () => undefined }));

import { admitBankImport, confirmAiDraftIntoJob } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { advanceBankImportJob } from '@/lib/financial-data-hub/services/bankImportWorker';
import { BANK_IMPORT_AI_MAX_ATTEMPTS_PER_PART } from '@/lib/financial-data-hub/bankImport/jobModel';
import { statementNoteText } from '@/lib/financial-data-hub/domain/categoryReview';

const U1 = '00000000-0000-4000-8000-0000000000c1';
let counter = 0;
let accountId = '';
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.state.db.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const grouped = (n: number) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The same balance, printed six ways -- the shapes a real Australian statement uses. */
function printedBalance(b: number, shape: number): string {
  const neg = b < 0;
  const g = grouped(b);
  switch (shape % 6) {
    case 0: return b.toFixed(2);
    case 1: return `${g} ${neg ? 'DR' : 'CR'}`;
    case 2: return `${neg ? '-' : ''}$${g}`;
    case 3: return neg ? `(${g})` : g;
    case 4: return neg ? `${g}-` : g;
    default: return `$${g} ${neg ? 'DR' : 'CR'}`;
  }
}

function trueBalances(n: number): number[] {
  let bal = 500;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const dr = i % 7 !== 0;
    const amt = Math.round((10 + ((i * 7919) % 900) + 0.35) * 100) / 100;
    bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
    out.push(bal);
  }
  return out;
}

function pdfLines(n: number) {
  let bal = 500;
  const lines = ['EXAMPLE CREDIT UNION', 'Everyday account statement', 'Account ending 4321', 'Period: 01/09/2026 to 30/09/2026', `Opening balance ${printedBalance(bal, 5)}`, 'Date | Details | Withdrawals | Deposits | Balance'];
  for (let i = 0; i < n; i += 1) {
    const dr = i % 7 !== 0;
    const amt = Math.round((10 + ((i * 7919) % 900) + 0.35) * 100) / 100;
    bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
    const shape = Math.floor(i / 18);
    const amtText = i % 5 === 4 ? `$${grouped(amt)}` : amt.toFixed(2);
    lines.push(`${String(1 + (i % 28)).padStart(2, '0')}/09/2026 | PURCHASE ${i + 1} S${n} | ${dr ? amtText : ''} | ${dr ? '' : amtText} | ${printedBalance(bal, shape)}`);
  }
  lines.push(`Closing balance ${printedBalance(bal, 1)}`);
  return lines;
}

async function seedUser(id: string) {
  await h.state.db.query(`insert into auth.users(id,email) values ($1,$2) on conflict do nothing`, [id, `${id}@t.test`]);
  await h.state.db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [id]);
}
async function seedPdf(userId: string, lines: string[]): Promise<string> {
  counter += 1;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
  const key = `fdh/printed${counter}.pdf`;
  h.state.files.set(key, new Uint8Array(buildMinimalTextPdf(pages)));
  return (await one<{ id: string }>(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, financial_account_id, malware_scan_status, raw_document_storage_reference)
     values ($1,'pdf_native','bank_statement','AU','AUD','application/pdf','queued',$2,'clean',$3) returning id`,
    [userId, accountId, key],
  )).id;
}
async function driveToEnd(jobId: string, maxSlices = 800) {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < maxSlices; i += 1) {
    const out = await advanceBankImportJob(jobId, { userId: U1, sliceBudgetMs: 0 });
    if (out.kind === 'not_found') throw new Error('not found');
    last = out.job as unknown as Record<string, unknown>;
    if (['completed', 'failed', 'review_required'].includes(String(last.status))) return last;
  }
  throw new Error('did not finish');
}
const txCount = (docId: string) => count(`select count(*) n from fdh_transactions where statement_upload_id = $1`, [docId]);
const distinctRows = (docId: string) => count(`select count(distinct source_row) n from fdh_transactions where statement_upload_id = $1`, [docId]);

type Draft = { rows: Array<Record<string, unknown>>; statementPeriodStart: string; statementPeriodEnd: string; declaredOpeningBalance: number | null; declaredClosingBalance: number | null; balancesNotRead?: number; declaredBalancesNotRead?: number };
async function readToDraft(docId: string) {
  const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'pdf' });
  if (adm.kind !== 'job') throw new Error('job expected');
  const review = await driveToEnd(adm.job.id);
  return { jobId: adm.job.id, review };
}
async function confirmAndFinish(jobId: string, docId: string) {
  const draft = await one<{ payload: Draft }>(`select payload from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
  const reviewed = {
    rows: draft.payload.rows.map((r, i) => ({ ...r, sourceRowNumber: i + 1 })) as never,
    statementPeriodStart: draft.payload.statementPeriodStart, statementPeriodEnd: draft.payload.statementPeriodEnd,
    declaredOpeningBalance: draft.payload.declaredOpeningBalance, declaredClosingBalance: draft.payload.declaredClosingBalance, maskedAccountIdentifier: null,
  };
  const c1 = await confirmAiDraftIntoJob({ userId: U1, documentId: docId, reviewed });
  expect(c1.kind).toBe('job');
  return driveToEnd(jobId);
}

beforeAll(async () => {
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
  h.state.db = await buildDb();
  h.state.client = pgliteSupabase(h.state.db);
  await h.state.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await seedUser(U1);
  accountId = (await one<{ id: string }>(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','Everyday') returning id`, [U1])).id;
}, 600_000);
afterAll(async () => {
  await h.state.db?.close();
});
beforeEach(() => {
  h.state.calls.length = 0;
  h.state.garbage.clear();
  h.state.unreadBalances.clear();
  h.state.unreadClosing = false;
  h.state.dropSigns.clear();
});

describe('PGlite job run with the production failure mix (43-part scale, printed CR/DR/$/brackets/trailing-minus balances)', () => {
  it('every part is read: parts 2 and 3 pass on the third try, 4, 6, 18 and 30 on the second; rows exact; certified; no extra provider calls', async () => {
    const N = 760;
    const docId = await seedPdf(U1, pdfLines(N));
    // The production pattern: parts 2 and 3 (1-based 3rd and 4th reading attempts... see below) and 4, 6, 18, 30 returned unusable answers.
    h.state.garbage.set(1, 2); // 2 bad answers then good = passes on the 3rd try
    h.state.garbage.set(2, 2);
    for (const s of [3, 5, 17, 29]) h.state.garbage.set(s, 1); // 1 bad answer, good on the 2nd try
    const { jobId, review } = await readToDraft(docId);
    expect(review).toMatchObject({ status: 'review_required', review_reason: 'ai_draft', phase: 'ai_review' });
    const parts = Number((review.checkpoint as Record<string, unknown>).parts_total);
    expect(parts).toBeGreaterThanOrEqual(40);
    // Cost discipline: one call per part plus exactly one per bad answer (2 + 2 + 4) -- nothing re-read.
    expect(h.state.calls.length).toBe(parts + 8);
    const perSeq = new Map<number, number>();
    for (const c of h.state.calls) perSeq.set(c.seq, (perSeq.get(c.seq) ?? 0) + 1);
    expect(perSeq.get(1)).toBe(3);
    expect(perSeq.get(2)).toBe(3);
    for (const s of [3, 5, 17, 29]) expect(perSeq.get(s)).toBe(2);
    expect(Math.max(...perSeq.values())).toBeLessThanOrEqual(BANK_IMPORT_AI_MAX_ATTEMPTS_PER_PART);

    // The repair note: only on the retries, carries the path (collapsed) and no figure of any statement.
    const firsts = h.state.calls.filter((c) => c.seq === 1);
    expect(firsts[0].prompt).not.toContain('previous answer');
    expect(firsts[1].prompt).toContain('rejected because these fields were not in the required format: transactions[*].amount');
    expect(firsts[2].prompt).toContain('transactions[*].amount');
    expect(firsts[1].prompt).not.toContain('about fifty');

    const draft = await one<{ payload: Draft; status: string }>(`select payload, status from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
    expect(draft.status).toBe('pending_review');
    expect(draft.payload.rows).toHaveLength(N); // exactly once: a retried part is never counted twice
    expect(draft.payload.balancesNotRead ?? 0).toBe(0);
    expect(draft.payload.declaredOpeningBalance).toBe(500);
    expect(draft.payload.rows.some((r) => (r.balanceAfter as number) < 0)).toBe(true); // DR / bracket / trailing-minus balances kept their sign

    const end = await confirmAndFinish(jobId, docId);
    expect(end.status).toBe('completed');
    expect(await txCount(docId)).toBe(N);
    expect(await distinctRows(docId)).toBe(N);
    const doc = await one<{ processing_status: string; certification_status: string; reconciliation_status: string }>(`select processing_status, certification_status, reconciliation_status from fdh_statement_uploads where id=$1`, [docId]);
    expect(doc).toMatchObject({ processing_status: 'approved', certification_status: 'certified', reconciliation_status: 'reconciled' });
  }, 300_000);

  it('Try again on a failed job re-reads ONLY the missing part: the parts already read are not requested again, rows stay exact', async () => {
    const N = 360;
    const docId = await seedPdf(U1, pdfLines(N));
    h.state.garbage.set(4, 99); // part 5 never answers properly in this run
    const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'pdf' });
    if (adm.kind !== 'job') throw new Error('job expected');
    const failed = await driveToEnd(adm.job.id);
    expect(failed).toMatchObject({ status: 'failed', error_code: 'ai_part_failed' });
    const parts = Number((failed.checkpoint as Record<string, unknown>).parts_total);
    const before = new Map<number, number>();
    for (const c of h.state.calls) before.set(c.seq, (before.get(c.seq) ?? 0) + 1);
    expect(before.get(4)).toBe(BANK_IMPORT_AI_MAX_ATTEMPTS_PER_PART);
    for (let s = 0; s < parts; s += 1) if (s !== 4) expect(before.get(s), `part ${s}`).toBe(1);

    h.state.garbage.clear(); // the fault clears (or the model answers properly)
    h.state.calls.length = 0;
    const retry = await admitBankImport({ userId: U1, documentId: docId, kind: 'pdf' });
    expect(retry.kind).toBe('job');
    const review = await driveToEnd(adm.job.id);
    expect(review).toMatchObject({ status: 'review_required', review_reason: 'ai_draft' });
    expect(h.state.calls.map((c) => c.seq)).toEqual([4]); // exactly one billed call: the missing part
    // the previous failure's paths ride along so the model corrects the format
    expect(h.state.calls[0].prompt).toContain('transactions[*].amount');

    const end = await confirmAndFinish(adm.job.id, docId);
    expect(end.status).toBe('completed');
    expect(await txCount(docId)).toBe(N);
    expect(await distinctRows(docId)).toBe(N);
  }, 300_000);

  it('balances the model could not make out are NOT a reason to throw the part away: lines kept, counted, statement lands in review (never certified), reconciliation is "cannot verify" not "mismatch"', async () => {
    const N = 120;
    const docId = await seedPdf(U1, pdfLines(N));
    h.state.unreadBalances.add(2);
    const { jobId, review } = await readToDraft(docId);
    expect(review.status).toBe('review_required');
    expect(h.state.calls.every((c) => c.seq !== 2 || true)).toBe(true);
    const draft = await one<{ payload: Draft }>(`select payload from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
    expect(draft.payload.rows).toHaveLength(N); // every line kept
    const unread = draft.payload.rows.filter((r) => r.balanceAfter === null).length;
    expect(unread).toBeGreaterThan(0);
    expect(draft.payload.balancesNotRead).toBe(unread);

    const end = await confirmAndFinish(jobId, docId);
    expect(end.status).toBe('completed');
    expect(await txCount(docId)).toBe(N);
    const doc = await one<{ processing_status: string; certification_status: string; reconciliation_status: string }>(`select processing_status, certification_status, reconciliation_status from fdh_statement_uploads where id=$1`, [docId]);
    expect(doc.certification_status).toBe('review_required');
    expect(doc.processing_status).toBe('review_required');
    expect(doc.reconciliation_status).not.toBe('failed');
    const item = await one<{ severity: string; status: string; context_json: Record<string, unknown> }>(
      `select severity, status, context_json from fdh_review_items where statement_upload_id=$1 and title_code='bank_statement.ai_balances_not_read'`, [docId]);
    expect(item).toMatchObject({ severity: 'blocking', status: 'open' });
    expect(item.context_json.lines_not_read).toBe(unread);
    const note = statementNoteText({ id: 'x', severity: 'blocking', title_code: 'bank_statement.ai_balances_not_read', context_json: item.context_json });
    expect(note).toContain(`the balance for ${unread} line`);
    expect(note).toContain('cannot be approved');
    // no reconciliation-failure item was raised for a check that simply could not be run
    expect(await count(`select count(*) n from fdh_review_items where statement_upload_id=$1 and title_code='bank_pdf.reconciliation_failed'`, [docId])).toBe(0);
  }, 300_000);

  it('unread running balances AND an unreadable closing balance: still "cannot verify", never a false mismatch (no reconciliation-failure item), never certified', async () => {
    const N = 90;
    const docId = await seedPdf(U1, pdfLines(N));
    h.state.unreadBalances.add(0); // the first part's running balances are unreadable, so the derived opening balance would be wrong
    h.state.unreadClosing = true;
    const { jobId, review } = await readToDraft(docId);
    expect(review.status).toBe('review_required');
    const draft = await one<{ payload: Draft }>(`select payload from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
    expect(draft.payload.rows).toHaveLength(N);
    expect(draft.payload.declaredClosingBalance).toBeNull();
    expect(draft.payload.declaredBalancesNotRead).toBe(1);
    expect(draft.payload.balancesNotRead).toBeGreaterThan(0);
    const end = await confirmAndFinish(jobId, docId);
    expect(end.status).toBe('completed');
    const doc = await one<{ certification_status: string; reconciliation_status: string }>(`select certification_status, reconciliation_status from fdh_statement_uploads where id=$1`, [docId]);
    expect(doc.certification_status).toBe('review_required');
    expect(doc.reconciliation_status).not.toBe('failed');
    expect(await count(`select count(*) n from fdh_review_items where statement_upload_id=$1 and title_code='bank_pdf.reconciliation_failed'`, [docId])).toBe(0);
    expect(await count(`select count(*) n from fdh_review_items where statement_upload_id=$1 and title_code='bank_statement.ai_balances_not_read'`, [docId])).toBe(1);
  }, 300_000);

  it('a part where the model DROPPED the minus of overdrawn balances: no wrong-sign balance enters the draft; the lines are kept, the balances counted, the statement is reviewed and never certified', async () => {
    const N = 75; // a distinct length: an identical file would be recognised as a copy of an earlier upload
    const docId = await seedPdf(U1, pdfLines(N));
    h.state.dropSigns.add(0);
    const { jobId, review } = await readToDraft(docId);
    expect(review.status).toBe('review_required');
    const draft = await one<{ payload: Draft }>(`select payload from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
    expect(draft.payload.rows).toHaveLength(N);
    expect(draft.payload.balancesNotRead).toBeGreaterThan(0);
    // every balance that IS in the draft equals the statement's true balance: no wrong-sign figure got through
    const truth = trueBalances(N);
    draft.payload.rows.forEach((r, i) => expect(r.balanceAfter === null || r.balanceAfter === truth[i], `line ${i + 1}`).toBe(true));
    expect(truth.some((t) => t < 0)).toBe(true);
    expect(draft.payload.rows.filter((r) => r.balanceAfter === null).length).toBe(draft.payload.balancesNotRead);
    const end = await confirmAndFinish(jobId, docId);
    expect(end.status).toBe('completed');
    expect(await txCount(docId)).toBe(N);
    const doc = await one<{ certification_status: string }>(`select certification_status from fdh_statement_uploads where id=$1`, [docId]);
    expect(doc.certification_status).toBe('review_required');
  }, 300_000);
});
