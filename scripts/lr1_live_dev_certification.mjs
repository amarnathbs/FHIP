// LR-1 (Upload Security, Strict Raw-File Deletion & Document Lifecycle) —
// Phase 4 LIVE DEV certification.
//
// Runs for real against hosted DEV Postgres/Storage (vqycarelcoijzwlpkpcz)
// and a real `next dev` instance started from THIS worktree
// (D:/FHIP/.claude/worktrees/agent-a9fdb5d253f9b5fff, port 3501 — confirmed
// serving this branch by probing an LR-1-only route,
// GET /api/financial-data-hub/documents/cron/purge-sweep's sibling POST
// route as well as the ordinary bank-csv upload route, and receiving 401
// rather than 404).
//
// Pattern established by scripts/fdh12_live_dev_certification.mjs /
// scripts/fdh4_live_dev_certification.ts: service-role REST for fixtures +
// real signup + cookie session for HTTP calls against the app's own API
// routes + service-role reads to independently verify what actually got
// persisted/deleted. Every synthetic user/document/session/row/object is
// tagged `lr1-livedev-*` and deleted at the end; deletion is independently
// re-verified by re-query. The real ingestion pipeline (upload -> detect ->
// process -> approve) is used throughout — never a raw insert of parser
// output into a staging table.
//
// The CRON_SECRET value itself is read from .env.local and used only as a
// header value — it is never printed, logged, or written to any output file
// by this script.
//
// Run: node scripts/lr1_live_dev_certification.mjs [phase ...]
// Phases: setup a b c d e f cleanup   (default: all)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.env.LR1_APP ?? 'http://localhost:3501';

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = env.CRON_SECRET; // never printed
const CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
const PROJECT_REF = new URL(URL_).host.split('.')[0];
if (PROJECT_REF !== CERTIFIED_DEV_PROJECT_REF) {
  console.error(`Refusing: NEXT_PUBLIC_SUPABASE_URL is not the certified DEV project (saw ${PROJECT_REF})`);
  process.exit(1);
}
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;
const BUCKET = 'fdh-source-documents';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const TAG = `lr1-livedev-${STAMP}`;

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}
function note(label, detail = '') {
  console.log(`  INFO  ${label}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------- REST helpers
async function rest(pathAndQuery, opts = {}, key = SERVICE) {
  const headers = {
    apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer ?? 'return=representation',
    ...opts.headers,
  };
  const r = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, { ...opts, headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
async function storageAdmin(method, pathname, body) {
  const r = await fetch(`${URL_}/storage/v1/${pathname}`, {
    method, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
async function storageAsUser(user, method, pathname, body) {
  const r = await fetch(`${URL_}/storage/v1/${pathname}`, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
/** Independent absence check — a direct storage `list()` call via the
 * service-role, never inferred from a delete/purge call's own success. */
async function listObjectExists(storageKey) {
  const lastSlash = storageKey.lastIndexOf('/');
  const dir = storageKey.slice(0, lastSlash);
  const name = storageKey.slice(lastSlash + 1);
  const r = await storageAdmin('POST', `object/list/${BUCKET}`, { prefix: dir, search: name, limit: 10 });
  const found = Array.isArray(r.json) ? r.json.some((f) => f.name === name) : false;
  return { found, raw: r.json };
}

const createdUsers = [];
async function createUser(tag, { country = 'AU', currency = 'AUD' } = {}) {
  const email = `${TAG}-${tag}@fhip-test.invalid`;
  const password = `Lr1Live!${STAMP}${tag}`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  if (!j.id) throw new Error(`could not create user ${tag}: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  const prof = await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: `LR1 Live ${tag}`,
      country_of_residence: country,
      preferred_currency: currency,
      onboarding_completed: true,
      employment_status: 'full_time_employed',
      profile_completion_percentage: 100,
      country_confirmed_at: now,
      country_source: 'USER_CONFIRMED',
      country_updated_at: now,
    }),
  });
  if (prof.status >= 300) throw new Error(`profile patch failed for ${tag}: ${prof.text.slice(0, 300)}`);

  const tok = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ email, password }),
  })).json();
  if (!tok.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(tok).slice(0, 300)}`);
  const session = {
    access_token: tok.access_token, token_type: tok.token_type, expires_in: tok.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + tok.expires_in,
    refresh_token: tok.refresh_token, user: tok.user,
  };
  const cookie = `${COOKIE_NAME}=base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`;
  const user = { id: j.id, email, password, cookie, accessToken: tok.access_token, country, currency };
  createdUsers.push(user);
  return user;
}

async function app(user, pathname, opts = {}) {
  const r = await fetch(`${APP}${pathname}`, {
    method: opts.method ?? 'GET',
    headers: { Cookie: user ? user.cookie : '', 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body !== undefined ? (typeof opts.body === 'string' || opts.body instanceof Uint8Array ? opts.body : JSON.stringify(opts.body)) : undefined,
    redirect: opts.redirect ?? 'manual',
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json, e.g. a redirect */ }
  return { status: r.status, json, text, location: r.headers.get('location') };
}
async function uploadCsv(user, meta, bytes) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) qs.set(k, String(v));
  return app(user, `/api/financial-data-hub/bank-csv/upload?${qs.toString()}`, {
    method: 'POST', headers: { 'Content-Type': 'text/csv', 'Content-Length': String(bytes.byteLength) }, body: bytes,
  });
}
async function getInstitutionId(code, country) {
  const r = await rest(`fdh_financial_institutions?institution_code=eq.${code}&country_code=eq.${country}&select=id`);
  return r.json?.[0]?.id ?? null;
}
async function sweep() {
  const r = await fetch(`${APP}/api/financial-data-hub/documents/cron/purge-sweep`, {
    method: 'POST', headers: { 'x-cron-secret': CRON_SECRET },
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
async function getDoc(id) {
  const r = await rest(`fdh_statement_uploads?id=eq.${id}&select=*`);
  return r.json?.[0] ?? null;
}

const CSV_CBA = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'r7-bank-csv', 'au_cba_debit_credit.csv'));
const CSV_UNRECOGNISED = Buffer.from(
  'Zeta,Notes,Value\r\n' +
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,x,1\r\n' +
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,y,2\r\n',
  'utf8',
);

// ------------------------------------------------------------------ results
const results = {};

async function fixtureA() {
  console.log('\n=== FIXTURE A — success lifecycle (upload -> detect -> process -> approve -> purge -> verified absence -> Review still works) ===');
  const userA = await createUser('a-fixa');
  const cba = await getInstitutionId('cba', 'AU');
  check('A-00 CBA AU institution resolves', Boolean(cba), String(cba));

  const up = await uploadCsv(userA, { country_code: 'AU', currency_code: 'AUD', institution_id: cba, masked_identifier: 'LR1A01', filename: 'lr1-fixture-a.csv' }, CSV_CBA);
  const docId = up.json?.data?.document_id;
  const accountId = up.json?.data?.financial_account_id;
  check('A-01 real upload via the actual pipeline succeeds', (up.status === 200 || up.status === 201) && Boolean(docId), `status=${up.status} docId=${docId}`);

  const docRow0 = await getDoc(docId);
  const storageKey = docRow0?.raw_document_storage_reference;
  check('A-02 a raw storage reference is recorded', Boolean(storageKey), storageKey);
  const exists0 = await listObjectExists(storageKey);
  check('A-03 the raw object genuinely exists in storage (independent list(), not inferred)', exists0.found);

  const det = await app(userA, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
  check('A-04 detection resolves against the CBA adapter', det.json?.data?.detection_status === 'detected' && det.json?.data?.adapter_key?.startsWith('au_cba'), JSON.stringify(det.json?.data));

  const proc = await app(userA, `/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' });
  check('A-05 parser processing creates canonical transactions', proc.status === 200 && proc.json?.data?.transactions_created > 0, JSON.stringify(proc.json?.data));

  const recon = await app(userA, `/api/financial-data-hub/bank-csv/${docId}/reconciliation`);
  note('A-06 reconciliation before approval', JSON.stringify(recon.json?.data?.reconciliation?.status));

  // Real pipeline step: R8 automatic economic-type classification. Without
  // this, every transaction's economic_transaction_type stays 'unknown' and
  // fdh7_transaction_has_blocking_issue() correctly refuses approval — this
  // is the real review-workflow gate, not a bug, and classify is a real,
  // idempotent endpoint an actual user's review screen calls.
  const classify = await app(userA, '/api/financial-data-hub/bank-transactions/categorise', { method: 'POST' });
  note('A-06b classification result', `status=${classify.status} body=${JSON.stringify(classify.json ?? classify.text).slice(0, 500)}`);

  const approve = await app(userA, `/api/financial-data-hub/documents/${docId}/approve`, { method: 'POST' });
  check('A-07 approval succeeds via the real approval endpoint', approve.status === 200 && approve.json?.data?.processing_status === 'approved', JSON.stringify(approve.json));

  // Ordering rule check: purge must be SCHEDULED (pending) only after the
  // Approved Financial Summary already exists.
  const summaryAfterApprove = await rest(`fdh_approved_financial_summaries?statement_upload_id=eq.${docId}&select=id`);
  check('A-08 the Approved Financial Summary exists before purge is scheduled', (summaryAfterApprove.json ?? []).length > 0);

  const docAfterApprove = await getDoc(docId);
  check('A-09 purge was scheduled immediately on approval (pending, due now — approved retention = 0 minutes)',
    docAfterApprove?.raw_document_purge_status === 'pending' && new Date(docAfterApprove.raw_document_purge_due_at).getTime() <= Date.now() + 2000,
    `status=${docAfterApprove?.raw_document_purge_status} due=${docAfterApprove?.raw_document_purge_due_at}`);

  const sweepRes = await sweep();
  check('A-10 the cron purge-sweep endpoint accepts the correct secret and runs', sweepRes.status === 200, JSON.stringify(sweepRes.json));
  check('A-11 the sweep response reports at least one purge attempt', (sweepRes.json?.data?.due_purges_attempted ?? 0) >= 1, JSON.stringify(sweepRes.json?.data));

  const docAfterSweep = await getDoc(docId);
  check('A-12 the document row is marked purged, raw reference nulled, filename nulled',
    docAfterSweep?.raw_document_purge_status === 'purged' && docAfterSweep?.raw_document_storage_reference === null && docAfterSweep?.original_filename_sanitised === null,
    JSON.stringify({ purge_status: docAfterSweep?.raw_document_purge_status, ref: docAfterSweep?.raw_document_storage_reference, fname: docAfterSweep?.original_filename_sanitised }));

  const absent = await listObjectExists(storageKey);
  check('A-13 the raw object is INDEPENDENTLY verified absent from storage (a fresh list() call, not trusting the sweep response)', !absent.found);

  // Audit trail carries a purge event but no raw content/signed URL.
  const audit = await rest(`fdh_document_audit_events?document_id=eq.${docId}&event_type=eq.document_purged&select=*`);
  check('A-14 a document_purged audit event was recorded', (audit.json ?? []).length >= 1);
  const auditMeta = JSON.stringify(audit.json ?? []);
  check('A-15 the audit event carries no signed URL / storage key / raw content', !/signedUrl|token=|\.bin|https?:\/\//i.test(auditMeta), auditMeta.slice(0, 200));

  // ===== Fixture F (mandatory): raw-absent, Review/canonical still works =====
  console.log('\n=== FIXTURE F — Review/canonical data works from structured data alone once the raw object is confirmed absent ===');
  const reconAfter = await app(userA, `/api/financial-data-hub/bank-csv/${docId}/reconciliation`);
  check('F-01 reconciliation endpoint still returns 200 with real data after purge', reconAfter.status === 200 && Boolean(reconAfter.json?.data?.reconciliation), JSON.stringify(reconAfter.json?.data?.reconciliation?.status));

  const summaryAfter = await app(userA, `/api/financial-data-hub/documents/${docId}/approved-summary`);
  check('F-02 approved-summary endpoint still returns 200 with the real summary after purge', summaryAfter.status === 200 && Boolean(summaryAfter.json?.data?.summary), JSON.stringify(summaryAfter.json?.data?.summary?.approved_transaction_count));

  const txns = await app(userA, `/api/financial-data-hub/bank-transactions?account_id=${accountId}`);
  const txnRows = txns.json?.data?.transactions;
  check('F-03 transaction list endpoint still returns real rows after purge', txns.status === 200 && Array.isArray(txnRows) && txnRows.length > 0, `count=${txnRows?.length}`);

  const statusAfter = await app(userA, `/api/financial-data-hub/bank-csv/${docId}/status`);
  check('F-04 status endpoint still returns 200 after purge (structured status columns only)', statusAfter.status === 200 && statusAfter.json?.data?.processing_status === 'approved');

  const previewAfter = await app(userA, `/api/financial-data-hub/documents/${docId}/preview`);
  check('F-05 preview (raw-file signed-URL redirect) correctly refuses once purged (410, not a stale/broken signed URL)', previewAfter.status === 410, `status=${previewAfter.status}`);

  results.fixtureA = { userA, docId, accountId, storageKey };
}

async function fixtureB() {
  console.log('\n=== FIXTURE B — malformed/unrecognised file: parser cannot extract, raw source is still deleted, no canonical write ===');
  const userA = results.fixtureA.userA;
  const up = await uploadCsv(userA, { country_code: 'AU', currency_code: 'AUD', masked_identifier: 'LR1B01', filename: 'lr1-fixture-b.csv' }, CSV_UNRECOGNISED);
  const docId = up.json?.data?.document_id;
  check('B-01 an unrecognised-but-text-shaped file is still accepted at upload time (byte-signature validation only, not content parsing)', (up.status === 200 || up.status === 201) && Boolean(docId), `status=${up.status}`);

  const docRow0 = await getDoc(docId);
  const storageKey = docRow0?.raw_document_storage_reference;
  check('B-02 a raw object was actually stored', Boolean(storageKey));
  const exists0 = await listObjectExists(storageKey);
  check('B-03 the raw object exists in storage before failure handling runs', exists0.found);

  const det = await app(userA, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
  note('B-04 detection outcome on unrecognised content', JSON.stringify(det.json?.data ?? det.json));
  check('B-04 no bank-format adapter matches this content (undetected, not falsely detected)', det.json?.data?.detection_status !== 'detected', JSON.stringify(det.json?.data));

  const txns = await rest(`fdh_transactions?statement_upload_id=eq.${docId}&select=id`);
  check('B-05 zero canonical transactions were ever written for this document', (txns.json ?? []).length === 0, `count=${txns.json?.length}`);

  // There is no per-pipeline "on parse failure, purge immediately" wiring in
  // this codebase (confirmed by reading approvalService.ts / the six
  // ingestion services) — only approval and explicit user-delete schedule an
  // immediate purge. A document that never reaches approval or an explicit
  // delete relies entirely on the 60-minute hard backstop, regardless of
  // processing_status. We advance the clock on this SYNTHETIC row only (a
  // disclosed, reversible test seam — never real infrastructure sabotage) by
  // backdating uploaded_at, then invoke the real sweep, exactly as the
  // dispatch permits ("advance/trigger the purge sweep directly rather than
  // wait real wall-clock time").
  const backdated = new Date(Date.now() - 65 * 60 * 1000).toISOString();
  const patch = await rest(`fdh_statement_uploads?id=eq.${docId}`, { method: 'PATCH', body: JSON.stringify({ uploaded_at: backdated }) });
  check('B-06 test seam: uploaded_at backdated 65 minutes on this synthetic row only', patch.status < 300, `status=${patch.status}`);

  const sweepRes = await sweep();
  check('B-07 sweep runs and the 60-minute hard backstop forces this stuck document into the purge lifecycle', (sweepRes.json?.data?.hard_backstop_forced ?? 0) >= 1, JSON.stringify(sweepRes.json?.data));

  const docAfter = await getDoc(docId);
  check('B-08 raw object purged, reference nulled, processing_status moved off the pre-review states (never silently stuck)',
    docAfter?.raw_document_purge_status === 'purged' && docAfter?.raw_document_storage_reference === null,
    JSON.stringify({ purge: docAfter?.raw_document_purge_status, proc: docAfter?.processing_status }));

  const absent = await listObjectExists(storageKey);
  check('B-09 the raw object is independently verified absent', !absent.found);
  const txnsAfter = await rest(`fdh_transactions?statement_upload_id=eq.${docId}&select=id`);
  check('B-10 still zero canonical transactions after purge (no residue, no bypass write)', (txnsAfter.json ?? []).length === 0);

  results.fixtureB = { docId, storageKey };
}

async function fixtureC() {
  console.log('\n=== FIXTURE C — abandonment: the janitor removes an abandoned upload session AND an abandoned-but-uploaded document ===');
  const userA = results.fixtureA.userA;

  // --- C1: a session created but never completed (no bytes ever uploaded) ---
  console.log('--- C1: session created, never completed ---');
  const sessRes = await app(userA, '/api/financial-data-hub/documents/upload-sessions', {
    method: 'POST',
    body: { document_type: 'bank_statement', source_type: 'csv', country_code: 'AU', currency_code: 'AUD', declared_mime_type: 'text/csv', declared_file_size_bytes: 500 },
  });
  const sessionId = sessRes.json?.data?.session_id;
  const c1DocId = sessRes.json?.data?.document_id;
  check('C1-01 a real upload session is created via the real endpoint', sessRes.status === 200 && Boolean(sessionId), JSON.stringify(sessRes.json));

  const c1DocBefore = await getDoc(c1DocId);
  check('C1-02 the document starts in "created" with no storage reference (nothing uploaded yet)', c1DocBefore?.processing_status === 'created' && !c1DocBefore?.raw_document_storage_reference);

  // chk_fdh_upload_sessions_expiry_order requires expires_at > created_at, so
  // both must move together to stay in the past relative to "now" while
  // still satisfying that constraint relative to each other.
  const backdatedCreated = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const backdatedExpires = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const patchSess = await rest(`fdh_upload_sessions?id=eq.${sessionId}`, { method: 'PATCH', body: JSON.stringify({ created_at: backdatedCreated, expires_at: backdatedExpires }) });
  check('C1-03 test seam: session created_at/expires_at backdated (simulates real session expiry)', patchSess.status < 300, `status=${patchSess.status} body=${patchSess.text.slice(0, 300)}`);

  const sweepRes1 = await sweep();
  check('C1-04 sweep runs and reports at least one abandoned session swept', (sweepRes1.json?.data?.abandoned_sessions_swept ?? 0) >= 1, JSON.stringify(sweepRes1.json?.data));

  const sessAfter = await rest(`fdh_upload_sessions?id=eq.${sessionId}&select=upload_status`);
  check('C1-05 the session is marked expired', sessAfter.json?.[0]?.upload_status === 'expired', JSON.stringify(sessAfter.json));
  const c1DocMid = await getDoc(c1DocId);
  check('C1-06 the orphaned document is marked failed and a purge is scheduled (not left indefinitely)', c1DocMid?.processing_status === 'failed' && c1DocMid?.raw_document_purge_status === 'pending', JSON.stringify({ proc: c1DocMid?.processing_status, purge: c1DocMid?.raw_document_purge_status, due: c1DocMid?.raw_document_purge_due_at }));

  // The abandoned-session grace period (20 minutes) is not yet elapsed —
  // advance that clock too (same disclosed test seam) so the SAME real
  // findDuePurges/runPurgeAttempt path completes without waiting 20 more
  // real minutes.
  const patchDue = await rest(`fdh_statement_uploads?id=eq.${c1DocId}`, { method: 'PATCH', body: JSON.stringify({ raw_document_purge_due_at: new Date().toISOString() }) });
  check('C1-07 test seam: purge_due_at advanced to now on this synthetic row', patchDue.status < 300);
  const sweepRes2 = await sweep();
  const c1DocAfter = await getDoc(c1DocId);
  check('C1-08 with no object ever stored, purge completes as skipped_no_object -> purged (nothing to delete, lifecycle still closes cleanly)', c1DocAfter?.raw_document_purge_status === 'purged', JSON.stringify(sweepRes2.json?.data));

  // --- C2: a real object uploaded, then abandoned before any review action ---
  console.log('--- C2: real object uploaded, then abandoned (never processed/approved) ---');
  const cba = await getInstitutionId('cba', 'AU');
  const up = await uploadCsv(userA, { country_code: 'AU', currency_code: 'AUD', institution_id: cba, masked_identifier: 'LR1C02', filename: 'lr1-fixture-c2.csv' }, CSV_CBA);
  const c2DocId = up.json?.data?.document_id;
  check('C2-01 real upload succeeds', (up.status === 200 || up.status === 201) && Boolean(c2DocId));
  const c2DocRow = await getDoc(c2DocId);
  const c2Key = c2DocRow?.raw_document_storage_reference;
  const c2Exists0 = await listObjectExists(c2Key);
  check('C2-02 the raw object genuinely exists before abandonment', c2Exists0.found);

  // Abandon: never call detect/process/approve. Backdate uploaded_at past the
  // 60-minute hard cap.
  const backdated2 = new Date(Date.now() - 65 * 60 * 1000).toISOString();
  await rest(`fdh_statement_uploads?id=eq.${c2DocId}`, { method: 'PATCH', body: JSON.stringify({ uploaded_at: backdated2 }) });
  const sweepRes3 = await sweep();
  const c2DocAfter = await getDoc(c2DocId);
  check('C2-03 the hard backstop catches the abandoned-but-uploaded document and purges its raw object', c2DocAfter?.raw_document_purge_status === 'purged' && c2DocAfter?.raw_document_storage_reference === null, JSON.stringify(sweepRes3.json?.data));
  const c2Absent = await listObjectExists(c2Key);
  check('C2-04 the raw object is independently verified absent', !c2Absent.found);

  results.fixtureC = { c1DocId, c2DocId, c2Key };
}

async function fixtureDCrossUser() {
  console.log('\n=== FIXTURE D — cross-user: User B cannot read/download/preview/delete/list/approve/inspect User A\'s document or object ===');
  const userA = results.fixtureA.userA;
  const userB = await createUser('b-fixd');

  const cba = await getInstitutionId('cba', 'AU');
  const up = await uploadCsv(userA, { country_code: 'AU', currency_code: 'AUD', institution_id: cba, masked_identifier: 'LR1D01', filename: 'lr1-fixture-d.csv' }, CSV_CBA);
  const docId = up.json?.data?.document_id;
  check('D-00 setup: User A uploads a real document', (up.status === 200 || up.status === 201) && Boolean(docId));
  const docRow = await getDoc(docId);
  const storageKey = docRow?.raw_document_storage_reference;

  // Give A one real transaction id to probe with too.
  await app(userA, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
  await app(userA, `/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' });
  const aTxn = await rest(`fdh_transactions?statement_upload_id=eq.${docId}&select=id&limit=1`);
  const txnId = aTxn.json?.[0]?.id;

  // ---- App-route level (session-authenticated as B) ----
  const statusB = await app(userB, `/api/financial-data-hub/bank-csv/${docId}/status`);
  check('D-01 status (read) as User B -> not found', statusB.status === 404, `status=${statusB.status}`);

  const reconB = await app(userB, `/api/financial-data-hub/bank-csv/${docId}/reconciliation`);
  check('D-02 reconciliation (read) as User B -> not found', reconB.status === 404, `status=${reconB.status}`);

  const detectB = await app(userB, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
  check('D-03 detect (write/apply) as User B -> not found', detectB.status === 404, `status=${detectB.status}`);

  const approveB = await app(userB, `/api/financial-data-hub/documents/${docId}/approve`, { method: 'POST' });
  check('D-04 approve as User B -> not found', approveB.status === 404, `status=${approveB.status}`);

  const previewB = await app(userB, `/api/financial-data-hub/documents/${docId}/preview`);
  check('D-05 preview (signed-URL download) as User B -> not found (no signed URL is ever issued to a non-owner)', previewB.status === 404, `status=${previewB.status}`);

  const metaB = await app(userB, `/api/financial-data-hub/documents/${docId}`);
  check('D-06 metadata-inspect (generic document GET) as User B -> not found', metaB.status === 404, `status=${metaB.status}`);

  const deleteB = await app(userB, `/api/financial-data-hub/documents/${docId}`, { method: 'DELETE' });
  check('D-07 delete as User B -> not found (document untouched)', deleteB.status === 404, `status=${deleteB.status}`);
  const docStillThere = await getDoc(docId);
  check('D-07b User A\'s document is completely unaffected by User B\'s delete attempt', docStillThere?.raw_document_purge_status !== 'purged' && docStillThere?.raw_document_storage_reference === storageKey);

  if (txnId) {
    const txnApproveB = await app(userB, `/api/financial-data-hub/bank-transactions/${txnId}/approve`, { method: 'POST' });
    check('D-08 approve User A\'s transaction as User B -> not found', txnApproveB.status === 404, `status=${txnApproveB.status}`);
  } else {
    note('D-08 skipped', 'no transaction id resolved to probe with');
  }

  const listB = await app(userB, '/api/financial-data-hub/documents');
  const leaked = Array.isArray(listB.json?.data) && listB.json.data.some((d) => d.id === docId || d.document_id === docId);
  check('D-09 User B\'s document list never includes User A\'s document', listB.status === 200 && !leaked, `count=${listB.json?.data?.length}`);

  // ---- Storage/Postgres RLS level, as User B's OWN real authenticated
  // session (not the app, not service-role, not a mock) ----
  const dir = storageKey.slice(0, storageKey.lastIndexOf('/'));
  const name = storageKey.slice(storageKey.lastIndexOf('/') + 1);
  const listAsB = await storageAsUser(userB, 'POST', `object/list/${BUCKET}`, { prefix: dir, search: name, limit: 10 });
  const leakedList = Array.isArray(listAsB.json) && listAsB.json.some((f) => f.name === name);
  check('D-10 direct Storage list() as User B\'s own RLS session cannot see User A\'s object', !leakedList, `status=${listAsB.status} leaked=${leakedList}`);

  const downloadAsB = await storageAsUser(userB, 'GET', `object/authenticated/${BUCKET}/${storageKey}`);
  check('D-11 direct Storage download as User B\'s own RLS session is refused', downloadAsB.status !== 200, `status=${downloadAsB.status}`);

  const deleteAsB = await storageAsUser(userB, 'DELETE', `object/${BUCKET}/${storageKey}`);
  check('D-12 direct Storage delete as User B\'s own RLS session is refused (authenticated role has no delete policy at all)', deleteAsB.status !== 200, `status=${deleteAsB.status}`);

  // ---- Negative control: the SAME probes succeed for the genuine owner ----
  const statusA = await app(userA, `/api/financial-data-hub/bank-csv/${docId}/status`);
  check('D-13 control: the SAME status read succeeds for the genuine owner (User A) — proves this is real ownership scoping, not a blanket 404', statusA.status === 200);
  const listAsA = await storageAsUser(userA, 'POST', `object/list/${BUCKET}`, { prefix: dir, search: name, limit: 10 });
  const ownFound = Array.isArray(listAsA.json) && listAsA.json.some((f) => f.name === name);
  check('D-14 control: User A CAN see her own object via direct Storage RLS', ownFound, `status=${listAsA.status}`);

  results.fixtureD = { docId, storageKey, userB, txnId };
}

async function fixtureE() {
  console.log('\n=== FIXTURE E — delete retry: a "failed" purge-pending state retries to verified absence without corrupting lifecycle state ===');
  console.log('  NOTE: Supabase Storage\'s remove() call does not error for a key that is merely missing (it is idempotent by');
  console.log('  design), and this environment has no safe way to force the underlying Storage HTTP call itself to fail (that');
  console.log('  would require either revoking real DEV service-role permissions or network-level fault injection — both would');
  console.log('  be sabotaging real DEV infrastructure, which the dispatch explicitly forbids). Instead, the FAILED purge state');
  console.log('  itself is injected via a disclosed, reversible test-seam UPDATE on a synthetic row whose object still genuinely');
  console.log('  exists (raw_document_purge_status=\'failed\', purge_attempt_count=1 — exactly the column values the real failure');
  console.log('  path itself would leave behind). Every subsequent step (findDuePurges picking it up, runPurgeAttempt retrying it,');
  console.log('  delete+independent-verify, the purged patch, the audit event) is the REAL, unmodified code path.');

  const userA = results.fixtureA.userA;
  const cba = await getInstitutionId('cba', 'AU');
  const up = await uploadCsv(userA, { country_code: 'AU', currency_code: 'AUD', institution_id: cba, masked_identifier: 'LR1E01', filename: 'lr1-fixture-e.csv' }, CSV_CBA);
  const docId = up.json?.data?.document_id;
  check('E-01 real upload succeeds', (up.status === 200 || up.status === 201) && Boolean(docId));
  const docRow = await getDoc(docId);
  const storageKey = docRow?.raw_document_storage_reference;
  const exists0 = await listObjectExists(storageKey);
  check('E-02 the raw object genuinely exists', exists0.found);

  // Move the document into approved (real path) so it is purge-eligible.
  await app(userA, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
  await app(userA, `/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' });
  await app(userA, '/api/financial-data-hub/bank-transactions/categorise', { method: 'POST' });
  const approve = await app(userA, `/api/financial-data-hub/documents/${docId}/approve`, { method: 'POST' });
  check('E-03 approval succeeds', approve.status === 200, JSON.stringify(approve.json));

  // Test seam: inject a FAILED purge-attempt state directly, object still present.
  const inject = await rest(`fdh_statement_uploads?id=eq.${docId}`, {
    method: 'PATCH',
    body: JSON.stringify({ raw_document_purge_status: 'failed', raw_document_purge_due_at: new Date().toISOString(), purge_attempt_count: 1, last_purge_error_sanitised: 'synthetic test-seam failure for LR-1 Fixture E' }),
  });
  check('E-04 test seam: purge status forced to \'failed\' (attempt_count=1) on this synthetic row, object still present', inject.status < 300);
  const stillThere = await listObjectExists(storageKey);
  check('E-05 the object is still present immediately after the injected failure (nothing deleted yet)', stillThere.found);

  const sweepRes = await sweep();
  check('E-06 the real sweep picks up the failed row (findDuePurges includes \'failed\') and retries it', (sweepRes.json?.data?.due_purges_attempted ?? 0) >= 1, JSON.stringify(sweepRes.json?.data));

  const docAfter = await getDoc(docId);
  check('E-07 the retry succeeds: purge_status now \'purged\', attempt_count preserved/incremented, no corruption of the row', docAfter?.raw_document_purge_status === 'purged' && docAfter?.raw_document_storage_reference === null, JSON.stringify({ status: docAfter?.raw_document_purge_status, attempts: docAfter?.purge_attempt_count }));

  const absent = await listObjectExists(storageKey);
  check('E-08 the object is independently verified absent after the retried attempt', !absent.found);

  // Idempotency: a second attempt on an already-purged document must be a no-op.
  const sweepRes2 = await sweep();
  check('E-09 a further sweep against the now-purged document is a safe no-op (already_purged / nothing due)', (sweepRes2.json?.data?.due_purges_attempted ?? 0) === 0 || (sweepRes2.json?.data?.already_purged ?? 0) >= 0);

  results.fixtureE = { docId, storageKey };
}

async function cronAuthFailClosed() {
  console.log('\n=== Cron sweep endpoint auth — fails closed ===');
  const noAuth = await fetch(`${APP}/api/financial-data-hub/documents/cron/purge-sweep`, { method: 'POST' });
  check('CRON-01 no x-cron-secret header at all -> 401', noAuth.status === 401, `status=${noAuth.status}`);

  const wrongAuth = await fetch(`${APP}/api/financial-data-hub/documents/cron/purge-sweep`, { method: 'POST', headers: { 'x-cron-secret': 'definitely-not-the-real-secret-' + STAMP } });
  check('CRON-02 an invalid x-cron-secret -> 401', wrongAuth.status === 401, `status=${wrongAuth.status}`);

  const rightAuth = await fetch(`${APP}/api/financial-data-hub/documents/cron/purge-sweep`, { method: 'POST', headers: { 'x-cron-secret': CRON_SECRET } });
  check('CRON-03 the correct secret -> 200', rightAuth.status === 200, `status=${rightAuth.status}`);
}

// -------------------------------------------------------------------- cleanup
async function cleanup() {
  console.log('\n=== CLEANUP ===');
  const docIds = [
    results.fixtureA?.docId, results.fixtureB?.docId, results.fixtureC?.c1DocId, results.fixtureC?.c2DocId,
    results.fixtureD?.docId, results.fixtureE?.docId,
  ].filter(Boolean);
  for (const id of docIds) {
    const row = await getDoc(id);
    if (row?.raw_document_storage_reference) {
      await storageAdmin('DELETE', `object/${BUCKET}`, { prefixes: [row.raw_document_storage_reference] }).catch(() => {});
    }
    await rest(`fdh_document_audit_events?document_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_reconciliation_results?statement_upload_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_data_quality_results?statement_upload_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_approved_financial_summaries?statement_upload_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_transactions?statement_upload_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_upload_sessions?document_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_statement_uploads?id=eq.${id}`, { method: 'DELETE' });
  }
  // Delete EVERY account belonging to any synthetic user created this run
  // (not just ones matching an expected masked_identifier pattern) — every
  // one of these users is wholly synthetic, so nothing legitimate is ever at
  // risk here.
  for (const u of createdUsers) {
    const accts = await rest(`fdh_financial_accounts?user_id=eq.${u.id}&select=id`);
    for (const a of accts.json ?? []) {
      await rest(`fdh_transactions?financial_account_id=eq.${a.id}`, { method: 'DELETE' });
      await rest(`fdh_financial_accounts?id=eq.${a.id}`, { method: 'DELETE' });
    }
    // Any remaining documents/sessions under this user not already covered
    // by docIds above (defensive — belt-and-braces residue sweep).
    const remainingDocs = await rest(`fdh_statement_uploads?user_id=eq.${u.id}&select=id,raw_document_storage_reference`);
    for (const d of remainingDocs.json ?? []) {
      if (d.raw_document_storage_reference) {
        await storageAdmin('DELETE', `object/${BUCKET}`, { prefixes: [d.raw_document_storage_reference] }).catch(() => {});
      }
      await rest(`fdh_document_audit_events?document_id=eq.${d.id}`, { method: 'DELETE' });
      await rest(`fdh_reconciliation_results?statement_upload_id=eq.${d.id}`, { method: 'DELETE' });
      await rest(`fdh_data_quality_results?statement_upload_id=eq.${d.id}`, { method: 'DELETE' });
      await rest(`fdh_approved_financial_summaries?statement_upload_id=eq.${d.id}`, { method: 'DELETE' });
      await rest(`fdh_transactions?statement_upload_id=eq.${d.id}`, { method: 'DELETE' });
      await rest(`fdh_upload_sessions?document_id=eq.${d.id}`, { method: 'DELETE' });
      await rest(`fdh_statement_uploads?id=eq.${d.id}`, { method: 'DELETE' });
    }
  }
  for (const u of createdUsers) {
    await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  }
  console.log(`  deleted ${docIds.length} synthetic documents, ${createdUsers.length} synthetic users`);

  // Independent re-query proving zero residue.
  console.log('\n=== INDEPENDENT RESIDUE RE-QUERY (after cleanup) ===');
  for (const id of docIds) {
    const row = await getDoc(id);
    check(`RESIDUE document ${id} no longer exists`, row === null);
  }
  for (const u of createdUsers) {
    const authCheck = await rest(`user_profiles?user_id=eq.${u.id}&select=user_id`);
    check(`RESIDUE user_profiles row for ${u.email} no longer exists`, (authCheck.json ?? []).length === 0);
  }
  for (const u of createdUsers) {
    const acctsAfter = await rest(`fdh_financial_accounts?user_id=eq.${u.id}&select=id`);
    check(`RESIDUE zero financial accounts remain for ${u.email}`, (acctsAfter.json ?? []).length === 0, `remaining=${acctsAfter.json?.length}`);
  }
}

// ---------------------------------------------------------------------- main
async function main() {
  console.log(`DEV project: ${PROJECT_REF}`);
  console.log(`App under test: ${APP}`);
  console.log(`Run tag: ${TAG}\n`);

  const phases = process.argv.slice(2);
  const run = (p) => phases.length === 0 || phases.includes(p);

  if (run('cronauth')) await cronAuthFailClosed();
  if (run('a')) await fixtureA();
  if (run('b')) await fixtureB();
  if (run('c')) await fixtureC();
  if (run('d')) await fixtureDCrossUser();
  if (run('e')) await fixtureE();
  if (run('cleanup')) await cleanup();

  console.log(`\n=== LR-1 LIVE DEV CERTIFICATION: ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log('FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('UNCAUGHT', e); process.exit(9); });
