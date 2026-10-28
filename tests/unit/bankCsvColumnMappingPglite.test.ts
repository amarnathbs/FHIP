/**
 * Bank CSV column mapping (28-10-2026) -- the whole chain against a REAL Postgres (PGlite, this repository's full migration chain):
 * Upload (the stored document) -> detect -> the dead end -> columns -> map -> process (the background job) -> review state, exactly once,
 * a second identical upload, a second different upload of the same layout (the remembered layout, no mapping asked), a wrong mapping
 * corrected without a second upload, the Bank Australia recognised layout, malware admission, and two users on every new route.
 *
 * All data is synthetic (tests/support/buildPoShapedBankCsv.ts). Evidence label: PGLITE-VERIFIED (a real Postgres engine; NOT DEV-verified).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildDb } from './support/fdh10LedgerPgliteHarness';
import { pgliteSupabase } from './support/pgliteSupabaseJobs';
import { buildPoShapedCsv, UNRECOGNISED_VARIANT } from '../support/buildPoShapedBankCsv';
import { detectBankCsvFormat } from '@/lib/financial-data-hub/bank-csv/detection';
import { suggestMapping, toMapRequest, adviseDateFormat } from '@/lib/financial-data-hub/bank-csv/mappingAssist';
import { bankCsvMappingConfirmSchema } from '@/lib/financial-data-hub/validation/bankCsv';

const h = vi.hoisted(() => ({ db: null as unknown as PGlite, client: null as unknown, files: new Map<string, Uint8Array>(), user: null as null | { id: string } }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async (key: string) => (h.files.has(key) ? { ok: true as const, bytes: h.files.get(key)! } : { ok: false as const, message: 'gone' }),
}));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ purgeRawDocumentAfterAiConfirm: async () => ({ status: 'skipped' }) }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => (h.user ? { user: h.user, unauthenticated: null } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) }),
}));
// Premium admission is exercised by tests/unit/premiumUploadRoutes.test.ts for every listed route (including the new remap route).
vi.mock('@/lib/entitlements/financialDataImport', () => ({ refuseUnlessImportRunMayStart: async () => null }));
vi.mock('@/lib/financial-data-hub/services/importRunPosition', () => ({ fdhDocumentRunPosition: async () => 'queued' }));

import { admitBankImport } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { advanceBankImportJob } from '@/lib/financial-data-hub/services/bankImportWorker';
import { confirmBankCsvMapping, detectBankCsvDocument, loadBankCsvMappingSample, BankCsvProcessingError } from '@/lib/financial-data-hub/services/bankCsvProcessingService';
import { resetBankCsvForRemap } from '@/lib/financial-data-hub/services/bankCsvRemap';
import { readStatementIdentityFromStoredFile } from '@/lib/financial-data-hub/services/bankAccountAssignment';

const U1 = '00000000-0000-4000-8000-0000000000c1';
const U2 = '00000000-0000-4000-8000-0000000000c2';
let counter = 0;
const accounts: Record<string, string> = {};

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.db.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

async function seedUser(id: string) {
  await h.db.query(`insert into auth.users(id,email) values ($1,$2) on conflict do nothing`, [id, `${id}@t.test`]);
  await h.db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [id]);
  accounts[id] = (await one<{ id: string }>(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','Everyday') returning id`, [id])).id;
}

/** What the upload route leaves behind: the stored file and a queued, scanned, account-resolved document. Detection has not run yet. */
async function seedUpload(userId: string, bytes: Uint8Array, malware = 'clean'): Promise<string> {
  counter += 1;
  const key = `fdh/map-${counter}.csv`;
  h.files.set(key, bytes);
  return (await one<{ id: string }>(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, financial_account_id, malware_scan_status, raw_document_storage_reference, file_hash)
     values ($1,'csv','bank_statement','AU','AUD','text/csv','queued',$2,$3,$4,$5) returning id`,
    [userId, accounts[userId], malware, key, createHash('sha256').update(bytes).digest('hex')],
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
const txCount = (docId: string) => count(`select count(*) n from fdh_transactions where statement_upload_id = $1`, [docId]);
const docRow = (docId: string) => one<Record<string, unknown>>(`select * from fdh_statement_uploads where id = $1`, [docId]);

/** The body the screen sends for a file, built the way the screen builds it (suggestion, proven date style). */
function bodyFor(bytes: Uint8Array, overrides: { dateFormat?: Parameters<typeof toMapRequest>[2]; remember?: boolean } = {}) {
  const { header, rows } = detectBankCsvFormat(bytes).parsed!;
  const s = suggestMapping(header, rows);
  const advice = adviseDateFormat(header, rows, s.draft.transactionDate);
  const body = toMapRequest(s.draft, s.amountStyle!, overrides.dateFormat ?? advice.proven!, ',', { remember: overrides.remember ?? true, allowSharedColumns: false });
  return bankCsvMappingConfirmSchema.parse(body);
}

beforeAll(async () => {
  h.db = await buildDb();
  h.client = pgliteSupabase(h.db);
  await h.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await seedUser(U1);
  await seedUser(U2);
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
}, 600_000);
afterAll(async () => {
  await h.db?.close();
});

const N = 342;
const variant = buildPoShapedCsv(N, 1, UNRECOGNISED_VARIANT);
/** Other headings of the same kind: each scenario below uses its own, because a layout the person has already confirmed is remembered by its headings. */
const otherLayout = (n: number, seed: number, ref: string) => buildPoShapedCsv(n, seed, { omit: ['Transaction type'], renames: { 'Reference no': ref } });
let firstDoc = '';
let firstTemplateId = '';

describe('the dead end, then the way out (an unrecognised layout of 342 rows)', () => {
  it('detect says manual_mapping_required, and process still refuses with the mapping_required code (what the person hit)', async () => {
    firstDoc = await seedUpload(U1, variant.bytes);
    const detected = await detectBankCsvDocument(U1, firstDoc);
    expect(detected.detection_status).toBe('manual_mapping_required');
    const refused = await admitBankImport({ userId: U1, documentId: firstDoc, kind: 'csv' });
    expect(refused).toMatchObject({ kind: 'error', status: 400, code: 'mapping_required' });
    expect(await txCount(firstDoc)).toBe(0);
  });

  it('the columns step gets the 10 headings, 100 sample rows and the true row count', async () => {
    const sample = await loadBankCsvMappingSample(U1, firstDoc);
    expect(sample.header).toEqual(variant.header);
    expect(sample.rows).toHaveLength(100);
    expect(sample.totalRows).toBe(N);
    expect(sample.delimiter).toBe(',');
  });

  it('the stored template shape check REQUIRES the key "amount": a body without it (the old behaviour for a debit/credit file) is refused by the database', async () => {
    let message = '';
    try {
      await h.db.query(
        `insert into fdh_csv_mapping_templates (user_id, source_fingerprint, amount_convention, date_format, delimiter, column_mapping)
         values ($1, 'probe-no-amount', 'debit_credit_columns', 'DD/MM/YYYY', ',', $2::jsonb)`,
        [U1, JSON.stringify({ transaction_date: 'Date', description: 'Description', debit: 'Debit', credit: 'Credit' })],
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/chk_fdh_mapping_shape/);
  });

  it('confirming the suggested columns saves a remembered layout with EVERY key present', async () => {
    const confirmed = await confirmBankCsvMapping(U1, firstDoc, bodyFor(variant.bytes));
    expect(confirmed.detection_status).toBe('detected');
    firstTemplateId = confirmed.mapping_template_id as string;
    expect(firstTemplateId).toBeTruthy();
    const t = await one<{ status: string; amount_convention: string; date_format: string; column_mapping: Record<string, unknown> }>(`select * from fdh_csv_mapping_templates where id=$1`, [firstTemplateId]);
    expect(t).toMatchObject({ status: 'user_confirmed', amount_convention: 'debit_credit_columns', date_format: 'h:mma ddd D MMMM, YYYY' });
    expect(t.column_mapping).toMatchObject({ transaction_date: 'Effective date', description: 'Description', extra_description: 'Long description', debit: 'Debit amount', credit: 'Credit amount', amount: null });
  });

  it('process then runs as a background job and stores exactly 342 lines, once, in review', async () => {
    const adm = await admitBankImport({ userId: U1, documentId: firstDoc, kind: 'csv' });
    expect(adm.kind).toBe('job');
    if (adm.kind !== 'job') return;
    expect(await txCount(firstDoc)).toBe(0); // admission wrote nothing
    const end = await driveToEnd(adm.job.id);
    expect(end.status).toBe('completed');
    expect(await txCount(firstDoc)).toBe(N);
    expect(await count(`select count(distinct source_row) n from fdh_transactions where statement_upload_id=$1`, [firstDoc])).toBe(N);
    const doc = await docRow(firstDoc);
    expect(doc).toMatchObject({ certification_status: 'review_required', certified_row_count: N });
    const first = await one<{ transaction_date: string; description_raw: string }>(`select transaction_date::text, description_raw from fdh_transactions where statement_upload_id=$1 and source_row=1`, [firstDoc]);
    expect(first.transaction_date).toBe('2025-07-01');
    expect(first.description_raw).toContain('Synthetic Merchant');
    // asking again changes nothing
    const again = await admitBankImport({ userId: U1, documentId: firstDoc, kind: 'csv' });
    expect(again.kind).toBe('result');
    expect(await txCount(firstDoc)).toBe(N);
  });

  it('a second IDENTICAL upload is recognised as a copy: no mapping asked, nothing read, nothing added', async () => {
    const second = await seedUpload(U1, variant.bytes);
    await detectBankCsvDocument(U1, second); // a copy of an imported statement is not read again
    const adm = await admitBankImport({ userId: U1, documentId: second, kind: 'csv' });
    expect(adm.kind).toBe('result'); // the original's result, not a job and not a mapping question
    expect(adm).toMatchObject({ payload: { transactions_created: 0, duplicates_skipped: N } });
    expect(await txCount(second)).toBe(0);
    expect(await count(`select count(*) n from fdh_transactions where user_id=$1`, [U1])).toBeGreaterThanOrEqual(N);
  });

  it('a different file with the SAME layout and overlapping lines: no mapping asked, the overlap is not duplicated', async () => {
    const before = await count(`select count(*) n from fdh_transactions where user_id=$1`, [U1]);
    const longer = buildPoShapedCsv(N + 58, 1, UNRECOGNISED_VARIANT); // the first 342 lines are the same lines, 58 are new
    const third = await seedUpload(U1, longer.bytes);
    const detected = await detectBankCsvDocument(U1, third);
    expect(detected.detection_status).toBe('detected');
    expect(detected.mapping_template_id).toBe(firstTemplateId);
    const adm = await admitBankImport({ userId: U1, documentId: third, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    const end = await driveToEnd(adm.job.id);
    expect(end.status).toBe('completed');
    expect(await txCount(third)).toBe(58);
    expect(await count(`select count(*) n from fdh_transactions where user_id=$1`, [U1])).toBe(before + 58);
    expect(await count(`select count(*) n from (select economic_fingerprint from fdh_transactions where user_id=$1 group by 1 having count(*) > 1) d`, [U1])).toBe(0);
  });
});

describe('two users, every new route and service', () => {
  it('another user gets "not found" for the columns, the mapping, the remap and the job, and nothing changes', async () => {
    const before = await docRow(firstDoc);
    for (const run of [
      () => loadBankCsvMappingSample(U2, firstDoc),
      () => confirmBankCsvMapping(U2, firstDoc, bodyFor(variant.bytes)),
      () => resetBankCsvForRemap(U2, firstDoc),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(await admitBankImport({ userId: U2, documentId: firstDoc, kind: 'csv' })).toMatchObject({ kind: 'error', status: 404 });
    const after = await docRow(firstDoc);
    expect(after.mapping_template_id).toBe(before.mapping_template_id);
    expect(await txCount(firstDoc)).toBe(N);
  });

  it('the ROUTES answer 401 signed out, and 404 (never the data) to another user', async () => {
    const columns = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/columns/route');
    const remap = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/remap/route');
    const map = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/map/route');
    const ctx = { params: Promise.resolve({ documentId: firstDoc }) };
    h.user = null;
    expect((await columns.GET(new Request('http://t/x'), ctx)).status).toBe(401);
    expect((await remap.POST(new Request('http://t/x', { method: 'POST' }), ctx)).status).toBe(401);
    h.user = { id: U2 };
    const c = await columns.GET(new Request('http://t/x'), ctx);
    expect(c.status).toBe(404);
    expect(JSON.stringify(await c.json())).not.toContain('Effective date');
    expect((await remap.POST(new Request('http://t/x', { method: 'POST' }), ctx)).status).toBe(404);
    expect((await map.POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify(bodyFor(variant.bytes)) }), ctx)).status).toBe(404);
    h.user = null;
  });

  it('the map route refuses a column that is not in the file, and one column chosen twice, with a 422 and a plain message', async () => {
    const f = otherLayout(30, 5, 'Ref A');
    const doc = await seedUpload(U1, f.bytes);
    expect((await detectBankCsvDocument(U1, doc)).detection_status).toBe('manual_mapping_required');
    const map = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/map/route');
    const ctx = { params: Promise.resolve({ documentId: doc }) };
    h.user = { id: U1 };
    const good = bodyFor(f.bytes);
    const missing = await map.POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ ...good, column_mapping: { ...good.column_mapping, description: 'No such column' } }) }), ctx);
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toMatch(/not in this file/);
    const twice = await map.POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ ...good, column_mapping: { ...good.column_mapping, balance: 'Debit amount' } }) }), ctx);
    expect(twice.status).toBe(422);
    expect((await twice.json()).error).toMatch(/both/);
    const allowed = await map.POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ ...good, column_mapping: { ...good.column_mapping, balance: 'Debit amount' }, allow_shared_columns: true }) }), ctx);
    expect(allowed.status).toBe(200);
    h.user = null;
  });
});

describe('malware admission is preserved on the new read', () => {
  it('a file the scan has not cleared is never read for the mapping step, and is never imported', async () => {
    const doc = await seedUpload(U1, otherLayout(20, 6, 'Ref D').bytes, 'pending');
    await h.db.query(`update fdh_statement_uploads set detection_status='manual_mapping_required', detection_evidence=$2::jsonb where id=$1`, [doc, JSON.stringify({ header: variant.header })]);
    await expect(loadBankCsvMappingSample(U1, doc)).rejects.toMatchObject({ code: 'invalid_state' });
    const adm = await admitBankImport({ userId: U1, documentId: doc, kind: 'csv' });
    expect(adm).toMatchObject({ kind: 'error', code: 'invalid_state' });
    expect(await txCount(doc)).toBe(0);
  });
});

describe('a wrong mapping is corrected without uploading the file again', () => {
  const bytes = otherLayout(50, 9, 'Ref B').bytes;
  let doc = '';

  it('a wrong date style reads nothing; the statement is then taken back to the columns, the old reading is gone, the job is gone', async () => {
    doc = await seedUpload(U1, bytes);
    expect((await detectBankCsvDocument(U1, doc)).detection_status).toBe('manual_mapping_required');
    await confirmBankCsvMapping(U1, doc, bodyFor(bytes, { dateFormat: 'DD/MM/YYYY', remember: false }));
    const adm = await admitBankImport({ userId: U1, documentId: doc, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    await driveToEnd(adm.job.id);
    expect(await txCount(doc)).toBe(0); // every date was unreadable
    expect(await count(`select count(*) n from fdh_bank_import_jobs where statement_upload_id=$1`, [doc])).toBe(1);

    const reset = await resetBankCsvForRemap(U1, doc);
    expect(reset).toMatchObject({ detection_status: 'manual_mapping_required', mapping_template_id: null, processing_status: 'queued', certification_status: null, processing_completed_at: null });
    expect(await count(`select count(*) n from fdh_bank_import_jobs where statement_upload_id=$1`, [doc])).toBe(0);
  });

  it('choosing the columns again and processing reads every line exactly once', async () => {
    await confirmBankCsvMapping(U1, doc, bodyFor(bytes));
    const adm = await admitBankImport({ userId: U1, documentId: doc, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    const end = await driveToEnd(adm.job.id);
    expect(end.status).toBe('completed');
    expect(await txCount(doc)).toBe(50);
    expect(await count(`select count(distinct source_row) n from fdh_transactions where statement_upload_id=$1`, [doc])).toBe(50);
  });

  it('once any line is approved the statement cannot be read again, and nothing is removed', async () => {
    // (the database refuses an approval while a blocking review issue is open; the test clears that precondition, it does not model resolving it)
    await h.db.query(`delete from fdh_review_items where statement_upload_id=$1 or transaction_id in (select id from fdh_transactions where statement_upload_id=$1)`, [doc]);
    await h.db.query(`update fdh_transactions set economic_transaction_type='expense' where statement_upload_id=$1 and source_row=1`, [doc]);
    await h.db.query(`update fdh_transactions set approval_status='approved', approved_by=$2 where statement_upload_id=$1 and source_row=1`, [doc, U1]);
    await expect(resetBankCsvForRemap(U1, doc)).rejects.toMatchObject({ code: 'already_approved' });
    expect(await txCount(doc)).toBe(50);
    expect(await count(`select count(*) n from fdh_bank_import_jobs where statement_upload_id=$1`, [doc])).toBe(1);
  });

  it('if the stored file is gone the statement is NOT reset (checked before anything is removed)', async () => {
    const other = otherLayout(20, 11, 'Ref C').bytes;
    const d = await seedUpload(U1, other);
    await detectBankCsvDocument(U1, d);
    await confirmBankCsvMapping(U1, d, bodyFor(other, { remember: false }));
    const adm = await admitBankImport({ userId: U1, documentId: d, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    await driveToEnd(adm.job.id);
    expect(await txCount(d)).toBe(20);
    const key = (await docRow(d)).raw_document_storage_reference as string;
    const kept = h.files.get(key)!;
    h.files.delete(key);
    await expect(resetBankCsvForRemap(U1, d)).rejects.toMatchObject({ code: 'file_gone' });
    expect(await txCount(d)).toBe(20);
    h.files.set(key, kept);
  });
});

describe('a remembered layout that turns out wrong is replaced when the person corrects it', () => {
  const bytes = otherLayout(40, 13, 'Ref E').bytes;
  const nextBytes = otherLayout(45, 13, 'Ref E').bytes; // same headings, 5 more lines
  let templateId = '';

  it('wrong columns remembered, nothing read; after the correction the SAME remembered layout is updated and the next file reads right with no question', async () => {
    const doc = await seedUpload(U1, bytes);
    await detectBankCsvDocument(U1, doc);
    templateId = (await confirmBankCsvMapping(U1, doc, bodyFor(bytes, { dateFormat: 'DD/MM/YYYY', remember: true }))).mapping_template_id as string;
    const adm = await admitBankImport({ userId: U1, documentId: doc, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    await driveToEnd(adm.job.id);
    expect(await txCount(doc)).toBe(0);

    await resetBankCsvForRemap(U1, doc);
    const fixed = await confirmBankCsvMapping(U1, doc, bodyFor(bytes, { remember: true }));
    expect(fixed.mapping_template_id).toBe(templateId);
    expect((await one<{ date_format: string }>(`select date_format from fdh_csv_mapping_templates where id=$1`, [templateId])).date_format).toBe('h:mma ddd D MMMM, YYYY');
    expect(await count(`select count(*) n from fdh_csv_mapping_templates where user_id=$1 and source_fingerprint=(select source_fingerprint from fdh_csv_mapping_templates where id=$2)`, [U1, templateId])).toBe(1);
    const adm2 = await admitBankImport({ userId: U1, documentId: doc, kind: 'csv' });
    if (adm2.kind !== 'job') throw new Error('job expected');
    await driveToEnd(adm2.job.id);
    expect(await txCount(doc)).toBe(40);

    const next = await seedUpload(U1, nextBytes);
    const detected = await detectBankCsvDocument(U1, next);
    expect(detected).toMatchObject({ detection_status: 'detected', mapping_template_id: templateId });
    const adm3 = await admitBankImport({ userId: U1, documentId: next, kind: 'csv' });
    if (adm3.kind !== 'job') throw new Error('job expected');
    await driveToEnd(adm3.job.id);
    expect(await txCount(next)).toBe(5); // 40 already imported lines are not written again
  });
});

describe('Bank Australia recognised layout (experimental): no mapping, always review, account named from the last digits', () => {
  const built = buildPoShapedCsv(342, 2);
  let doc = '';

  it('detects, imports 342 lines once, and lands in review (experimental never certifies on its own)', async () => {
    doc = await seedUpload(U1, built.bytes);
    const detected = await detectBankCsvDocument(U1, doc);
    expect(detected).toMatchObject({ detection_status: 'detected', adapter_key: 'au_bank_australia_debit_credit_v1' });
    expect(detected.mapping_template_id).toBeNull();
    const adm = await admitBankImport({ userId: U1, documentId: doc, kind: 'csv' });
    if (adm.kind !== 'job') throw new Error('job expected');
    const end = await driveToEnd(adm.job.id);
    expect(end.status).toBe('completed');
    expect(await txCount(doc)).toBe(342);
    expect(await docRow(doc)).toMatchObject({ certification_status: 'review_required', certified_row_count: 342 });
  });

  it('names the institution and the last four digits of the account (never the whole number)', async () => {
    const identity = await readStatementIdentityFromStoredFile(await docRow(doc));
    expect(identity).toMatchObject({ institutionCode: 'bank_australia', lastDigits: '1234' });
    expect(JSON.stringify(identity)).not.toMatch(/\d{5,}/);
  });

  it('has no column mapping to change (the remap route refuses a recognised layout)', async () => {
    await expect(resetBankCsvForRemap(U1, doc)).rejects.toBeInstanceOf(BankCsvProcessingError);
    await expect(resetBankCsvForRemap(U1, doc)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await txCount(doc)).toBe(342);
  });
});
