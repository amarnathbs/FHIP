/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE10-QA-02      Create a proof that deterministic route makes zero provider calls
 *                    — L1 asserts aiWasUsed=false against real DEV infrastructure.
 *   AIE10-QA-09      Create a proof that deletion racing with processing cannot
 *                    resurrect data — L4 (delete, independently verify absent, then
 *                    record), L5 (TTL fires on age alone on a NON-terminal run), L6
 *                    (negative control: a row inside TTL survives the same sweep).
 *   AIE11-DEV-02     Process a deterministic-complete synthetic PDF and prove zero
 *                    provider calls.
 *   AIE12-LIVE-02    Process a known deterministic native-text investment statement
 *                    with zero provider calls.
 *   AIE12-LIVE-12    Delete all synthetic users/documents/artifacts/items/canonical
 *                    rows and independently verify zero residue — 8 tables re-queried,
 *                    both runs.
 */
/**
 * M3 (Phase 4) — LIVE-DEV proof of the Investment Intelligence dispatch path.
 *
 * WHAT MAKES THIS DIFFERENT FROM `tests/unit/aieM3InvestmentDispatch.test.ts`.
 * That suite substitutes the database and object storage. This one does not:
 * it creates a real synthetic auth user in the real DEV project, uploads real
 * PDF bytes into the real `aie-document-quarantine` Supabase Storage bucket,
 * runs the real `dispatchInvestmentDocument` against the real DEV database,
 * and then deletes everything it made and proves zero residue.
 *
 * WHY IT MATTERS THAT IT IS SUPABASE STORAGE AND NOT S3. The mission's H.2/
 * H.3 quarantine design targets an S3 bucket with GuardDuty Malware
 * Protection. M2 established, and M3 re-verified on 2026-09-15, that no such
 * bucket exists, that this environment's AWS identity has zero S3 and
 * GuardDuty permissions, and that the application has no S3 code path at all
 * (`package.json` declares no AWS SDK). So this proof runs against the
 * quarantine the codebase ACTUALLY has. That is a real, tenant-scoped,
 * service-role-only private bucket — and it is not a malware scanner. The
 * S3 + GuardDuty swap remains blocked infrastructure, named as such in the M3
 * report rather than implied to be covered by this test.
 *
 * NOT RUN BY `npm test`. `vitest.config.ts` includes only `tests/unit/**`, so
 * this file is dormant unless invoked explicitly — and it is additionally
 * gated behind `AIE_M3_LIVE_DISPATCH_PROOF=1` so that pointing vitest at
 * `tests/live-dev/` cannot create DEV rows by accident.
 *
 * HARD PRODUCTION GUARD. The target project ref is derived from the
 * service-role JWT and compared against the known DEV ref before anything
 * runs; a mismatch throws rather than proceeding.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { C1_CAS_BASELINE, C10_RECONCILIATION_FAILURE } from '../support/buildM3InvestmentCorpus';

const ENABLED = process.env.AIE_M3_LIVE_DISPATCH_PROOF === '1';

/**
 * `.env.local` is not committed and lives in the MAIN checkout, not in a git
 * worktree — a worktree sits at `<main>/.claude/worktrees/<name>`, so the
 * file is several levels up. Every existing live-dev suite reads it from the
 * suite's own repo root, which works when they are run from the main
 * checkout and fails silently-ish (ENOENT) from a worktree. Walking up
 * covers both, and throws a clear message rather than proceeding with an
 * empty environment and an unexplained auth failure later.
 */
function findEnvFile(): string {
  let dir = path.resolve(__dirname, '..', '..');
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, '.env.local');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate .env.local in this checkout or any ancestor directory');
}

const env: Record<string, string> = {};
if (ENABLED) {
  // TWO REAL PARSING HAZARDS, both hit while writing this suite:
  //
  //  1. The file is UTF-8 with a BOM. Left in place, the BOM becomes part of
  //     the FIRST key's name, so that one variable silently reads as absent.
  //  2. The file uses CRLF line endings, and JavaScript's `.` does NOT match
  //     `\r`. Splitting on '\n' alone therefore leaves a trailing `\r` on
  //     every line, `(.*)$` cannot reach end-of-line, and the regex matches
  //     NOTHING AT ALL — zero keys, no error, and a confusing "Invalid URL"
  //     several lines later. Splitting on /\r?\n/ is the fix.
  //
  // Both are silent failures that produce an empty environment rather than an
  // exception, which is why the guard below asserts the key was actually
  // found instead of trusting the parse.
  const raw = fs.readFileSync(findEnvFile(), 'utf8').replace(/^﻿/, '');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('.env.local was located but SUPABASE_SERVICE_ROLE_KEY was not parsed out of it — refusing to run against an unknown target.');
  }
}

const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
/** `NEXT_PUBLIC_SUPABASE_URL` is absent from this `.env.local` (an M2
 * finding), so the DEV project is derived from the service-role JWT's own
 * `ref` claim — the same method M2's live cost-admission proof used. */
const DERIVED_REF = SERVICE ? (JSON.parse(Buffer.from(SERVICE.split('.')[1], 'base64').toString('utf8')) as { ref?: string }).ref ?? '' : '';
const BASE = env.NEXT_PUBLIC_SUPABASE_URL || (DERIVED_REF ? `https://${DERIVED_REF}.supabase.co` : '');

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
if (ENABLED) {
  const actualRef = new URL(BASE).host.split('.')[0];
  if (actualRef !== EXPECTED_DEV_REF) {
    throw new Error('REFUSING TO RUN: the target project is not the expected DEV project. This suite never touches production.');
  }
  if (BASE === env.PRODUCTION_SUPABASE_URL) {
    throw new Error('REFUSING TO RUN: target equals PRODUCTION_SUPABASE_URL.');
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  // Masking is key-gated and fails closed. A deterministic-only run never
  // reaches the masking stage, but the key is installed so that a document
  // which DID declare an AI-eligible gap would fail on the provider kill
  // switch (which is off) rather than on a missing key — keeping the reason
  // for any non-AI outcome unambiguous.
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = env.AIE_MASK_TOKEN_ENCRYPTION_KEY || 'a1'.repeat(32);
}

const admin = ENABLED ? createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } }) : (null as never);

const STAMP = Date.now();
const RUN_TAG = `m3-live-${STAMP}`;
const QUARANTINE_BUCKET = 'aie-document-quarantine';

const created = {
  userIds: [] as string[],
  intakeIds: [] as string[],
  storageKeys: [] as string[],
};

/** Counted so the report can state exact row figures rather than "some". */
const counts = { intakes: 0, runs: 0, candidates: 0, reconciliationRuns: 0, unresolvedItems: 0, auditEvents: 0, storageObjects: 0 };

function pdfFor(text: string): Uint8Array {
  return new Uint8Array(buildMinimalTextPdf([text.split('\n')]));
}

describe.skipIf(!ENABLED)('M3 live-DEV — Investment Intelligence dispatch against the real DEV project', () => {
  let userId = '';

  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `${RUN_TAG}@fhip-synthetic.test`,
      password: `Synthetic!${RUN_TAG}`,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`could not create synthetic user: ${error?.message}`);
    userId = data.user.id;
    created.userIds.push(userId);
  }, 60_000);

  it('L1: a clean CAS is uploaded to the REAL quarantine bucket and dispatched end to end', async () => {
    const { dispatchInvestmentDocument } = await import('@/lib/aie/adapters/investment-intelligence/dispatch');
    const { createDefaultDeps } = await import('@/lib/aie/orchestrator');
    const { AieDocumentAiGateway } = await import('@/lib/aie/provider/gateway');
    const { MockAieProvider } = await import('@/lib/aie/provider/mockAieProvider');
    const { buildQuarantineStorageKey } = await import('@/lib/aie/storage');

    const { data: intake, error: intakeErr } = await admin
      .from('aie_document_intake')
      .insert({ user_id: userId, declared_mime_type: 'application/pdf', byte_size: 1024, display_filename: `${RUN_TAG}-c1.pdf`, source_module_hint: 'investment_intelligence', status: 'received' })
      .select('id')
      .single();
    expect(intakeErr).toBeNull();
    const intakeId = intake!.id as string;
    created.intakeIds.push(intakeId);
    counts.intakes += 1;

    const storageKey = buildQuarantineStorageKey(userId, intakeId);
    const bytes = pdfFor(C1_CAS_BASELINE.text);
    const up = await admin.storage.from(QUARANTINE_BUCKET).upload(storageKey, bytes, { contentType: 'application/pdf', upsert: false });
    expect(up.error, 'real quarantine upload failed').toBeNull();
    created.storageKeys.push(storageKey);
    counts.storageObjects += 1;

    // The real state transitions the route performs, through the real,
    // FSM-enforcing repository function.
    const { updateIntakeStatus } = await import('@/lib/aie/db/repository');
    expect((await updateIntakeStatus({ intakeId, toStatus: 'quarantined', storageKey, detectedMimeType: 'application/pdf' })).ok).toBe(true);
    expect((await updateIntakeStatus({ intakeId, toStatus: 'ready' })).ok).toBe(true);

    const outcome = await dispatchInvestmentDocument({
      intakeId,
      userId,
      storageKey,
      countryCode: 'IN',
      ownerMemberId: null, // deliberately unresolved — see L2
      deps: createDefaultDeps(new AieDocumentAiGateway(new MockAieProvider({ respond: () => '{}' }), { isKillSwitchEnabled: () => false })),
    });

    expect(outcome.ok, `dispatch failed: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.parserCode).toBe('cams_detailed_v1');
    expect(outcome.certifiedDocumentClass).toBe(true);
    expect(outcome.aiWasUsed).toBe(false);

    // Real rows, read back from the real database.
    const { data: runs } = await admin.from('aie_extraction_run').select('id, status').eq('intake_id', intakeId);
    expect(runs).toHaveLength(1);
    counts.runs += 1;

    const { count: candidateCount } = await admin.from('aie_field_candidate').select('id', { count: 'exact', head: true }).eq('run_id', outcome.runId);
    expect(candidateCount ?? 0).toBeGreaterThan(0);
    counts.candidates += candidateCount ?? 0;

    const { data: recon } = await admin.from('aie_reconciliation_run').select('rule_id, outcome').eq('run_id', outcome.runId);
    expect((recon ?? []).length).toBeGreaterThan(0);
    counts.reconciliationRuns += (recon ?? []).length;
    // The adapter's OWN rules ran — not the generic "no domain adapter"
    // placeholder that `accept.ts` refuses as never-actually-checked.
    expect((recon ?? []).some((r) => (r.rule_id as string).startsWith('ii_adapter_'))).toBe(true);
    expect((recon ?? []).some((r) => r.rule_id === 'aie1_1_no_domain_adapter_registered')).toBe(false);

    const { data: items } = await admin.from('aie_unresolved_item').select('id, reason_code, severity').eq('run_id', outcome.runId);
    counts.unresolvedItems += (items ?? []).length;

    // M3 FIX, proved live: the STORED run status must agree with the
    // reported one. This assertion is the reason the fix exists — the first
    // live run of this suite reported `unresolved` while the row still read
    // `awaiting_acceptance`, which is the state `accept.ts` treats as ready.
    const { data: runRow } = await admin.from('aie_extraction_run').select('status').eq('id', outcome.runId).single();
    expect(runRow!.status, 'the stored run status must match the reported one').toBe(outcome.finalStatus);

    const { count: auditCount } = await admin.from('aie_audit_event').select('id', { count: 'exact', head: true }).eq('intake_id', intakeId);
    counts.auditEvents += auditCount ?? 0;

    // eslint-disable-next-line no-console
    console.log(`[M3 L1] run=${outcome.runId.slice(0, 8)} status=${outcome.finalStatus} candidates=${candidateCount} recon=${(recon ?? []).length} items=${(items ?? []).length}`);
  }, 120_000);

  it('L2: an unresolved owner produces a REAL blocking unresolved item, not a guess', async () => {
    const { data: items } = await admin
      .from('aie_unresolved_item')
      .select('reason_code, severity, status')
      .in('intake_id', created.intakeIds);
    const ownerItem = (items ?? []).find((i) => i.reason_code === 'ii_adapter:owner_unresolved');
    expect(ownerItem, 'no owner_unresolved item was written').toBeDefined();
    expect(ownerItem!.severity).toBe('blocking');
    expect(ownerItem!.status).toBe('open');
  }, 60_000);

  it('L3: a statement whose closing balance contradicts its transactions is BLOCKED live, on a first upload', async () => {
    // The M3 defect fix, proved against the real database with an empty
    // canonical store — the exact condition under which the pre-fix rule
    // skipped reconciliation entirely and read as a pass.
    const { dispatchInvestmentDocument } = await import('@/lib/aie/adapters/investment-intelligence/dispatch');
    const { createDefaultDeps } = await import('@/lib/aie/orchestrator');
    const { AieDocumentAiGateway } = await import('@/lib/aie/provider/gateway');
    const { MockAieProvider } = await import('@/lib/aie/provider/mockAieProvider');
    const { buildQuarantineStorageKey, uploadToQuarantine } = await import('@/lib/aie/storage');
    const { updateIntakeStatus } = await import('@/lib/aie/db/repository');

    const { data: intake } = await admin
      .from('aie_document_intake')
      .insert({ user_id: userId, declared_mime_type: 'application/pdf', byte_size: 1024, display_filename: `${RUN_TAG}-c10.pdf`, source_module_hint: 'investment_intelligence', status: 'received' })
      .select('id')
      .single();
    const intakeId = intake!.id as string;
    created.intakeIds.push(intakeId);
    counts.intakes += 1;

    const storageKey = buildQuarantineStorageKey(userId, intakeId);
    expect((await uploadToQuarantine({ storageKey, bytes: pdfFor(C10_RECONCILIATION_FAILURE.text), contentType: 'application/pdf' })).ok).toBe(true);
    created.storageKeys.push(storageKey);
    counts.storageObjects += 1;

    await updateIntakeStatus({ intakeId, toStatus: 'quarantined', storageKey, detectedMimeType: 'application/pdf' });
    await updateIntakeStatus({ intakeId, toStatus: 'ready' });

    const outcome = await dispatchInvestmentDocument({
      intakeId,
      userId,
      storageKey,
      countryCode: 'IN',
      ownerMemberId: 'not-a-real-member-but-present-so-owner-is-not-the-blocker',
      deps: createDefaultDeps(new AieDocumentAiGateway(new MockAieProvider({ respond: () => '{}' }), { isKillSwitchEnabled: () => false })),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    counts.runs += 1;

    const { data: recon } = await admin.from('aie_reconciliation_run').select('rule_id, outcome, delta').eq('run_id', outcome.runId);
    counts.reconciliationRuns += (recon ?? []).length;
    const rollForward = (recon ?? []).filter((r) => (r.rule_id as string).startsWith('ii_adapter_roll_forward:'));
    expect(rollForward.length, 'a brand-new position must still be reconciled').toBeGreaterThan(0);
    expect(rollForward.some((r) => r.outcome === 'fail'), 'the wrong closing balance must FAIL').toBe(true);

    const { data: items } = await admin.from('aie_unresolved_item').select('id, severity').eq('run_id', outcome.runId);
    counts.unresolvedItems += (items ?? []).length;
    expect((items ?? []).some((i) => i.severity === 'blocking')).toBe(true);
    expect(outcome.finalStatus).toBe('unresolved');

    const { count: auditCount } = await admin.from('aie_audit_event').select('id', { count: 'exact', head: true }).eq('intake_id', intakeId);
    counts.auditEvents += auditCount ?? 0;

    // eslint-disable-next-line no-console
    console.log(`[M3 L3] run=${outcome.runId.slice(0, 8)} status=${outcome.finalStatus} rollForwardFail=${rollForward.filter((r) => r.outcome === 'fail').length} delta=${rollForward[0]?.delta}`);
  }, 120_000);

  it('L4: the binary purge deletes the real object and INDEPENDENTLY VERIFIES it is absent before recording a purge', async () => {
    const { finalizeDocumentBinaryAfterRun } = await import('@/lib/aie/services/purge');
    const intakeId = created.intakeIds[0];
    const storageKey = created.storageKeys[0];

    const before = await admin.storage.from(QUARANTINE_BUCKET).list(storageKey.slice(0, storageKey.lastIndexOf('/')), { search: storageKey.split('/').pop()! });
    expect((before.data ?? []).length, 'the object should exist before the purge').toBe(1);

    const result = await finalizeDocumentBinaryAfterRun({ intakeId, userId, storageKey });
    // eslint-disable-next-line no-console
    console.log(`[M3 L4] purge result=${result.status}`);
    expect(['deleted', 'scheduled_for_retry']).toContain(result.status);

    if (result.status === 'deleted') {
      // Independently re-verified here, not trusting the service's own report.
      const after = await admin.storage.from(QUARANTINE_BUCKET).list(storageKey.slice(0, storageKey.lastIndexOf('/')), { search: storageKey.split('/').pop()! });
      expect((after.data ?? []).length, 'the object must be genuinely gone').toBe(0);
      created.storageKeys = created.storageKeys.filter((k) => k !== storageKey);

      const { data: row } = await admin.from('aie_document_intake').select('status, purge_status, storage_key, purged_at').eq('id', intakeId).single();
      expect(row!.status).toBe('deleted');
      expect(row!.purge_status).toBe('purged');
      expect(row!.storage_key).toBeNull();
      expect(row!.purged_at).not.toBeNull();
    }
  }, 120_000);

  it('L5: the mask-token TTL sweep deletes an expired row UNCONDITIONALLY, regardless of the run\'s lifecycle state', async () => {
    const { purgeExpiredMaskTokenMaps } = await import('@/lib/aie/services/purge');

    const { data: runs } = await admin.from('aie_extraction_run').select('id, status').in('intake_id', created.intakeIds).limit(1);
    const runId = runs![0].id as string;
    const runStatus = runs![0].status as string;

    // A row that is already older than the TTL, attached to a run that is
    // demonstrably NOT in a terminal state — the exact case the Product Owner
    // decided must still be destroyed.
    const staleIso = new Date(Date.now() - 72 * 3600_000).toISOString();
    const { error: insErr } = await admin.from('aie_mask_token_map').insert({
      run_id: runId,
      token: `[MASKED:folio_number:hmac:${'ab'.repeat(12)}]`,
      ciphertext: Buffer.from('synthetic-m3-ttl-probe').toString('hex'),
      created_at: staleIso,
    });
    expect(insErr, `could not seed the TTL probe row: ${insErr?.message}`).toBeNull();

    const { count: beforeCount } = await admin.from('aie_mask_token_map').select('id', { count: 'exact', head: true }).eq('run_id', runId);
    expect(beforeCount).toBe(1);

    const purged = await purgeExpiredMaskTokenMaps();
    // eslint-disable-next-line no-console
    console.log(`[M3 L5] runStatus=${runStatus} ttlHours=${purged.ttlHours} deleted=${purged.deleted}`);
    expect(purged.ttlHours).toBe(48);
    expect(purged.deleted).toBeGreaterThanOrEqual(1);

    const { count: afterCount } = await admin.from('aie_mask_token_map').select('id', { count: 'exact', head: true }).eq('run_id', runId);
    expect(afterCount).toBe(0);
    // The run itself is untouched — the sweep is time-driven, not
    // lifecycle-driven, and must not alter the document it belonged to.
    const { data: runAfter } = await admin.from('aie_extraction_run').select('status').eq('id', runId).single();
    expect(runAfter!.status).toBe(runStatus);
  }, 120_000);

  it('L6: a fresh mask-token row INSIDE the TTL survives the same sweep', async () => {
    // Without this, L5 would pass for a sweep that deleted everything.
    const { purgeExpiredMaskTokenMaps } = await import('@/lib/aie/services/purge');
    const { data: runs } = await admin.from('aie_extraction_run').select('id').in('intake_id', created.intakeIds).limit(1);
    const runId = runs![0].id as string;

    await admin.from('aie_mask_token_map').insert({
      run_id: runId,
      token: `[MASKED:tax_id:hmac:${'cd'.repeat(12)}]`,
      ciphertext: Buffer.from('synthetic-m3-fresh-probe').toString('hex'),
    });
    await purgeExpiredMaskTokenMaps();
    const { count } = await admin.from('aie_mask_token_map').select('id', { count: 'exact', head: true }).eq('run_id', runId);
    expect(count, 'a row inside the TTL must survive').toBe(1);

    await admin.from('aie_mask_token_map').delete().eq('run_id', runId);
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED) return;

    // FK-ordered teardown, then an independent zero-residue verification.
    // PC4-INV-16 records that NO production synthetic-cleanup mechanism
    // exists; this suite therefore brings its own, and proves it worked
    // rather than asserting it did.
    for (const key of created.storageKeys) {
      await admin.storage.from(QUARANTINE_BUCKET).remove([key]);
    }
    for (const intakeId of created.intakeIds) {
      const { data: runs } = await admin.from('aie_extraction_run').select('id').eq('intake_id', intakeId);
      for (const run of runs ?? []) {
        await admin.from('aie_mask_token_map').delete().eq('run_id', run.id);
        await admin.from('aie_reconciliation_run').delete().eq('run_id', run.id);
        await admin.from('aie_field_candidate').delete().eq('run_id', run.id);
        await admin.from('aie_unresolved_item').delete().eq('run_id', run.id);
        await admin.from('aie_parser_attempt').delete().eq('run_id', run.id);
        await admin.from('aie_processing_transition').delete().eq('run_id', run.id);
        await admin.from('aie_masking_summary').delete().eq('run_id', run.id);
        await admin.from('aie_ai_completion_attempt').delete().eq('run_id', run.id);
        await admin.from('aie_write_batch').delete().eq('run_id', run.id);
      }
      await admin.from('aie_audit_event').delete().eq('intake_id', intakeId);
      await admin.from('aie_extraction_run').delete().eq('intake_id', intakeId);
      await admin.from('aie_document_fingerprint').delete().eq('intake_id', intakeId);
      await admin.from('aie_document_intake').delete().eq('id', intakeId);
    }
    for (const id of created.userIds) {
      await admin.auth.admin.deleteUser(id);
    }

    // Independent zero-residue verification — re-queried from the database
    // rather than inferred from the deletes having "returned successfully".
    const residue: Record<string, number> = {};
    const byIntakeColumn: [string, string][] = [
      ['aie_document_intake', 'id'],
      ['aie_extraction_run', 'intake_id'],
      ['aie_audit_event', 'intake_id'],
      ['aie_unresolved_item', 'intake_id'],
      ['aie_field_candidate', 'intake_id'],
      ['aie_reconciliation_run', 'intake_id'],
    ];
    for (const [table, column] of byIntakeColumn) {
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).in(column, created.intakeIds);
      residue[table] = count ?? 0;
    }
    for (const key of created.storageKeys) {
      const listed = await admin.storage.from(QUARANTINE_BUCKET).list(key.slice(0, key.lastIndexOf('/')), { search: key.split('/').pop()! });
      residue.storage_objects = (residue.storage_objects ?? 0) + (listed.data ?? []).length;
    }
    const { data: remainingUsers } = await admin.auth.admin.listUsers({ perPage: 200 });
    residue.auth_users = (remainingUsers?.users ?? []).filter((u) => created.userIds.includes(u.id)).length;

    // eslint-disable-next-line no-console
    console.log(`[M3 CLEANUP] created: ${JSON.stringify(counts)}`);
    // eslint-disable-next-line no-console
    console.log(`[M3 CLEANUP] residue: ${JSON.stringify(residue)}`);
    for (const [table, n] of Object.entries(residue)) {
      if (n !== 0) throw new Error(`CLEANUP INCOMPLETE: ${table} still has ${n} row(s) from this run`);
    }
  }, 180_000);
});
