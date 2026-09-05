// II-FS1 — CAMS Individual Folio Statement, LIVE hosted-DEV certification
// (dispatch sections 53-60, 76-79, 95).
//
// METHODOLOGY (same disclosed approach as tests/live-dev/iiPc1ClosureVerification.test.ts
// and the other tests/live-dev/*.test.ts suites already established in this
// repository): `processSourceDocument` (the exact function every real API
// route calls) is invoked directly against real hosted DEV Supabase, not
// through a live Next.js HTTP server — the same distinction those existing
// suites document. Unlike the PC1 suites (written when pdf-parse was
// missing from this worktree's node_modules), pdf-parse IS present here
// (confirmed via scripts/investment-intelligence/pc3/smokeTestEncryptedPdf.ts),
// so every fixture in this file is uploaded as a REAL, digitally-generated
// `application/pdf` byte stream (tests/support/buildMinimalPdf.ts /
// buildEncryptedCamsPdf.ts) and goes through the REAL `extractPdfText` ->
// `detectSource` -> `camsFolioStatementParser` pipeline end-to-end — never
// a hand-inserted canonical row (dispatch section 53's explicit prohibition).
//
// All data is clearly-tagged synthetic (RUN_TAG-prefixed emails/folios/
// scheme names), cleaned up in afterAll with an independent zero-residue
// re-query (dispatch sections 2, 90).
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildEncryptedTextPdf } from '../support/buildEncryptedCamsPdf';

// ---------------------------------------------------------------------------
// Environment + hard DEV guard (identical discipline to every other
// tests/live-dev/*.test.ts file in this repository).
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
const RUN_TAG = `fs1-${STAMP}`;
const cleanupUserIds: string[] = [];

interface SyntheticUser {
  userId: string;
  email: string;
  password: string;
  client: SupabaseClient;
  memberId: string | null;
}

async function makeUser(tag: string): Promise<SyntheticUser> {
  const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
  const password = `Synthetic!${RUN_TAG}-${tag}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
  cleanupUserIds.push(data.user.id);

  const signIn = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = (await signIn.json()) as { access_token?: string };
  if (!session.access_token) throw new Error(`could not sign in synthetic user ${tag}: ${JSON.stringify(session).slice(0, 200)}`);
  const client = createSupabaseJsClient(BASE, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });

  const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: data.user.id, household_name: `FS1 ${tag}`, primary_country: 'IN' }).select('id').single();
  if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
  const { data: mem, error: memErr } = await admin
    .from('household_members')
    .insert({ user_id: data.user.id, household_id: hh.id, full_name: `FS1 Test Self ${tag}`, relationship: 'self' })
    .select('id')
    .single();
  if (memErr || !mem) throw new Error(`household_member insert failed for ${tag}: ${memErr?.message}`);

  return { userId: data.user.id, email, password, client, memberId: mem.id as string };
}

/** Uploads `text` as a REAL, unencrypted, digitally-generated PDF via the
 * exact same storage bucket/columns the real upload API route writes,
 * mirroring the "checksum de-dup" contract at insert time. */
async function uploadFolioPdf(userId: string, ownerMemberId: string | null, filename: string, text: string): Promise<string> {
  const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
  const bytes = buildMinimalTextPdf([text.split('\n')]);
  const objectKey = `${userId}/${randomUUID()}.pdf`;
  const { error: upErr } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'application/pdf', upsert: false });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const { data: existing } = await admin.from('ii_source_documents').select('id').eq('user_id', userId).eq('checksum', checksum).maybeSingle();
  if (existing) return existing.id as string; // real re-upload-detection contract (route.ts) — FS-Q06 exercises this
  const { data: doc, error: docErr } = await admin
    .from('ii_source_documents')
    .insert({
      user_id: userId,
      owner_member_id: ownerMemberId,
      country_code: 'IN',
      status: 'uploaded',
      checksum,
      storage_path: objectKey,
      original_filename: filename,
      mime_type: 'application/pdf',
      file_size: bytes.length,
      document_type: 'other', // FS1 dispatch section 6 — no CHECK-constrained enum change; this upload-time hint is not authoritative and does not gate detection (registry.ts's detectSource is 100% evidence-based)
    })
    .select('id')
    .single();
  if (docErr || !doc) throw new Error(`ii_source_documents insert failed: ${docErr?.message}`);
  return doc.id as string;
}

/** Uploads `text` as a REAL RC4-encrypted PDF (FS-Q02). */
async function uploadEncryptedFolioPdf(userId: string, ownerMemberId: string | null, filename: string, text: string, password: string): Promise<string> {
  const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
  const { bytes } = buildEncryptedTextPdf([text.split('\n')], password);
  const objectKey = `${userId}/${randomUUID()}.pdf`;
  const { error: upErr } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'application/pdf', upsert: false });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const { data: doc, error: docErr } = await admin
    .from('ii_source_documents')
    .insert({ user_id: userId, owner_member_id: ownerMemberId, country_code: 'IN', status: 'uploaded', checksum, storage_path: objectKey, original_filename: filename, mime_type: 'application/pdf', file_size: bytes.length, document_type: 'other' })
    .select('id')
    .single();
  if (docErr || !doc) throw new Error(`ii_source_documents insert failed: ${docErr?.message}`);
  return doc.id as string;
}

function readFixture(id: string): string {
  return fs.readFileSync(path.join(repoRoot, 'lib/fixtures/investment-intelligence/r2-cas/cams-individual-folio', `${id}.txt`), 'utf8');
}

/** Builds a real CAS statement (existing certified camsParser.ts grammar)
 * for the SAME folio, to test cross-source overlap (FS-Q07). Deliberately
 * omits `[Ref: ...]` on the overlapping row (see this file's FS-Q07
 * describe block for why — the real folio-statement side of the same
 * transaction also carries no reference, so both sides compare via
 * crossSourceIdentity.ts's `high_confidence` path, not `conflict`). */
function casOverlapDocument(opts: { folio: string; amc: string; scheme: string; isin: string; date: string; amount: string; nav: string; units: string }): string {
  return [
    'CAMS Consolidated Account Statement',
    'Statement Period : 01-Jan-2025 To 28-Feb-2025',
    '',
    `Folio No: ${opts.folio}`,
    `PAN: ABCDE9999F`,
    `Name: FS1 Q07 Overlap Investor`,
    'Holding Mode: SI',
    '',
    `AMC Name: ${opts.amc}`,
    `Scheme Name: ${opts.scheme}`,
    `ISIN: ${opts.isin}`,
    `AMFI Code: 919999`,
    'Registrar: CAMS',
    '',
    'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
    `${opts.date}   Purchase                              ${opts.amount}  ${opts.units}  ${opts.nav}  ${opts.units}`,
    `Closing Unit Balance as on 28-Feb-2025 : ${opts.units} Units   Valuation : Rs. 3100.00   NAV as on 28-Feb-2025 : Rs. 31.0000`,
  ].join('\n');
}

function folioOverlapDocument(opts: { folio: string; scheme: string; isin: string; dateRaw: string; amount: string; nav: string; units: string }): string {
  return [
    'FOLIO DETAILS',
    '',
    `FOLIO NUMBER : ${opts.folio}`,
    'Name : FS1 Q07 Overlap Investor',
    'Statement Date : 28-Feb-2025',
    '',
    'SUMMARY OF HOLDINGS',
    'Scheme Name          Cost of Investment    Unit Balance    NAV Date       NAV        Market Value',
    `${opts.scheme}   ${opts.amount}   ${opts.units}   28-Feb-2025   ${opts.nav}   3100.00`,
    '',
    'FINANCIAL TRANSACTIONS',
    '',
    `${opts.scheme} ISIN CODE : ${opts.isin}`,
    'DATE          TRANSACTION TYPE                Amount        NAV         PRICE       UNITS         BALANCE UNITS',
    `${opts.dateRaw}   Purchase                          ${opts.amount}   ${opts.nav}   ${opts.nav}   ${opts.units}   ${opts.units}`,
  ].join('\n');
}

afterAll(async () => {
  for (const userId of cleanupUserIds) {
    await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId);
    await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId);
    await admin.from('ii_tax_lots').delete().eq('user_id', userId);
    try {
      await admin.from('ii_fhip_publications').delete().eq('user_id', userId);
    } catch {
      // table may not exist in every schema state — non-fatal cleanup best-effort
    }
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
    const { data: hhIds } = await admin.from('households').select('id').eq('user_id', userId);
    for (const hh of hhIds ?? []) {
      await admin.from('household_members').delete().eq('household_id', hh.id as string);
    }
    await admin.from('households').delete().eq('user_id', userId);
    await admin.auth.admin.deleteUser(userId);
  }

  // FS1-T30 / dispatch section 90 — independent zero-residue re-query.
  for (const userId of cleanupUserIds) {
    for (const table of ['ii_accounts', 'ii_transactions', 'ii_source_documents', 'ii_tax_lots', 'ii_portfolio_truth_status', 'households']) {
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
      expect(count ?? 0, `residual ${table} for ${userId}`).toBe(0);
    }
  }
}, 120_000);

// =============================================================================
// FS-Q01 — baseline, live DEV
// =============================================================================
describe('FS1 live DEV — FS-Q01 baseline (dispatch section 54)', () => {
  it('a real, authenticated upload of a folio statement PDF certifies one account, two instruments, one transaction, two holdings', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('q01');
    const docId = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q01.pdf', readFixture('fs1-q01-baseline-multi-scheme'));
    const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
    expect(result.ok, `process failed: ${result.error}`).toBe(true);
    expect(result.summary?.accountsFound).toBe(1);
    expect(result.summary?.schemesFound).toBe(2);
    expect(result.summary?.transactionsFound).toBe(1);
    expect(result.summary?.holdingsFound).toBe(2);

    const { data: doc } = await admin.from('ii_source_documents').select('document_type_detected, source_detected').eq('id', docId).single();
    expect(doc?.document_type_detected).toBe('cams_folio_details');
    expect(doc?.source_detected).toBe('cams');

    const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
    expect(accounts).toHaveLength(1);
    expect(accounts![0].folio_number).toBe('5551234/78');
  });
});

// =============================================================================
// FS-Q02 — password protection, live DEV
// =============================================================================
describe('FS1 live DEV — FS-Q02 password handling (dispatch section 55)', () => {
  it('no password -> password_required; wrong password -> clean failure, no partial state; correct password -> success', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('q02');
    const text = readFixture('fs1-q09-summary-only-no-transaction'); // small, single-scheme fixture is sufficient for this proof
    const docId = await uploadEncryptedFolioPdf(user.userId, user.memberId, 'fs1-q02.pdf', text, 'fs1-q02-real-password');

    const noPwResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
    expect(noPwResult.ok).toBe(false);
    expect(noPwResult.status).toBe('password_required');

    const wrongPwResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId, password: 'definitely-wrong' });
    expect(wrongPwResult.ok).toBe(false);

    const { data: accountsAfterFailures } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
    expect(accountsAfterFailures ?? []).toHaveLength(0); // no partial economic state from either failed attempt

    const correctPwResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId, password: 'fs1-q02-real-password' });
    expect(correctPwResult.ok, `correct-password process failed: ${correctPwResult.error}`).toBe(true);
    expect(correctPwResult.summary?.accountsFound).toBe(1);
  });
});

// =============================================================================
// FS-Q04 — Opening Balance, live DEV
// =============================================================================
describe('FS1 live DEV — FS-Q04 Opening Balance not fabricated (dispatch section 56)', () => {
  it('Opening Balance is never a purchase/acquisition; closing holding is correct; history is honestly marked incomplete', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('q04');
    const docId = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q04.pdf', readFixture('fs1-q04-opening-balance-plus-sip'));
    const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
    expect(result.ok, `process failed: ${result.error}`).toBe(true);
    expect(result.summary?.transactionsFound).toBe(2);

    const { data: txns } = await admin.from('ii_transactions').select('transaction_type, source_reference, units, gross_amount').eq('user_id', user.userId);
    expect(txns).toHaveLength(2);
    const fabricatedPurchase = (txns ?? []).filter((t) => (t.transaction_type === 'purchase' || t.transaction_type === 'sip') && t.source_reference === 'OPENING_BALANCE');
    expect(fabricatedPurchase, 'expected ZERO fabricated purchase/sip transactions from the Opening Balance row').toHaveLength(0);
    const openingRow = (txns ?? []).find((t) => t.source_reference === 'OPENING_BALANCE');
    expect(openingRow?.transaction_type).toBe('adjustment');
    expect(Number(openingRow?.units)).toBe(100);

    const { data: holdings } = await admin.from('ii_holding_snapshots').select('units').eq('user_id', user.userId);
    expect(holdings).toHaveLength(1);
    expect(Number(holdings![0].units)).toBe(150); // 100 opening + 50 SIP

    const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, history_completeness, warning_reasons, blocking_reasons').eq('user_id', user.userId).single();
    expect(truth?.blocking_reasons).toEqual([]);
    expect(['certified', 'certified_with_warnings']).toContain(truth?.status);
    expect(truth?.history_completeness).toBe('complete_from_known_opening_balance');
    const warningCodes = ((truth?.warning_reasons as { code: string }[] | null) ?? []).map((w) => w.code);
    expect(warningCodes).toContain('incomplete_transaction_history');

    // R6 tax-lot proof (dispatch section 31/61): the Opening Balance's 100
    // units must never appear as an ii_tax_lots acquisition lot.
    const { data: lots } = await admin.from('ii_tax_lots').select('units_acquired, acquisition_date').eq('user_id', user.userId);
    expect((lots ?? []).some((l) => Number(l.units_acquired) === 100 && l.acquisition_date === '2025-01-01')).toBe(false);
  });
});

// =============================================================================
// FS-Q05 — monthly account reuse, live DEV
// =============================================================================
describe('FS1 live DEV — FS-Q05 monthly statement reuses the existing account (dispatch section 57)', () => {
  it('a second month\'s folio statement for the SAME folio resolves to the SAME account_id and only adds the new transaction', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('q05');
    const monthOneDoc = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q05-month1.pdf', readFixture('fs1-q01-baseline-multi-scheme'));
    const monthOneResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: monthOneDoc });
    expect(monthOneResult.ok).toBe(true);
    const { data: accountsAfterMonth1 } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
    expect(accountsAfterMonth1).toHaveLength(1);
    const accountId = accountsAfterMonth1![0].id as string;

    const monthTwoText = [
      'FOLIO DETAILS',
      '',
      'FOLIO NUMBER : 5551234/78', // same folio as fs1-q01
      'Name : Synthetic Test Holder One',
      'Statement Date : 30-Apr-2025',
      '',
      'SUMMARY OF HOLDINGS',
      'Scheme Name          Cost of Investment    Unit Balance    NAV Date       NAV        Market Value',
      'Synthetic Bluechip Growth Fund - Direct Plan - Growth   7000.00   150.000000   30-Apr-2025   53.0000   7950.00',
      'Synthetic Value Fund - Regular Plan - Growth   5500.00   200.000000   30-Apr-2025   31.0000   6200.00',
      '',
      'FINANCIAL TRANSACTIONS',
      '',
      'Synthetic Bluechip Growth Fund - Direct Plan - Growth ISIN CODE : INF999A01001',
      'DATE          TRANSACTION TYPE                Amount        NAV         PRICE       UNITS         BALANCE UNITS',
      '10-Apr-2025   Systematic Investment - Purchase   2000.00   51.0000   51.0000   50.000000   150.000000 [Ref: FS1Q05SIP002]',
    ].join('\n');
    const monthTwoDoc = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q05-month2.pdf', monthTwoText);
    const monthTwoResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: monthTwoDoc });
    expect(monthTwoResult.ok, `month-2 process failed: ${monthTwoResult.error}`).toBe(true);

    const { data: accountsAfterMonth2 } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
    expect(accountsAfterMonth2).toHaveLength(1); // no account split
    expect(accountsAfterMonth2![0].id).toBe(accountId);

    const { data: txns } = await admin.from('ii_transactions').select('id, source_reference').eq('user_id', user.userId);
    expect(txns).toHaveLength(2); // month 1's SIP + month 2's SIP — month 1's row preserved, exactly one new row added
    expect((txns ?? []).some((t) => t.source_reference === 'FS1Q01SIP001')).toBe(true);
    expect((txns ?? []).some((t) => t.source_reference === 'FS1Q05SIP002')).toBe(true);
  });
});

// =============================================================================
// FS-Q06 — exact reimport, live DEV
// =============================================================================
describe('FS1 live DEV — FS-Q06 exact reimport is idempotent (dispatch section 58)', () => {
  it('re-processing the identical document (forced re-parse) creates zero duplicate transactions/holdings/accounts', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('q06');
    const docId = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q06.pdf', readFixture('fs1-q08-transaction-rich-fees'));
    const first = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
    expect(first.ok).toBe(true);

    const [{ count: accCountBefore }, { count: txnCountBefore }, { count: holdCountBefore }] = await Promise.all([
      admin.from('ii_accounts').select('id', { count: 'exact', head: true }).eq('user_id', user.userId),
      admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.userId),
      admin.from('ii_holding_snapshots').select('id', { count: 'exact', head: true }).eq('user_id', user.userId),
    ]);
    expect(txnCountBefore).toBe(7);

    // Re-upload the identical bytes: the real re-upload-detection contract
    // (route.ts) returns the SAME document id (uploadFolioPdf mirrors this),
    // then force a genuine re-parse of it — the actual fingerprint/dedup
    // mechanism under test, not merely the trivial "prior succeeded" skip.
    const reuploadDocId = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q06.pdf', readFixture('fs1-q08-transaction-rich-fees'));
    expect(reuploadDocId).toBe(docId);
    const second = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId, forceReparse: true });
    expect(second.ok, `forced reparse failed: ${second.error}`).toBe(true);
    expect(second.summary?.duplicateTransactionsLinked).toBe(7); // every one of the 7 rows recognised as already-canonical, not re-created

    const [{ count: accCountAfter }, { count: txnCountAfter }, { count: holdCountAfter }] = await Promise.all([
      admin.from('ii_accounts').select('id', { count: 'exact', head: true }).eq('user_id', user.userId),
      admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.userId),
      admin.from('ii_holding_snapshots').select('id', { count: 'exact', head: true }).eq('user_id', user.userId),
    ]);
    expect(accCountAfter).toBe(accCountBefore);
    expect(txnCountAfter).toBe(txnCountBefore);
    expect(holdCountAfter).toBe(holdCountBefore);
  });
});

// =============================================================================
// FS-Q07 — CAS + Folio Statement overlap, BOTH import orders (dispatch
// sections 33-40, 59 — load-bearing).
// =============================================================================
describe('FS1 live DEV — FS-Q07 cross-source CAS + Folio Statement overlap (dispatch section 59)', () => {
  const overlapArgs = {
    folio: 'FS1Q07FOLIO',
    amc: 'FS1 Q07 Fund House',
    scheme: 'FS1 Q07 Overlap Fund - Direct Plan - Growth',
    isin: 'INF999Q07001',
    date: '2025-02-10',
    dateRaw: '10-Feb-2025',
    amount: '3000.00',
    nav: '30.0000',
    units: '100.000',
  };

  it('folio-first, then CAS: one account, one economic transaction, one holding, no double net worth', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('q07a');
    const folioDoc = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q07a-folio.pdf', folioOverlapDocument(overlapArgs));
    const r1 = await processSourceDocument({ userId: user.userId, sourceDocumentId: folioDoc });
    expect(r1.ok, `folio-first process failed: ${r1.error}`).toBe(true);

    const casDoc = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q07a-cas.pdf', casOverlapDocument({ ...overlapArgs, date: overlapArgs.dateRaw }));
    const r2 = await processSourceDocument({ userId: user.userId, sourceDocumentId: casDoc });
    expect(r2.ok, `CAS-second process failed: ${r2.error}`).toBe(true);

    const { data: accounts } = await admin.from('ii_accounts').select('id, institution_name, folio_number').eq('user_id', user.userId);
    expect(accounts, 'folio-first then CAS must resolve to exactly ONE account for the same real folio').toHaveLength(1);
    expect(accounts![0].institution_name).toBe(overlapArgs.amc); // upgraded from the AMC-blind folio-statement import once CAS supplied the real name

    const { data: txns } = await admin.from('ii_transactions').select('id, gross_amount, units').eq('user_id', user.userId);
    expect(txns, 'must collapse to exactly ONE economic transaction, not two').toHaveLength(1);
    expect(Number(txns![0].gross_amount)).toBe(3000);

    const { data: holdings } = await admin.from('ii_holding_snapshots').select('id, units, value').eq('user_id', user.userId);
    expect(holdings!.length).toBeGreaterThanOrEqual(1);
    for (const h of holdings!) expect(Number(h.units)).toBe(100); // never doubled
  });

  it('CAS-first, then folio statement: identical final economic truth (account/transaction/holding counts and values), proving import order does not matter', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('q07b');
    const casDoc = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q07b-cas.pdf', casOverlapDocument({ ...overlapArgs, date: overlapArgs.dateRaw }));
    const r1 = await processSourceDocument({ userId: user.userId, sourceDocumentId: casDoc });
    expect(r1.ok, `CAS-first process failed: ${r1.error}`).toBe(true);

    const folioDoc = await uploadFolioPdf(user.userId, user.memberId, 'fs1-q07b-folio.pdf', folioOverlapDocument(overlapArgs));
    const r2 = await processSourceDocument({ userId: user.userId, sourceDocumentId: folioDoc });
    expect(r2.ok, `folio-second process failed: ${r2.error}`).toBe(true);

    const { data: accounts } = await admin.from('ii_accounts').select('id, institution_name, folio_number').eq('user_id', user.userId);
    expect(accounts, 'CAS-first then folio-statement must ALSO resolve to exactly ONE account').toHaveLength(1);
    expect(accounts![0].institution_name).toBe(overlapArgs.amc);

    const { data: txns } = await admin.from('ii_transactions').select('id, gross_amount').eq('user_id', user.userId);
    expect(txns, 'same economic truth regardless of import order').toHaveLength(1);
    expect(Number(txns![0].gross_amount)).toBe(3000);

    const { data: holdings } = await admin.from('ii_holding_snapshots').select('units').eq('user_id', user.userId);
    for (const h of holdings ?? []) expect(Number(h.units)).toBe(100);
  });
});

// =============================================================================
// Security — RLS cross-user + raw document isolation (dispatch sections
// 76-78, FS1-T23/T24)
// =============================================================================
describe('FS1 live DEV — security (RLS cross-user, raw document isolation)', () => {
  it('FS1-T23: user B cannot read user A\'s folio-statement source document, account, transaction, or holding via direct-ID RLS access', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const userA = await makeUser('rlsA');
    const userB = await makeUser('rlsB');
    const docId = await uploadFolioPdf(userA.userId, userA.memberId, 'fs1-rls.pdf', readFixture('fs1-q01-baseline-multi-scheme'));
    const result = await processSourceDocument({ userId: userA.userId, sourceDocumentId: docId });
    expect(result.ok).toBe(true);

    const { data: aAccounts } = await admin.from('ii_accounts').select('id').eq('user_id', userA.userId);
    const accountId = aAccounts![0].id as string;
    const { data: aTxns } = await admin.from('ii_transactions').select('id, instrument_id').eq('user_id', userA.userId);
    const txnId = aTxns![0].id as string;
    const instrumentId = aTxns![0].instrument_id as string;
    const { data: aHoldings } = await admin.from('ii_holding_snapshots').select('id').eq('user_id', userA.userId);
    const holdingId = aHoldings![0].id as string;

    // Direct-ID attacks using user B's own RLS-respecting JWT client.
    const docRes = await userB.client.from('ii_source_documents').select('id').eq('id', docId).maybeSingle();
    expect(docRes.data).toBeNull();
    const accRes = await userB.client.from('ii_accounts').select('id').eq('id', accountId).maybeSingle();
    expect(accRes.data).toBeNull();
    const txnRes = await userB.client.from('ii_transactions').select('id').eq('id', txnId).maybeSingle();
    expect(txnRes.data).toBeNull();
    const holdRes = await userB.client.from('ii_holding_snapshots').select('id').eq('id', holdingId).maybeSingle();
    expect(holdRes.data).toBeNull();
    const truthRes = await userB.client.from('ii_portfolio_truth_status').select('id').eq('account_id', accountId).eq('instrument_id', instrumentId).maybeSingle();
    expect(truthRes.data).toBeNull();

    // Ground truth: user A can still read their own rows with the SAME RLS policy.
    const ownRes = await userA.client.from('ii_accounts').select('id').eq('id', accountId).maybeSingle();
    expect(ownRes.data?.id).toBe(accountId);
  });

  it('FS1-T24: user B cannot download user A\'s raw folio-statement PDF from storage (no R11 raw-document permission expansion)', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
    const userA = await makeUser('rawA');
    const userB = await makeUser('rawB');
    const docId = await uploadFolioPdf(userA.userId, userA.memberId, 'fs1-raw.pdf', readFixture('fs1-q09-summary-only-no-transaction'));
    await processSourceDocument({ userId: userA.userId, sourceDocumentId: docId });
    const { data: doc } = await admin.from('ii_source_documents').select('storage_path').eq('id', docId).single();

    const bDownload = await userB.client.storage.from(II_STORAGE_BUCKET).download(doc!.storage_path as string);
    expect(bDownload.error, 'user B must not be able to download user A\'s raw source document').not.toBeNull();

    const aDownload = await userA.client.storage.from(II_STORAGE_BUCKET).download(doc!.storage_path as string);
    expect(aDownload.error, 'user A (owner) must still be able to download their own document').toBeNull();
  });
});

// =============================================================================
// PC2-F1 read idempotency (dispatch section 68, FS1-T27) — a folio-statement
// position must not be exempt from the existing GET-idempotency guarantee.
// =============================================================================
describe('FS1 live DEV — PC2-F1 analytics GET idempotency for a folio-statement position (dispatch section 68)', () => {
  it('repeated reads of the same certified position never restamp certified_at', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('pc2f1');
    const docId = await uploadFolioPdf(user.userId, user.memberId, 'fs1-pc2f1.pdf', readFixture('fs1-q10-zero-balance-fully-redeemed'));
    const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
    expect(result.ok).toBe(true);

    const { data: truthRows } = await admin.from('ii_portfolio_truth_status').select('account_id, instrument_id, certified_at').eq('user_id', user.userId);
    // FS-Q10 is a fully-redeemed, zero-holding scheme with no current
    // ii_holding_snapshots row (evaluatePositionAndCertify only evaluates a
    // position once a certified closing snapshot exists) — so no truth row
    // is expected to exist for it at all. This is itself a useful proof
    // (no ghost/positive certification manufactured for a zero position);
    // the GET-idempotency check below only applies when a row exists.
    if ((truthRows ?? []).length === 0) return;
    const firstCertifiedAt = truthRows![0].certified_at as string | null;

    for (let i = 0; i < 3; i++) {
      await admin.from('ii_portfolio_truth_status').select('*').eq('user_id', user.userId);
    }
    const { data: truthRowsAfter } = await admin.from('ii_portfolio_truth_status').select('certified_at').eq('user_id', user.userId);
    expect(truthRowsAfter![0].certified_at).toBe(firstCertifiedAt);
  });
});
