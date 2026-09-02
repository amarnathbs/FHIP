// II-PC1 — LIVE hosted-DEV certification for all four defect closures
// (D1 CAMS folio/AMC identity, D2 ISIN validation, D3 manual-entry
// idempotency, D4 malformed-date hardening).
//
// WHAT IS LIVE HERE
//   * A real hosted DEV Supabase project (ref guarded below).
//   * Real synthetic auth users created through the Auth admin API.
//   * The real, unmodified `processSourceDocument()` / `importManualFixture()`
//     / `submitManualDirectPosition()` service functions — imported
//     directly, not re-implemented (same methodology as
//     scripts/r11_final_live_dev_tests.ts).
//
// WHAT IS SUBSTITUTED
//   * `pdf-parse` is mocked at the module boundary ONLY because this
//     worktree's node_modules is missing it (a pre-existing, repo-wide
//     environment gap unrelated to PC1 — confirmed absent from the main
//     checkout's node_modules too). Every synthetic "statement" in this
//     suite is uploaded as `text/csv` (R1's OTHER always-supported ingestion
//     mime type — see storage.ts's ALLOWED_MIME_TYPES), which routes
//     through documentProcessing.ts's plain-buffer-to-utf8 branch, NEVER
//     the PDF-extraction branch — so the mock is never actually exercised
//     at runtime, only satisfies the module's static import.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

vi.mock('pdf-parse', () => ({
  PDFParse: class {},
  PasswordException: class extends Error {},
}));

// ---------------------------------------------------------------------------
// Environment + hard DEV guard
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = path.join(repoRoot, '.env.local');
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_DEV_REF) {
  throw new Error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project. This suite never touches production.`);
}

process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const STAMP = Date.now();
const RUN_TAG = `pc1-${STAMP}`;
const cleanupUserIds: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
  const password = `Synthetic!${RUN_TAG}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
  cleanupUserIds.push(data.user.id);
  return data.user.id;
}

async function uploadTextStatement(userId: string, filename: string, text: string): Promise<string> {
  const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
  const bytes = Buffer.from(text, 'utf8');
  const objectKey = `${userId}/${randomUUID()}.csv`;
  const { error: upErr } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'text/csv', upsert: false });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const { data: doc, error: docErr } = await admin
    .from('ii_source_documents')
    .insert({
      user_id: userId,
      country_code: 'IN',
      status: 'uploaded',
      checksum,
      storage_path: objectKey,
      original_filename: filename,
      mime_type: 'text/csv',
      file_size: bytes.length,
      document_type: 'cas_statement',
    })
    .select('id')
    .single();
  if (docErr || !doc) throw new Error(`ii_source_documents insert failed: ${docErr?.message}`);
  return doc.id as string;
}

function camsLines(opts: {
  folio: string;
  pan: string;
  name: string;
  amc: string;
  scheme: string;
  isin: string;
  amfi: string;
  rows: { date: string; desc: string; amount: string; units: string; nav: string; balance: string; ref: string }[];
  closing: { date: string; units: string; value: string; nav: string };
}): string[] {
  const lines = [
    `Folio No: ${opts.folio}`,
    `PAN: ${opts.pan}`,
    `Name: ${opts.name}`,
    'Holding Mode: SI',
    '',
    `AMC Name: ${opts.amc}`,
    `Scheme Name: ${opts.scheme}`,
    `ISIN: ${opts.isin}`,
    `AMFI Code: ${opts.amfi}`,
    'Registrar: CAMS',
    '',
    'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
  ];
  for (const r of opts.rows) {
    lines.push(`${r.date}   ${r.desc}                              ${r.amount}  ${r.units}  ${r.nav}  ${r.balance} [Ref: ${r.ref}]`);
  }
  lines.push(`Closing Unit Balance as on ${opts.closing.date} : ${opts.closing.units} Units   Valuation : Rs. ${opts.closing.value}   NAV as on ${opts.closing.date} : Rs. ${opts.closing.nav}`);
  return lines;
}

function camsDocument(blocks: string[][]): string {
  return ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2025 To 30-Jun-2025', '', ...blocks.flatMap((b) => [...b, ''])].join('\n');
}

afterAll(async () => {
  // PC1 cleanup — delete every synthetic row created by this suite, deepest
  // dependents first. Never rely on a DELETE response alone: re-query
  // afterwards to prove zero residue (see final assertions below).
  for (const userId of cleanupUserIds) {
    const { data: accIds } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
    const accountIds = (accIds ?? []).map((r) => r.id as string);
    if (accountIds.length > 0) {
      await admin.from('ii_portfolio_truth_status').delete().in('account_id', accountIds);
      await admin.from('ii_holding_snapshots').delete().in('account_id', accountIds);
      await admin.from('ii_transactions').delete().in('account_id', accountIds);
    }
    await admin.from('ii_reconciliation_cases').delete().eq('user_id', userId);
    await admin.from('ii_transaction_source_links').delete().eq('user_id', userId);
    const { data: docIds } = await admin.from('ii_source_documents').select('id, storage_path').eq('user_id', userId);
    for (const d of docIds ?? []) {
      await admin.storage.from('investment-source-documents').remove([d.storage_path as string]).catch(() => {});
    }
    await admin.from('ii_document_parse_runs').delete().eq('user_id', userId);
    await admin.from('ii_source_documents').delete().eq('user_id', userId);
    await admin.from('ii_accounts').delete().eq('user_id', userId);
    await admin.auth.admin.deleteUser(userId);
  }

  // Zero-residue proof.
  for (const userId of cleanupUserIds) {
    const { count: accCount } = await admin.from('ii_accounts').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    const { count: txCount } = await admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    const { count: docCount } = await admin.from('ii_source_documents').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    expect(accCount ?? 0, `residual ii_accounts for ${userId}`).toBe(0);
    expect(txCount ?? 0, `residual ii_transactions for ${userId}`).toBe(0);
    expect(docCount ?? 0, `residual ii_source_documents for ${userId}`).toBe(0);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// D1 — CAMS folio/AMC identity, live DEV
// ---------------------------------------------------------------------------
describe('PC1-D1 live DEV — multi-AMC document + monthly delta + transaction reorder', () => {
  it('two folios / two AMCs resolve to two correctly-attributed accounts; a monthly delta reuses the SAME account; reordering is safe', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const userId = await makeUser('d1');

    const initialText = camsDocument([
      camsLines({
        folio: 'PC1FOLIOA', pan: 'ABCDE1111F', name: 'PC1 INVESTOR A', amc: 'PC1 Alpha Mutual Fund', scheme: 'PC1 Alpha Flexi Cap Fund - Growth', isin: 'INF000PC1A01',
        amfi: '900001',
        rows: [{ date: '01-Feb-2025', desc: 'Purchase', amount: '10,000.00', units: '100.000', nav: '100.0000', balance: '100.000', ref: 'PC1A-TX1' }],
        closing: { date: '30-Jun-2025', units: '100.000', value: '12,000.00', nav: '120.0000' },
      }),
      camsLines({
        folio: 'PC1FOLIOB', pan: 'ABCDE2222F', name: 'PC1 INVESTOR B', amc: 'PC1 Beta Mutual Fund', scheme: 'PC1 Beta Bluechip Fund - Growth', isin: 'INF000PC1B02',
        amfi: '900002',
        rows: [{ date: '05-Mar-2025', desc: 'Purchase', amount: '20,000.00', units: '200.000', nav: '100.0000', balance: '200.000', ref: 'PC1B-TX1' }],
        closing: { date: '30-Jun-2025', units: '200.000', value: '24,000.00', nav: '120.0000' },
      }),
    ]);

    const initialDocId = await uploadTextStatement(userId, 'pc1-initial.csv', initialText);
    const initialResult = await processSourceDocument({ userId, sourceDocumentId: initialDocId });
    expect(initialResult.ok, `initial process failed: ${initialResult.error}`).toBe(true);
    expect(initialResult.summary?.accountsFound).toBe(2);

    const { data: accountsAfterInitial } = await admin.from('ii_accounts').select('id, institution_name, folio_number').eq('user_id', userId);
    expect(accountsAfterInitial).toHaveLength(2);
    const byFolio = new Map((accountsAfterInitial ?? []).map((a) => [a.folio_number as string, a]));
    expect(byFolio.get('PC1FOLIOA')?.institution_name).toBe('PC1 Alpha Mutual Fund');
    expect(byFolio.get('PC1FOLIOB')?.institution_name).toBe('PC1 Beta Mutual Fund'); // THE regression: pre-fix, this resolved to 'PC1 Alpha Mutual Fund'

    const accountAId = byFolio.get('PC1FOLIOA')!.id as string;
    const accountBId = byFolio.get('PC1FOLIOB')!.id as string;

    // Monthly delta: ONLY folio B has a new transaction this month.
    const deltaText = camsDocument([
      camsLines({
        folio: 'PC1FOLIOB', pan: 'ABCDE2222F', name: 'PC1 INVESTOR B', amc: 'PC1 Beta Mutual Fund', scheme: 'PC1 Beta Bluechip Fund - Growth', isin: 'INF000PC1B02',
        amfi: '900002',
        rows: [{ date: '10-Jul-2025', desc: 'Purchase', amount: '5,000.00', units: '50.000', nav: '100.0000', balance: '250.000', ref: 'PC1B-TX2' }],
        closing: { date: '31-Jul-2025', units: '250.000', value: '30,000.00', nav: '120.0000' },
      }),
    ]);
    const deltaDocId = await uploadTextStatement(userId, 'pc1-delta-july.csv', deltaText);
    const deltaResult = await processSourceDocument({ userId, sourceDocumentId: deltaDocId });
    expect(deltaResult.ok, `delta process failed: ${deltaResult.error}`).toBe(true);
    expect(deltaResult.summary?.accountsFound).toBe(1); // only folio B touched this run

    const { data: accountsAfterDelta } = await admin.from('ii_accounts').select('id, institution_name, folio_number').eq('user_id', userId);
    expect(accountsAfterDelta).toHaveLength(2); // STILL 2 — no duplicate account created
    const accountBAfterDelta = (accountsAfterDelta ?? []).find((a) => a.folio_number === 'PC1FOLIOB')!;
    expect(accountBAfterDelta.id).toBe(accountBId); // SAME account id reused, not a new one
    expect(accountBAfterDelta.institution_name).toBe('PC1 Beta Mutual Fund');

    const { count: txCountA } = await admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('account_id', accountAId);
    const { count: txCountB } = await admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('account_id', accountBId);
    expect(txCountA).toBe(1); // folio A untouched by the delta
    expect(txCountB).toBe(2); // folio B's original + delta transaction, both under the SAME account

    // Reorder proof: an equivalent second user, same two folios/AMCs but
    // with the folio blocks printed in the OPPOSITE order in the raw
    // document, must resolve to the SAME institution attribution.
    const userId2 = await makeUser('d1-reorder');
    const reorderedText = camsDocument([
      camsLines({
        folio: 'PC1FOLIOB', pan: 'ABCDE2222F', name: 'PC1 INVESTOR B', amc: 'PC1 Beta Mutual Fund', scheme: 'PC1 Beta Bluechip Fund - Growth', isin: 'INF000PC1B02',
        amfi: '900002',
        rows: [{ date: '05-Mar-2025', desc: 'Purchase', amount: '20,000.00', units: '200.000', nav: '100.0000', balance: '200.000', ref: 'PC1B-TX1-R' }],
        closing: { date: '30-Jun-2025', units: '200.000', value: '24,000.00', nav: '120.0000' },
      }),
      camsLines({
        folio: 'PC1FOLIOA', pan: 'ABCDE1111F', name: 'PC1 INVESTOR A', amc: 'PC1 Alpha Mutual Fund', scheme: 'PC1 Alpha Flexi Cap Fund - Growth', isin: 'INF000PC1A01',
        amfi: '900001',
        rows: [{ date: '01-Feb-2025', desc: 'Purchase', amount: '10,000.00', units: '100.000', nav: '100.0000', balance: '100.000', ref: 'PC1A-TX1-R' }],
        closing: { date: '30-Jun-2025', units: '100.000', value: '12,000.00', nav: '120.0000' },
      }),
    ]);
    const reorderedDocId = await uploadTextStatement(userId2, 'pc1-reordered.csv', reorderedText);
    const reorderedResult = await processSourceDocument({ userId: userId2, sourceDocumentId: reorderedDocId });
    expect(reorderedResult.ok, `reordered process failed: ${reorderedResult.error}`).toBe(true);
    const { data: reorderedAccounts } = await admin.from('ii_accounts').select('institution_name, folio_number').eq('user_id', userId2);
    const reorderedByFolio = new Map((reorderedAccounts ?? []).map((a) => [a.folio_number as string, a.institution_name as string]));
    expect(reorderedByFolio.get('PC1FOLIOA')).toBe('PC1 Alpha Mutual Fund');
    expect(reorderedByFolio.get('PC1FOLIOB')).toBe('PC1 Beta Mutual Fund'); // identical to forward-order result — order-independent
  }, 90_000);
});

// ---------------------------------------------------------------------------
// D2 — ISIN validation, live DEV
// ---------------------------------------------------------------------------
describe('PC1-D2 live DEV — ISIN validation', () => {
  it('an invalid ISIN is rejected with 0 rows persisted; a valid ISIN is accepted', async () => {
    const { submitManualDirectPosition } = await import('@/lib/services/investment-intelligence/manualDirectPositionService');
    const userId = await makeUser('d2');

    const invalid = await submitManualDirectPosition(userId, {
      action: 'buy', instrumentClass: 'equity', instrumentName: 'PC1 Invalid ISIN Co', isin: 'NOT-A-REAL-ISIN',
      accountInstitutionName: 'PC1 Test Broker', transactionDate: '2025-02-01', units: 10, pricePerUnit: 100,
    });
    expect(invalid.validationErrorCode).toBe('INVALID_ISIN');
    expect(invalid.sourceDocumentId).toBeNull();
    const { count: docCountAfterInvalid } = await admin.from('ii_source_documents').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    expect(docCountAfterInvalid).toBe(0);

    const valid = await submitManualDirectPosition(userId, {
      action: 'buy', instrumentClass: 'equity', instrumentName: 'PC1 Valid ISIN Co', isin: 'INE002A01018',
      accountInstitutionName: 'PC1 Test Broker', transactionDate: '2025-02-01', units: 10, pricePerUnit: 100,
    });
    expect(valid.validationError, `unexpected validation error: ${valid.validationError}`).toBeNull();
    expect(valid.error, `unexpected error: ${valid.error}`).toBeNull();
    expect(valid.sourceDocumentId).not.toBeNull();
    expect(valid.instrumentId).not.toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// D3 — manual-entry idempotency, live DEV
// ---------------------------------------------------------------------------
describe('PC1-D3 live DEV — manual-entry idempotency', () => {
  it('an exact duplicate submission (sequential) is idempotent — one canonical economic transaction/holding', async () => {
    const { submitManualDirectPosition } = await import('@/lib/services/investment-intelligence/manualDirectPositionService');
    const userId = await makeUser('d3-seq');
    const input = {
      action: 'buy' as const, instrumentClass: 'equity' as const, instrumentName: 'PC1 Idempotency Co', isin: 'GB0002374006',
      accountInstitutionName: 'PC1 Test Broker', transactionDate: '2025-03-01', units: 25, pricePerUnit: 40,
    };

    const first = await submitManualDirectPosition(userId, input);
    expect(first.error, `first submit failed: ${first.error}`).toBeNull();
    expect(first.sourceDocumentId).not.toBeNull();
    expect(first.transactionIds).toHaveLength(1);
    expect(first.unitsAfter).toBe(25);

    const second = await submitManualDirectPosition(userId, input);
    expect(second.error, `replay unexpectedly errored: ${second.error}`).toBeNull();
    expect(second.sourceDocumentId).toBe(first.sourceDocumentId); // SAME document — no duplicate chain
    expect(second.instrumentId).toBe(first.instrumentId); // replay now correctly resolves instrumentId (was null pre-fix)
    expect(second.transactionIds).toEqual(first.transactionIds); // SAME transaction id, not a new one
    expect(second.unitsAfter).toBe(25); // NOT 50 — no double-counting

    const { count: docCount } = await admin.from('ii_source_documents').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    const { count: txCount } = await admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    expect(docCount).toBe(1);
    expect(txCount).toBe(1);
  }, 60_000);

  it('5 concurrent identical submissions produce exactly ONE canonical economic admission', async () => {
    const { submitManualDirectPosition } = await import('@/lib/services/investment-intelligence/manualDirectPositionService');
    const userId = await makeUser('d3-concurrent');
    const input = {
      action: 'buy' as const, instrumentClass: 'equity' as const, instrumentName: 'PC1 Concurrency Co', isin: 'US0378331005',
      accountInstitutionName: 'PC1 Test Broker', transactionDate: '2025-04-01', units: 12, pricePerUnit: 55,
    };

    const results = await Promise.all(Array.from({ length: 5 }, () => submitManualDirectPosition(userId, input)));
    for (const r of results) {
      expect(r.error, `concurrent submit errored: ${r.error}`).toBeNull();
      expect(r.sourceDocumentId).not.toBeNull();
    }
    const distinctDocIds = new Set(results.map((r) => r.sourceDocumentId));
    expect(distinctDocIds.size).toBe(1); // all 5 converge on ONE document, never 5

    const { count: docCount } = await admin.from('ii_source_documents').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    const { count: txCount } = await admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    expect(docCount).toBe(1);
    expect(txCount).toBe(1);
  }, 60_000);

  it('legitimate near-duplicates (same ISIN/date/price, different units) remain DISTINCT transactions', async () => {
    const { submitManualDirectPosition } = await import('@/lib/services/investment-intelligence/manualDirectPositionService');
    const userId = await makeUser('d3-negctrl');
    const base = {
      action: 'buy' as const, instrumentClass: 'equity' as const, instrumentName: 'PC1 Near Duplicate Co', isin: 'INE002A01018',
      accountInstitutionName: 'PC1 Test Broker', transactionDate: '2025-05-01', pricePerUnit: 60,
    };

    const buy1 = await submitManualDirectPosition(userId, { ...base, units: 10 });
    const buy2 = await submitManualDirectPosition(userId, { ...base, units: 20 }); // different units -> legitimately distinct
    expect(buy1.error).toBeNull();
    expect(buy2.error).toBeNull();
    expect(buy2.sourceDocumentId).not.toBe(buy1.sourceDocumentId); // NOT deduped
    expect(buy2.unitsAfter).toBe(30); // additive, both counted

    const { count: txCount } = await admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    expect(txCount).toBe(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// D4 — malformed date hardening, live DEV
// ---------------------------------------------------------------------------
describe('PC1-D4 live DEV — malformed transaction date', () => {
  it('a malformed date is rejected with a stable application error, no raw DB details, and 0 rows persisted; a valid date is accepted', async () => {
    const { submitManualDirectPosition } = await import('@/lib/services/investment-intelligence/manualDirectPositionService');
    const userId = await makeUser('d4');

    const malformed = await submitManualDirectPosition(userId, {
      action: 'buy', instrumentClass: 'equity', instrumentName: 'PC1 Bad Date Co', isin: 'US0378331005',
      accountInstitutionName: 'PC1 Test Broker', transactionDate: '2026-02-31', units: 5, pricePerUnit: 200,
    });
    expect(malformed.validationErrorCode).toBe('INVALID_TRANSACTION_DATE');
    expect(malformed.sourceDocumentId).toBeNull();
    const msg = (malformed.validationError ?? '').toLowerCase();
    expect(msg).not.toMatch(/postgres|sqlstate|relation|constraint|column ".*" of relation|23514|22007/);
    const { count: docCountAfterMalformed } = await admin.from('ii_source_documents').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    expect(docCountAfterMalformed).toBe(0);

    const valid = await submitManualDirectPosition(userId, {
      action: 'buy', instrumentClass: 'equity', instrumentName: 'PC1 Good Date Co', isin: 'INE002A01018',
      accountInstitutionName: 'PC1 Test Broker', transactionDate: '2025-06-15', units: 5, pricePerUnit: 200,
    });
    expect(valid.validationError).toBeNull();
    expect(valid.sourceDocumentId).not.toBeNull();
  }, 60_000);
});
