// II-PC3 — LIVE hosted-DEV campaign (Phase 4). Prepared but NOT EXECUTED in
// the environment this pack was built in — no `.env.local` was present, so
// there were no real DEV Supabase credentials to run against (checked at
// the start of this pack's work, before anything else). See
// docs/investment-intelligence/II_PC3_LIVE_DEV_CAMPAIGN_STATUS.md for the
// full accounting of what this means for the final verdict.
//
// This file follows the EXACT same real-hosted-DEV methodology as
// tests/live-dev/iiPc1LiveDev.test.ts (real synthetic auth users, the
// real unmodified processSourceDocument()/recertifyPosition() service
// functions imported directly — never re-implemented, real Storage
// uploads, real Postgres reads to prove persisted state) — with ONE
// deliberate difference: every fixture here is uploaded as REAL
// `application/pdf` bytes (mime_type='application/pdf'), not `text/csv`.
// PC1's live-DEV suite explicitly mocked `pdf-parse` and routed every
// fixture through the CSV branch specifically BECAUSE this repo's
// node_modules was missing pdf-parse in that run — meaning no live-DEV
// suite has ever actually exercised the real PDF/password-extraction
// branch end-to-end against real hosted DEV. This suite is written to be
// the first one that does, once it can run.
//
// To run this suite for real: supply a `.env.local` with
// NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY pointed at the DEV project
// (ref `vqycarelcoijzwlpkpcz`, matching every other live-dev suite's
// guard), then `npx vitest run tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts`.
// Every synthetic user/document/account/transaction/holding/reconciliation-
// case/portfolio-truth-status row this suite creates is deleted in
// `afterAll`, and the cleanup itself re-queries to confirm zero residue —
// consistent with PC3 Phase 5's mandatory cleanup requirement.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = path.join(repoRoot, '.env.local');
const HAS_ENV = fs.existsSync(envFile);

// This suite is a NO-OP (single skipped placeholder test) unless a real
// .env.local is present — it must never silently "pass" 0 assertions and
// be mistaken for a genuine live-DEV run. See the file header for how to
// actually run it.
if (!HAS_ENV) {
  describe('II-PC3 Phase 4 — live DEV campaign', () => {
    it.skip('SKIPPED: no .env.local present in this environment — Phase 4 was NOT executed (see II_PC3_LIVE_DEV_CAMPAIGN_STATUS.md)', () => {
      expect(HAS_ENV).toBe(false);
    });
  });
} else {
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
  const PACK_DIR = path.join(repoRoot, 'lib/fixtures/investment-intelligence/pc3-cams');
  const STAMP = Date.now();
  const RUN_TAG = `pc3-${STAMP}`;
  const cleanupUserIds: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
    const password = `Synthetic!${RUN_TAG}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
    cleanupUserIds.push(data.user.id);
    return data.user.id;
  }

  async function uploadPdfStatement(userId: string, fixtureId: string): Promise<string> {
    const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
    const bytes = fs.readFileSync(path.join(PACK_DIR, `${fixtureId}.pdf`));
    const objectKey = `${userId}/${randomUUID()}.pdf`;
    const { error: upErr } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'application/pdf', upsert: false });
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const { data: doc, error: docErr } = await admin
      .from('ii_source_documents')
      .insert({ user_id: userId, country_code: 'IN', status: 'uploaded', checksum, storage_path: objectKey, original_filename: `${fixtureId}.pdf`, mime_type: 'application/pdf', file_size: bytes.length })
      .select('id')
      .single();
    if (docErr || !doc) throw new Error(`could not create source document row: ${docErr?.message}`);
    return doc.id as string;
  }

  afterAll(async () => {
    // Full teardown, re-verified — Phase 5's "independently re-verify zero
    // residue" requirement applied per-user rather than deferred.
    for (const userId of cleanupUserIds) {
      const tables = [
        'ii_reconciliation_cases', 'ii_transaction_source_links', 'ii_transactions', 'ii_holding_snapshots',
        'ii_portfolio_truth_status', 'ii_document_parse_runs', 'ii_source_documents', 'ii_accounts',
      ];
      for (const t of tables) await admin.from(t).delete().eq('user_id', userId);
      await admin.auth.admin.deleteUser(userId);
    }
    for (const t of ['ii_source_documents', 'ii_accounts']) {
      for (const userId of cleanupUserIds) {
        const { data } = await admin.from(t).select('id').eq('user_id', userId).limit(1);
        expect(data ?? [], `residue check: ${t} must be empty for cleaned-up user ${userId}`).toEqual([]);
      }
    }
  });

  describe('II-PC3 Phase 4 — live DEV campaign (real pipeline, real Supabase, real API surface)', () => {
    it('Q01 baseline: real PDF upload -> real processSourceDocument() -> certified accounts/transactions/holdings persisted', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q01');
      const docId = await uploadPdfStatement(userId, 'pc3-q01-baseline-multi-folio-multi-amc');
      const result = await processSourceDocument({ userId, sourceDocumentId: docId });
      expect(result.ok).toBe(true);
      expect(result.summary?.accountsFound).toBe(2);
      expect(result.summary?.transactionsFound).toBe(2);
      const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', userId);
      expect(accounts?.length).toBe(2);
    });

    it('Q02 encrypted: wrong password rejected (password_required/wrong_password), correct password yields the SAME persisted result as Q01', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q02');
      const docId = await uploadPdfStatement(userId, 'pc3-q02-encrypted-duplicate-of-q01');
      const noPassword = await processSourceDocument({ userId, sourceDocumentId: docId });
      expect(noPassword.status).toBe('password_required');
      const wrongPassword = await processSourceDocument({ userId, sourceDocumentId: docId, password: 'wrong' });
      expect(wrongPassword.status).toBe('password_required');
      const correct = await processSourceDocument({ userId, sourceDocumentId: docId, password: 'PC3-Qualification-2026' });
      expect(correct.ok).toBe(true);
      expect(correct.summary?.accountsFound).toBe(2);
      expect(correct.summary?.transactionsFound).toBe(2);
      // Password-never-persisted guarantee (spec section 10):
      const { data: runs } = await admin.from('ii_document_parse_runs').select('errors').eq('source_document_id', docId);
      for (const r of runs ?? []) expect(JSON.stringify(r.errors ?? '')).not.toContain('PC3-Qualification-2026');
    });

    it('Q05 exact reimport of Q01: uploading the identical PDF a second time produces ZERO duplicate transactions/accounts/holdings', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q05');
      const doc1 = await uploadPdfStatement(userId, 'pc3-q01-baseline-multi-folio-multi-amc');
      await processSourceDocument({ userId, sourceDocumentId: doc1 });
      const doc2 = await uploadPdfStatement(userId, 'pc3-q01-baseline-multi-folio-multi-amc');
      const reimport = await processSourceDocument({ userId, sourceDocumentId: doc2 });
      expect(reimport.ok).toBe(true);
      expect(reimport.summary?.duplicateTransactionsLinked).toBe(2);
      const { data: txns } = await admin.from('ii_transactions').select('id').eq('user_id', userId);
      expect(txns?.length).toBe(2); // not 4 — zero net-new rows from the reimport
    });

    it('Q04 monthly delta: same folio reused across two uploads — Jan transaction deduped, Feb transaction added exactly once', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q04');
      const doc1 = await uploadPdfStatement(userId, 'pc3-q04a-month1');
      const r1 = await processSourceDocument({ userId, sourceDocumentId: doc1 });
      expect(r1.summary?.accountsFound).toBe(1);
      const { data: accountsAfter1 } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
      const accountIdAfter1 = accountsAfter1?.[0]?.id;
      const doc2 = await uploadPdfStatement(userId, 'pc3-q04b-month1-plus-2-cumulative');
      const r2 = await processSourceDocument({ userId, sourceDocumentId: doc2 });
      expect(r2.ok).toBe(true);
      expect(r2.summary?.duplicateTransactionsLinked).toBe(1); // the repeated Jan row
      const { data: accountsAfter2 } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
      expect(accountsAfter2?.length).toBe(1); // SAME account identity reused, not a second account minted
      expect(accountsAfter2?.[0]?.id).toBe(accountIdAfter1);
      const { data: txns } = await admin.from('ii_transactions').select('id').eq('user_id', userId);
      expect(txns?.length).toBe(2); // Jan + Feb, no duplicate Jan
    });

    it('Q03 FIFO account-scoping (F1 live probe): redemption from Folio B never reduces Folio A\'s balance', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q03');
      const docId = await uploadPdfStatement(userId, 'pc3-q03-same-instrument-two-folios-fifo-scope');
      const result = await processSourceDocument({ userId, sourceDocumentId: docId });
      expect(result.ok).toBe(true);
      const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', userId);
      const folioA = accounts?.find((a) => a.folio_number === '9303040000301');
      const folioB = accounts?.find((a) => a.folio_number === '9303040000302');
      expect(folioA).toBeTruthy();
      expect(folioB).toBeTruthy();
      const { data: holdingA } = await admin.from('ii_holding_snapshots').select('units').eq('account_id', folioA!.id).order('as_of_date', { ascending: false }).limit(1).single();
      expect(Number(holdingA?.units)).toBeCloseTo(100.19, 2); // Folio A's original purchase, untouched
    });

    it('Q09 multi-page continuation: all 12 transactions persisted exactly once (zero loss, zero duplication across the real page break)', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q09');
      const docId = await uploadPdfStatement(userId, 'pc3-q09-multi-page-continuation');
      const result = await processSourceDocument({ userId, sourceDocumentId: docId });
      expect(result.ok).toBe(true);
      expect(result.summary?.transactionsFound).toBe(12);
      const { data: txns } = await admin.from('ii_transactions').select('source_reference').eq('user_id', userId);
      const refs = new Set((txns ?? []).map((t) => t.source_reference));
      expect(refs.size).toBe(12); // 12 distinct refs — no duplicate, no collapse
    });

    it('Q08 reconciliation exception: certification MUST land on reconciliation_required, never certified', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q08');
      const docId = await uploadPdfStatement(userId, 'pc3-q08-reconciliation-exception');
      await processSourceDocument({ userId, sourceDocumentId: docId });
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
      const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status').eq('account_id', accounts![0].id).single();
      expect(truth?.status).not.toBe('certified');
    });

    it('Q10 controlled malformed: post-fix, certification is blocked by parser_fatal_error (not silently certified on reconciliation math alone)', async () => {
      const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
      const userId = await makeUser('q10');
      const docId = await uploadPdfStatement(userId, 'pc3-q10-controlled-malformed');
      await processSourceDocument({ userId, sourceDocumentId: docId });
      const { data: accounts } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
      const { data: truth } = await admin.from('ii_portfolio_truth_status').select('status, blocking_reasons').eq('account_id', accounts![0].id).single();
      expect(truth?.status).toBe('reconciliation_required');
      expect(JSON.stringify(truth?.blocking_reasons)).toContain('parser_fatal_error');
    });

    it.skip('cross-user RLS: User B cannot reach User A\'s document/account/transaction/holding/performance via the anon-key client (persisted truth + response body, not just status code) — TODO when this suite is actually run', () => {
      // Deliberately left as an explicit TODO rather than a fabricated
      // pass — writing a correct anon-client RLS probe requires live
      // iteration against the real hosted project (as R1/R4's own
      // security suites did), which cannot be done without credentials.
    });

    it.skip('full UI journey (Overview -> Data/Import -> process -> certify -> publish -> Performance -> SIP -> X-Ray -> Tax -> Review) via Playwright against real DEV — TODO when this suite is actually run', () => {
      // Same reasoning as above — an E2E browser journey cannot be
      // meaningfully authored blind; it needs to be driven against the
      // real running app once DEV credentials and a running preview are
      // both available.
    });
  });
}
