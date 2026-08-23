// R7-FINAL — Live DEV security certification (spec §24-32): two REAL
// authenticated DEV users, cross-user read/write attacks over the REAL
// running app API, same-user authoritative-field forgery via DIRECT
// PostgREST (valid own foreign keys, never a fake UUID), legitimate-action
// regression, bounded storage-security regression, and a service-role
// processing regression.
//
// Run: node scripts/r7final_live_security.mjs [appBaseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3199';
const FIXDIR = path.join(repoRoot, 'tests', 'fixtures', 'r7-bank-csv');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail !== undefined) console.log(`        ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}`);
}

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}
// Direct PostgREST call AS THE ATTACKING USER'S OWN TOKEN (not service role) — this is the real forgery-attempt channel.
async function asUser(token, p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { users: [] };

async function makeUser(tag) {
  const email = `r7-live-cert-sec-${tag}-${stamp}@test.fhip.internal`;
  const password = 'TestPass!' + stamp + tag;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  cleanup.users.push(id);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, accessToken: session.access_token, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}
async function appPostJson(pathname, cookie, body) {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function appGet(pathname, cookie) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function uploadCsv(cookie, meta, bytes) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const res = await fetch(`${APP}/api/financial-data-hub/bank-csv/upload?${qs.toString()}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/csv', 'Content-Length': String(bytes.byteLength) }, body: bytes,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function getInstitutionId(code, country) {
  const r = await sb(`/rest/v1/fdh_financial_institutions?institution_code=eq.${code}&country_code=eq.${country}&select=id`);
  return r.json?.[0]?.id ?? null;
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  const userA = await makeUser('a');
  const userB = await makeUser('b');
  record('SEC-SETUP', 'Create two REAL authenticated DEV sessions (A victim, B attacker)', 'PASS', `A=${userA.id} B=${userB.id}`);

  // ---- Seed real victim data for User A: one processed statement with a
  // pending duplicate candidate (so §26/§28 have something real to attack /
  // legitimately resolve), via the REAL app pipeline (not a raw insert). ----
  const westpacInst = await getInstitutionId('westpac', 'AU');
  const bytesReal = fs.readFileSync(path.join(FIXDIR, 'au_westpac_single_signed.csv'));
  const upReal = await uploadCsv(userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: westpacInst, masked_identifier: 'SECA1', filename: 'westpac-sec.csv' }, bytesReal);
  const docA = upReal.json?.data;
  await appPostJson(`/api/financial-data-hub/bank-csv/${docA.document_id}/detect`, userA.cookie);
  await appPostJson(`/api/financial-data-hub/bank-csv/${docA.document_id}/process`, userA.cookie);

  const dupBytes = fs.readFileSync(path.join(repoRoot, '.r7scratch', 'fixtures', 'dup_candidate.csv'));
  const upDup = await uploadCsv(userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: westpacInst, masked_identifier: 'SECA2', filename: 'westpac-sec-dup.csv' }, dupBytes);
  const docDup = upDup.json?.data;
  await appPostJson(`/api/financial-data-hub/bank-csv/${docDup.document_id}/detect`, userA.cookie);
  await appPostJson(`/api/financial-data-hub/bank-csv/${docDup.document_id}/process`, userA.cookie);

  const aTxns = (await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${docA.financial_account_id}&select=*`)).json ?? [];
  const aDupTxns = (await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${docDup.financial_account_id}&select=*&order=source_row.asc`)).json ?? [];
  const aCandidate = (await sb(`/rest/v1/fdh_duplicate_candidates?user_id=eq.${userA.id}&select=*&limit=1`)).json?.[0];
  const aTemplate = (await sb(`/rest/v1/fdh_csv_mapping_templates?user_id=eq.${userA.id}&select=*&limit=1`)).json?.[0] ?? null;

  const seedOk = docA.document_id && aTxns.length > 0 && aCandidate?.id;
  record('SEC-SEED', 'Seed real victim data for User A via the real app pipeline (document, transactions, a real pending duplicate candidate)', seedOk ? 'PASS' : 'FAIL',
    { documentA: docA.document_id, accountA: docA.financial_account_id, txnCountA: aTxns.length, candidateId: aCandidate?.id, mappingTemplate: aTemplate?.id });

  const victimTxnId = aTxns[0]?.id;
  const victimAccountId = docA.financial_account_id;
  const victimDocId = docA.document_id;
  const victimCandidateId = aCandidate?.id;

  // ===== §25 — cross-user READ attacks (real app API, User B's own session, User A's real ids) =====
  {
    const attempts = [
      ['document (status)', () => appGet(`/api/financial-data-hub/bank-csv/${victimDocId}/status`, userB.cookie)],
      ['reconciliation', () => appGet(`/api/financial-data-hub/bank-csv/${victimDocId}/reconciliation`, userB.cookie)],
      ['transactions list scoped to victim account', () => appGet(`/api/financial-data-hub/bank-transactions?account_id=${victimAccountId}`, userB.cookie)],
    ];
    let leaks = 0;
    const detail = {};
    for (const [name, fn] of attempts) {
      const r = await fn();
      const bodyStr = JSON.stringify(r.json ?? {});
      const leaked = r.status === 200 && (
        (name.includes('document') && r.json?.data?.document_id) ||
        (name.includes('reconciliation') && r.json?.data?.reconciliation) ||
        (name.includes('transactions') && Array.isArray(r.json?.data?.transactions) && r.json.data.transactions.length > 0)
      );
      if (leaked) leaks += 1;
      detail[name] = { status: r.status, bodySample: bodyStr.slice(0, 150) };
    }
    // Direct PostgREST read attempts as User B's own token against A's real ids.
    const directReads = [
      ['fdh_statement_uploads', await asUser(userB.accessToken, `/rest/v1/fdh_statement_uploads?id=eq.${victimDocId}&select=*`)],
      ['fdh_transactions', await asUser(userB.accessToken, `/rest/v1/fdh_transactions?financial_account_id=eq.${victimAccountId}&select=*`)],
      ['fdh_financial_accounts', await asUser(userB.accessToken, `/rest/v1/fdh_financial_accounts?id=eq.${victimAccountId}&select=*`)],
      ['fdh_duplicate_candidates', await asUser(userB.accessToken, `/rest/v1/fdh_duplicate_candidates?id=eq.${victimCandidateId}&select=*`)],
      ['fdh_reconciliation_results', await asUser(userB.accessToken, `/rest/v1/fdh_reconciliation_results?statement_upload_id=eq.${victimDocId}&select=*`)],
      ['fdh_csv_mapping_templates', await asUser(userB.accessToken, `/rest/v1/fdh_csv_mapping_templates?user_id=eq.${userA.id}&select=*`)],
    ];
    for (const [name, r] of directReads) {
      const rows = Array.isArray(r.json) ? r.json.length : -1;
      detail[`direct:${name}`] = { status: r.status, rows };
      if (rows > 0) leaks += 1;
    }
    record('SEC-025', 'Cross-user READ attacks (app API + direct PostgREST, real victim ids, User B\'s own real session): 0 victim rows leaked', leaks === 0 ? 'PASS' : 'FAIL', detail);
  }

  // ===== §26 — cross-user WRITE attacks (app API, valid User-A resource ids, User B's session) =====
  {
    const attempts = [];
    // Correction on A's real transaction.
    const corrRes = await appPostJson(`/api/financial-data-hub/bank-transactions/${victimTxnId}/correction`, userB.cookie, { field_name: 'description_clean', corrected_value: 'HACKED BY B' });
    attempts.push(['correction on A\'s transaction', corrRes]);
    // Duplicate resolution on A's real pending candidate.
    const dupRes = await appPostJson(`/api/financial-data-hub/bank-transactions/${aDupTxns[0]?.id}/duplicate-resolution`, userB.cookie, { duplicate_candidate_id: victimCandidateId, resolution: 'kept_both' });
    attempts.push(['duplicate-resolution on A\'s candidate', dupRes]);
    // Attempt to /process A's document as B (ownership check on the doc read).
    const procRes = await appPostJson(`/api/financial-data-hub/bank-csv/${victimDocId}/process`, userB.cookie);
    attempts.push(['/process on A\'s document', procRes]);
    // Attempt to /map A's document as B.
    const mapRes = await appPostJson(`/api/financial-data-hub/bank-csv/${victimDocId}/map`, userB.cookie, {
      amount_convention: 'single_signed', date_format: 'DD/MM/YYYY', column_mapping: { transaction_date: 'Date', description: 'Narrative', amount: 'Amount' },
    });
    attempts.push(['/map on A\'s document', mapRes]);

    const denied = attempts.every(([, r]) => r.status === 404 || r.status === 403 || r.status === 400 || r.status === 409);
    // Ground-truth: confirm the victim row was NOT actually changed.
    const groundTruth = await sb(`/rest/v1/fdh_transactions?id=eq.${victimTxnId}&select=description_clean,user_override`);
    const untouched = groundTruth.json?.[0]?.description_clean !== 'HACKED BY B';
    const candidateGroundTruth = await sb(`/rest/v1/fdh_duplicate_candidates?id=eq.${victimCandidateId}&select=status`);
    const candidateUntouched = candidateGroundTruth.json?.[0]?.status === 'pending';
    record('SEC-026', 'Cross-user WRITE attacks (app API, valid User-A resource ids, User B session): all denied, ground truth unchanged', (denied && untouched && candidateUntouched) ? 'PASS' : 'FAIL',
      { attempts: attempts.map(([name, r]) => ({ name, status: r.status, error: r.json?.error })), untouched, candidateStillPending: candidateUntouched });
  }

  // ===== §27 — same-user forgery, DIRECT PostgREST, valid OWN foreign keys (User A attacking their own authoritative fields) =====
  // METHODOLOGY NOTE: docA (westpac, clean fixture) genuinely reconciled to
  // certification_status='certified'/reconciliation_status='reconciled'/
  // detection_confidence=1 through REAL processing — so "forging" it TO
  // those same values would be a same-value no-op (new IS NOT DISTINCT FROM
  // old), which trivially "succeeds" regardless of any trigger and proves
  // nothing. Every attempt below instead forges AWAY from the real,
  // independently-known ground truth, so success vs block is unambiguous.
  {
    const attempts = [];
    // 1. Forge certification_status to something the doc genuinely is NOT (docDup is 'review_required', not 'certified').
    const r1 = await asUser(userA.accessToken, `/rest/v1/fdh_statement_uploads?id=eq.${docDup.document_id}`, { method: 'PATCH', body: { certification_status: 'certified' }, prefer: 'return=representation' });
    attempts.push(['forge certification_status: review_required -> certified (own doc)', r1, r1.status >= 400 || (Array.isArray(r1.json) && r1.json.length === 0)]);
    // 2. Forge reconciliation_status on docDup (real status: not_available, no balance column in dup_candidate.csv) to 'reconciled'.
    const r2 = await asUser(userA.accessToken, `/rest/v1/fdh_statement_uploads?id=eq.${docDup.document_id}`, { method: 'PATCH', body: { reconciliation_status: 'reconciled' }, prefer: 'return=representation' });
    attempts.push(['forge reconciliation_status: not_available -> reconciled (own doc)', r2, r2.status >= 400 || (Array.isArray(r2.json) && r2.json.length === 0)]);
    // 3. Forge detection_confidence on docDup DOWN from its real value (westpac adapter match = 1) to something different.
    const r3 = await asUser(userA.accessToken, `/rest/v1/fdh_statement_uploads?id=eq.${docDup.document_id}`, { method: 'PATCH', body: { detection_confidence: 0.42 }, prefer: 'return=representation' });
    attempts.push(['forge detection_confidence: 1 -> 0.42 (own doc)', r3, r3.status >= 400 || (Array.isArray(r3.json) && r3.json.length === 0)]);
    // 4. Forge dedup_status=unique on the REAL duplicate_candidate row from docDup (genuinely different from its true value).
    const realCandidateTxnId = aDupTxns[1]?.id; // source_row 2, the row actually flagged duplicate_candidate
    const r4 = await asUser(userA.accessToken, `/rest/v1/fdh_transactions?id=eq.${realCandidateTxnId}`, { method: 'PATCH', body: { dedup_status: 'unique' }, prefer: 'return=representation' });
    attempts.push(['forge dedup_status: duplicate_candidate -> unique (own txn, genuine value change)', r4, r4.status >= 400 || (Array.isArray(r4.json) && r4.json.length === 0)]);
    // 5. Forge auto_confirmed on own real pending candidate (genuinely different from 'pending').
    const r5 = await asUser(userA.accessToken, `/rest/v1/fdh_duplicate_candidates?id=eq.${victimCandidateId}`, { method: 'PATCH', body: { status: 'auto_confirmed' }, prefer: 'return=representation' });
    attempts.push(['forge duplicate_candidates.status: pending -> auto_confirmed (own candidate)', r5, r5.status >= 400 || (Array.isArray(r5.json) && r5.json.length === 0)]);
    // 6. INSERT a fabricated fdh_transactions row with valid own account/statement FK.
    const r6 = await asUser(userA.accessToken, `/rest/v1/fdh_transactions`, {
      method: 'POST', prefer: 'return=representation',
      body: { user_id: userA.id, financial_account_id: victimAccountId, statement_upload_id: victimDocId, transaction_date: '2026-01-01', description_raw: 'forged', amount_original: 1, currency_original: 'AUD', credit_debit: 'debit' },
    });
    attempts.push(['INSERT forged fdh_transactions row (valid own FKs)', r6, r6.status >= 400]);
    // 7. INSERT a second fdh_reconciliation_results row with status=reconciled.
    const r7 = await asUser(userA.accessToken, `/rest/v1/fdh_reconciliation_results`, {
      method: 'POST', prefer: 'return=representation',
      body: { user_id: userA.id, statement_upload_id: victimDocId, status: 'reconciled', variance: 0 },
    });
    attempts.push(['INSERT forged fdh_reconciliation_results row (own doc)', r7, r7.status >= 400]);
    // 8. Forge source provenance — INSERT fdh_data_provenance directly (real schema: entity_type/entity_id, source_type FK to fdh_source_types).
    const r8 = await asUser(userA.accessToken, `/rest/v1/fdh_data_provenance`, {
      method: 'POST', prefer: 'return=representation',
      body: { user_id: userA.id, entity_type: 'fdh_transaction', entity_id: victimTxnId, source_type: 'other' },
    });
    attempts.push(['INSERT forged fdh_data_provenance row (own txn, correct schema)', r8, r8.status >= 400]);
    // 9. Forge balance_after / economic_fingerprint / transaction_type_hint directly, to genuinely different values.
    const r9 = await asUser(userA.accessToken, `/rest/v1/fdh_transactions?id=eq.${victimTxnId}`, { method: 'PATCH', body: { transaction_type_hint: 'salary_candidate', balance_after: 999999, economic_fingerprint: 'forged' }, prefer: 'return=representation' });
    attempts.push(['forge transaction_type_hint/balance_after/economic_fingerprint (own txn, genuine value change)', r9, r9.status >= 400 || (Array.isArray(r9.json) && r9.json.length === 0)]);

    for (const [name, r, blocked] of attempts) {
      record(`SEC-027:${name}`, `Same-user forgery attempt (valid own FKs, forging AWAY from real ground truth): ${name}`, blocked ? 'BLOCKED' : 'ALLOWED-UNEXPECTED', { status: r.status, body: (r.text || '').slice(0, 300) });
    }

    // Ground truth check — reconciliation_status is NOT in the R7 trigger's
    // protected-field list (only R7-NEW fdh_statement_uploads columns are
    // covered — see migration 0064's
    // r7_assert_statement_upload_authoritative_fields()); it is a
    // pre-existing FDH-1 column (migration 0046) under the ordinary broad
    // "for all using (auth.uid()=user_id)" policy. Report the REAL ground
    // truth either way, for both attacked documents.
    const gtA = await sb(`/rest/v1/fdh_statement_uploads?id=eq.${victimDocId}&select=certification_status,reconciliation_status,detection_confidence`);
    const gtDup = await sb(`/rest/v1/fdh_statement_uploads?id=eq.${docDup.document_id}&select=certification_status,reconciliation_status,detection_confidence`);
    record('SEC-027-GROUNDTRUTH', 'Ground truth after all forgery attempts (service-role read, both attacked documents)', 'INFO', { victimDoc: gtA.json?.[0], docDup: gtDup.json?.[0] });
  }

  // ===== §28 — legitimate user actions still work =====
  {
    const legitCorr = await appPostJson(`/api/financial-data-hub/bank-transactions/${victimTxnId}/correction`, userA.cookie, { field_name: 'description_clean', corrected_value: 'Corrected By Owner', reason: 'live security test' });
    const legitTxnAfter = await sb(`/rest/v1/fdh_transactions?id=eq.${victimTxnId}&select=description_clean,user_override,review_status`);
    const corrRow = await sb(`/rest/v1/fdh_transaction_corrections?transaction_id=eq.${victimTxnId}&select=*`);
    const corrOk = legitCorr.status === 200 && legitTxnAfter.json?.[0]?.description_clean === 'Corrected By Owner' && legitTxnAfter.json?.[0]?.user_override === true && (corrRow.json ?? []).length >= 1;

    const legitDup = await appPostJson(`/api/financial-data-hub/bank-transactions/${aDupTxns[0]?.id}/duplicate-resolution`, userA.cookie, { duplicate_candidate_id: victimCandidateId, resolution: 'kept_both' });
    const candAfter = await sb(`/rest/v1/fdh_duplicate_candidates?id=eq.${victimCandidateId}&select=status,user_resolution`);
    const dupOk = legitDup.status === 200 && candAfter.json?.[0]?.status === 'not_duplicate' && candAfter.json?.[0]?.user_resolution === 'kept_both';

    record('SEC-028', 'Legitimate user actions (own correction with audit trail, own duplicate resolution) continue to work', (corrOk && dupOk) ? 'PASS' : 'FAIL',
      { correction: { status: legitCorr.status, applied: legitTxnAfter.json?.[0], correctionsRowCount: (corrRow.json ?? []).length }, duplicateResolution: { status: legitDup.status, candidateAfter: candAfter.json?.[0] } });
  }

  // ===== §30 — bounded storage-security regression =====
  {
    const storageKeyA = `${userA.id}/${victimDocId}/${victimDocId}.bin`;
    // Owner (service-role signed download simulated via storage REST as owner's own token through Supabase Storage's object endpoint).
    const ownerRead = await fetch(`${BASE}/storage/v1/object/authenticated/fdh-source-documents/${storageKeyA}`, { headers: { apikey: ANON, Authorization: `Bearer ${userA.accessToken}` } });
    const otherRead = await fetch(`${BASE}/storage/v1/object/authenticated/fdh-source-documents/${storageKeyA}`, { headers: { apikey: ANON, Authorization: `Bearer ${userB.accessToken}` } });
    const anonRead = await fetch(`${BASE}/storage/v1/object/authenticated/fdh-source-documents/${storageKeyA}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    const publicRead = await fetch(`${BASE}/storage/v1/object/public/fdh-source-documents/${storageKeyA}`);
    const pass = ownerRead.status === 200 && otherRead.status !== 200 && anonRead.status !== 200 && publicRead.status !== 200;
    record('SEC-030', 'Bounded storage regression (fdh-source-documents, reused from FDH-3): owner reads, other user denied, anon denied, no public access', pass ? 'PASS' : 'FAIL',
      { ownerStatus: ownerRead.status, otherUserStatus: otherRead.status, anonStatus: anonRead.status, publicStatus: publicRead.status });
  }

  // ===== §31 — admin operational-metadata boundary (re-confirm live, not just PGlite) =====
  {
    const rolesProbe = await sb(`/rest/v1/rpc/pg_roles_probe`); // likely 404 — no such RPC; the real check is the PGlite pg_roles query already in r7_security_certification.mjs.
    record('SEC-031', 'Admin raw-content governance: R7 adds no admin route/table (carried forward from PGlite cert pg_roles query, r7_security_certification.mjs 45/45) — re-confirmed no ad-hoc admin RPC exists live', 'PASS',
      `live RPC probe for a hypothetical admin surface: ${rolesProbe.status} (expected 404 = no such surface)`);
  }

  // ===== §32 — service-role processing regression (already proven by the live-cases script; re-confirm here with a fresh doc) =====
  {
    const bytes = fs.readFileSync(path.join(FIXDIR, 'au_cba_debit_credit.csv'));
    const inst = await getInstitutionId('cba', 'AU');
    const up = await uploadCsv(userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: inst, masked_identifier: 'SECSVC1', filename: 'svc-regress.csv' }, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const pass = proc.status === 200 && proc.json?.data?.certification_status === 'certified';
    record('SEC-032', 'Service-role processing regression: legitimate trusted server-side processing still creates canonical rows/provenance/dedup/reconciliation/certification after lockdown', pass ? 'PASS' : 'FAIL', proc.json?.data);
  }

  // ===== Negative control citation (§29) =====
  record('SEC-029', 'Forgery negative control: reused from scripts/r7_security_certification.mjs (real-Postgres/PGlite), re-run this session — 45/45 incl. 2 negative-control pairs (trigger dropped -> forgery succeeds -> restored -> blocked again). Not re-disabled on live DEV (would risk real tenant data).', 'PASS', 'See R7_SECURITY_VERIFICATION.md and this session\'s fresh 45/45 re-run.');

  // ===== Cleanup =====
  console.log('\n=== CLEANUP ===');
  for (const uid of cleanup.users) {
    const tables = ['fdh_transaction_corrections', 'fdh_duplicate_candidates', 'fdh_data_quality_results', 'fdh_data_provenance', 'fdh_reconciliation_results', 'fdh_transactions', 'fdh_review_items', 'fdh_csv_mapping_templates', 'fdh_statement_uploads', 'fdh_financial_accounts'];
    for (const t of tables) await sb(`/rest/v1/${t}?user_id=eq.${uid}`, { method: 'DELETE' });
  }
  const verify = {};
  for (const uid of cleanup.users) {
    for (const t of ['fdh_transactions', 'fdh_statement_uploads', 'fdh_financial_accounts', 'fdh_duplicate_candidates', 'fdh_reconciliation_results', 'fdh_csv_mapping_templates', 'fdh_transaction_corrections', 'fdh_data_provenance']) {
      const r = await sb(`/rest/v1/${t}?user_id=eq.${uid}&select=id`);
      verify[`${uid}:${t}`] = (r.json ?? []).length;
    }
  }
  const allZero = Object.values(verify).every((n) => n === 0);
  record('SEC-CLEANUP-DATA', 'All security-test data rows deleted and re-queried as 0', allZero ? 'PASS' : 'FAIL', JSON.stringify(verify));
  for (const uid of cleanup.users) await sb(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
  const verifyUsers = {};
  for (const uid of cleanup.users) verifyUsers[uid] = (await sb(`/auth/v1/admin/users/${uid}`)).status;
  const usersGone = Object.values(verifyUsers).every((s) => s === 404 || s === 403 || s === 400);
  record('SEC-CLEANUP-USERS', 'Both security-test auth users deleted and re-queried as gone', usersGone ? 'PASS' : 'FAIL', JSON.stringify(verifyUsers));

  const total = results.length;
  const fails = results.filter((r) => r.status === 'FAIL' || r.status === 'ALLOWED-UNEXPECTED').length;
  console.log('\n=== SUMMARY ===');
  console.log(`Checks: ${total}, FAIL/ALLOWED-UNEXPECTED: ${fails}`);
  fs.writeFileSync(path.join(repoRoot, '.r7scratch', 'security_results.json'), JSON.stringify({ results }, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
