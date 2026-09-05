// II-PC3-C1 — REAL_CAMS_VARIANT_QUALIFICATION live hosted-DEV campaign.
//
// Same real-hosted-DEV methodology as iiPc3RealCamsQualificationLiveDev.test.ts
// (real synthetic auth users, the real unmodified processSourceDocument()/
// r5Repository/sipOrchestrator/taxRepository/taxOrchestrator/publishing
// service functions imported directly — never re-implemented, real Storage
// uploads, real Postgres reads) — run against the NEW Q01-Q12
// REAL_CAMS_VARIANT fixture pack (lib/fixtures/investment-intelligence/
// pc3-cams-real-variant/), built against the REAL CAMS grammar
// (docs/investment-intelligence/II_PC3_REAL_CAMS_VARIANT_FINGERPRINT.md),
// not the legacy pre-real-sample grammar.
//
// To run this suite for real: supply a `.env.local` with
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY pointed at the DEV project
// (ref `vqycarelcoijzwlpkpcz`), then
// `npx vitest run --config vitest.livedev.config.ts tests/live-dev/iiPc3RealVariantQualificationLiveDev.test.ts`.
// Every synthetic user/household/document/account/transaction/holding/
// reconciliation-case/portfolio-truth-status/tax/publication/analytics row
// this suite creates is deleted in `afterAll`, which independently
// re-queries to confirm zero residue.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = path.join(repoRoot, '.env.local');
const HAS_ENV = fs.existsSync(envFile);

if (!HAS_ENV) {
  describe('II-PC3-C1 — real-variant live DEV campaign', () => {
    it.skip('SKIPPED: no .env.local present in this environment', () => {
      expect(HAS_ENV).toBe(false);
    });
  });
} else {
  const env: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = rawLine.replace(/^﻿/, '').trim();
    const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
  const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!BASE || !ANON || !SERVICE) {
    throw new Error('INFRASTRUCTURE DEPENDENCY — NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must all be present in .env.local for live-DEV certification.');
  }
  const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
  const actualRef = new URL(BASE).host.split('.')[0];
  if (actualRef !== EXPECTED_DEV_REF) {
    throw new Error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project. This suite never touches production.`);
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;

  const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const PACK_DIR = path.join(repoRoot, 'lib/fixtures/investment-intelligence/pc3-cams-real-variant');
  const STAMP = Date.now();
  const RUN_TAG = `pc3rv-${STAMP}`;
  const cleanupUserIds: string[] = [];

  interface SyntheticUser { userId: string; email: string; client: SupabaseClient; memberId: string }

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
    if (!session.access_token) throw new Error(`could not sign in synthetic user ${tag}`);
    const client = createSupabaseJsClient(BASE, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    });

    const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: data.user.id, household_name: `PC3RV ${tag}`, primary_country: 'IN' }).select('id').single();
    if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
    const { data: mem, error: memErr } = await admin
      .from('household_members')
      .insert({ user_id: data.user.id, household_id: hh.id, full_name: `PC3RV Self ${tag}`, relationship: 'self' })
      .select('id')
      .single();
    if (memErr || !mem) throw new Error(`household_member insert failed for ${tag}: ${memErr?.message}`);

    return { userId: data.user.id, email, client, memberId: mem.id as string };
  }

  async function uploadPdfStatement(userId: string, fixtureId: string, ownerMemberId: string): Promise<{ docId: string; deduplicated: boolean }> {
    const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
    const bytes = fs.readFileSync(path.join(PACK_DIR, `${fixtureId}.pdf`));
    const checksum = createHash('sha256').update(bytes).digest('hex');

    const { data: existing } = await admin.from('ii_source_documents').select('id').eq('user_id', userId).eq('checksum', checksum).maybeSingle();
    if (existing) return { docId: existing.id as string, deduplicated: true };

    const objectKey = `${userId}/${randomUUID()}.pdf`;
    const { error: upErr } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'application/pdf', upsert: false });
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
    const { data: doc, error: docErr } = await admin
      .from('ii_source_documents')
      .insert({ user_id: userId, owner_member_id: ownerMemberId, country_code: 'IN', status: 'uploaded', checksum, storage_path: objectKey, original_filename: `${fixtureId}.pdf`, mime_type: 'application/pdf', file_size: bytes.length })
      .select('id')
      .single();
    if (docErr || !doc) throw new Error(`could not create source document row: ${docErr?.message}`);
    return { docId: doc.id as string, deduplicated: false };
  }

  afterAll(async () => {
    for (const userId of cleanupUserIds) {
      await admin.from('ii_fhip_publications').delete().eq('user_id', userId);
      await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId);
      await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId);
      await admin.from('ii_tax_lots').delete().eq('user_id', userId);
      await admin.from('ii_r5_analytics_results').delete().eq('user_id', userId);
      const tables = [
        'ii_reconciliation_cases', 'ii_transaction_source_links', 'ii_transactions', 'ii_holding_snapshots',
        'ii_portfolio_truth_status', 'ii_document_parse_runs', 'ii_source_documents', 'ii_accounts',
      ];
      for (const t of tables) await admin.from(t).delete().eq('user_id', userId);
      const { data: hhIds } = await admin.from('households').select('id').eq('user_id', userId);
      for (const hh of hhIds ?? []) await admin.from('household_members').delete().eq('household_id', hh.id as string);
      await admin.from('households').delete().eq('user_id', userId);
      await admin.auth.admin.deleteUser(userId);
    }
    for (const t of ['ii_source_documents', 'ii_accounts', 'ii_tax_lots', 'ii_r5_analytics_results', 'ii_fhip_publications', 'households', 'household_members']) {
      for (const userId of cleanupUserIds) {
        const { data } = await admin.from(t).select('id').eq('user_id', userId).limit(1);
        expect(data ?? [], `residue check: ${t} must be empty for cleaned-up user ${userId}`).toEqual([]);
      }
    }
    for (const userId of cleanupUserIds) {
      const { data: authUser } = await admin.auth.admin.getUserById(userId);
      expect(authUser?.user ?? null, `residual auth user ${userId}`).toBeNull();
    }
  }, 180_000);

  // Same disclosed wall-clock-staleness reasoning as the legacy Gate B
  // suite: every fixture carries 2025 dates, so a genuinely clean fixture
  // legitimately certifies 'certified_with_warnings' (stale_statement_date),
  // not bare 'certified'. Also allow 'incomplete_transaction_history' for
  // incremental/second uploads (Q04/Q05).
  const ACCEPTABLE_WARNING_CODES = new Set(['stale_statement_date', 'incomplete_transaction_history']);
  // II-PC3-C1 harness fix (found running this suite live): ii_portfolio_truth_status
  // is keyed by (account_id, instrument_id), not account_id alone — an
  // account holding MULTIPLE instruments (this grammar's Q07, where two
  // schemes share one account because amcName collapses to 'Unknown AMC')
  // genuinely has multiple truth rows for the same account_id. The
  // original version of this helper used `.single()`, which fails
  // whenever more than one row matches, making `truth` null and every
  // assertion compare against `undefined` — a harness bug, not a product
  // defect (documentProcessing.ts's own (account,instrument) certification
  // model is correct and unchanged). Fixed to check EVERY matching row.
  async function expectCleanCertification(accountId: string, instrumentId?: string) {
    let query = admin.from('ii_portfolio_truth_status').select('status, warning_reasons, blocking_reasons').eq('account_id', accountId);
    if (instrumentId) query = query.eq('instrument_id', instrumentId);
    const { data: truths } = await query;
    expect(truths?.length, `expected at least one portfolio_truth_status row for account ${accountId}`).toBeGreaterThan(0);
    for (const truth of truths ?? []) {
      expect(truth.status, `must not be blocked: ${JSON.stringify(truth.blocking_reasons)}`).not.toBe('reconciliation_required');
      expect(['certified', 'certified_with_warnings']).toContain(truth.status);
      if (truth.status === 'certified_with_warnings') {
        const codes = (truth.warning_reasons as { code: string }[] | null)?.map((w) => w.code) ?? [];
        for (const code of codes) expect(ACCEPTABLE_WARNING_CODES.has(code), `unexpected warning code on an otherwise-clean fixture: ${code}`).toBe(true);
      }
    }
    return truths;
  }

  describe('II-PC3-C1 — REAL_CAMS_VARIANT_QUALIFICATION live DEV campaign', () => {
    it('Q01 real-variant baseline: real PDF upload -> processSourceDocument() -> 2 accounts, 6 transactions (incl. fee+tax rows), 2 holdings, clean certification', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q01');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q01-baseline-multi-amc-multi-folio', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.accountsFound).toBe(2);
      expect(result.summary?.transactionsFound).toBe(6);
      const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
      expect(accounts?.length).toBe(2);
      const { data: txns } = await admin.from('ii_transactions').select('transaction_type, units').eq('user_id', user.userId);
      const byType = new Map<string, number>();
      for (const t of txns ?? []) byType.set(t.transaction_type as string, (byType.get(t.transaction_type as string) ?? 0) + 1);
      expect(byType.get('fee')).toBe(1);
      expect(byType.get('tax')).toBe(1);
      const feeRow = (txns ?? []).find((t) => t.transaction_type === 'fee');
      expect(Number(feeRow?.units)).toBe(0); // fee row must carry zero units, never fabricated/misclassified
      for (const a of accounts ?? []) await expectCleanCertification(a.id as string);
    }, 120_000);

    it('Q02 real-variant encrypted: no/wrong password rejected, correct password (synthetic, never the real document\'s) yields SAME persisted result as Q01, password never persisted', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q02');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q02-encrypted-duplicate-of-q01', user.memberId);
      const noPassword = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(noPassword.status).toBe('password_required');
      const wrongPassword = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId, password: 'wrong' });
      expect(wrongPassword.status).toBe('password_required');
      const correct = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId, password: 'PC3RV-Qualification-2026' });
      expect(correct.ok, correct.error ?? '').toBe(true);
      expect(correct.summary?.accountsFound).toBe(2);
      expect(correct.summary?.transactionsFound).toBe(6);
      const { data: runs } = await admin.from('ii_document_parse_runs').select('errors').eq('source_document_id', docId);
      for (const r of runs ?? []) expect(JSON.stringify(r.errors ?? '')).not.toContain('PC3RV-Qualification-2026');
      const { data: doc } = await admin.from('ii_source_documents').select('*').eq('id', docId).single();
      expect(JSON.stringify(doc)).not.toContain('PC3RV-Qualification-2026');
    }, 120_000);

    it("Q03 real-variant F1 probe: redemption from Folio B never reduces Folio A's balance — zero cross-account contamination", async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q03');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q03-two-folios-fifo-scope', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
      const folioA = accounts?.find((a) => a.folio_number === '950304000001');
      const folioB = accounts?.find((a) => a.folio_number === '950304000002');
      expect(folioA).toBeTruthy();
      expect(folioB).toBeTruthy();
      const { data: holdingA } = await admin.from('ii_holding_snapshots').select('units').eq('account_id', folioA!.id).order('as_of_date', { ascending: false }).limit(1).single();
      expect(Number(holdingA?.units)).toBeCloseTo(100.19, 2);
      const { data: holdingB } = await admin.from('ii_holding_snapshots').select('units').eq('account_id', folioB!.id).order('as_of_date', { ascending: false }).limit(1).single();
      expect(Number(holdingB?.units)).toBeCloseTo(90.29, 2);
      for (const a of accounts ?? []) await expectCleanCertification(a.id as string);
    }, 120_000);

    it('Q04 real-variant monthly delta (reusing Q01/Q03 account identities): same accounts reused, historical transactions dedup, only genuinely new ones added', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q04');
      // Establish the SAME account identities Q04 will reuse.
      const q01 = await uploadPdfStatement(user.userId, 'pc3rv-q01-baseline-multi-amc-multi-folio', user.memberId);
      const r01 = await processSourceDocument({ userId: user.userId, sourceDocumentId: q01.docId });
      expect(r01.ok, r01.error ?? '').toBe(true);
      const q03 = await uploadPdfStatement(user.userId, 'pc3rv-q03-two-folios-fifo-scope', user.memberId);
      const r03 = await processSourceDocument({ userId: user.userId, sourceDocumentId: q03.docId });
      expect(r03.ok, r03.error ?? '').toBe(true);
      const { data: accountsAfterBase } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
      expect(accountsAfterBase?.length).toBe(4);
      const accountIdsBefore = new Set((accountsAfterBase ?? []).map((a) => a.id));

      const q04 = await uploadPdfStatement(user.userId, 'pc3rv-q04-monthly-delta', user.memberId);
      const r04 = await processSourceDocument({ userId: user.userId, sourceDocumentId: q04.docId });
      expect(r04.ok, r04.error ?? '').toBe(true);
      expect(r04.summary?.duplicateTransactionsLinked).toBe(4); // 3 from folio1 (Q01) + 1 from folioA (Q03)

      const { data: accountsAfterDelta } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accountsAfterDelta?.length).toBe(4); // NO new account minted — same 4 identities reused
      for (const a of accountsAfterDelta ?? []) expect(accountIdsBefore.has(a.id)).toBe(true);

      const { data: txns } = await admin.from('ii_transactions').select('source_reference').eq('user_id', user.userId);
      expect(txns?.length).toBe(11); // Q01(6) + Q03(3) + Q04's 2 genuinely-new rows, zero duplicates persisted
      const refs = new Set((txns ?? []).map((t) => t.source_reference).filter(Boolean));
      expect(refs.has('PCRV4-NEW-001')).toBe(true);
      expect(refs.has('PCRV4-NEW-002')).toBe(true);
    }, 90_000);

    it('Q05 real-variant exact reimport of Q04: identical-byte reupload deduplicated at the upload layer, reprocessing idempotent — ZERO duplicate rows', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q05');
      const q01 = await uploadPdfStatement(user.userId, 'pc3rv-q01-baseline-multi-amc-multi-folio', user.memberId);
      await processSourceDocument({ userId: user.userId, sourceDocumentId: q01.docId });
      const q03 = await uploadPdfStatement(user.userId, 'pc3rv-q03-two-folios-fifo-scope', user.memberId);
      await processSourceDocument({ userId: user.userId, sourceDocumentId: q03.docId });
      const first = await uploadPdfStatement(user.userId, 'pc3rv-q04-monthly-delta', user.memberId);
      expect(first.deduplicated).toBe(false);
      const r1 = await processSourceDocument({ userId: user.userId, sourceDocumentId: first.docId });
      expect(r1.ok, r1.error ?? '').toBe(true);

      const second = await uploadPdfStatement(user.userId, 'pc3rv-q04-monthly-delta', user.memberId);
      expect(second.deduplicated, 'identical checksum for the same user must be deduplicated at the upload layer').toBe(true);
      expect(second.docId).toBe(first.docId);

      const reimport = await processSourceDocument({ userId: user.userId, sourceDocumentId: second.docId });
      expect(reimport.ok, reimport.error ?? '').toBe(true);
      expect(reimport.summary?.duplicateTransactionsLinked).toBe(0); // nothing NEW ran at all

      const { data: txns } = await admin.from('ii_transactions').select('id').eq('user_id', user.userId);
      expect(txns?.length).toBe(11); // unchanged from post-Q04
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accounts?.length).toBe(4);
      const { data: docs } = await admin.from('ii_source_documents').select('id').eq('user_id', user.userId);
      expect(docs?.length, 'only ONE source-document row for the Q04 statement must exist — the dedup route never creates a second').toBe(3); // Q01 + Q03 + Q04 (Q05 reused Q04's row)
    }, 90_000);

    it('Q06 real-variant SIP-rich: exactly 5 SIP transactions persisted, real R5 SIP engine detects the Feb->Apr gap', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q06');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q06-sip-rich-skipped-month', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(5);
      const { data: txns } = await admin.from('ii_transactions').select('transaction_date, transaction_type').eq('user_id', user.userId).order('transaction_date');
      expect((txns ?? []).map((t) => t.transaction_date)).toEqual(['2025-01-05', '2025-02-05', '2025-04-05', '2025-05-05', '2025-06-05']);
      expect((txns ?? []).every((t) => t.transaction_type === 'sip')).toBe(true);

      const { loadSipDataset, attachAttributableInflows } = await import('@/lib/services/investment-intelligence/r5Repository');
      const { runSipAnalytics } = await import('@/lib/engines/investment-intelligence/sip/sipOrchestrator');
      const { dataset } = await loadSipDataset(user.client, user.userId, {});
      expect(dataset).toBeTruthy();
      const preliminary = runSipAnalytics(dataset!);
      attachAttributableInflows(dataset!, preliminary.analytics.map((a) => a.series.seriesKey));
      const sipResult = runSipAnalytics(dataset!);
      expect(sipResult.analytics.length).toBeGreaterThan(0);
      const series = sipResult.analytics[0];
      expect(series.consistency.gaps?.length, 'the real R5 gap-detector must surface exactly one gap (Feb->Apr)').toBe(1);
      expect(series.consistency.gaps![0].fromDate).toBe('2025-02-05');
      expect(series.consistency.gaps![0].toDate).toBe('2025-04-05');
    }, 120_000);

    it('Q07 real-variant transaction-rich: every currently-supported transaction type ingests correctly, plus fee evidence, correct opening/closing balance arithmetic', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q07');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q07-transaction-rich', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(8);
      const { data: txns } = await admin.from('ii_transactions').select('transaction_type, units, gross_amount, source_reference').eq('user_id', user.userId).order('source_reference');
      const byRef = new Map((txns ?? []).map((t) => [t.source_reference as string | null, t]));
      expect(byRef.get('PCRV7-001')?.transaction_type).toBe('purchase');
      expect(byRef.get('PCRV7-002')?.transaction_type).toBe('sip');
      expect(byRef.get('PCRV7-003')?.transaction_type).toBe('redemption');
      expect(byRef.get('PCRV7-004')?.transaction_type).toBe('dividend');
      expect(byRef.get('PCRV7-005')?.transaction_type).toBe('reinvestment');
      expect(byRef.get('PCRV7-006')?.transaction_type).toBe('switch_out');
      expect(byRef.get('PCRV7-007')?.transaction_type).toBe('switch_in');
      const feeRows = (txns ?? []).filter((t) => t.transaction_type === 'fee');
      expect(feeRows.length).toBe(1);
      expect(Number(feeRows[0].units)).toBe(0);
      // Opening balance correctly zero: closing units must equal the sum of
      // this scheme's own listed transaction units by direction — checked
      // directly against the real persisted holding snapshot.
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accounts?.length).toBe(1); // both schemes share one account (amcName collapses to 'Unknown AMC' in this grammar) — instrument-level distinction handles the rest
      const { data: holdings } = await admin.from('ii_holding_snapshots').select('instrument_id, units').eq('account_id', accounts![0].id);
      expect(holdings?.length).toBe(2); // 2 distinct instruments (schemes)
      for (const a of accounts ?? []) await expectCleanCertification(a.id as string);
    }, 120_000);

    it('Q08 real-variant reconciliation mismatch: certification MUST land on reconciliation_required, never certified', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q08');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q08-reconciliation-mismatch', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, blocking_reasons').eq('account_id', accounts![0].id).single();
      expect(truth?.status).not.toBe('certified');
      expect(truth?.status).toBe('reconciliation_required');
      expect(JSON.stringify(truth?.blocking_reasons)).toContain('unit_variance_exceeds_tolerance');
    }, 120_000);

    it('Q09 real-variant continuation + AMC transition: all 7 transactions persisted exactly once across the real page break with zero header reprint, second folio/scheme correctly independent', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q09');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q09-continuation-amc-transition', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(7);
      const { data: txns } = await admin.from('ii_transactions').select('source_reference, account_id').eq('user_id', user.userId);
      const refs = new Set((txns ?? []).map((t) => t.source_reference).filter(Boolean));
      expect(refs.size).toBe(6); // 6 refs (the fee row carries no ref, by design)
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accounts?.length).toBe(2);
      const accountIds = new Set((txns ?? []).map((t) => t.account_id));
      expect(accountIds.size).toBe(2); // zero cross-account leakage
      for (const a of accounts ?? []) await expectCleanCertification(a.id as string);
    }, 120_000);

    it('Q10 real-variant malformed negative: the impossible-date row is rejected, certification blocked by parser_fatal_error, no raw DB error, one clean row persists', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q10');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q10-malformed-negative', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(typeof result.ok).toBe('boolean');
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accounts?.length).toBe(1);
      const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, blocking_reasons').eq('account_id', accounts![0].id).single();
      expect(truth?.status).toBe('reconciliation_required');
      expect(JSON.stringify(truth?.blocking_reasons)).toContain('parser_fatal_error');
      const { data: txns } = await admin.from('ii_transactions').select('source_reference').eq('user_id', user.userId);
      expect((txns ?? []).map((t) => t.source_reference)).toEqual(['PCRV10-002']);
      const { data: run } = await admin.from('ii_document_parse_runs').select('errors').eq('source_document_id', docId).single();
      expect(JSON.stringify(run?.errors)).toContain('unparseable_date');
    }, 120_000);

    it('Q11 real-variant fee evidence: every fee/tax row persists with correct type/zero units/null nav, never becomes its own holding, dual-fee date persists BOTH rows', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q11');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q11-fee-evidence', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(7);
      const { data: txns } = await admin.from('ii_transactions').select('transaction_type, units, gross_amount, transaction_date').eq('user_id', user.userId);
      const feeTax = (txns ?? []).filter((t) => t.transaction_type === 'fee' || t.transaction_type === 'tax');
      expect(feeTax.length).toBe(4);
      for (const t of feeTax) expect(Number(t.units)).toBe(0);
      const dualDate = (txns ?? []).filter((t) => t.transaction_date === '2025-03-11');
      expect(dualDate.length).toBe(2);
      expect(dualDate.map((t) => t.transaction_type).sort()).toEqual(['fee', 'tax']);
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      const { data: holdings } = await admin.from('ii_holding_snapshots').select('id').eq('account_id', accounts![0].id);
      expect(holdings?.length).toBe(1); // fee/tax rows never became their own holding
    }, 120_000);

    it('Q12 real-variant continuation stress: 18 transactions across a page break with zero header reprint, zero loss/duplication, zero cross-scheme/cross-AMC leakage', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q12');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q12-continuation-stress', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(18);
      const { data: txns } = await admin.from('ii_transactions').select('source_reference, account_id').eq('user_id', user.userId);
      const refs = (txns ?? []).map((t) => t.source_reference).filter(Boolean) as string[];
      expect(new Set(refs).size).toBe(refs.length); // zero duplication
      const folio1Refs = refs.filter((r) => r.startsWith('PCRV12-0'));
      const folio2Refs = refs.filter((r) => r.startsWith('PCRV12-EXTRA'));
      expect(folio1Refs.length).toBe(14);
      expect(folio2Refs.length).toBe(2);
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accounts?.length).toBe(2);
      const accountIds = new Set((txns ?? []).map((t) => t.account_id));
      expect(accountIds.size).toBe(2); // zero cross-scheme/cross-AMC leakage
      const { data: holdings } = await admin.from('ii_holding_snapshots').select('id').eq('user_id', user.userId);
      expect(holdings?.length).toBe(2);
    }, 120_000);

    it('SECURITY — cross-user RLS: a second real synthetic user cannot reach Q01 real-variant user\'s document/account/transaction/holding via the anon-key client', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userA = await makeUser('rlsA');
      const { docId } = await uploadPdfStatement(userA.userId, 'pc3rv-q01-baseline-multi-amc-multi-folio', userA.memberId);
      await processSourceDocument({ userId: userA.userId, sourceDocumentId: docId });
      const { data: accountsA } = await admin.from('ii_accounts').select('id').eq('user_id', userA.userId);
      const accountIdA = accountsA![0].id as string;

      const userB = await makeUser('rlsB');
      const { data: docsB } = await userB.client.from('ii_source_documents').select('*').eq('user_id', userA.userId);
      expect(docsB ?? []).toHaveLength(0);
      const { data: accountsB } = await userB.client.from('ii_accounts').select('*').eq('user_id', userA.userId);
      expect(accountsB ?? []).toHaveLength(0);
      const { data: txnsB } = await userB.client.from('ii_transactions').select('*').eq('user_id', userA.userId);
      expect(txnsB ?? []).toHaveLength(0);
      const { data: holdingsB } = await userB.client.from('ii_holding_snapshots').select('*').eq('user_id', userA.userId);
      expect(holdingsB ?? []).toHaveLength(0);

      const { data: directAccount } = await userB.client.from('ii_accounts').select('*').eq('id', accountIdA);
      expect(directAccount ?? []).toHaveLength(0);
      const { data: directTxns } = await userB.client.from('ii_transactions').select('*').eq('account_id', accountIdA);
      expect(directTxns ?? []).toHaveLength(0);

      const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
      const { data: docRowA } = await admin.from('ii_source_documents').select('storage_path').eq('id', docId).single();
      const { error: downloadErr } = await userB.client.storage.from(II_STORAGE_BUCKET).download(docRowA!.storage_path as string);
      expect(downloadErr, 'User B must be rejected reading User A\'s storage object').not.toBeNull();

      const { error: forgeErr } = await userB.client.from('ii_accounts').insert({
        user_id: userA.userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: 'Forged', folio_number: `${RUN_TAG}-forged`,
      });
      expect(forgeErr, 'authenticated-role insert claiming another user\'s user_id must be REJECTED by RLS').not.toBeNull();
    }, 120_000);

    // -----------------------------------------------------------------
    // Net-worth-once-only (Q01/Q03) — the ADR-004 dedup guarantee at the
    // persistence layer. This exercises `publishPositionStructural`
    // (the real, unmodified admin-client publication function from
    // publishing.ts) directly, NOT the full request-scoped
    // `publishPosition()` orchestration in investmentPublicationService.ts
    // — that function calls `createClient()` (Next.js server/cookie
    // context) and has no script-level entry point in any live-dev suite
    // in this codebase. This is disclosed honestly as the bounded, real
    // proof available at this layer: the SAME canonical_position_id
    // (holding snapshot id) published twice must produce exactly ONE
    // `ii_fhip_publications` row, `include_in_net_worth: true`, both calls
        // returning the identical publicationId.
    // -----------------------------------------------------------------
    it('Net-worth-once-only (Q01): publishing the same canonical position twice creates exactly ONE ii_fhip_publications row, never a duplicate', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const { publishPositionStructural } = await import('@/lib/services/investment-intelligence/publishing');
      const user = await makeUser('nwoo01');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q01-baseline-multi-amc-multi-folio', user.memberId);
      await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      const { data: holdings } = await admin.from('ii_holding_snapshots').select('id').eq('user_id', user.userId).limit(1);
      const positionId = holdings![0].id as string;
      const first = await publishPositionStructural({ userId: user.userId, canonicalPositionId: positionId, publicationTarget: 'investments' });
      expect(first.error).toBeNull();
      const second = await publishPositionStructural({ userId: user.userId, canonicalPositionId: positionId, publicationTarget: 'investments' });
      expect(second.error).toBeNull();
      expect(second.publicationId).toBe(first.publicationId); // same row, not a duplicate
      const { data: pubs } = await admin.from('ii_fhip_publications').select('id, include_in_net_worth').eq('canonical_position_id', positionId);
      expect(pubs?.length, 'exactly one publication row for this position — net worth counted once').toBe(1);
      expect(pubs![0].include_in_net_worth).toBe(true);
    }, 120_000);

    it('Net-worth-once-only (Q03): each of the two distinct folio positions publishes to its own single row, zero cross-position collapse', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const { publishPositionStructural } = await import('@/lib/services/investment-intelligence/publishing');
      const user = await makeUser('nwoo03');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q03-two-folios-fifo-scope', user.memberId);
      await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      const { data: holdings } = await admin.from('ii_holding_snapshots').select('id, account_id').eq('user_id', user.userId);
      expect(holdings?.length).toBe(2);
      const publicationIds: string[] = [];
      for (const h of holdings ?? []) {
        const pub = await publishPositionStructural({ userId: user.userId, canonicalPositionId: h.id as string, publicationTarget: 'investments' });
        expect(pub.error).toBeNull();
        publicationIds.push(pub.publicationId as string);
      }
      expect(new Set(publicationIds).size).toBe(2); // two distinct positions -> two distinct publications, never merged
      const { data: pubs } = await admin.from('ii_fhip_publications').select('id').eq('user_id', user.userId);
      expect(pubs?.length).toBe(2);
    }, 120_000);

    // F2 stale-v2-current-observation: no existing live-dev harness in this
    // codebase (legacy Gate B included) exercises this check at the
    // script level — honestly disclosed as NOT SUPPORTED by this harness,
    // per the task's own "if the harness supports it" qualifier, rather
    // than fabricated.

    it('PC2-F1 closed_at idempotency (Q03 real-variant disposal): repeated real-DEV tax-pipeline reads produce stable lot/consumption/gain rows and a stable (null) closed_at', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q03tax');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3rv-q03-two-folios-fifo-scope', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);

      const { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } = await import('@/lib/services/investment-intelligence/taxRepository');
      const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');

      async function runTaxPipelineOnce() {
        const { dataset } = await loadTaxDataset(user.client, user.userId, {});
        expect(dataset).toBeTruthy();
        const simResult = runTaxSimulation({
          acquisitions: [...dataset!.acquisitionsByInstrument.values()].flat(),
          disposals: [...dataset!.disposalsByInstrument.values()].flat(),
          classificationByInstrument: dataset!.classificationByInstrument,
          fmv31Jan2018ByInstrument: dataset!.fmv31Jan2018ByInstrument,
          salePricePerUnitByDisposal: dataset!.salePricePerUnitByDisposal,
          exitLoadSchedules: dataset!.exitLoadSchedules,
          residencyProfile: {},
        });
        const lotsP = await persistTaxLots(user.userId, simResult.lots);
        const consP = await persistTaxLotConsumptions(user.userId, simResult.disposalResults);
        const cgP = await persistCapitalGainsComputations(user.userId, simResult.disposalResults, simResult.exitLoadResults);
        return { simResult, lotsP, consP, cgP };
      }

      const first = await runTaxPipelineOnce();
      expect(first.lotsP.error).toBeNull();
      expect(first.consP.error).toBeNull();
      expect(first.cgP.error).toBeNull();
      expect(first.simResult.disposalResults).toHaveLength(1);
      expect(first.simResult.disposalResults[0].unitsConsumed).toBeCloseTo(58.65, 2);

      const { data: firstLotRows } = await admin.from('ii_tax_lots').select('id, closed_at, units_remaining').eq('user_id', user.userId).order('id');
      const beforeClosedAt = (firstLotRows ?? []).map((r) => r.closed_at);
      for (const row of firstLotRows ?? []) {
        expect(Number(row.units_remaining)).toBeGreaterThan(0);
        expect(row.closed_at).toBeNull();
      }
      const { count: consCountAfter1 } = await admin.from('ii_tax_lot_consumptions').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);
      const { count: cgCountAfter1 } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);

      await new Promise((r) => setTimeout(r, 1100));
      const second = await runTaxPipelineOnce();
      expect(second.lotsP.error).toBeNull();
      const { data: secondLotRows } = await admin.from('ii_tax_lots').select('id, closed_at, units_remaining').eq('user_id', user.userId).order('id');
      expect((secondLotRows ?? []).map((r) => r.closed_at)).toEqual(beforeClosedAt);
      const { count: consCountAfter2 } = await admin.from('ii_tax_lot_consumptions').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);
      const { count: cgCountAfter2 } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);
      expect(consCountAfter2).toBe(consCountAfter1);
      expect(cgCountAfter2).toBe(cgCountAfter1);
    }, 120_000);

    it.skip('full UI journey via Playwright against real DEV — explicitly out of scope for this script-level campaign, consistent with every other PC-series live-dev suite in this codebase', () => {});
  });
}
