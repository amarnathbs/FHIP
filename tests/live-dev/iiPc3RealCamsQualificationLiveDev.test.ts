// II-PC3 — LIVE hosted-DEV campaign (Phase 4 / II-PC3-C1 Gate B).
//
// This file follows the EXACT same real-hosted-DEV methodology as
// tests/live-dev/iiPc1LiveDev.test.ts and iiPc2F1ReadSideMutationLiveDev.test.ts
// (real synthetic auth users, the real unmodified processSourceDocument()/
// taxRepository/r5Repository/sipOrchestrator/xrayOrchestrator service
// functions imported directly — never re-implemented, real Storage uploads,
// real Postgres reads to prove persisted state) — with ONE deliberate
// difference: every fixture here is uploaded as REAL `application/pdf`
// bytes (mime_type='application/pdf'), not `text/csv`, since this is the
// first live-DEV suite to exercise the real PDF/password-extraction branch
// end-to-end against real hosted DEV.
//
// GATE-B ITERATION NOTE: this file's FIRST real run against live DEV caught
// two genuine harness bugs (not product defects), both fixed here after
// live iteration — see II_PC3_QUALIFICATION_PACK_MANIFEST.md's Gate B
// section for the full account:
//   1. Every synthetic user needs a `household_members` row and the
//      uploaded `ii_source_documents.owner_member_id` must be set to it —
//      `ownerUnresolved = !doc.owner_member_id` in documentProcessing.ts is
//      a real, by-design precondition (the real upload UI always asks
//      "whose statement is this?"); the original version of this harness
//      never supplied it, so every fixture landed on `reconciliation_required`
//      / `open_blocking_reconciliation_case` (discrepancy_type
//      'owner_unmatched') for a reason that had nothing to do with parsing,
//      reconciliation, or the two already-fixed PC3 defects.
//   2. `uploadPdfStatement` now mirrors the REAL upload route's own
//      re-upload-detection logic (app/api/investment-intelligence/
//      source-documents/route.ts, "spec section 31"): it checks for an
//      existing `(user_id, checksum)` row FIRST and returns that document's
//      id unchanged, rather than blind-inserting and letting
//      `uidx_ii_source_documents_user_checksum` reject it. The original
//      version of this harness bypassed the real route and hit that raw DB
//      constraint directly.
//
// To run this suite for real: supply a `.env.local` with
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY pointed at the DEV project
// (ref `vqycarelcoijzwlpkpcz`, matching every other live-dev suite's
// guard), then `npx vitest run --config vitest.livedev.config.ts tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts`.
// Every synthetic user/household/document/account/transaction/holding/
// reconciliation-case/portfolio-truth-status/tax/analytics row this suite
// creates is deleted in `afterAll`, and the cleanup itself re-queries to
// confirm zero residue.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = path.join(repoRoot, '.env.local');
const HAS_ENV = fs.existsSync(envFile);

// This suite is a NO-OP (single skipped placeholder test) unless a real
// .env.local is present — it must never silently "pass" 0 assertions and
// be mistaken for a genuine live-DEV run.
if (!HAS_ENV) {
  describe('II-PC3 Phase 4 — live DEV campaign', () => {
    it.skip('SKIPPED: no .env.local present in this environment — Phase 4 was NOT executed (see II_PC3_LIVE_DEV_CAMPAIGN_STATUS.md)', () => {
      expect(HAS_ENV).toBe(false);
    });
  });
} else {
  // BOM/CRLF-safe .env.local parsing (the ORIGINAL version of this parser
  // required a bare `^([A-Za-z_]+)=` match with no BOM-stripping — a real
  // bug caught while actually running this suite for the first time: this
  // repo's real .env.local starts with a UTF-8 BOM, which silently broke
  // the very first line (NEXT_PUBLIC_SUPABASE_URL) and made BASE
  // `undefined`. Fixed to match the already-working parser used by
  // iiPc2F1ReadSideMutationLiveDev.test.ts.)
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
  const PACK_DIR = path.join(repoRoot, 'lib/fixtures/investment-intelligence/pc3-cams');
  const STAMP = Date.now();
  const RUN_TAG = `pc3g-${STAMP}`;
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

    // A real statement upload always names an owning household member
    // (documentProcessing.ts's ownerUnresolved gate requires
    // ii_source_documents.owner_member_id to be set) — every synthetic user
    // needs one, exactly as iiPc2F1ReadSideMutationLiveDev.test.ts's fixture
    // does.
    const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: data.user.id, household_name: `PC3G ${tag}`, primary_country: 'IN' }).select('id').single();
    if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
    const { data: mem, error: memErr } = await admin
      .from('household_members')
      .insert({ user_id: data.user.id, household_id: hh.id, full_name: `PC3G Self ${tag}`, relationship: 'self' })
      .select('id')
      .single();
    if (memErr || !mem) throw new Error(`household_member insert failed for ${tag}: ${memErr?.message}`);

    return { userId: data.user.id, email, client, memberId: mem.id as string };
  }

  // Mirrors the REAL upload route's own re-upload-detection logic
  // (app/api/investment-intelligence/source-documents/route.ts): checks for
  // an existing (user_id, checksum) row FIRST and returns it unchanged if
  // found, rather than letting `uidx_ii_source_documents_user_checksum`
  // reject a blind duplicate insert.
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
    // Full teardown, re-verified — independently re-queried, never trusted
    // from delete replies alone.
    for (const userId of cleanupUserIds) {
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
    for (const t of ['ii_source_documents', 'ii_accounts', 'ii_tax_lots', 'ii_r5_analytics_results', 'households', 'household_members']) {
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

  // All fixtures in this pack carry 2025 statement dates (authored well
  // before this live-DEV run). Real wall-clock "now" is well past
  // reconciliationConfig.ts's DEFAULT_RECONCILIATION_CONFIG.
  // statementFreshnessWarningDays (120 days), so every genuinely CLEAN
  // fixture is expected to land on 'certified_with_warnings' carrying
  // `stale_statement_date` — not 'certified' outright. This is the
  // certification engine behaving exactly as documented (spec section 29's
  // own "may permit CERTIFIED_WITH_WARNINGS" list includes statement
  // staleness); it is a fixture-authoring-date artifact of this
  // qualification pack being run more than a year after it was built, not
  // a functional defect. A position built from a SECOND, incremental
  // upload against an already-certified account (Q04's Feb delta) also
  // legitimately carries `incomplete_transaction_history` (spec section
  // 46 — its reconciliation opening balance comes from the prior snapshot,
  // not scheme inception) — also not a defect. This helper asserts the
  // CLEAN half of the claim — reconciliation/owner/instrument/parser
  // checks all genuinely passed (status is never 'reconciliation_required')
  // and only KNOWN-ACCEPTABLE warning codes are present — without
  // over-asserting an exact terminal status that depends on wall-clock time.
  const ACCEPTABLE_WARNING_CODES = new Set(['stale_statement_date', 'incomplete_transaction_history']);
  async function expectCleanCertification(accountId: string) {
    const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, warning_reasons, blocking_reasons').eq('account_id', accountId).single();
    expect(truth?.status, `must not be blocked: ${JSON.stringify(truth?.blocking_reasons)}`).not.toBe('reconciliation_required');
    expect(['certified', 'certified_with_warnings']).toContain(truth?.status);
    if (truth?.status === 'certified_with_warnings') {
      const codes = (truth.warning_reasons as { code: string }[] | null)?.map((w) => w.code) ?? [];
      for (const code of codes) expect(ACCEPTABLE_WARNING_CODES.has(code), `unexpected warning code on an otherwise-clean fixture: ${code}`).toBe(true);
    }
    return truth;
  }

  describe('II-PC3-C1 Gate B — live DEV campaign (real pipeline, real Supabase, real API surface)', () => {
    it('Q01 baseline: real PDF upload -> real processSourceDocument() -> certified accounts/transactions/holdings persisted', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q01');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q01-baseline-multi-folio-multi-amc', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.accountsFound).toBe(2);
      expect(result.summary?.transactionsFound).toBe(2);
      const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
      expect(accounts?.length).toBe(2);
      for (const a of accounts ?? []) await expectCleanCertification(a.id as string);
    }, 60_000);

    it('Q02 encrypted: wrong password rejected (password_required), correct password yields the SAME persisted result as Q01, password never persisted', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q02');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q02-encrypted-duplicate-of-q01', user.memberId);
      const noPassword = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(noPassword.status).toBe('password_required');
      const wrongPassword = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId, password: 'wrong' });
      expect(wrongPassword.status).toBe('password_required');
      const correct = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId, password: 'PC3-Qualification-2026' });
      expect(correct.ok, correct.error ?? '').toBe(true);
      expect(correct.summary?.accountsFound).toBe(2);
      expect(correct.summary?.transactionsFound).toBe(2);
      // Password-never-persisted guarantee (spec section 10):
      const { data: runs } = await admin.from('ii_document_parse_runs').select('errors').eq('source_document_id', docId);
      for (const r of runs ?? []) expect(JSON.stringify(r.errors ?? '')).not.toContain('PC3-Qualification-2026');
      const { data: doc } = await admin.from('ii_source_documents').select('*').eq('id', docId).single();
      expect(JSON.stringify(doc)).not.toContain('PC3-Qualification-2026');
    }, 60_000);

    it('Q05 exact reimport of Q01: uploading the identical PDF a second time is deduplicated at the upload layer, and reprocessing it is idempotent at the processing layer — ZERO duplicate transactions/accounts/holdings either way', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q05');
      const first = await uploadPdfStatement(user.userId, 'pc3-q01-baseline-multi-folio-multi-amc', user.memberId);
      expect(first.deduplicated).toBe(false);
      const r1 = await processSourceDocument({ userId: user.userId, sourceDocumentId: first.docId });
      expect(r1.ok, r1.error ?? '').toBe(true);

      // Re-"upload" the byte-identical file: the real route's own
      // re-upload-detection returns the SAME document id, never a new row.
      const second = await uploadPdfStatement(user.userId, 'pc3-q01-baseline-multi-folio-multi-amc', user.memberId);
      expect(second.deduplicated, 'identical checksum for the same user must be deduplicated at the upload layer').toBe(true);
      expect(second.docId).toBe(first.docId);

      // Reprocessing the SAME already-succeeded document is idempotent —
      // documentProcessing.ts short-circuits to the cached prior-succeeded
      // summary rather than re-running the parse/reconciliation pipeline.
      const reimport = await processSourceDocument({ userId: user.userId, sourceDocumentId: second.docId });
      expect(reimport.ok, reimport.error ?? '').toBe(true);
      expect(reimport.summary?.duplicateTransactionsLinked).toBe(0); // nothing NEW was linked — nothing new ran at all
      const { data: txns } = await admin.from('ii_transactions').select('id').eq('user_id', user.userId);
      expect(txns?.length).toBe(2); // not 4 — zero net-new rows from the reimport
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accounts?.length).toBe(2); // not 4 accounts
      const { data: snaps } = await admin.from('ii_holding_snapshots').select('id').eq('user_id', user.userId);
      expect(snaps?.length).toBe(2); // one snapshot per account per as-of-date, not doubled
      const { data: docs } = await admin.from('ii_source_documents').select('id').eq('user_id', user.userId);
      expect(docs?.length, 'only ONE source-document row must exist for this user — the dedup route never creates a second').toBe(1);
    }, 60_000);

    it('Q04 monthly delta: same folio/account reused across two uploads — Jan transaction deduped, Feb transaction added exactly once', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q04');
      const doc1 = await uploadPdfStatement(user.userId, 'pc3-q04a-month1', user.memberId);
      const r1 = await processSourceDocument({ userId: user.userId, sourceDocumentId: doc1.docId });
      expect(r1.ok, r1.error ?? '').toBe(true);
      expect(r1.summary?.accountsFound).toBe(1);
      const { data: accountsAfter1 } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      const accountIdAfter1 = accountsAfter1?.[0]?.id;
      const doc2 = await uploadPdfStatement(user.userId, 'pc3-q04b-month1-plus-2-cumulative', user.memberId);
      const r2 = await processSourceDocument({ userId: user.userId, sourceDocumentId: doc2.docId });
      expect(r2.ok, r2.error ?? '').toBe(true);
      expect(r2.summary?.duplicateTransactionsLinked).toBe(1); // the repeated Jan row
      const { data: accountsAfter2 } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accountsAfter2?.length).toBe(1); // SAME account identity reused, not a second account minted
      expect(accountsAfter2?.[0]?.id).toBe(accountIdAfter1);
      const { data: txns } = await admin.from('ii_transactions').select('id').eq('user_id', user.userId);
      expect(txns?.length).toBe(2); // Jan + Feb, no duplicate Jan
      await expectCleanCertification(accountIdAfter1 as string);
    }, 60_000);

    it("Q03 FIFO account-scoping (F1 live probe): redemption from Folio B never reduces Folio A's balance", async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q03');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q03-same-instrument-two-folios-fifo-scope', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
      const folioA = accounts?.find((a) => a.folio_number === '9303040000301');
      const folioB = accounts?.find((a) => a.folio_number === '9303040000302');
      expect(folioA).toBeTruthy();
      expect(folioB).toBeTruthy();
      const { data: holdingA } = await admin.from('ii_holding_snapshots').select('units').eq('account_id', folioA!.id).order('as_of_date', { ascending: false }).limit(1).single();
      expect(Number(holdingA?.units)).toBeCloseTo(100.19, 2); // Folio A's original purchase, untouched
      const { data: holdingB } = await admin.from('ii_holding_snapshots').select('units').eq('account_id', folioB!.id).order('as_of_date', { ascending: false }).limit(1).single();
      expect(Number(holdingB?.units)).toBeCloseTo(90.29, 2); // Folio B's post-redemption balance
      for (const a of accounts ?? []) await expectCleanCertification(a.id as string);
    }, 60_000);

    it('Q09 multi-page continuation: all 12 transactions persisted exactly once (zero loss, zero duplication across the real page break)', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q09');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q09-multi-page-continuation', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(12);
      const { data: txns } = await admin.from('ii_transactions').select('source_reference').eq('user_id', user.userId);
      const refs = new Set((txns ?? []).map((t) => t.source_reference));
      expect(refs.size).toBe(12); // 12 distinct refs — no duplicate, no collapse
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      await expectCleanCertification(accounts![0].id as string);
    }, 60_000);

    it('Q06 SIP-rich: exactly 5 SIP transactions persisted, and the real R5 SIP engine detects the Feb->Apr gap (no phantom March)', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q06');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q06-sip-rich-skipped-month', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(5);
      const { data: txns } = await admin.from('ii_transactions').select('transaction_date, transaction_type').eq('user_id', user.userId).order('transaction_date');
      expect((txns ?? []).map((t) => t.transaction_date)).toEqual(['2025-01-05', '2025-02-05', '2025-04-05', '2025-05-05', '2025-06-05']);
      expect((txns ?? []).every((t) => t.transaction_type === 'sip')).toBe(true);

      // Real R5 SIP orchestrator, through the exact call the /sip route makes.
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
      const gap = series.consistency.gaps![0];
      expect(gap.fromDate).toBe('2025-02-05');
      expect(gap.toDate).toBe('2025-04-05');
    }, 60_000);

    it('Q07 transaction-rich: every currently-supported transaction type ingests correctly with the right canonical type/units/amount', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q07');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q07-transaction-rich', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);
      expect(result.summary?.transactionsFound).toBe(7);
      const { data: txns } = await admin
        .from('ii_transactions')
        .select('transaction_type, units, gross_amount, source_reference')
        .eq('user_id', user.userId)
        .order('source_reference');
      const byRef = new Map((txns ?? []).map((t) => [t.source_reference as string, t]));
      expect(byRef.get('PC3Q7-001')?.transaction_type).toBe('purchase');
      expect(byRef.get('PC3Q7-002')?.transaction_type).toBe('sip');
      expect(byRef.get('PC3Q7-003')?.transaction_type).toBe('redemption');
      expect(byRef.get('PC3Q7-004')?.transaction_type).toBe('dividend');
      expect(byRef.get('PC3Q7-005')?.transaction_type).toBe('reinvestment');
      expect(byRef.get('PC3Q7-006')?.transaction_type).toBe('switch_out');
      expect(byRef.get('PC3Q7-007')?.transaction_type).toBe('switch_in');
      expect(Number(byRef.get('PC3Q7-001')?.units)).toBeCloseTo(83.5, 3);
      expect(Number(byRef.get('PC3Q7-004')?.units)).toBeCloseTo(0, 3); // IDCW payout, no unit impact
      // This fixture was fixed during this Gate B run (a fixture-authoring
      // bug — see the commit message — the scenario's Scheme-A running
      // balance started from a synthetic pre-existing 500 units, which is
      // inconsistent with this codebase's own zero-based
      // complete_from_inception assumption for a first-time document
      // import) to be genuinely zero-based; it must now certify cleanly
      // (allowing only the expected statement-staleness warning).
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      for (const a of accounts ?? []) await expectCleanCertification(a.id as string);
    }, 60_000);

    it('Q08 reconciliation exception: certification MUST land on reconciliation_required, never certified', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q08');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q08-reconciliation-exception', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true); // processing succeeds; CERTIFICATION is what must be blocked
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, blocking_reasons').eq('account_id', accounts![0].id).single();
      expect(truth?.status).not.toBe('certified');
      expect(truth?.status).toBe('reconciliation_required');
      expect(JSON.stringify(truth?.blocking_reasons)).toContain('unit_variance_exceeds_tolerance');
    }, 60_000);

    it('Q10 controlled malformed: certification is blocked by parser_fatal_error, not silently certified on reconciliation math alone; no raw DB error surfaces', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q10');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q10-controlled-malformed', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      // Clean structured outcome, not a raw exception — 'ok' may be true
      // (the document overall was processed; the ONE bad row was rejected,
      // not the whole request) but certification must be blocked.
      expect(typeof result.ok).toBe('boolean');
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', user.userId);
      expect(accounts?.length).toBe(1);
      const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, blocking_reasons').eq('account_id', accounts![0].id).single();
      expect(truth?.status).toBe('reconciliation_required');
      expect(JSON.stringify(truth?.blocking_reasons)).toContain('parser_fatal_error');
      // The one surviving clean row (PC3Q10-002) must still have persisted —
      // proving the failure is row-scoped, not document-scoped.
      const { data: txns } = await admin.from('ii_transactions').select('source_reference').eq('user_id', user.userId);
      expect((txns ?? []).map((t) => t.source_reference)).toEqual(['PC3Q10-002']);
      const { data: run } = await admin.from('ii_document_parse_runs').select('errors').eq('source_document_id', docId).single();
      expect(JSON.stringify(run?.errors)).toContain('unparseable_transaction_row');
    }, 60_000);

    it('SECURITY — cross-user RLS: a second real synthetic user cannot reach Q01 user\'s document/account/transaction/holding via the anon-key client', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userA = await makeUser('rlsA');
      const { docId } = await uploadPdfStatement(userA.userId, 'pc3-q01-baseline-multi-folio-multi-amc', userA.memberId);
      await processSourceDocument({ userId: userA.userId, sourceDocumentId: docId });
      const { data: accountsA } = await admin.from('ii_accounts').select('id').eq('user_id', userA.userId);
      const accountIdA = accountsA![0].id as string;

      const userB = await makeUser('rlsB');

      // 1) Broad table reads via User B's real authenticated (anon-key) client.
      const { data: docsB } = await userB.client.from('ii_source_documents').select('*').eq('user_id', userA.userId);
      expect(docsB ?? []).toHaveLength(0);
      const { data: accountsB } = await userB.client.from('ii_accounts').select('*').eq('user_id', userA.userId);
      expect(accountsB ?? []).toHaveLength(0);
      const { data: txnsB } = await userB.client.from('ii_transactions').select('*').eq('user_id', userA.userId);
      expect(txnsB ?? []).toHaveLength(0);
      const { data: holdingsB } = await userB.client.from('ii_holding_snapshots').select('*').eq('user_id', userA.userId);
      expect(holdingsB ?? []).toHaveLength(0);
      const { data: truthB } = await userB.client.from('ii_portfolio_truth_status').select('*').eq('user_id', userA.userId);
      expect(truthB ?? []).toHaveLength(0);

      // 2) Direct-ID reach (User B guesses/obtains User A's real account id) —
      // RLS must still return nothing, proving the isolation is not merely
      // "the app never shows you someone else's user_id filter" but a real
      // row-level policy.
      const { data: directAccount } = await userB.client.from('ii_accounts').select('*').eq('id', accountIdA);
      expect(directAccount ?? []).toHaveLength(0);
      const { data: directTxns } = await userB.client.from('ii_transactions').select('*').eq('account_id', accountIdA);
      expect(directTxns ?? []).toHaveLength(0);
      const { data: directHoldings } = await userB.client.from('ii_holding_snapshots').select('*').eq('account_id', accountIdA);
      expect(directHoldings ?? []).toHaveLength(0);

      // 3) Storage object isolation: User B cannot download User A's raw PDF.
      const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
      const { data: docRowA } = await admin.from('ii_source_documents').select('storage_path').eq('id', docId).single();
      const { error: downloadErr } = await userB.client.storage.from(II_STORAGE_BUCKET).download(docRowA!.storage_path as string);
      expect(downloadErr, 'User B must be rejected reading User A\'s storage object').not.toBeNull();

      // 4) Forgery: User B cannot INSERT a row claiming to be owned by User A.
      const { error: forgeErr } = await userB.client.from('ii_accounts').insert({
        user_id: userA.userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: 'Forged', folio_number: `${RUN_TAG}-forged`,
      });
      expect(forgeErr, 'authenticated-role insert claiming another user\'s user_id must be REJECTED by RLS').not.toBeNull();
    }, 60_000);

    // ---------------------------------------------------------------------
    // PC2-F1 closed_at provenance idempotency check, applied to Q03's real
    // disposal (Folio B redeems 58.65 of 148.94 units — a PARTIAL redemption,
    // so the resulting tax lot stays OPEN, not closed. This still proves the
    // relevant half of the PC2-F1 fix that applies to this fixture: closed_at
    // stays consistently null and rows never duplicate across repeated
    // idempotent re-reads of the tax pipeline. It does not exercise the
    // closed_at-drift-on-a-CLOSED-lot regression itself, because no fixture
    // in this qualification pack contains a full-close disposal — Q03 was
    // deliberately built as a partial redemption to prove F1 account-scoping,
    // not lot closure. Disclosed honestly rather than fabricating a closure.)
    // ---------------------------------------------------------------------
    it('PC2-F1 closed_at idempotency (Q03 disposal): repeated real-DEV tax-pipeline reads produce stable lot/consumption/gain rows and a stable (null) closed_at', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const user = await makeUser('q03tax');
      const { docId } = await uploadPdfStatement(user.userId, 'pc3-q03-same-instrument-two-folios-fifo-scope', user.memberId);
      const result = await processSourceDocument({ userId: user.userId, sourceDocumentId: docId });
      expect(result.ok, result.error ?? '').toBe(true);

      const { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } = await import('@/lib/services/investment-intelligence/taxRepository');
      const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');

      async function runTaxPipelineOnce() {
        const { dataset } = await loadTaxDataset(user.client, user.userId, {});
        expect(dataset, 'loadTaxDataset must see Q03\'s real persisted transactions via the RLS-respecting client').toBeTruthy();
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
      expect(first.lotsP.error, first.lotsP.error ?? '').toBeNull();
      expect(first.consP.error, first.consP.error ?? '').toBeNull();
      expect(first.cgP.error, first.cgP.error ?? '').toBeNull();
      expect(first.simResult.disposalResults, 'exactly one disposal — the Folio B redemption').toHaveLength(1);
      expect(first.simResult.disposalResults[0].unitsConsumed).toBeCloseTo(58.65, 2);

      const { data: firstLotRows } = await admin.from('ii_tax_lots').select('id, closed_at, units_remaining').eq('user_id', user.userId).order('id');
      expect(firstLotRows?.length).toBeGreaterThan(0);
      const beforeClosedAt = (firstLotRows ?? []).map((r) => r.closed_at);
      // Partial redemption: every lot in this fixture (Folio A untouched;
      // Folio B's post-redemption remainder) still has units_remaining > 0.
      for (const row of firstLotRows ?? []) {
        expect(Number(row.units_remaining)).toBeGreaterThan(0);
        expect(row.closed_at, 'no lot in this fixture is fully closed — closed_at must be null').toBeNull();
      }

      const { count: consCountAfter1 } = await admin.from('ii_tax_lot_consumptions').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);
      const { count: cgCountAfter1 } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);

      await new Promise((r) => setTimeout(r, 1100)); // distinguishable wall-clock tick
      const second = await runTaxPipelineOnce();
      expect(second.lotsP.error, second.lotsP.error ?? '').toBeNull();

      const { data: secondLotRows } = await admin.from('ii_tax_lots').select('id, closed_at, units_remaining').eq('user_id', user.userId).order('id');
      const afterClosedAt = (secondLotRows ?? []).map((r) => r.closed_at);
      expect(afterClosedAt, 'closed_at must remain identical (null) across a repeated idempotent re-read').toEqual(beforeClosedAt);

      const { count: consCountAfter2 } = await admin.from('ii_tax_lot_consumptions').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);
      const { count: cgCountAfter2 } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', user.userId);
      expect(consCountAfter2, 'a repeated read must not duplicate consumption rows').toBe(consCountAfter1);
      expect(cgCountAfter2, 'a repeated read must not duplicate capital-gains rows').toBe(cgCountAfter1);
    }, 60_000);

    it.skip('full UI journey (Overview -> Data/Import -> process -> certify -> publish -> Performance -> SIP -> X-Ray -> Tax -> Review) via Playwright against real DEV — explicitly out of scope for this script-level Gate B campaign, consistent with every other PC-series live-dev suite in this codebase (none drive a browser)', () => {});
  });
}
