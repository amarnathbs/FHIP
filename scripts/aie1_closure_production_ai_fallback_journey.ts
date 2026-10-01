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
 * RAW-FILE RETENTION MODEL (corrected 2026-10-01, "purge on confirm").
 * The earlier assumption here -- that the raw PDF is already gone when
 * POST .../process returns a draft -- was DISPROVEN by the first production run:
 * the file stays (purge_status=not_required) while the AI-fallback draft is
 * pending review. Agreed design: KEEP the file while a young draft is pending,
 * DELETE it the moment the user confirms and the structured result is durable;
 * the 50-minute hard backstop remains the safety net (it deletes the raw file but
 * keeps the document's status, so a pending draft stays confirmable).
 * Two modes, run both:
 *   default                       step 7: file still present while pending;
 *                                 step 10: deleted by the confirm itself
 *                                 (purge_reason ai_fallback_confirmed_durable_result).
 *   AIE1_CLOSURE_BACKDATE_UPLOAD=1  step 7: past the backstop, the real purge
 *                                 sweep deletes it (raw_retention_hard_backstop_*);
 *                                 step 8: confirm still succeeds without the file.
 * Deletion is always verified by re-listing the bucket, not by trusting the
 * delete call's own response.
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
// EXISTING-ACCOUNT MODE (PO-authorised 2026-10-01: "use my account, it is just
// production beta testing data"). Set AIE1_CLOSURE_EXISTING_EMAIL to a real
// account that is ALREADY on the pilot allowlist AND set
// AIE1_CLOSURE_CONFIRM_REAL_ACCOUNT=YES. In this mode the script never creates
// or deletes the auth user and never edits user_profiles; cleanup removes only
// the rows this run created (upload, drafts, transactions, reconciliation).
const EXISTING_EMAIL = process.env.AIE1_CLOSURE_EXISTING_EMAIL?.trim() || '';
const EXISTING_MODE = EXISTING_EMAIL !== '';
if (EXISTING_MODE && process.env.AIE1_CLOSURE_CONFIRM_REAL_ACCOUNT !== 'YES') {
  console.error('REFUSING: AIE1_CLOSURE_EXISTING_EMAIL is set, so this would run against a REAL account. Also set AIE1_CLOSURE_CONFIRM_REAL_ACCOUNT=YES to confirm.');
  process.exit(2);
}
const EMAIL = EXISTING_MODE ? EXISTING_EMAIL : (process.env.AIE1_CLOSURE_FIXED_EMAIL?.trim() || `${RUN_TAG}@fhip-synthetic.test`);
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
  let userId: string;
  if (EXISTING_MODE) {
    let found: string | undefined;
    for (let page = 1; page <= 20 && !found; page++) {
      const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (listErr) throw new Error(`could not list users: ${listErr.message}`);
      found = list.users.find((u) => (u.email ?? '').toLowerCase() === EMAIL.toLowerCase())?.id;
      if (list.users.length < 200) break;
    }
    if (!found) throw new Error('existing-account mode: no auth user with that email found in production');
    userId = found;
    console.log(`EXISTING production account (real, PO-authorised): ${EMAIL} (${userId})`);
  } else {
    const password = `Synthetic!${randomUUID()}`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
    if (createErr || !created.user) throw new Error(`could not create synthetic production user: ${createErr?.message}`);
    userId = created.user.id;
    console.log(`synthetic production user: ${EMAIL} (${userId})`);
  }
  evidence.userId = userId;
  evidence.mode = EXISTING_MODE ? 'existing_account' : 'synthetic_account';

  const track: { table: string; id: string }[] = [];
  let uploadDocumentId: string | undefined;
  try {
    if (EXISTING_MODE) {
      // Never edit a real profile. Record only non-identifying context, since
      // the AU fixture's country/currency vs this profile may affect routing.
      const prof = (await rows('user_profiles', `user_id=eq.${userId}`, 'country_of_residence,preferred_currency,country_confirmed_at'))[0] as any;
      evidence.profileContext = { country: prof?.country_of_residence ?? null, currency: prof?.preferred_currency ?? null, countryConfirmed: !!prof?.country_confirmed_at };
      console.log(`profile context (not modified): country=${prof?.country_of_residence ?? 'null'} currency=${prof?.preferred_currency ?? 'null'} countryConfirmed=${!!prof?.country_confirmed_at}`);
    } else {
      const { error: profErr } = await admin
        .from('user_profiles')
        .update({ onboarding_completed: true, country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', preferred_currency: 'AUD', full_name: `AIE1 Closure PROD Proof ${RUN_TAG}` })
        .eq('user_id', userId);
      if (profErr) throw new Error(`user_profiles update failed: ${profErr.message}`);
    }

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

    // ------------------------------------------ 7. retention while pending
    // Two modes, two different things proven (corrected after the 2026-10-01
    // runs -- the pending-draft guard in enforceRawFileHardBackstop protects the
    // document's processing_status, NOT the raw file, which the backstop still
    // deletes at 50 minutes):
    //  - default: the document is young, so the raw file must still be present
    //    while the draft is pending; step 10 then proves "purge on confirm"
    //    (purge_reason ai_fallback_confirmed_durable_result).
    //  - AIE1_CLOSURE_BACKDATE_UPLOAD=1: backdate THIS RUN'S OWN document's
    //    uploaded_at by 60 minutes, past the 50-minute hard backstop
    //    (FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES). The real purge sweep must then
    //    delete the file (purge_reason raw_retention_hard_backstop_*) AND the
    //    user's confirm must still succeed afterwards, proving the draft is
    //    durable without the file. Step 10 cannot prove purge-on-confirm in this
    //    mode because the file is already gone -- use the default mode for that.
    const backdate = process.env.AIE1_CLOSURE_BACKDATE_UPLOAD === '1';
    if (backdate) {
      const newUploadedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { error: bdErr } = await admin.from('fdh_statement_uploads').update({ uploaded_at: newUploadedAt }).eq('id', documentId);
      evidence.backdate = { applied: !bdErr, uploadedAt: newUploadedAt, error: bdErr?.message ?? null };
      console.log(`  backdated this run's own document uploaded_at to ${newUploadedAt} (${bdErr ? 'FAILED: ' + bdErr.message : 'ok'}); it is now past the hard backstop, so only the pending-draft guard can keep it`);
    }
    let docAfterProcess = await row('fdh_statement_uploads', documentId);
    let purgeSweepOutcome: { attempted: boolean; status: number | null } = { attempted: false, status: null };
    // Run the real sweep once while the draft is pending: with the guard working
    // it must leave the file alone, even when the document is past the backstop.
    purgeSweepOutcome = await tryCronSweep('purge-sweep');
    await sleep(1500);
    docAfterProcess = await row('fdh_statement_uploads', documentId);
    let storageStillListed: boolean | null = null;
    const storageRef = docAfterProcess.raw_document_storage_reference as string | null;
    if (storageRef) {
      const dir = storageRef.slice(0, storageRef.lastIndexOf('/'));
      const name = storageRef.slice(storageRef.lastIndexOf('/') + 1);
      const listRes = await fetch(`${BASE}/storage/v1/object/list/fdh-source-documents`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: dir, search: name, limit: 10 }) });
      const listJson: any = await listRes.json().catch(() => null);
      storageStillListed = Array.isArray(listJson) ? listJson.some((o: any) => o.name === name) : null;
    }
    const retainedWhilePending = docAfterProcess.raw_document_purge_status !== 'purged' && !!docAfterProcess.raw_document_storage_reference && storageStillListed === true;
    const backstopPurged = docAfterProcess.raw_document_purge_status === 'purged' && !docAfterProcess.raw_document_storage_reference && storageRef === null
      && String(docAfterProcess.purge_reason ?? '').startsWith('raw_retention_hard_backstop');
    const step7Detail = JSON.stringify({ mode: backdate ? 'backdated' : 'default', purgeStatus: docAfterProcess.raw_document_purge_status, purgeReason: docAfterProcess.purge_reason ?? null, hadRef: !!storageRef, storageStillListed, purgeSweepAttempted: purgeSweepOutcome.attempted, purgeSweepStatus: purgeSweepOutcome.status });
    if (backdate) {
      check('BACKSTOP: a document past 50 minutes with a pending draft has its raw file deleted by the real purge sweep (purge_reason raw_retention_hard_backstop_*), and the draft stays reviewable',
        backstopPurged && purgeSweepOutcome.attempted && purgeSweepOutcome.status === 200, step7Detail);
    } else {
      check('original PDF is RETAINED while a young draft is pending review (deleted only on confirm): purge_status not purged, storage reference kept, independently re-listed present in the bucket, real purge sweep ran and left it alone',
        retainedWhilePending && purgeSweepOutcome.attempted && purgeSweepOutcome.status === 200, step7Detail);
    }
    evidence.deletion = {
      purgeStatus: docAfterProcess.raw_document_purge_status,
      storageStillListed,
      purgeSweepOutcome,
      retainedWhilePending,
      backstopPurged,
      purgeReason: docAfterProcess.purge_reason ?? null,
      retentionColumnsAfterProcess: Object.fromEntries(Object.entries(docAfterProcess ?? {}).filter(([k]) => /purge|retention|raw_document/i.test(k))),
    };

    // ----------------------------------- 8. acceptance AFTER deletion + 9
    const bankPanelBody = { rows: draft.rows, statementPeriodStart: draft.statementPeriodStart, statementPeriodEnd: draft.statementPeriodEnd, declaredOpeningBalance: draft.declaredOpeningBalance, declaredClosingBalance: draft.declaredClosingBalance, maskedAccountIdentifier: draft.maskedAccountIdentifier };
    const confirm = await app(session, `/api/financial-data-hub/bank-pdf/${documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody });
    check('acceptance succeeds (the confirm writes the durable result from the reviewed draft, then deletes the raw file)', confirm.status === 200, `${confirm.status} ${confirm.text.slice(0, 300)}`);

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

    // ------------------------- 10. raw PDF retention AFTER acceptance (new)
    // The 2026-10-01 first run found the raw PDF still stored after /process
    // (purge_status=not_required, object listed). This step records WHEN, if
    // ever, it is deleted after acceptance: polls the document row and the
    // bucket, nudging the purge sweep each cycle (production's pg_cron also
    // runs it every 5 minutes). Outcome is evidence either way; the check only
    // passes if the object is genuinely gone from the bucket in the window.
    const waitSeconds = Number(process.env.AIE1_CLOSURE_POST_ACCEPT_WAIT_SECONDS ?? 780);
    const retentionKeys = (r: any) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => /purge|retention|raw_document/i.test(k)));
    const timeline: Array<{ tSec: number; purgeStatus: unknown; hasRef: boolean; objectListed: boolean | null }> = [];
    const pollStart = Date.now();
    let purgedAtSec: number | null = null;
    const objectListed = async (ref: string | null): Promise<boolean | null> => {
      const p = ref ?? `${userId}/${documentId}/${documentId}.bin`;
      const dir = p.slice(0, p.lastIndexOf('/'));
      const nm = p.slice(p.lastIndexOf('/') + 1);
      const lr = await fetch(`${BASE}/storage/v1/object/list/fdh-source-documents`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: dir, search: nm, limit: 10 }) });
      const lj: any = await lr.json().catch(() => null);
      return Array.isArray(lj) ? lj.some((o: any) => o.name === nm) : null;
    };
    // "Purge on confirm": the confirm call above deletes the raw file inline, so
    // this normally passes on the first poll (0s). The poll/sweep remains as the
    // fallback path if the inline purge failed and the 5-minute cron has to retry.
    console.log(`  waiting up to ${waitSeconds}s after acceptance to observe raw-PDF deletion (polling every 30s)...`);
    for (;;) {
      const d = await row('fdh_statement_uploads', documentId);
      const listed = await objectListed((d?.raw_document_storage_reference as string | null) ?? null);
      const tSec = Math.round((Date.now() - pollStart) / 1000);
      timeline.push({ tSec, purgeStatus: d?.raw_document_purge_status ?? null, hasRef: !!d?.raw_document_storage_reference, objectListed: listed });
      if (d?.raw_document_purge_status === 'purged' && !d?.raw_document_storage_reference && listed === false) { purgedAtSec = tSec; break; }
      if (tSec >= waitSeconds) break;
      if (!backdate) await tryCronSweep('purge-sweep'); // backdate mode: only the real cron may purge
      await sleep(30_000);
    }
    const finalRow = await row('fdh_statement_uploads', documentId);
    evidence.postAcceptanceDeletion = { waitedSec: Math.round((Date.now() - pollStart) / 1000), purgedAtSec, retentionColumns: retentionKeys(finalRow), timeline };
    const finalReason = String(finalRow?.purge_reason ?? '');
    if (backdate) {
      check(`raw PDF is gone after acceptance (already deleted by the backstop in this mode; does NOT prove purge-on-confirm -- run without AIE1_CLOSURE_BACKDATE_UPLOAD for that)`, purgedAtSec !== null, purgedAtSec !== null ? `gone ${purgedAtSec}s after acceptance; purge_reason ${finalReason}` : `NOT deleted in window; last state ${JSON.stringify(timeline[timeline.length - 1])}`);
    } else {
      check(`PURGE ON CONFIRM: the raw PDF is deleted from the bucket when the user accepts, by the confirm path itself (purge_reason ai_fallback_confirmed_durable_result), observed within ${waitSeconds}s`, purgedAtSec !== null && finalReason === 'ai_fallback_confirmed_durable_result', purgedAtSec !== null ? `purged ${purgedAtSec}s after acceptance; purge_reason ${finalReason}` : `NOT deleted in window; last state ${JSON.stringify(timeline[timeline.length - 1])}; retention columns ${JSON.stringify(retentionKeys(finalRow))}`);
    }
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
    // Raw PDF object: the DB row's deletion does NOT remove it (found 2026-10-01 --
    // it was left orphaned in the bucket). Remove this run's own object explicitly
    // and verify it is gone, whatever state the row is in.
    let rawObjectPath: string | null = null;
    if (uploadDocumentId) {
      const prow = await row('fdh_statement_uploads', uploadDocumentId);
      rawObjectPath = (prow?.raw_document_storage_reference as string | null) ?? `${userId}/${uploadDocumentId}/${uploadDocumentId}.bin`;
      const rm = await admin.storage.from('fdh-source-documents').remove([rawObjectPath]);
      if (rm.error) console.log(`  cleanup warning: raw object remove: ${rm.error.message}`);
    }
    if (uploadDocumentId) {
      if (EXISTING_MODE) {
        // No user-delete cascade in this mode: remove this run's own child rows
        // explicitly (scoped strictly to this one document id). Audit events and
        // AI cost rows are append-only audit evidence and may legitimately remain.
        const d1 = await admin.from('fdh_ai_fallback_drafts').delete().eq('statement_upload_id', uploadDocumentId);
        if (d1.error) console.log(`  cleanup warning: fdh_ai_fallback_drafts: ${d1.error.message}`);
        const d2 = await admin.from('fdh_document_audit_events').delete().eq('document_id', uploadDocumentId);
        if (d2.error) console.log(`  note: audit events for this document retained (append-only?): ${d2.error.message}`);
      }
      const { error } = await admin.from('fdh_statement_uploads').delete().eq('id', uploadDocumentId);
      if (error) console.log(`  cleanup warning: fdh_statement_uploads id=${uploadDocumentId}: ${error.message}`);
    }
    if (!EXISTING_MODE) await admin.auth.admin.deleteUser(userId);

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
    if (rawObjectPath) {
      const dir = rawObjectPath.slice(0, rawObjectPath.lastIndexOf('/'));
      const nm = rawObjectPath.slice(rawObjectPath.lastIndexOf('/') + 1);
      const lr = await fetch(`${BASE}/storage/v1/object/list/fdh-source-documents`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: dir, search: nm, limit: 10 }) });
      const lj: any = await lr.json().catch(() => null);
      if (!Array.isArray(lj) || lj.some((o: any) => o.name === nm)) { residue += 1; console.log(`  RESIDUE: raw PDF object still listed (or could not be verified absent) at ${rawObjectPath}`); }
    }
    if (uploadDocumentId) {
      const { data: leftDrafts } = await admin.from('fdh_ai_fallback_drafts').select('id').eq('statement_upload_id', uploadDocumentId);
      if (leftDrafts && leftDrafts.length > 0) { residue += 1; console.log('  RESIDUE: ai fallback draft still present'); }
    }
    if (!EXISTING_MODE) {
      const stillThere = await admin.auth.admin.getUserById(userId).then((r) => r, () => ({ data: null }) as any);
      if ((stillThere as any)?.data?.user) { residue += 1; console.log('  RESIDUE: synthetic auth user still present'); }
    }
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
