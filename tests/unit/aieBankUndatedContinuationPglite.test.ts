/**
 * A statement that prints a date ONLY on the first transaction of a day, read in parts, against a REAL Postgres (PGlite, the full
 * migration chain). 28-10-2026 production defect: the parts that start at a page top (or mid-day) begin with undated transaction
 * lines; the model returned an empty date and the strict schema rejected the whole part, three times, so the job failed.
 * SYNTHETIC text only. The OpenAI provider is a fake that behaves like the production model on these lines: it reads a printed date
 * when there is one and, for an undated line, uses the date given in the prompt's "date in force" note (a model that follows the hint)
 * or returns an empty date (a model that ignores it). The real job, gateway, wire schema, normaliser, mapper, merge, draft, confirm,
 * deterministic pipeline, certification and review items run unchanged.
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
    prompts: [] as string[],
    /** true = the model ignores the date-in-force note and returns an empty date for an undated line */
    ignoreHint: false,
  };
  const f = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present_on_document' : null });
  const fakeProvider = {
    providerName: 'fake',
    generateStructured: async (req: { userPrompt: string }) => {
      state.prompts.push(req.userPrompt);
      const hint = /date in force where this part starts is .*? \((\d{4}-\d{2}-\d{2})\)/.exec(req.userPrompt)?.[1] ?? null;
      const tx: Array<Record<string, unknown>> = [];
      let current: string | null = hint && !state.ignoreHint ? hint : null;
      let opening: string | null = null;
      let closing: string | null = null;
      for (const l of req.userPrompt.split('\n')) {
        const cells = l.split('|').map((x) => x.trim());
        const dm = /^(\d{2})\/09\/2026$/.exec(cells[0] ?? '');
        if (dm) current = `2026-09-${dm[1]}`;
        const isRow = cells.length >= 5 && cells[1] !== '' && cells[1] !== 'Details' && !/forward/i.test(cells[1]) && (cells[2] !== '' || cells[3] !== '');
        if (isRow) {
          const debit = cells[2] !== '';
          tx.push({ transactionDate: dm ? current : state.ignoreHint ? '' : (current ?? ''), descriptionRaw: cells[1], amount: debit ? cells[2] : cells[3], creditDebit: debit ? 'debit' : 'credit', balanceAfter: cells[4] });
        }
        const o = /^Opening balance (.+)$/.exec(l);
        if (o) opening = o[1];
        const c = /^Closing balance (.+)$/.exec(l);
        if (c) closing = c[1];
      }
      const facts = {
        schemaVersion: '1', documentMissingReasonCode: null, institutionName: f(null), maskedAccountIdentifier: f(null), statementPeriodStart: f(null), statementPeriodEnd: f(null),
        declaredOpeningBalance: f(opening), declaredClosingBalance: f(closing), allTransactionsListed: true, transactions: tx,
      };
      return { rawText: JSON.stringify(facts), inputTokens: 900, outputTokens: 300, latencyMs: 1, modelVersion: 'fake', finishReason: 'stop' as const, providerRequestIds: ['req_x'] };
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

const U1 = '00000000-0000-4000-8000-0000000000d1';
let counter = 0;
let accountId = '';
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.state.db.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

/** A day is three consecutive lines; ONLY the first of them prints its date (the NAB habit). Truth: every line's real date. */
const DAY = (i: number) => 1 + (Math.floor(i / 3) % 28);
function statement(n: number): { pages: string[][]; truthDates: string[] } {
  let bal = 200000;
  const rows: string[] = [];
  const truthDates: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const dr = i % 7 !== 0;
    const amt = Math.round((10 + ((i * 7919) % 900) + 0.35) * 100) / 100;
    bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
    const dd = String(DAY(i)).padStart(2, '0');
    truthDates.push(`2026-09-${dd}`);
    const date = i % 3 === 0 ? `${dd}/09/2026` : '';
    rows.push(`${date} | PURCHASE ${i + 1} U${n} | ${dr ? amt.toFixed(2) : ''} | ${dr ? '' : amt.toFixed(2)} | ${bal.toFixed(2)}`);
  }
  const head = ['EXAMPLE CREDIT UNION', 'Everyday account statement', 'Account ending 4321', 'Opening balance 200000.00', 'Date | Details | Withdrawals | Deposits | Balance'];
  const pages: string[][] = [];
  const perPage = 50;
  for (let p = 0, at = 0; at < rows.length || p === 0; p += 1) {
    const slice = rows.slice(at, at + perPage);
    at += perPage;
    pages.push([...(p === 0 ? head : [`Synthetic Statement   Page ${p + 1}`, ' | Brought forward | | | 1.00']), ...slice, ...(at >= rows.length ? [`Closing balance ${bal.toFixed(2)}`] : [])]);
  }
  return { pages, truthDates };
}

async function seedUser(id: string) {
  await h.state.db.query(`insert into auth.users(id,email) values ($1,$2) on conflict do nothing`, [id, `${id}@t.test`]);
  await h.state.db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [id]);
}
async function seedPdf(pages: string[][]): Promise<string> {
  counter += 1;
  const key = `fdh/undated${counter}.pdf`;
  h.state.files.set(key, new Uint8Array(buildMinimalTextPdf(pages)));
  return (await one<{ id: string }>(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, financial_account_id, malware_scan_status, raw_document_storage_reference)
     values ($1,'pdf_native','bank_statement','AU','AUD','application/pdf','queued',$2,'clean',$3) returning id`,
    [U1, accountId, key],
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
type Draft = { rows: Array<{ transactionDate: string; balanceAfter: number | null }>; statementPeriodStart: string | null; statementPeriodEnd: string | null; declaredOpeningBalance: number | null; declaredClosingBalance: number | null; datesCarriedForward?: number };
async function readToDraft(docId: string) {
  const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'pdf' });
  if (adm.kind !== 'job') throw new Error('job expected');
  return { jobId: adm.job.id, review: await driveToEnd(adm.job.id) };
}
async function confirmAndFinish(jobId: string, docId: string) {
  const draft = await one<{ payload: Draft }>(`select payload from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
  const reviewed = {
    rows: draft.payload.rows.map((r, i) => ({ ...r, sourceRowNumber: i + 1 })) as never,
    statementPeriodStart: draft.payload.statementPeriodStart, statementPeriodEnd: draft.payload.statementPeriodEnd,
    declaredOpeningBalance: draft.payload.declaredOpeningBalance, declaredClosingBalance: draft.payload.declaredClosingBalance, maskedAccountIdentifier: null,
  };
  expect((await confirmAiDraftIntoJob({ userId: U1, documentId: docId, reviewed })).kind).toBe('job');
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
  h.state.prompts.length = 0;
  h.state.ignoreHint = false;
});

describe('PGlite: a statement whose date is printed only on the first transaction of a day', () => {
  it('the parts that start with undated lines get the date in force; every part is read first time, every line has its true date, and the statement certifies', async () => {
    const N = 300;
    const { pages, truthDates } = statement(N);
    const docId = await seedPdf(pages);
    const { jobId, review } = await readToDraft(docId);
    expect(review).toMatchObject({ status: 'review_required', review_reason: 'ai_draft' });
    const parts = Number((review.checkpoint as Record<string, unknown>).parts_total);
    expect(parts).toBeGreaterThan(10);
    expect(h.state.prompts.length).toBe(parts); // no retry: nothing was rejected, nothing billed twice
    const hinted = h.state.prompts.filter((p) => p.includes('date in force where this part starts'));
    expect(hinted.length).toBeGreaterThan(0);
    expect(hinted.length).toBeLessThan(parts); // parts that start with their own dated line, and part 1, get none
    expect(h.state.prompts[0]).not.toContain('date in force');

    const draft = await one<{ payload: Draft }>(`select payload from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
    expect(draft.payload.rows).toHaveLength(N);
    expect(draft.payload.rows.map((r) => r.transactionDate)).toEqual(truthDates);
    expect(draft.payload.datesCarriedForward ?? 0).toBe(0);

    const end = await confirmAndFinish(jobId, docId);
    expect(end.status).toBe('completed');
    expect(await count(`select count(*) n from fdh_transactions where statement_upload_id=$1`, [docId])).toBe(N);
    const doc = await one<{ processing_status: string; certification_status: string; reconciliation_status: string }>(`select processing_status, certification_status, reconciliation_status from fdh_statement_uploads where id=$1`, [docId]);
    expect(doc).toMatchObject({ processing_status: 'approved', certification_status: 'certified', reconciliation_status: 'reconciled' });
  }, 300_000);

  it('a model that IGNORES the hint (empty dates) no longer fails the statement: dates are taken from the line above, counted, and the statement is reviewed, never certified', async () => {
    const N = 301;
    h.state.ignoreHint = true;
    const { pages, truthDates } = statement(N);
    const docId = await seedPdf(pages);
    const { jobId, review } = await readToDraft(docId);
    expect(review).toMatchObject({ status: 'review_required', review_reason: 'ai_draft' }); // not 'failed' / ai_part_failed
    const draft = await one<{ payload: Draft }>(`select payload from fdh_ai_fallback_drafts where statement_upload_id=$1`, [docId]);
    expect(draft.payload.rows).toHaveLength(N);
    expect(draft.payload.datesCarriedForward).toBeGreaterThan(0);
    expect(draft.payload.rows.map((r) => r.transactionDate)).toEqual(truthDates); // here the line above / the date in force IS the day
    const end = await confirmAndFinish(jobId, docId);
    expect(end.status).toBe('completed');
    const doc = await one<{ certification_status: string }>(`select certification_status from fdh_statement_uploads where id='${docId}'`);
    expect(doc.certification_status).toBe('review_required');
    expect(await count(`select count(*) n from fdh_review_items where statement_upload_id=$1 and title_code='bank_statement.ai_dates_taken_from_previous_line'`, [docId])).toBe(1);
    expect(await count(`select count(*) n from fdh_transactions where statement_upload_id=$1`, [docId])).toBe(N);
  }, 300_000);
});
