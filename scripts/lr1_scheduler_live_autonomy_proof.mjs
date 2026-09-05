// LR-1 Scheduler Closure — DEV-live AUTONOMOUS scheduler proof.
//
// NOT RUNNABLE YET. This script is prepared ahead of time so it is ready to
// run the moment migration 0128_lr1_document_purge_sweep_scheduler.sql has
// actually been pasted into the DEV Supabase SQL Editor by a human (with its
// placeholder URL replaced by a real, reachable DEV app origin, and the
// `lr1_purge_sweep_cron_secret` Vault secret created — see
// docs/financial-data-hub/LR1_SCHEDULER_CLOSURE_MIGRATION_READY.md). Running
// it before that point will simply time out with FAIL, which is the correct,
// honest outcome — it proves nothing was faked.
//
// WHAT THIS PROVES, AND WHY IT IS NOT A REPEAT OF PHASE 4: Phase 4
// (scripts/lr1_live_dev_certification.mjs) proved the purge-sweep ROUTE
// itself works correctly when invoked. It never proved anything about
// AUTONOMOUS, UNATTENDED invocation — every one of its sweeps was triggered
// by the script itself calling the route directly. This script deliberately
// NEVER calls the purge-sweep route. It creates one real, tagged, bounded
// synthetic document via the actual upload pipeline, backdates it (a
// disclosed, reversible test seam — the identical technique Phase 4's own
// Fixtures B and C2 used for the 60-minute predecessor of this backstop)
// so it is already past the 50-minute hard-backstop threshold, then does
// NOTHING further except POLL — on an interval, not sleep-and-hope — for up
// to ~12 minutes (comfortably covering at least two 5-minute cron ticks) to
// see whether something *else*, unprompted, purges it. If it disappears
// autonomously within that window, that is real, live proof the pg_cron /
// pg_net scheduler registered by migration 0128 is actually running this
// app's purge-sweep endpoint on its own cadence in DEV — not merely that the
// migration text parses.
//
// Run: node scripts/lr1_scheduler_live_autonomy_proof.mjs
// (No phase arguments — this script does one thing.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.env.LR1_APP ?? 'http://localhost:3501';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const MAX_WAIT_MS = 12 * 60_000; // ~12 minutes — at least two 5-minute cron ticks

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
const CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
const PROJECT_REF = new URL(URL_).host.split('.')[0];
if (PROJECT_REF !== CERTIFIED_DEV_PROJECT_REF) {
  console.error(`Refusing: NEXT_PUBLIC_SUPABASE_URL is not the certified DEV project (saw ${PROJECT_REF})`);
  process.exit(1);
}
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;
const BUCKET = 'fdh-source-documents';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const TAG = `lr1-scheduler-proof-${STAMP}`;

// NOTE: deliberately no import of, or call to,
// `/api/financial-data-hub/documents/cron/purge-sweep` anywhere in this file.

async function rest(pathAndQuery, opts = {}) {
  const headers = {
    apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
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
/** Independent absence check — a direct storage list() call, never inferred
 * from a DB status flip alone (mirrors Phase 4's own methodology). */
async function listObjectExists(storageKey) {
  const lastSlash = storageKey.lastIndexOf('/');
  const dir = storageKey.slice(0, lastSlash);
  const name = storageKey.slice(lastSlash + 1);
  const r = await storageAdmin('POST', `object/list/${BUCKET}`, { prefix: dir, search: name, limit: 10 });
  const found = Array.isArray(r.json) ? r.json.some((f) => f.name === name) : false;
  return { found, raw: r.json };
}
async function createUser() {
  const email = `${TAG}-a@fhip-test.invalid`;
  const password = `Lr1Proof!${STAMP}`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  if (!j.id) throw new Error(`could not create synthetic user: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  const prof = await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: 'LR1 Scheduler Proof',
      country_of_residence: 'AU',
      preferred_currency: 'AUD',
      onboarding_completed: true,
      employment_status: 'full_time_employed',
      profile_completion_percentage: 100,
      country_confirmed_at: now,
      country_source: 'USER_CONFIRMED',
      country_updated_at: now,
    }),
  });
  if (prof.status >= 300) throw new Error(`profile patch failed: ${prof.text.slice(0, 300)}`);
  const tok = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ email, password }),
  })).json();
  if (!tok.access_token) throw new Error(`sign-in failed: ${JSON.stringify(tok).slice(0, 300)}`);
  const session = {
    access_token: tok.access_token, token_type: tok.token_type, expires_in: tok.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + tok.expires_in,
    refresh_token: tok.refresh_token, user: tok.user,
  };
  const cookie = `${COOKIE_NAME}=base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`;
  return { id: j.id, email, cookie, accessToken: tok.access_token };
}
async function app(user, pathname, opts = {}) {
  const r = await fetch(`${APP}${pathname}`, {
    method: opts.method ?? 'GET',
    headers: { Cookie: user.cookie, 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body !== undefined ? (typeof opts.body === 'string' || opts.body instanceof Uint8Array ? opts.body : JSON.stringify(opts.body)) : undefined,
    redirect: opts.redirect ?? 'manual',
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, json, text };
}
async function getDoc(id) {
  const r = await rest(`fdh_statement_uploads?id=eq.${id}&select=*`);
  return r.json?.[0] ?? null;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  console.log(`DEV project: ${PROJECT_REF}`);
  console.log(`App under test (for the ORIGINAL upload only, never for the sweep itself): ${APP}`);
  console.log(`Run tag: ${TAG}`);
  console.log(
    'This script will NOT call the purge-sweep endpoint at any point. It will only ' +
    'create one bounded synthetic document, backdate it past the 50-minute hard ' +
    'backstop, then poll for autonomous disappearance.\n',
  );

  const user = await createUser();
  console.log(`Created synthetic user ${user.email} (${user.id})`);

  const csvPath = path.join(repoRoot, 'tests', 'fixtures', 'r7-bank-csv', 'au_cba_debit_credit.csv');
  const bytes = fs.readFileSync(csvPath);
  // country_code and currency_code are REQUIRED by bankCsvUploadMetadataSchema
  // (lib/financial-data-hub/validation/bankCsv.ts) — required since this
  // route's very first commit (473ca73, R7). This script predates being run
  // even once and omitted them, which is what produced the 422 "Required"
  // this fix addresses (see LR-1 diagnosis table). AU/AUD matches the fixture
  // CSV (au_cba_debit_credit.csv) and the synthetic user's own confirmed
  // country, exactly like every other AU fixture in this suite.
  const uploadRes = await app(
    user,
    '/api/financial-data-hub/bank-csv/upload?filename=lr1-scheduler-proof.csv&country_code=AU&currency_code=AUD',
    { method: 'POST', headers: { 'Content-Type': 'text/csv', 'Content-Length': String(bytes.byteLength) }, body: bytes },
  );
  // Route wraps its payload in `{ data: ... }` (lib/api.ts's `ok()`) and
  // returns snake_case `document_id` (see route.ts) — matching the access
  // pattern already used correctly by scripts/lr1_live_dev_certification.mjs.
  // This script's original `uploadRes.json?.documentId ?? uploadRes.json?.id`
  // never matched either shape and was a second, independent bug alongside
  // the missing country_code/currency_code query params (see LR-1 diagnosis
  // table) — it would have left docId undefined even once the 422 was fixed.
  const docId = uploadRes.json?.data?.document_id;
  if (uploadRes.status >= 300 || !docId) {
    console.error(`FAIL — upload did not succeed (status=${uploadRes.status}): ${uploadRes.text.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`Uploaded synthetic document ${docId}`);

  const before = await getDoc(docId);
  if (!before?.raw_document_storage_reference) {
    console.error('FAIL — uploaded document has no raw_document_storage_reference; cannot prove object deletion.');
    process.exit(1);
  }
  const objectExistsBefore = await listObjectExists(before.raw_document_storage_reference);
  if (!objectExistsBefore.found) {
    console.error('FAIL — raw object is not present in storage immediately after upload (unexpected precondition failure).');
    process.exit(1);
  }
  console.log(`Confirmed raw object present in storage: ${before.raw_document_storage_reference}`);

  // Backdate uploaded_at (and created_at, for the fallback path) 51 minutes
  // into the past — 1 minute past the new 50-minute hard backstop — so the
  // very next autonomous cron tick (<=5 minutes away) should already find it
  // due. This is the same disclosed, reversible test-seam technique Phase 4
  // used for the 60-minute predecessor (Fixtures B and C2).
  const backdatedIso = new Date(Date.now() - 51 * 60_000).toISOString();
  const backdatePatch = await rest(`fdh_statement_uploads?id=eq.${docId}`, {
    method: 'PATCH',
    body: JSON.stringify({ uploaded_at: backdatedIso, created_at: backdatedIso }),
  });
  if (backdatePatch.status >= 300) {
    console.error(`FAIL — could not backdate document: ${backdatePatch.text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`Backdated uploaded_at/created_at to ${backdatedIso} (51 minutes ago — past the 50-minute backstop)`);
  console.log(`Deliberately NOT calling purge-sweep. Polling every ${POLL_INTERVAL_MS / 1000}s for up to ${MAX_WAIT_MS / 60_000} minutes...\n`);

  const startedAt = Date.now();
  let purgedAutonomously = false;
  let lastStatus = null;
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    const doc = await getDoc(docId);
    lastStatus = doc?.raw_document_purge_status ?? '(row missing)';
    const stillPresent = doc?.raw_document_storage_reference
      ? (await listObjectExists(doc.raw_document_storage_reference)).found
      : false;
    console.log(`  [t=${elapsedMin}m] processing_status=${doc?.processing_status} raw_document_purge_status=${lastStatus} object_present=${stillPresent}`);
    if (doc?.raw_document_purge_status === 'purged' && !stillPresent) {
      purgedAutonomously = true;
      console.log(`\nPASS — raw object autonomously purged after ${elapsedMin} minutes, with no manual sweep call from this script.`);
      break;
    }
  }

  if (!purgedAutonomously) {
    console.error(
      `\nFAIL — document was NOT autonomously purged within ${MAX_WAIT_MS / 60_000} minutes ` +
      `(last raw_document_purge_status=${lastStatus}). This means either the migration has not ` +
      'been applied to DEV yet, the Vault secret / target URL are not both correctly set, or the ' +
      'scheduled job is not actually reaching this app. Nothing was faked or manually triggered ' +
      'to force a pass.',
    );
  }

  // Cleanup regardless of outcome — this document/user is wholly synthetic.
  console.log('\n=== CLEANUP ===');
  const finalDoc = await getDoc(docId);
  if (finalDoc?.raw_document_storage_reference) {
    await storageAdmin('DELETE', `object/${BUCKET}`, { prefixes: [finalDoc.raw_document_storage_reference] }).catch(() => {});
  }
  await rest(`fdh_document_audit_events?document_id=eq.${docId}`, { method: 'DELETE' });
  await rest(`fdh_reconciliation_results?statement_upload_id=eq.${docId}`, { method: 'DELETE' });
  await rest(`fdh_data_quality_results?statement_upload_id=eq.${docId}`, { method: 'DELETE' });
  await rest(`fdh_approved_financial_summaries?statement_upload_id=eq.${docId}`, { method: 'DELETE' });
  await rest(`fdh_transactions?statement_upload_id=eq.${docId}`, { method: 'DELETE' });
  await rest(`fdh_upload_sessions?document_id=eq.${docId}`, { method: 'DELETE' });
  await rest(`fdh_statement_uploads?id=eq.${docId}`, { method: 'DELETE' });
  await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  console.log('Cleanup complete.');

  process.exit(purgedAutonomously ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
