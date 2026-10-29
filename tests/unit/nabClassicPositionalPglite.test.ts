/**
 * A statement laid out like a real NAB statement, imported through the REAL background import job against a REAL Postgres (PGlite, this
 * repository's full migration chain). SYNTHETIC PDFs only (tests/support/buildNabClassicPdf.ts). The OpenAI provider is a fake that
 * records every call it receives; the job, the positions reader, the normaliser, the dedup, the rollforward, the certification, the
 * persistence and the finalisation all run unchanged.
 *
 * What is proven (PGLITE-VERIFIED; nothing here is DEV- or production-verified):
 *   1. the deterministic reader handles the statement WITHOUT the AI: the fake provider is never called, the job completes, every
 *      transaction is stored with the direction its column gave it, the description has no leader, and the statement CERTIFIES
 *      (reconciled) and is approved with the period it prints;
 *   2. a statement the reader cannot place confidently is NOT guessed: it goes down the AI path (the provider IS called) and nothing is
 *      stored natively;
 *   3. a statement whose arithmetic is one cent out is read but NOT certified: it lands in review with a blocking reconciliation item.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildDb } from './support/fdh10LedgerPgliteHarness';
import { pgliteSupabase } from './support/pgliteSupabaseJobs';
import { buildNabClassicPdf, sampleLedger, type NabSpec } from '../support/buildNabClassicPdf';

const h = vi.hoisted(() => {
  const state = { db: null as unknown as PGlite, client: null as unknown, files: new Map<string, Uint8Array>(), prompts: [] as string[] };
  const f = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present_on_document' : null });
  const fakeProvider = {
    providerName: 'fake',
    generateStructured: async (req: { userPrompt: string }) => {
      state.prompts.push(req.userPrompt);
      const facts = {
        schemaVersion: '1', documentMissingReasonCode: null, institutionName: f(null), maskedAccountIdentifier: f(null), statementPeriodStart: f(null), statementPeriodEnd: f(null),
        declaredOpeningBalance: f(null), declaredClosingBalance: f(null), allTransactionsListed: true, transactions: [],
      };
      return { rawText: JSON.stringify(facts), inputTokens: 100, outputTokens: 10, latencyMs: 1, modelVersion: 'fake', finishReason: 'stop' as const, providerRequestIds: ['req_x'] };
    },
    validateProviderHealth: async () => ({}) as never,
    estimateCost: () => ({}) as never,
  };
  return { state, fakeProvider };
});

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.state.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.state.client }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async (key: string) => (h.state.files.has(key) ? { ok: true as const, bytes: new Uint8Array(h.state.files.get(key)!) } : { ok: false as const, message: 'gone' }),
}));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ purgeRawDocumentAfterAiConfirm: async () => ({ status: 'skipped' }) }));
vi.mock('@/lib/aie/adapters/bankStatement/featureFlags', () => ({ isAieBankStatementAiFallbackEnabled: () => true }));
vi.mock('@/lib/aie/adapters/shared/fallbackGate', () => ({
  evaluateAiFallbackGate: async (p: { extractedText: string }) => ({ ok: true, maskedText: p.extractedText, coverageByType: {}, totalMatches: 0 }),
  evaluateAiEgressPreconditions: async () => ({ ok: true }),
}));
vi.mock('@/lib/aie/provider/providerFactory', () => ({ createAieAiProvider: () => h.fakeProvider, createLazyAieAiProvider: () => h.fakeProvider }));
vi.mock('@/lib/aie/cost/costAdmission', () => ({ reserveConservativeAiCost: async () => ({ admitted: true, reservedUsd: 0.01 }), settleAiCost: async () => undefined }));

import { admitBankImport } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { advanceBankImportJob } from '@/lib/financial-data-hub/services/bankImportWorker';

const U1 = '00000000-0000-4000-8000-0000000000e1';
let counter = 0;
let accountId = '';
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.state.db.query<T>(sql, params)).rows[0];
const many = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.state.db.query<T>(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

async function seedUser(id: string) {
  await h.state.db.query(`insert into auth.users(id,email) values ($1,$2) on conflict do nothing`, [id, `${id}@t.test`]);
  await h.state.db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [id]);
}
/** A fresh account per statement: the same synthetic ledger imported twice into ONE account would (correctly) be seen as duplicates. */
async function freshAccount(): Promise<string> {
  return (await one<{ id: string }>(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','Everyday') returning id`, [U1])).id;
}
async function seedPdf(spec: NabSpec): Promise<{ docId: string; built: ReturnType<typeof buildNabClassicPdf> }> {
  counter += 1;
  accountId = await freshAccount();
  const built = buildNabClassicPdf(spec);
  const key = `fdh/nab${counter}.pdf`;
  h.state.files.set(key, new Uint8Array(built.pdf));
  const docId = (await one<{ id: string }>(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, financial_account_id, malware_scan_status, raw_document_storage_reference)
     values ($1,'pdf_native','bank_statement','AU','AUD','application/pdf','queued',$2,'clean',$3) returning id`,
    [U1, accountId, key],
  )).id;
  return { docId, built };
}
async function driveToEnd(jobId: string, maxSlices = 400) {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < maxSlices; i += 1) {
    const out = await advanceBankImportJob(jobId, { userId: U1, sliceBudgetMs: 0 });
    if (out.kind === 'not_found') throw new Error('not found');
    last = out.job as unknown as Record<string, unknown>;
    if (['completed', 'failed', 'review_required'].includes(String(last.status))) return last;
  }
  throw new Error('did not finish');
}
async function importPdf(spec: NabSpec) {
  const { docId, built } = await seedPdf(spec);
  const adm = await admitBankImport({ userId: U1, documentId: docId, kind: 'pdf' });
  if (adm.kind !== 'job') throw new Error('job expected');
  return { docId, built, end: await driveToEnd(adm.job.id) };
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
});

describe('PGlite: a statement laid out like a real NAB statement', () => {
  it('is read WITHOUT the AI, every direction and description is stored as the columns gave them, and the statement certifies', async () => {
    const { docId, built, end } = await importPdf({ opening: 1234.56, entries: sampleLedger(45), perPage: 12, notice: true });
    expect(end.status).toBe('completed');
    expect(h.state.prompts).toHaveLength(0); // the deterministic reader handled it: the AI was never asked

    const doc = await one<{ processing_status: string; certification_status: string; reconciliation_status: string; adapter_key: string | null; statement_period_start: string | null; statement_period_end: string | null; parsed_row_count: number }>(
      `select processing_status, certification_status, reconciliation_status, adapter_key, statement_period_start::text, statement_period_end::text, parsed_row_count from fdh_statement_uploads where id=$1`,
      [docId],
    );
    expect(doc).toMatchObject({ processing_status: 'approved', certification_status: 'certified', reconciliation_status: 'reconciled', adapter_key: 'au_nab_classic_pdf_v2', parsed_row_count: 45 });
    expect(doc.statement_period_start).toBe('2024-03-04');
    expect(doc.statement_period_end).toBe('2024-06-01');

    const rows = await many<{ credit_debit: string; amount_original: string; description_raw: string; transaction_date: string; balance_after: string | null; source_row: number; source_page: number }>(
      `select credit_debit, amount_original::text, description_raw, transaction_date::text, balance_after::text, source_row, source_page from fdh_transactions where statement_upload_id=$1 order by source_row`,
      [docId],
    );
    expect(rows).toHaveLength(45);
    expect(rows.map((r) => r.credit_debit)).toEqual(built.expected.map((e) => e.side));
    expect(rows.map((r) => Number(r.amount_original))).toEqual(built.expected.map((e) => e.amount));
    expect(rows.map((r) => r.description_raw)).toEqual(built.expected.map((e) => e.description));
    expect(rows.map((r) => r.transaction_date)).toEqual(built.expected.map((e) => e.dateIso));
    expect(rows.map((r) => (r.balance_after === null ? null : Number(r.balance_after)))).toEqual(built.expected.map((e) => e.balance));
    expect(rows.every((r) => !/\.{2,}/.test(r.description_raw))).toBe(true);
    expect(Math.max(...rows.map((r) => r.source_page))).toBeGreaterThan(1);

    const recon = await one<{ status: string; opening_balance: string; reported_closing_balance: string; variance: string }>(
      `select status, opening_balance::text, reported_closing_balance::text, variance::text from fdh_reconciliation_results where statement_upload_id=$1`,
      [docId],
    );
    expect(recon.status).toBe('reconciled');
    expect(Number(recon.opening_balance)).toBe(1234.56);
    expect(Number(recon.reported_closing_balance)).toBe(built.summary.closing);
    expect(Number(recon.variance)).toBe(0);
    expect(await count(`select count(*) n from fdh_review_items where statement_upload_id=$1 and severity='blocking'`, [docId])).toBe(0);
  }, 300_000);

  it('a statement whose arithmetic is ONE CENT out is read but NOT certified: it lands in review with a blocking reconciliation item', async () => {
    const probe = buildNabClassicPdf({ opening: 1234.56, entries: sampleLedger(30), perPage: 12 });
    const { docId, end } = await importPdf({ opening: 1234.56, entries: sampleLedger(30), perPage: 12, closingOverride: Math.round((probe.summary.closing + 0.01) * 100) / 100 });
    expect(end.status).toBe('completed');
    expect(h.state.prompts).toHaveLength(0);
    const doc = await one<{ processing_status: string; certification_status: string; reconciliation_status: string }>(`select processing_status, certification_status, reconciliation_status from fdh_statement_uploads where id=$1`, [docId]);
    expect(doc).toMatchObject({ processing_status: 'review_required', certification_status: 'review_required', reconciliation_status: 'failed' });
    expect(await count(`select count(*) n from fdh_transactions where statement_upload_id=$1`, [docId])).toBe(30);
    expect(await count(`select count(*) n from fdh_review_items where statement_upload_id=$1 and title_code='bank_pdf.reconciliation_failed' and severity='blocking'`, [docId])).toBe(1);
  }, 300_000);

  it('a statement the reader CANNOT place confidently is not guessed: it goes down the AI path (the provider is asked) and nothing is stored natively', async () => {
    const { docId, end } = await importPdf({ opening: 1234.56, entries: sampleLedger(30), perPage: 12, misplaceAmountOnEntry: { entry: 5, dx: 60 } });
    expect(h.state.prompts.length).toBeGreaterThan(0);
    expect(end.status).not.toBe('completed');
    expect(await count(`select count(*) n from fdh_transactions where statement_upload_id=$1`, [docId])).toBe(0);
    const doc = await one<{ adapter_key: string | null; certification_status: string | null }>(`select adapter_key, certification_status from fdh_statement_uploads where id=$1`, [docId]);
    expect(doc.adapter_key).toBeNull();
    expect(doc.certification_status).not.toBe('certified');
  }, 300_000);
});
