// R7-FINAL — Live DEV certification: the 15 LIVE-R7-DEV cases, 10
// independent live reconciliations, and several boundary checks (§33-37).
//
// Talks to: (a) the real running Next.js app (http://localhost:3199 by
// default) for every user-facing action, (b) the real DEV Supabase project
// via its REST API with the service-role key for ground-truth verification
// and cleanup ONLY (never used to fake a user action). Independent
// expectations come from scripts/r7_independent_bank_csv_oracle.py, invoked
// as a real subprocess per fixture -- this script never imports any
// production TypeScript.
//
// Run: node scripts/r7final_live_dev_certification.mjs [appBaseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3199';
const FIXDIR_ORIG = path.join(repoRoot, 'tests', 'fixtures', 'r7-bank-csv');
const FIXDIR_NEW = path.join(repoRoot, '.r7scratch', 'fixtures');

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
function record(id, description, status, detail, extra = {}) {
  results.push({ id, description, status, detail, ...extra });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail !== undefined) console.log(`        ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
}

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { users: [], userEmails: [] };

async function makeUser(tag) {
  const email = `r7-live-cert-${tag}-${stamp}@test.fhip.internal`;
  const password = 'TestPass!' + stamp + tag;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  cleanup.users.push(id);
  cleanup.userEmails.push(email);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, session, accessToken: session.access_token, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function appGet(pathname, cookie) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function appPostJson(pathname, cookie, body) {
  const res = await fetch(`${APP}${pathname}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function uploadCsv(cookie, meta, bytes, contentType = 'text/csv') {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const res = await fetch(`${APP}/api/financial-data-hub/bank-csv/upload?${qs.toString()}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) }, body: bytes,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

function readFixtureBytes(name, dir = FIXDIR_ORIG) {
  return fs.readFileSync(path.join(dir, name));
}
function runOracle(csvName, profileName, dir = FIXDIR_ORIG) {
  const csvPath = path.join(dir, csvName);
  const profilePath = path.join(dir, profileName);
  const out = execFileSync('python', [path.join(repoRoot, 'scripts', 'r7_independent_bank_csv_oracle.py'), csvPath, profilePath], { encoding: 'utf8' });
  return JSON.parse(out);
}

async function getInstitutionId(code, country) {
  const r = await sb(`/rest/v1/fdh_financial_institutions?institution_code=eq.${code}&country_code=eq.${country}&select=id`);
  return r.json?.[0]?.id ?? null;
}

async function getTransactions(financialAccountId) {
  // Paginated read (Range header, 1000 rows/page) — a naive single-shot
  // PostgREST query silently caps at the project's default page size, which
  // would falsely look like row loss on the >1000-row live case. This
  // mirrors the same pagination discipline the app's own
  // bank-csv/pagination.ts uses internally, but reimplemented here
  // independently of that file.
  const PAGE = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const res = await fetch(`${BASE}/rest/v1/fdh_transactions?financial_account_id=eq.${financialAccountId}&select=*&order=source_row.asc`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Range: `${from}-${from + PAGE - 1}`, Prefer: 'count=exact' },
    });
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all = all.concat(page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
async function getDocument(documentId) {
  const r = await sb(`/rest/v1/fdh_statement_uploads?id=eq.${documentId}&select=*`);
  return r.json?.[0] ?? null;
}
async function getReconciliation(documentId) {
  const r = await sb(`/rest/v1/fdh_reconciliation_results?statement_upload_id=eq.${documentId}&select=*&order=created_at.desc&limit=1`);
  return r.json?.[0] ?? null;
}
async function getDuplicateCandidates(userId, txnIds) {
  const r = await sb(`/rest/v1/fdh_duplicate_candidates?user_id=eq.${userId}&select=*`);
  const all = r.json ?? [];
  return all.filter((c) => txnIds.includes(c.transaction_id_a) || txnIds.includes(c.transaction_id_b));
}

function num(x) { return x === null || x === undefined ? null : Number(x); }
function eqMoney(a, b, tol = 0.0001) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(Number(a) - Number(b)) <= tol;
}

// Reconciliation ledger: every doc we independently verify (spec §23 — 10 of 15).
const reconciliationLedger = [];
function recordIndependentReconciliation(caseId, documentId, oracleRecon, dbRecon, note) {
  const fields = ['status', 'opening_balance', 'extracted_credits', 'extracted_debits', 'expected_closing_balance', 'reported_closing_balance', 'variance'];
  const diffs = [];
  for (const f of fields) {
    const oVal = oracleRecon[f === 'opening_balance' ? 'opening_balance' : f];
    const dVal = dbRecon ? dbRecon[f] : null;
    if (f === 'status') {
      if (oVal !== dVal) diffs.push(`${f}: oracle=${oVal} db=${dVal}`);
    } else {
      if (!eqMoney(oVal === null ? null : Number(oVal), dVal === null ? null : Number(dVal))) diffs.push(`${f}: oracle=${oVal} db=${dVal}`);
    }
  }
  reconciliationLedger.push({ caseId, documentId, note, diffs, pass: diffs.length === 0, oracle: oracleRecon, db: dbRecon });
  record(`RECON-${caseId}`, `Independent reconciliation: ${note}`, diffs.length === 0 ? 'PASS' : 'FAIL', diffs.length ? diffs.join('; ') : `status=${dbRecon?.status} variance=${dbRecon?.variance}`);
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  // ===== Setup ==============================================================
  const userA = await makeUser('a');
  const userB = await makeUser('b');
  record('SETUP', 'Create two dedicated live-cert test users (A, B)', 'PASS', `A=${userA.id} (${userA.email}) B=${userB.id} (${userB.email})`);

  const inst = {
    cba: await getInstitutionId('cba', 'AU'),
    westpac: await getInstitutionId('westpac', 'AU'),
    nab: await getInstitutionId('nab', 'AU'),
    sbi: await getInstitutionId('sbi', 'IN'),
    hdfc: await getInstitutionId('hdfc_bank', 'IN'),
    icici: await getInstitutionId('icici_bank', 'IN'),
  };
  record('SETUP-INST', 'Resolve live institution ids for adapters under test', Object.values(inst).every(Boolean) ? 'PASS' : 'FAIL', JSON.stringify(inst));

  const caseDocs = {}; // caseId -> { documentId, financialAccountId, userId, userTag }

  // ===== LIVE-R7-001 — exact re-import =====================================
  {
    const bytes = readFixtureBytes('au_nab_debit_credit.csv');
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.nab, masked_identifier: 'R7C001', filename: 'nab-001.csv' };
    const up1 = await uploadCsv(userA.cookie, meta, bytes);
    const doc1 = up1.json?.data;
    const det1 = await appPostJson(`/api/financial-data-hub/bank-csv/${doc1.document_id}/detect`, userA.cookie);
    const proc1 = await appPostJson(`/api/financial-data-hub/bank-csv/${doc1.document_id}/process`, userA.cookie);
    const acctId = doc1.financial_account_id;

    const up2 = await uploadCsv(userA.cookie, meta, bytes);
    const doc2 = up2.json?.data;
    const det2 = await appPostJson(`/api/financial-data-hub/bank-csv/${doc2.document_id}/detect`, userA.cookie);
    const proc2 = await appPostJson(`/api/financial-data-hub/bank-csv/${doc2.document_id}/process`, userA.cookie);

    const oracle = runOracle('au_nab_debit_credit.csv', 'au_nab_debit_credit.profile.json');
    const txns = await getTransactions(acctId);
    const pass =
      up1.status === 200 && det1.status === 200 && proc1.status === 200 &&
      up2.status === 200 && det2.status === 200 && proc2.status === 200 &&
      proc1.json?.data?.transactions_created === oracle.parsed_row_count &&
      proc2.json?.data?.transactions_created === 0 &&
      txns.length === oracle.parsed_row_count;
    record('LIVE-R7-001', 'Exact re-import: 2nd import adds 0 new economic transactions', pass ? 'PASS' : 'FAIL',
      { firstCreated: proc1.json?.data?.transactions_created, secondCreated: proc2.json?.data?.transactions_created, secondDuplicatesSkipped: proc2.json?.data?.duplicates_skipped, persistedCount: txns.length, oracleExpected: oracle.parsed_row_count });
    caseDocs['001'] = { documentId: doc1.document_id, financialAccountId: acctId, userId: userA.id };
    recordIndependentReconciliation('001', doc1.document_id, oracle.reconciliation, await getReconciliation(doc1.document_id), 'NAB exact-import fixture (first import)');
  }

  // ===== LIVE-R7-002 — overlapping statements ==============================
  {
    const bytesA = fs.readFileSync(path.join(FIXDIR_NEW, 'overlap_stmt_a.csv'));
    const bytesB = fs.readFileSync(path.join(FIXDIR_NEW, 'overlap_stmt_b.csv'));
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.nab, masked_identifier: 'R7C002', filename: 'overlap.csv' };
    const upA = await uploadCsv(userA.cookie, meta, bytesA);
    const docA = upA.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${docA.document_id}/detect`, userA.cookie);
    const procA = await appPostJson(`/api/financial-data-hub/bank-csv/${docA.document_id}/process`, userA.cookie);
    const acctId = docA.financial_account_id;

    const upB = await uploadCsv(userA.cookie, meta, bytesB);
    const docB = upB.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${docB.document_id}/detect`, userA.cookie);
    const procB = await appPostJson(`/api/financial-data-hub/bank-csv/${docB.document_id}/process`, userA.cookie);

    const txns = await getTransactions(acctId);
    const oracleA = runOracle('overlap_stmt_a.csv', 'overlap_stmt_a.profile.json', FIXDIR_NEW);
    const oracleB = runOracle('overlap_stmt_b.csv', 'overlap_stmt_b.profile.json', FIXDIR_NEW);
    // Expected total economic rows = A's 4 + B's 2 genuinely-new (Feb) rows = 6.
    const expectedTotal = 6;
    const pass = procA.json?.data?.transactions_created === 4 && procB.json?.data?.transactions_created === 2 &&
      procB.json?.data?.duplicates_skipped === 3 && txns.length === expectedTotal;
    record('LIVE-R7-002', 'Overlapping statements: only genuinely-new rows counted once', pass ? 'PASS' : 'FAIL',
      { aCreated: procA.json?.data?.transactions_created, bCreated: procB.json?.data?.transactions_created, bDuplicatesSkipped: procB.json?.data?.duplicates_skipped, persistedTotal: txns.length, expectedTotal });
    caseDocs['002'] = { documentId: docB.document_id, financialAccountId: acctId, userId: userA.id };
    // R7's own reconciliation for document B is scoped to the NON-duplicate
    // accepted transactions of THAT processing run (spec's own reconciliation
    // methodology: "the set of non-duplicate-confirmed accepted
    // transactions") — i.e. only the 2 genuinely-new Feb rows, not all 5
    // parsed rows of the B file (3 of which are recognised duplicates and
    // correctly excluded). Independently recomputed here inline (own
    // from-scratch arithmetic, not the oracle script, since the oracle
    // operates on a whole fixture file rather than a dedup-filtered subset):
    // new rows = Woolworths debit 60.00 (bal 2824.02), Salary credit 2000.00
    // (bal 4824.02). opening = 2824.02 - (-60.00) = 2884.02.
    const openingIndep = 2824.02 + 60.0;
    const expectedClosingIndep = openingIndep + 2000.0 - 60.0;
    const indepRecon = {
      status: 'reconciled',
      opening_balance: openingIndep.toFixed(4),
      extracted_credits: '2000.0000',
      extracted_debits: '60.0000',
      expected_closing_balance: expectedClosingIndep.toFixed(4),
      reported_closing_balance: '4824.0200',
      variance: '0.0000',
    };
    recordIndependentReconciliation('002', docB.document_id, indepRecon, await getReconciliation(docB.document_id), 'Overlapping statement B — independently recomputed over ONLY the 2 genuinely-new (non-duplicate) rows, matching R7\'s own documented reconciliation scope');
  }

  // ===== LIVE-R7-003 — debit/credit columns (CBA) ==========================
  {
    const bytes = readFixtureBytes('au_cba_debit_credit.csv');
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.cba, masked_identifier: 'R7C003', filename: 'cba-003.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const txns = await getTransactions(doc.financial_account_id);
    const oracle = runOracle('au_cba_debit_credit.csv', 'au_cba_debit_credit.profile.json');
    let pass = txns.length === oracle.parsed_row_count;
    const diffs = [];
    for (let i = 0; i < oracle.accepted.length; i++) {
      const o = oracle.accepted[i]; const t = txns.find((x) => x.source_row === o.row);
      if (!t) { diffs.push(`row ${o.row} missing`); continue; }
      if (!eqMoney(t.amount_original, o.amount)) diffs.push(`row ${o.row} amount ${t.amount_original} != ${o.amount}`);
      if (t.credit_debit !== o.direction) diffs.push(`row ${o.row} direction ${t.credit_debit} != ${o.direction}`);
      if (t.transaction_date !== o.date) diffs.push(`row ${o.row} date ${t.transaction_date} != ${o.date}`);
    }
    pass = pass && diffs.length === 0;
    record('LIVE-R7-003', 'Debit/Credit columns (CBA): exact canonical signed amounts, credit positive/debit magnitude+flag', pass ? 'PASS' : 'FAIL', diffs.length ? diffs.join('; ') : `${txns.length} rows verified against oracle`);
    caseDocs['003'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id };
    recordIndependentReconciliation('003', doc.document_id, oracle.reconciliation, await getReconciliation(doc.document_id), 'CBA debit/credit fixture');
  }

  // ===== LIVE-R7-004 — single signed amount (Westpac) ======================
  {
    const bytes = readFixtureBytes('au_westpac_single_signed.csv');
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.westpac, masked_identifier: 'R7C004', filename: 'westpac-004.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const txns = await getTransactions(doc.financial_account_id);
    const oracle = runOracle('au_westpac_single_signed.csv', 'au_westpac_single_signed.profile.json');
    const diffs = [];
    for (const o of oracle.accepted) {
      const t = txns.find((x) => x.source_row === o.row);
      if (!t) { diffs.push(`row ${o.row} missing`); continue; }
      if (!eqMoney(t.amount_original, o.amount)) diffs.push(`row ${o.row} amount ${t.amount_original} != ${o.amount}`);
      if (t.credit_debit !== o.direction) diffs.push(`row ${o.row} direction ${t.credit_debit} != ${o.direction}`);
    }
    // Cross-check against 003: same sign convention (magnitude-always-positive + explicit direction column).
    const pass = diffs.length === 0 && txns.every((t) => Number(t.amount_original) > 0);
    record('LIVE-R7-004', 'Single-signed amount (Westpac): normalizes to the SAME canonical sign convention as R7-003', pass ? 'PASS' : 'FAIL', diffs.length ? diffs.join('; ') : `${txns.length} rows verified, all amount_original > 0, direction carried separately`);
    caseDocs['004'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id };
    recordIndependentReconciliation('004', doc.document_id, oracle.reconciliation, await getReconciliation(doc.document_id), 'Westpac single-signed fixture');
  }

  // ===== LIVE-R7-005 — Dr/Cr indicator (SBI) ================================
  {
    const bytes = readFixtureBytes('in_sbi_dr_cr.csv');
    const meta = { country_code: 'IN', currency_code: 'INR', institution_id: inst.sbi, masked_identifier: 'R7C005', filename: 'sbi-005.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const txns = await getTransactions(doc.financial_account_id);
    const oracle = runOracle('in_sbi_dr_cr.csv', 'in_sbi_dr_cr.profile.json');
    const diffs = [];
    for (const o of oracle.accepted) {
      const t = txns.find((x) => x.source_row === o.row);
      if (!t) { diffs.push(`row ${o.row} missing`); continue; }
      if (!eqMoney(t.amount_original, o.amount)) diffs.push(`row ${o.row} amount mismatch`);
      if (t.credit_debit !== o.direction) diffs.push(`row ${o.row} direction ${t.credit_debit} != ${o.direction} (DR/CR indicator)`);
    }
    const pass = diffs.length === 0;
    record('LIVE-R7-005', 'DR/CR indicator format (SBI): direction and signed value correct', pass ? 'PASS' : 'FAIL', diffs.length ? diffs.join('; ') : `${txns.length} rows verified`);
    caseDocs['005'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id };
    recordIndependentReconciliation('005', doc.document_id, oracle.reconciliation, await getReconciliation(doc.document_id), 'SBI Dr/Cr fixture');
  }

  // ===== LIVE-R7-006 — ambiguous date, never silently guessed ==============
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'generic_ambiguous.csv'));
    const meta = { country_code: 'AU', currency_code: 'AUD', masked_identifier: 'R7C006', filename: 'generic-006.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    const det = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const procBeforeMap = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const pass = det.json?.data?.detection_status === 'manual_mapping_required' && procBeforeMap.status !== 200 && /mapping/i.test(procBeforeMap.json?.error ?? '');
    record('LIVE-R7-006', 'Structurally ambiguous date (01/02/2026, unrecognised header): manual_mapping_required, never silently guessed', pass ? 'PASS' : 'FAIL',
      { detectionStatus: det.json?.data?.detection_status, processWithoutMapping: { status: procBeforeMap.status, error: procBeforeMap.json?.error } });
  }

  // ===== LIVE-R7-007 — manual mapping flow ==================================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'generic_ambiguous.csv'));
    const meta = { country_code: 'AU', currency_code: 'AUD', masked_identifier: 'R7C007', filename: 'generic-007.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const mapBody = {
      amount_convention: 'single_signed',
      date_format: 'DD/MM/YYYY',
      delimiter: ',',
      column_mapping: { transaction_date: 'TxnDate', description: 'Details', amount: 'Value', balance: 'RunningBalance', reference: 'RefNumber' },
      save_as_reusable_template: true,
    };
    const mapRes = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/map`, userA.cookie, mapBody);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const txns = await getTransactions(doc.financial_account_id);
    const row1 = txns.find((t) => t.source_row === 1);
    const row2 = txns.find((t) => t.source_row === 2);
    // Under explicit DD/MM/YYYY: 01/02/2026 -> 2026-02-01 (1 Feb, NOT 2 Jan).
    // single_signed convention (generic_ambiguous.csv "Value" column):
    // row1 = +25.50 (positive -> credit), row2 = -1200.00 (negative -> debit).
    const templateRow = await sb(`/rest/v1/fdh_csv_mapping_templates?user_id=eq.${userA.id}&select=*&order=created_at.desc&limit=1`);
    const pass = mapRes.status === 200 && proc.status === 200 &&
      row1?.transaction_date === '2026-02-01' && row1.credit_debit === 'credit' && Number(row1.amount_original) === 25.5 &&
      row2?.transaction_date === '2026-02-15' && row2.credit_debit === 'debit' && Number(row2.amount_original) === 1200 &&
      templateRow.json?.[0]?.user_id === userA.id;
    record('LIVE-R7-007', 'Manual column mapping flow (detect -> map -> process): mapping stored, tenant-scoped, canonical output matches the EXPLICITLY confirmed date_format (01/02/2026 -> 2026-02-01 under DD/MM/YYYY, not 2026-01-02)', pass ? 'PASS' : 'FAIL',
      { mapStatus: mapRes.status, mappingTemplateId: mapRes.json?.data?.mapping_template_id, row1Date: row1?.transaction_date, row2Date: row2?.transaction_date, templateOwner: templateRow.json?.[0]?.user_id });
    caseDocs['007'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id };

    // Independent reconciliation #10: generic_ambiguous.csv is NOT internally
    // consistent as a balance rollforward (it was only designed to exercise
    // date-format mapping) — computed by hand, independent of any script:
    // row1 +25.50 credit -> balance 974.50 => opening = 974.50 - 25.50 = 949.00.
    // row2 -1200.00 debit -> balance 2174.50 (reported).
    // expected closing = 949.00 + 25.50 - 1200.00 = -225.50, variance = -225.50 - 2174.50 = -2400.00 -> FAILED.
    const indepRecon007 = {
      status: 'failed',
      opening_balance: '949.0000',
      extracted_credits: '25.5000',
      extracted_debits: '1200.0000',
      expected_closing_balance: '-225.5000',
      reported_closing_balance: '2174.5000',
      variance: '-2400.0000',
    };
    recordIndependentReconciliation('007', doc.document_id, indepRecon007, await getReconciliation(doc.document_id), 'Generic-mapping fixture — hand-computed rollforward (not internally consistent by design, proves R7 doesn\'t fabricate RECONCILED)');
  }

  // ===== LIVE-R7-008 — reconciliation pass ==================================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_ORIG, 'in_hdfc_debit_credit.csv'));
    const meta = { country_code: 'IN', currency_code: 'INR', institution_id: inst.hdfc, masked_identifier: 'R7C008', filename: 'hdfc-008.csv' };
    const up = await uploadCsv(userB.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userB.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userB.cookie);
    const reconApi = await appGet(`/api/financial-data-hub/bank-csv/${doc.document_id}/reconciliation`, userB.cookie);
    const oracle = runOracle('in_hdfc_debit_credit.csv', 'in_hdfc_debit_credit.profile.json');
    const pass = proc.json?.data?.reconciliation_status === 'reconciled' && reconApi.json?.data?.reconciliation?.status === 'reconciled' && oracle.reconciliation.status === 'reconciled';
    record('LIVE-R7-008', 'Reconciliation pass: independently-computed opening+credits-debits=closing matches, R7 returns RECONCILED', pass ? 'PASS' : 'FAIL',
      { processReconciliationStatus: proc.json?.data?.reconciliation_status, apiReconStatus: reconApi.json?.data?.reconciliation?.status, oracleStatus: oracle.reconciliation.status });
    caseDocs['008'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userB.id };
    recordIndependentReconciliation('008', doc.document_id, oracle.reconciliation, await getReconciliation(doc.document_id), 'HDFC clean fixture (userB)');
  }

  // ===== LIVE-R7-009 — reconciliation failure ===============================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'recon_fail.csv'));
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.cba, masked_identifier: 'R7C009', filename: 'cba-009-broken.csv' };
    const up = await uploadCsv(userB.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userB.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userB.cookie);
    const docAfter = await getDocument(doc.document_id);
    const oracle = runOracle('recon_fail.csv', 'recon_fail.profile.json', FIXDIR_NEW);
    const pass = proc.json?.data?.reconciliation_status === 'failed' && docAfter.certification_status !== 'certified' && oracle.reconciliation.status === 'failed';
    record('LIVE-R7-009', 'Reconciliation failure (deliberately broken balance: -$10.00 variance): FAILED, never silently CERTIFIED/RECONCILED', pass ? 'PASS' : 'FAIL',
      { processReconciliationStatus: proc.json?.data?.reconciliation_status, certificationStatus: docAfter.certification_status, oracleVariance: oracle.reconciliation.variance });
    caseDocs['009'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userB.id };
    recordIndependentReconciliation('009', doc.document_id, oracle.reconciliation, await getReconciliation(doc.document_id), 'Deliberately-broken CBA fixture (-$10.00 variance)');
  }

  // ===== LIVE-R7-010 — duplicate candidate ==================================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'dup_candidate.csv'));
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.westpac, masked_identifier: 'R7C010', filename: 'westpac-010-dupcand.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const txns = await getTransactions(doc.financial_account_id);
    // Within a single upload, the FIRST occurrence of a fingerprint has no
    // prior match (dedup_status='unique' — nothing to compare against yet);
    // the SECOND occurrence matches it with weak evidence (no reference, no
    // balance on either side) and is flagged 'duplicate_candidate'. Both
    // rows are kept (spec 33) — neither is silently dropped.
    const statuses = txns.map((t) => t.dedup_status).sort();
    const candidatePair = await getDuplicateCandidates(userA.id, txns.map((t) => t.id));
    const pass = txns.length === 2 && JSON.stringify(statuses) === JSON.stringify(['duplicate_candidate', 'unique']) &&
      candidatePair.length === 1 && candidatePair[0].status === 'pending';
    record('LIVE-R7-010', 'Duplicate candidate (no reference, no balance, weak evidence): 1st occurrence unique, 2nd flagged DUPLICATE_CANDIDATE, both rows kept, a real pending fdh_duplicate_candidates row backs it for resolution', pass ? 'PASS' : 'FAIL',
      { persistedCount: txns.length, dedupStatuses: statuses, duplicateCandidatesReported: proc.json?.data?.duplicate_candidates, realCandidateRows: candidatePair.length, candidateStatus: candidatePair[0]?.status });
    caseDocs['010'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id, txns };
  }

  // ===== LIVE-R7-011 — legitimate identical transactions ====================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'dup_legit.csv'));
    const meta = { country_code: 'IN', currency_code: 'INR', institution_id: inst.sbi, masked_identifier: 'R7C011', filename: 'sbi-011-legit.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const txns = await getTransactions(doc.financial_account_id);
    const pass = txns.length === 2 && txns.every((t) => t.dedup_status === 'unique') && new Set(txns.map((t) => t.economic_fingerprint)).size === 2;
    record('LIVE-R7-011', 'Legitimate identical (same date/amount/description, DISTINCT reference REF9001/REF9002): 2 canonical transactions, no false dedup', pass ? 'PASS' : 'FAIL',
      { persistedCount: txns.length, dedupStatuses: txns.map((t) => t.dedup_status), distinctFingerprints: new Set(txns.map((t) => t.economic_fingerprint)).size });
    caseDocs['011'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id };
  }

  // ===== LIVE-R7-012 — multi-account =========================================
  {
    const bytes1 = fs.readFileSync(path.join(FIXDIR_NEW, 'multi_account_1.csv'));
    const bytes2 = fs.readFileSync(path.join(FIXDIR_NEW, 'multi_account_2.csv'));
    const meta1 = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.westpac, masked_identifier: 'R7ACCT1', filename: 'acct1.csv' };
    const meta2 = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.westpac, masked_identifier: 'R7ACCT2', filename: 'acct2.csv' };
    const up1 = await uploadCsv(userB.cookie, meta1, bytes1);
    const doc1 = up1.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc1.document_id}/detect`, userB.cookie);
    const proc1 = await appPostJson(`/api/financial-data-hub/bank-csv/${doc1.document_id}/process`, userB.cookie);
    const up2 = await uploadCsv(userB.cookie, meta2, bytes2);
    const doc2 = up2.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc2.document_id}/detect`, userB.cookie);
    const proc2 = await appPostJson(`/api/financial-data-hub/bank-csv/${doc2.document_id}/process`, userB.cookie);

    const acctsDiffer = doc1.financial_account_id !== doc2.financial_account_id;
    const txns1 = await getTransactions(doc1.financial_account_id);
    const txns2 = await getTransactions(doc2.financial_account_id);
    const pass = acctsDiffer && txns1.length === 1 && txns2.length === 1 && txns1[0].dedup_status === 'unique' && txns2[0].dedup_status === 'unique' && txns1[0].economic_fingerprint !== txns2[0].economic_fingerprint;
    record('LIVE-R7-012', 'Multi-account: identical-looking transaction on Account B1 and Account B2 — both survive, no cross-account dedup', pass ? 'PASS' : 'FAIL',
      { account1: doc1.financial_account_id, account2: doc2.financial_account_id, acctsDiffer, count1: txns1.length, count2: txns2.length, fp1: txns1[0]?.economic_fingerprint, fp2: txns2[0]?.economic_fingerprint });
    caseDocs['012a'] = { documentId: doc1.document_id, financialAccountId: doc1.financial_account_id, userId: userB.id };
    caseDocs['012b'] = { documentId: doc2.document_id, financialAccountId: doc2.financial_account_id, userId: userB.id };
  }

  // ===== LIVE-R7-013 — multi-currency =========================================
  {
    const bytesAud = fs.readFileSync(path.join(FIXDIR_ORIG, 'au_westpac_single_signed.csv'));
    const bytesInr = fs.readFileSync(path.join(FIXDIR_ORIG, 'in_icici_debit_credit.csv'));
    const metaAud = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.westpac, masked_identifier: 'R7C013AUD', filename: 'westpac-013.csv' };
    const metaInr = { country_code: 'IN', currency_code: 'INR', institution_id: inst.icici, masked_identifier: 'R7C013INR', filename: 'icici-013.csv' };
    const upAud = await uploadCsv(userB.cookie, metaAud, bytesAud);
    const docAud = upAud.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${docAud.document_id}/detect`, userB.cookie);
    await appPostJson(`/api/financial-data-hub/bank-csv/${docAud.document_id}/process`, userB.cookie);
    const upInr = await uploadCsv(userB.cookie, metaInr, bytesInr);
    const docInr = upInr.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${docInr.document_id}/detect`, userB.cookie);
    await appPostJson(`/api/financial-data-hub/bank-csv/${docInr.document_id}/process`, userB.cookie);

    const txnsAud = await getTransactions(docAud.financial_account_id);
    const txnsInr = await getTransactions(docInr.financial_account_id);
    const oracleInr = runOracle('in_icici_debit_credit.csv', 'in_icici_debit_credit.profile.json');
    const pass = docAud.financial_account_id !== docInr.financial_account_id &&
      txnsAud.every((t) => t.currency_original === 'AUD') && txnsInr.every((t) => t.currency_original === 'INR') &&
      txnsAud.every((t) => t.amount_reporting_currency === null && t.fx_rate === null) &&
      txnsInr.every((t) => t.amount_reporting_currency === null && t.fx_rate === null) &&
      txnsInr.length === oracleInr.parsed_row_count;
    record('LIVE-R7-013', 'Multi-currency (AUD + INR accounts): currency retained per row, no FX conversion, no cross-currency dedup', pass ? 'PASS' : 'FAIL',
      { aud: { account: docAud.financial_account_id, count: txnsAud.length, currencies: [...new Set(txnsAud.map((t) => t.currency_original))] },
        inr: { account: docInr.financial_account_id, count: txnsInr.length, currencies: [...new Set(txnsInr.map((t) => t.currency_original))] } });
    caseDocs['013a'] = { documentId: docAud.document_id, financialAccountId: docAud.financial_account_id, userId: userB.id };
    caseDocs['013b'] = { documentId: docInr.document_id, financialAccountId: docInr.financial_account_id, userId: userB.id };
    recordIndependentReconciliation('013', docInr.document_id, oracleInr.reconciliation, await getReconciliation(docInr.document_id), 'ICICI INR account (multi-currency case)');
  }

  // ===== LIVE-R7-014 — >1000 transactions ====================================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'large_2500.csv'));
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.cba, masked_identifier: 'R7C014', filename: 'cba-014-large.csv' };
    const up = await uploadCsv(userB.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userB.cookie);
    const t0 = Date.now();
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userB.cookie);
    const elapsedMs = Date.now() - t0;
    const txns = await getTransactions(doc.financial_account_id);
    const oracle = runOracle('large_2500.csv', 'large_2500.profile.json', FIXDIR_NEW);
    const sourceRows = txns.map((t) => t.source_row).sort((a, b) => a - b);
    const expectedRows = Array.from({ length: 2500 }, (_, i) => i + 1);
    const noGapsNoDupes = JSON.stringify(sourceRows) === JSON.stringify(expectedRows);
    const uniqueIds = new Set(txns.map((t) => t.id)).size === txns.length;
    const docAfter = await getDocument(doc.document_id);
    const pass = txns.length === 2500 && noGapsNoDupes && uniqueIds && docAfter.reconciliation_status === 'reconciled' && oracle.reconciliation.status === 'reconciled' &&
      eqMoney(docAfter.certified_row_count, 2500);
    record('LIVE-R7-014', '2500-row live import: exact count, no duplicate/missing source rows, no duplicate ids, correct closing balance beyond PostgREST 1000-row default page', pass ? 'PASS' : 'FAIL',
      { persistedCount: txns.length, noGapsNoDupes, uniqueIds, reconciliationStatus: docAfter.reconciliation_status, certifiedRowCount: docAfter.certified_row_count, elapsedMs });
    caseDocs['014'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userB.id };
    recordIndependentReconciliation('014', doc.document_id, oracle.reconciliation, await getReconciliation(doc.document_id), '2500-row large-file import (proves no 1000-row page-boundary truncation live)');
  }

  // ===== LIVE-R7-015 — unsupported / non-CSV-shaped format ==================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'unsupported.txt'));
    const meta = { country_code: 'AU', currency_code: 'AUD', masked_identifier: 'R7C015', filename: 'not-a-statement.txt' };
    const up = await uploadCsv(userA.cookie, meta, bytes, 'text/csv');
    const doc = up.json?.data;
    let detectionStatus = null;
    if (up.status === 200 && doc.processing_status !== 'rejected' && doc.processing_status !== 'failed') {
      const det = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
      detectionStatus = det.json?.data?.detection_status;
    } else {
      detectionStatus = doc?.error_code ?? 'rejected_at_upload';
    }
    const pass = doc?.processing_status === 'rejected' || detectionStatus === 'invalid' || detectionStatus === 'unsupported' || detectionStatus === 'manual_mapping_required';
    record('LIVE-R7-015', 'Structurally non-CSV-shaped file: never fabricates a format match (rejected / invalid / manual_mapping_required)', pass ? 'PASS' : 'FAIL',
      { uploadStatus: up.status, processingStatus: doc?.processing_status, errorCode: doc?.error_code, detectionStatus });
  }

  // ===== Boundary check §35 — reimport idempotency (retry same job) ========
  {
    const target = caseDocs['003'];
    const before = await getDocument(target.documentId);
    const beforeTxns = await getTransactions(target.financialAccountId);
    const retryRes = await appPostJson(`/api/financial-data-hub/bank-csv/${target.documentId}/process`, userA.cookie);
    const after = await getDocument(target.documentId);
    const afterTxns = await getTransactions(target.financialAccountId);
    // Idempotent = the retry is a no-op that returns the EXISTING result
    // (service header comment: "a repeated call is a no-op that returns the
    // existing result") — NOT literally transactions_created=0. The
    // load-bearing invariant is that the PERSISTED row count never grows and
    // no second reconciliation_results row is layered on top (checked next).
    const pass = retryRes.status === 200 && afterTxns.length === beforeTxns.length &&
      before.certification_status === after.certification_status && retryRes.json?.data?.transactions_created === beforeTxns.length;
    record('BOUNDARY-035', 'Reimport idempotency: retrying /process on an already-certified document is a no-op — persisted row count stable, same result returned, no growth (spec §35, §56)', pass ? 'PASS' : 'FAIL',
      { retryReportedTransactionsCreated: retryRes.json?.data?.transactions_created, beforeCount: beforeTxns.length, afterCount: afterTxns.length, certBefore: before.certification_status, certAfter: after.certification_status });

    // Also verify no second fdh_reconciliation_results row was layered on top.
    const reconRows = await sb(`/rest/v1/fdh_reconciliation_results?statement_upload_id=eq.${target.documentId}&select=id`);
    record('BOUNDARY-035b', 'Reimport idempotency: no duplicate reconciliation_results row created on retry', (reconRows.json?.length === 1) ? 'PASS' : 'FAIL', `reconciliation_results rows for doc = ${reconRows.json?.length}`);
  }

  // ===== Boundary check §36 — partial-failure atomicity =====================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_NEW, 'partial_fail.csv'));
    const meta = { country_code: 'AU', currency_code: 'AUD', institution_id: inst.cba, masked_identifier: 'R7C036', filename: 'cba-partial.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    const proc = await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const docAfter = await getDocument(doc.document_id);
    const txns = await getTransactions(doc.financial_account_id);
    const pass = docAfter.certification_status === 'partial' && proc.json?.data?.rejected_rows >= 1 && txns.length === 2 && docAfter.certification_status !== 'certified';
    record('BOUNDARY-036', 'Partial-failure atomicity: 1 malformed row (missing date) out of 3 -> certification_status=PARTIAL, valid rows persisted, never silently CERTIFIED (spec §36, §45-46)', pass ? 'PASS' : 'FAIL',
      { certificationStatus: docAfter.certification_status, rejectedRows: proc.json?.data?.rejected_rows, persistedValidRows: txns.length, declaredRowCount: docAfter.declared_row_count, parsedRowCount: docAfter.parsed_row_count });
    caseDocs['036'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id };
  }

  // ===== Boundary check §37 — classification-ready contract =================
  {
    const target = caseDocs['003'];
    const txns = await getTransactions(target.financialAccountId);
    const t = txns[0];
    const required = ['transaction_date', 'description_raw', 'description_clean', 'amount_original', 'credit_debit', 'currency_original', 'transaction_type_hint', 'financial_account_id', 'statement_upload_id'];
    const missing = required.filter((f) => t[f] === undefined || t[f] === null);
    const pass = missing.length === 0;
    record('BOUNDARY-037', 'Classification-ready contract: a certified live transaction carries every field a later classifier needs, without reopening the raw CSV', pass ? 'PASS' : 'FAIL',
      missing.length ? `missing: ${missing.join(',')}` : Object.fromEntries(required.map((f) => [f, t[f]])));
  }

  // ===== Boundary check §33 — bank -> investment boundary ===================
  {
    const bytes = fs.readFileSync(path.join(FIXDIR_ORIG, 'in_hdfc_debit_credit.csv')); // row 3: "SIP MUTUAL FUND ABC"
    const meta = { country_code: 'IN', currency_code: 'INR', institution_id: inst.hdfc, masked_identifier: 'R7C033', filename: 'hdfc-033-sip.csv' };
    const up = await uploadCsv(userA.cookie, meta, bytes);
    const doc = up.json?.data;
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/detect`, userA.cookie);
    await appPostJson(`/api/financial-data-hub/bank-csv/${doc.document_id}/process`, userA.cookie);
    const txns = await getTransactions(doc.financial_account_id);
    const sipRow = txns.find((t) => (t.description_raw || '').toUpperCase().includes('SIP'));
    const investmentTxCountAfter = await sb(`/rest/v1/ii_bank_transactions?select=id&limit=1`); // table should not exist / be empty — checked via schema probe below
    const iiTxAfter = await sb(`/rest/v1/ii_transactions?user_id=eq.${userA.id}&select=id`);
    const iiLotsAfter = await sb(`/rest/v1/ii_tax_lots?user_id=eq.${userA.id}&select=id`);
    const iiHoldingsAfter = await sb(`/rest/v1/ii_holding_snapshots?user_id=eq.${userA.id}&select=id`);
    const pass = sipRow?.transaction_type_hint === 'investment_transfer_candidate' &&
      (iiTxAfter.json ?? []).length === 0 && (iiLotsAfter.json ?? []).length === 0 && (iiHoldingsAfter.json ?? []).length === 0;
    record('BOUNDARY-033', 'Bank -> Investment boundary: SIP payment row gets investment_transfer_candidate HINT only; 0 new ii_transactions/ii_tax_lots/ii_holding_snapshots rows created for this user', pass ? 'PASS' : 'FAIL',
      { sipRowHint: sipRow?.transaction_type_hint, iiTransactions: (iiTxAfter.json ?? []).length, iiTaxLots: (iiLotsAfter.json ?? []).length, iiHoldingSnapshots: (iiHoldingsAfter.json ?? []).length, ii_bank_transactions_table_probe_status: investmentTxCountAfter.status });
    caseDocs['033'] = { documentId: doc.document_id, financialAccountId: doc.financial_account_id, userId: userA.id };
  }

  // ===== Boundary check §34 — FDH canonical ownership (no parallel ledger) ==
  {
    const probe = await sb('/rest/v1/ii_bank_transactions?select=id&limit=1');
    const probe2 = await sb('/rest/v1/ii_cash_transactions?select=id&limit=1');
    const probe3 = await sb('/rest/v1/ii_bank_statements?select=id&limit=1');
    // Expect PostgREST 404 (relation not found in schema cache) for all three — i.e. these tables genuinely do not exist.
    const pass = probe.status === 404 && probe2.status === 404 && probe3.status === 404;
    record('BOUNDARY-034', 'FDH canonical ownership: no parallel ii_bank_transactions/ii_cash_transactions/ii_bank_statements ledger exists in live DEV schema', pass ? 'PASS' : 'FAIL',
      { ii_bank_transactions: probe.status, ii_cash_transactions: probe2.status, ii_bank_statements: probe3.status });
  }

  // ===== Cleanup ==============================================================
  await cleanupAll();

  // ===== Summary ==============================================================
  const total = results.length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const reconFail = reconciliationLedger.filter((r) => !r.pass).length;
  console.log('\n=== SUMMARY ===');
  console.log(`Checks: ${total}, FAIL: ${failed}`);
  console.log(`Independent reconciliations recorded: ${reconciliationLedger.length}, FAIL: ${reconFail}`);
  fs.writeFileSync(path.join(repoRoot, '.r7scratch', 'live_results.json'), JSON.stringify({ results, reconciliationLedger, users: { userA: userA.id, userB: userB.id } }, null, 2));

  async function cleanupAll() {
    console.log('\n=== CLEANUP ===');
    for (const uid of cleanup.users) {
      // Order matters for FK cascades but most FDH tables cascade on user delete via auth.users FK;
      // delete explicitly first anyway for a verifiable, itemised cleanup.
      const tables = [
        'fdh_transaction_corrections', 'fdh_duplicate_candidates', 'fdh_data_quality_results',
        'fdh_data_provenance', 'fdh_reconciliation_results', 'fdh_transactions',
        'fdh_review_items', 'fdh_csv_mapping_templates', 'fdh_statement_uploads', 'fdh_financial_accounts',
      ];
      for (const t of tables) {
        await sb(`/rest/v1/${t}?user_id=eq.${uid}`, { method: 'DELETE' });
      }
    }
    // Verify 0 rows remain for both test users across every touched table.
    const verify = {};
    for (const uid of cleanup.users) {
      for (const t of ['fdh_transactions', 'fdh_statement_uploads', 'fdh_financial_accounts', 'fdh_duplicate_candidates', 'fdh_reconciliation_results', 'fdh_csv_mapping_templates', 'fdh_transaction_corrections', 'fdh_review_items']) {
        const r = await sb(`/rest/v1/${t}?user_id=eq.${uid}&select=id`);
        verify[`${uid}:${t}`] = (r.json ?? []).length;
      }
    }
    const allZero = Object.values(verify).every((n) => n === 0);
    record('CLEANUP-DATA', 'All test data rows deleted and re-queried as 0 for both test users', allZero ? 'PASS' : 'FAIL', JSON.stringify(verify));

    for (const uid of cleanup.users) {
      await sb(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
    }
    const verifyUsers = {};
    for (const uid of cleanup.users) {
      const r = await sb(`/auth/v1/admin/users/${uid}`);
      verifyUsers[uid] = r.status;
    }
    const usersGone = Object.values(verifyUsers).every((s) => s === 404 || s === 403 || s === 400);
    record('CLEANUP-USERS', 'Both test auth users deleted and re-queried as gone', usersGone ? 'PASS' : 'FAIL', JSON.stringify(verifyUsers));
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
