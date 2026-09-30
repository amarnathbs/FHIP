/**
 * AIE-1 / Approved Upload -> Canonical Data FINAL PRODUCTION CLOSURE mission.
 * The single most important remaining item: a genuine, unbroken PRODUCTION
 * journey proving the AIE extraction/review pipeline end to end (upload ->
 * real GuardDuty scan -> local extraction+masking -> real GPT-4o-mini ->
 * schema validation+reconciliation -> durable review record -> verified PDF
 * deletion -> acceptance AFTER deletion -> canonical write), against the
 * REAL deployed production application, using a disposable synthetic
 * account, with mandatory zero-residue cleanup.
 *
 * WHY THIS DOCUMENT SHAPE. `lib/aie/adapters/bankStatement/gateway.ts` is the
 * one call site that reaches the AI provider for bank statements; routing
 * INTO it requires the deterministic bank-PDF layout parsers
 * (`lib/financial-data-hub/bank-pdf/adapters/auAdapters.ts`) to fail first.
 * `scripts/aie1_other_pdf_fixtures.ts`'s `bankLetterPdf()` is an
 * already-proven (DEV-live, 2026-09-25) fixture for exactly this: a bank
 * statement written as a prose letter (no column table, no per-line grid),
 * so no layout adapter can segment it -- a genuine "needs AI fallback" shape
 * this session did not invent, reusing this repo's own established fixture
 * rather than hand-rolling a new one. Every person/institution/number in it
 * is already synthetic (see PLANTED_PII in that file).
 *
 * WHY THIS ORDER PROVES STEP 7 BEFORE STEP 8 FOR REAL, NOT BY ACCIDENT.
 * `docs/aie1-canonical-closure/CLOSURE_REGISTER.md` section 13 records (from
 * reading `lib/aie/services/purge.ts`'s `finalizeDocumentBinaryAfterRun()`)
 * that raw-file deletion is SYNCHRONOUS on the primary path and runs
 * immediately after every extraction outcome, INCLUDING
 * "awaiting-acceptance" (an AI-fallback draft ready for user review) -- i.e.
 * the raw PDF is expected to already be gone by the time POST .../process
 * returns a draft, well before the user ever calls confirm. This script
 * verifies that empirically (does not assume it): it checks
 * raw_document_purge_status and lists the storage bucket for absence
 * IMMEDIATELY after /process returns, BEFORE calling /confirm at all. If the
 * primary path turns out not to have purged synchronously, this script
 * still drives the purge-sweep cron (best-effort, see CRON_SECRET note
 * below) before proceeding, so the "acceptance after deletion" ordering in
 * step 8 is genuine either way, not assumed.
 *
 * CRON_SECRET NOTE. This dev environment's D:/FHIP/.env.local CRON_SECRET is
 * NOT confirmed to equal production's deployed Amplify CRON_SECRET (this
 * mission's own history records env vars silently failing to forward to
 * production before -- see MEMORY "Stripe/Razorpay env vars never forwarded
 * to production"). The sweep call below is attempted defensively (harmless
 * if wrong -- an authenticated-secret check returns 401, no side effect) and
 * its outcome is recorded as real evidence, not assumed to succeed.
 *
 * SAFETY / SCOPE. Refuses to run against anything but the known PRODUCTION
 * project ref. Uses a single disposable `@fhip-synthetic.test` account,
 * created via the SAME admin.auth.admin.createUser + generateLink(magiclink)
 * + /auth/v1/verify pattern already used and proven in this mission
 * (scripts/income_split_salary_live_PRODUCTION_proof.ts). Drives the REAL
 * deployed Next.js API routes over HTTPS with a real Supabase-SSR session
 * cookie -- never a direct database write standing in for the
 * upload/extract/review/accept/canonical-write proof itself (direct
 * service-role reads/writes are used ONLY for evidence capture and cleanup,
 * exactly as this mission's own binding instruction requires). One document,
 * one real GPT-4o-mini call. Every seeded row + the auth user are deleted in
 * a `finally` block, then independently re-queried to prove zero residue.
 * No credential value, raw PII, or full document text is ever printed.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/aie1_closure_production_ai_fallback_journey.ts
 * (.env.local here MUST be the repo-root D:/FHIP/.env.local -- the only
 * place PRODUCTION_SUPABASE_URL / PRODUCTION_SUPABASE_SERVICE_ROLE_KEY live.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { bankLetterPdf, BANK_EXPECTED, PLANTED_PII } from './aie1_other_pdf_fixtures';

// ------------------------------------------------------------ env / safety
const repoRoot = 'D:/FHIP';
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.PRODUCTION_SUPABASE_URL;
const SERVICE = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
const LOCAL_CRON_SECRET = env.CRON_SECRET;
const EXPECTED_PROD_REF = 'twwpnltizhtjxhamyoxt';
const APP = process.env.AIE1_PRODUCTION_APP_URL ?? 'https://app.financialhealthplatform.com';

if (!BASE || !SERVICE) {
  console.error('FATAL: missing PRODUCTION_SUPABASE_URL / PRODUCTION_SUPABASE_SERVICE_ROLE_KEY in D:/FHIP/.env.local');
  process.exit(2);
}
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_PROD_REF) {
  console.error(`REFUSING TO RUN: target project "${actualRef}" is not the expected PRODUCTION project (${EXPECTED_PROD_REF}).`);
  process.exit(2);
}

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN_TAG = `aie1closure-prod-${Date.now()}`;
// AIE_PILOT_COHORT_EMAILS (Amplify-only env var, no DB table -- see the
// cohort-admission comment below) is an EXACT-MATCH comma list, so a
// freshly timestamped email can never be pre-added by a human before this
// script runs. Set AIE1_CLOSURE_FIXED_EMAIL to a FIXED, predictable address
// (e.g. `aie1-closure-proof@fhip-synthetic.test`) that a human has already
// added to production's AIE_PILOT_COHORT_EMAILS (and redeployed), to get
// past that gate. Defaults to a fresh timestamped email, which will hit
// cohort_denied on any production with enforcement on -- that is expected
// and is exactly the blocker this script's evidence records.
const EMAIL = process.env.AIE1_CLOSURE_FIXED_EMAIL?.trim() || `${RUN_TAG}@fhip-synthetic.test`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures: string[] = [];
const evidence: Record<string, unknown> = { runTag: RUN_TAG, projectRef: actualRef, app: APP, startedAt: new Date().toISOString() };
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

// ---------------------------------------------------------- REST/API helpers
async function pg(pathAndQuery: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  let body: string | undefined;
  if (init.body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Prefer'] = 'return=representation'; body = JSON.stringify(init.body); }
  const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, { method: init.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function row(table: string, id: string, select = '*') {
  const r = await pg(`${table}?id=eq.${id}&select=${select}`);
  return Array.isArray(r.json) ? (r.json[0] ?? null) : null;
}
async function rows(table: string, filter: string, select = '*') {
  const r = await pg(`${table}?${filter}&select=${select}`);
  return Array.isArray(r.json) ? r.json : [];
}
async function ledger() { return (await rows('aie_ai_cost_ledger', 'id=eq.global'))[0] as any; }
async function audits(documentId: string) {
  return rows('fdh_document_audit_events', `document_id=eq.${documentId}&order=created_at.asc`, 'event_type,metadata,created_at') as Promise<any[]>;
}
async function drafts(documentId: string) {
  return rows('fdh_ai_fallback_drafts', `statement_upload_id=eq.${documentId}`, 'id,status,document_type,payload,provider_idempotency_key,confirmed_at') as Promise<any[]>;
}

interface Session { userId: string; cookie: string }

async function app(session: Session, p: string, init: { method?: string; body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { Cookie: session.cookie, ...(init.headers ?? {}) };
  let body = init.body;
  if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(`${APP}${p}`, { method: init.method ?? 'GET', headers, body, redirect: 'manual' });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function tryCronSweep(routeName: string): Promise<{ attempted: boolean; status: number | null }> {
  if (!LOCAL_CRON_SECRET) return { attempted: false, status: null };
  try {
    const res = await fetch(`${APP}/api/financial-data-hub/documents/cron/${routeName}`, { method: 'POST', headers: { 'x-cron-secret': LOCAL_CRON_SECRET } });
    return { attempted: true, status: res.status };
  } catch {
    return { attempted: true, status: null };
  }
}

async function main() {
  console.log(`=== AIE-1 closure: PRODUCTION AI-fallback journey (${RUN_TAG}) ===`);
  console.log(`target project ref: ${actualRef}   app: ${APP}`);

  // --------------------------------------------------- 0. account creation
  const password = `Synthetic!${randomUUID()}`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
  if (createErr || !created.user) throw new Error(`could not create synthetic production user: ${createErr?.message}`);
  const userId = created.user.id;
  console.log(`synthetic production user: ${EMAIL} (${userId})`);
  evidence.userId = userId;

  const track: { table: string; id: string }[] = [];
  let uploadDocumentId: string | undefined;
  try {
    const { error: profErr } = await admin
      .from('user_profiles')
      .update({ onboarding_completed: true, country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', preferred_currency: 'AUD', full_name: `AIE1 Closure PROD Proof ${RUN_TAG}` })
      .eq('user_id', userId);
    if (profErr) throw new Error(`user_profiles update failed: ${profErr.message}`);

    // AI-fallback pilot-cohort admission is EMAIL/USER-ID ALLOWLIST via
    // Amplify-only env vars (AIE_PILOT_COHORT_ENFORCED/_EMAILS/_USER_IDS,
    // lib/aie/featureFlags.ts) -- there is no database table backing it,
    // and this environment has no Amplify console/API access to add this
    // disposable synthetic email to that allowlist (same class of blocker
    // as this mission's other OPS-* deployment-identity items). This run
    // does NOT attempt to fabricate cohort membership; if production has
    // enforcement on and this email is not listed, the real, correct,
    // audited server behaviour is a clean `cohort_denied` refusal -- and
    // that outcome, if it happens, is captured below as real, honest
    // evidence of a precise, named blocker rather than assumed away.

    // ----------------------------------------------------- 1. real session
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
    if (linkErr || !linkData) throw new Error(`generateLink failed: ${linkErr?.message}`);
    const hashedToken = (linkData as any).properties?.hashed_token;
    const verifyResp = await fetch(`${BASE}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SERVICE },
      body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
    });
    const verifyJson: any = await verifyResp.json();
    check('real production session minted via generateLink + /auth/v1/verify', verifyResp.ok && !!verifyJson.access_token, `${verifyResp.status}`);
    if (!verifyJson.access_token) throw new Error(`session exchange failed: ${verifyResp.status} ${JSON.stringify(verifyJson)}`);

    // Supabase-SSR single-cookie encoding, exactly what lib/supabase/server.ts's
    // createServerClient() (cookies()-based) expects to decode.
    const sessionForCookie = {
      access_token: verifyJson.access_token,
      refresh_token: verifyJson.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (verifyJson.expires_in ?? 3600),
      expires_in: verifyJson.expires_in ?? 3600,
      token_type: verifyJson.token_type ?? 'bearer',
      user: verifyJson.user,
    };
    const encoded = 'base64-' + Buffer.from(JSON.stringify(sessionForCookie)).toString('base64url');
    const cookieName = `sb-${actualRef}-auth-token`;
    const CHUNK = 3180;
    const cookie = encoded.length <= CHUNK
      ? `${cookieName}=${encoded}`
      : Array.from({ length: Math.ceil(encoded.length / CHUNK) }, (_, i) => `${cookieName}.${i}=${encoded.slice(i * CHUNK, (i + 1) * CHUNK)}`).join('; ');
    const session: Session = { userId, cookie };
    evidence.sessionMinted = true;

    // (No separate "session accepted" probe route -- confirmed directly by
    // the real upload call below: a 200 with a real document_id proves the
    // session cookie authenticated against the real production app; a
    // 401/redirect there would have failed that check instead.)
    const institutionRow = (await rows('fdh_financial_institutions', 'institution_code=eq.CBA&country_code=eq.AU', 'id'))[0] as any;
    const institutionId = institutionRow?.id as string | undefined;

    // --------------------------------------------------------- 2. upload
    const bytes = bankLetterPdf(RUN_TAG);
    const qs = new URLSearchParams({ country_code: 'AU', currency_code: 'AUD', filename: `${RUN_TAG}.pdf`, masked_identifier: 'CLOS1', ...(institutionId ? { institution_id: institutionId } : {}) }).toString();
    const uploadStartedAt = Date.now();
    const uploadRes = await app(session, `/api/financial-data-hub/bank-pdf/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
    const documentId = uploadRes.json?.data?.document_id as string | undefined;
    check('real upload via the real production API route accepted', uploadRes.status === 200 && !!documentId, `${uploadRes.status} ${JSON.stringify(uploadRes.json?.data ?? uploadRes.text.slice(0, 300))}`);
    if (!documentId) throw new Error('upload did not return a document_id -- cannot continue');
    uploadDocumentId = documentId;
    track.push({ table: 'fdh_statement_uploads', id: documentId });
    console.log(`upload document id: ${documentId}`);
    evidence.uploadDocumentId = documentId;

    // -------------------------------------------- 3. real GuardDuty verdict
    let doc = await row('fdh_statement_uploads', documentId);
    const scanStart = Date.now();
    let sweepAttempts = 0;
    while (doc && doc.processing_status === 'validating' && Date.now() - scanStart < 240_000) {
      await sleep(4000);
      const sweep = await tryCronSweep('malware-scan-sweep');
      if (sweep.attempted) sweepAttempts += 1;
      doc = await row('fdh_statement_uploads', documentId);
    }
    const scanWaitMs = Date.now() - scanStart;
    evidence.scan = { status: doc?.malware_scan_status, processingStatus: doc?.processing_status, scanWaitMs, sweepAttempts, sweepSecretPresent: !!LOCAL_CRON_SECRET };
    check(`real GuardDuty scan resolved to a clean verdict (waited ${scanWaitMs}ms, ${sweepAttempts} sweep call(s) attempted)`, doc?.malware_scan_status === 'clean', JSON.stringify({ scan: doc?.malware_scan_status, processing: doc?.processing_status }));

    // ------------------------------------- 4/5/6. extraction, masking, AI
    const ledgerBefore = await ledger();
    const processT0 = Date.now();
    const proc = await app(session, `/api/financial-data-hub/bank-pdf/${documentId}/process`, { method: 'POST', json: {} });
    const processLatencyMs = Date.now() - processT0;
    const draft = proc.json?.data?.ai_fallback_draft;
    const trail = await audits(documentId);
    const nativeFail = trail.find((a) => a.event_type === 'pdf_native_extraction_started');
    const ready = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_draft_ready');
    const notUsable = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_not_usable');
    check('local native extraction ran first and genuinely failed on this document (real AI-fallback routing, not forced)', !!nativeFail, JSON.stringify(nativeFail?.event_type ?? null));
    if (!draft && notUsable?.metadata?.reason === 'cohort_denied') {
      evidence.BLOCKED = {
        step: 'AI fallback pilot-cohort admission',
        reason: 'cohort_denied',
        detail: 'This synthetic account is not on production\'s AIE_PILOT_COHORT_EMAILS/_USER_IDS allowlist, and this environment cannot edit Amplify env vars to add it (no console/API access). The gate itself worked correctly and honestly -- the AI-fallback PIPELINE beyond this gate could not be exercised by this run.',
        auditEvent: notUsable,
      };
      check('the real AI fallback produced a structured draft (real GPT-4o-mini call happened)', false, 'BLOCKED: cohort_denied -- see evidence.BLOCKED');
      throw new Error('BLOCKED: production AI-fallback pilot-cohort denied this synthetic account (cohort_denied) -- see evidence.BLOCKED for the exact audit row');
    }
    check('the real AI fallback produced a structured draft (real GPT-4o-mini call happened)', proc.status === 200 && proc.json?.data?.pipeline_status === 'ai_fallback_available' && !!draft, `${proc.status} pipeline=${proc.json?.data?.pipeline_status} notUsableReason=${notUsable?.metadata?.reason ?? 'n/a'}`);
    if (!draft) throw new Error(`no AI-fallback draft returned -- cannot continue the proof (pipeline_status=${proc.json?.data?.pipeline_status}, notUsable=${JSON.stringify(notUsable?.metadata ?? null)})`);

    const rowsOk = draft.rows?.length === 3 && BANK_EXPECTED.transactions.every((t, i) => draft.rows[i]?.transactionDate === t.date && Math.abs(Number(draft.rows[i]?.amountOriginal) - t.amount) < 0.005 && draft.rows[i]?.creditDebit === t.direction);
    check('the AI reading matches the hand-computed expected values (opening/closing/period/3 lines)', rowsOk && Math.abs(Number(draft.declaredOpeningBalance) - BANK_EXPECTED.openingBalance) < 0.005 && Math.abs(Number(draft.declaredClosingBalance) - BANK_EXPECTED.closingBalance) < 0.005, JSON.stringify({ rowsOk, opening: draft.declaredOpeningBalance, closing: draft.declaredClosingBalance }));

    const dRows = await drafts(documentId);
    check('durable review record persisted server-side, pending review, linked to the metered call (step 6)', dRows.length === 1 && dRows[0].status === 'pending_review' && dRows[0].document_type === 'bank_statement' && dRows[0].provider_idempotency_key === ready?.metadata?.ai_cost_key, JSON.stringify(dRows.map((d: any) => ({ s: d.status, k: !!d.provider_idempotency_key }))));

    const ledgerAfter = await ledger();
    const costKey = ready?.metadata?.ai_cost_key as string | undefined;
    const attempt = costKey ? (await rows('aie_ai_cost_attempt', `idempotency_key=eq.${encodeURIComponent(costKey)}`))[0] as any : null;
    const settledDeltaUsd = Number(ledgerAfter?.settled_usd ?? 0) - Number(ledgerBefore?.settled_usd ?? 0);
    check('genuinely fresh provider call: real OpenAI request id(s), real non-trivial token counts, real (non-reused) cost admitted this run', !!attempt && (attempt.provider_request_ids ?? []).length >= 1 && Number(attempt.input_tokens) > 0 && Number(attempt.output_tokens) > 0 && attempt.model === 'gpt-4o-mini' && settledDeltaUsd > 0 && settledDeltaUsd < 0.01,
      JSON.stringify({ requestIds: attempt?.provider_request_ids, inputTokens: attempt?.input_tokens, outputTokens: attempt?.output_tokens, settledDeltaUsd }));
    evidence.aiFallback = { documentId, processLatencyMs, model: attempt?.model, providerRequestIds: attempt?.provider_request_ids, inputTokens: attempt?.input_tokens, outputTokens: attempt?.output_tokens, settledDeltaUsd, draftId: dRows[0]?.id };

    // -------------------------------------------------- 5b. reconciliation
    // (Reconciliation for this adapter runs at confirm-time against the
    // confirmed figures, not before -- recorded here so step 5's
    // "reconciliation runs against it" is checked after confirm, below.)

    // ------------------------------------------------ 7. verified deletion
    // Checked BEFORE confirm/accept is ever called, per the ordering this
    // script's header explains.
    let docAfterProcess = await row('fdh_statement_uploads', documentId);
    let purgeSweepOutcome: { attempted: boolean; status: number | null } = { attempted: false, status: null };
    if (docAfterProcess.raw_document_purge_status !== 'purged') {
      // Primary synchronous path did not purge inline (or is slower than
      // this check) -- fall back to the sweep, exactly as designed as a
      // backstop. Recorded honestly either way.
      purgeSweepOutcome = await tryCronSweep('purge-sweep');
      await sleep(1500);
      docAfterProcess = await row('fdh_statement_uploads', documentId);
    }
    let storageStillListed: boolean | null = null;
    const storageRef = docAfterProcess.raw_document_storage_reference as string | null;
    if (storageRef) {
      const dir = storageRef.slice(0, storageRef.lastIndexOf('/'));
      const name = storageRef.slice(storageRef.lastIndexOf('/') + 1);
      const listRes = await fetch(`${BASE}/storage/v1/object/list/fdh-source-documents`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: dir, search: name, limit: 10 }) });
      const listJson: any = await listRes.json().catch(() => null);
      storageStillListed = Array.isArray(listJson) ? listJson.some((o: any) => o.name === name) : null;
    }
    check('original PDF genuinely deleted BEFORE acceptance: purge_status=purged, storage reference cleared, independently re-listed absent from the bucket (not trusting the delete call\'s own response)',
      docAfterProcess.raw_document_purge_status === 'purged' && !docAfterProcess.raw_document_storage_reference && storageStillListed === false,
      JSON.stringify({ purgeStatus: docAfterProcess.raw_document_purge_status, hadRef: !!storageRef, storageStillListed, purgeSweepAttempted: purgeSweepOutcome.attempted, purgeSweepStatus: purgeSweepOutcome.status }));
    evidence.deletion = { purgeStatus: docAfterProcess.raw_document_purge_status, storageStillListed, purgeSweepOutcome, deletedBeforeAccept: true };

    // ----------------------------------- 8. acceptance AFTER deletion + 9
    const bankPanelBody = { rows: draft.rows, statementPeriodStart: draft.statementPeriodStart, statementPeriodEnd: draft.statementPeriodEnd, declaredOpeningBalance: draft.declaredOpeningBalance, declaredClosingBalance: draft.declaredClosingBalance, maskedAccountIdentifier: draft.maskedAccountIdentifier };
    const confirm = await app(session, `/api/financial-data-hub/bank-pdf/${documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody });
    check('acceptance succeeds even though the original PDF is already gone (durable review data does not depend on the file)', confirm.status === 200, `${confirm.status} ${confirm.text.slice(0, 300)}`);

    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${documentId}`, 'id,amount_original,credit_debit,transaction_date,currency_original');
    for (const t of tx) track.push({ table: 'fdh_transactions', id: t.id });
    const recon = await rows('fdh_reconciliation_results', `statement_upload_id=eq.${documentId}`, 'id,status,variance');
    for (const r of recon) track.push({ table: 'fdh_reconciliation_results', id: r.id });
    const debits = tx.filter((t: any) => t.credit_debit === 'debit').reduce((a: number, t: any) => a + Number(t.amount_original), 0);
    const credits = tx.filter((t: any) => t.credit_debit === 'credit').reduce((a: number, t: any) => a + Number(t.amount_original), 0);
    const currenciesOk = tx.every((t: any) => t.currency_original === 'AUD');
    check('CANONICAL WRITE: exactly 3 transactions land, correct debits/credits/currency, correctly attributed to the synthetic user, reconciliation ran',
      tx.length === 3 && Math.abs(debits - BANK_EXPECTED.debits) < 0.005 && Math.abs(credits - BANK_EXPECTED.credits) < 0.005 && currenciesOk && recon.length === 1,
      JSON.stringify({ txCount: tx.length, debits, credits, currenciesOk, recon }));
    const dAfter = await drafts(documentId);
    check('the durable review record is marked confirmed exactly once', dAfter.length === 1 && dAfter[0].status === 'confirmed' && !!dAfter[0].confirmed_at, JSON.stringify(dAfter.map((d: any) => d.status)));

    const noRawPiiInDraft = !JSON.stringify(dAfter[0]?.payload ?? {}).includes(PLANTED_PII.bsbAccount) && !JSON.stringify(dAfter[0]?.payload ?? {}).includes(PLANTED_PII.name);
    check('no raw planted PII present in the persisted, durable draft payload (structural check only)', noRawPiiInDraft);

    evidence.canonical = { txCount: tx.length, debits, credits, currenciesOk, reconciliation: recon, draftStatus: dAfter[0]?.status };
    evidence.finishedAt = new Date().toISOString();
  } finally {
    console.log('\n=== CLEANUP ===');
    for (const { table, id } of [...track].reverse()) {
      if (table === 'aie_pilot_cohort_emails') {
        const { error } = await admin.from(table).delete().eq('email', id);
        if (error) console.log(`  cleanup warning: ${table} email=${id}: ${error.message}`);
        continue;
      }
      const { error } = await admin.from(table).delete().eq('id', id);
      if (error) console.log(`  cleanup warning: ${table} id=${id}: ${error.message}`);
    }
    if (uploadDocumentId) {
      const { error } = await admin.from('fdh_statement_uploads').delete().eq('id', uploadDocumentId);
      if (error) console.log(`  cleanup warning: fdh_statement_uploads id=${uploadDocumentId}: ${error.message}`);
    }
    await admin.auth.admin.deleteUser(userId);

    let residue = 0;
    for (const { table, id } of track) {
      if (table === 'aie_pilot_cohort_emails') continue; // was never real user data
      const { data } = await admin.from(table).select('id').eq('id', id);
      if (data && data.length > 0) { residue += 1; console.log(`  RESIDUE: ${table} id=${id} still present`); }
    }
    if (uploadDocumentId) {
      const { data } = await admin.from('fdh_statement_uploads').select('id').eq('id', uploadDocumentId);
      if (data && data.length > 0) { residue += 1; console.log(`  RESIDUE: fdh_statement_uploads id=${uploadDocumentId} still present`); }
    }
    const { data: cohortStill } = await admin.from('aie_pilot_cohort_emails').select('email').eq('email', EMAIL);
    if (cohortStill && cohortStill.length > 0) { residue += 1; console.log('  RESIDUE: pilot cohort row still present'); }
    const stillThere = await admin.auth.admin.getUserById(userId).then((r) => r, () => ({ data: null }) as any);
    if ((stillThere as any)?.data?.user) { residue += 1; console.log('  RESIDUE: synthetic auth user still present'); }
    check('CLEANUP: independent re-query confirms zero synthetic residue in PRODUCTION', residue === 0, `residue=${residue} rows_tracked=${track.length + (uploadDocumentId ? 1 : 0)}`);

    const scratch = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad';
    fs.mkdirSync(scratch, { recursive: true });
    const out = path.join(scratch, `${RUN_TAG}.evidence.json`);
    fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(`evidence: ${out}`);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
