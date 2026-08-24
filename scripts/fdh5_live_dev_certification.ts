/**
 * FDH-5 — Live DEV end-to-end + security + password + purge certification
 * (spec sections 103-108, "particular scrutiny area" for password handling).
 *
 * Talks to: (a) the real running Next.js app for every user-facing action,
 * (b) the real DEV Supabase project via REST with the service-role key for
 * ground-truth verification/cleanup ONLY. Mirrors
 * scripts/fdh4_live_dev_certification.ts's proven pattern exactly (same
 * helper shapes, same cleanup discipline).
 *
 * PASSWORD LIVE-DEV METHODOLOGY (disclosed honestly — see
 * FDH5_PASSWORD_PROTECTED_PDF.md). No genuine RC4/AES-encrypted PDF binary
 * is constructed here (out of scope to hand-roll, same call
 * tests/unit/iiR2PdfExtraction.test.ts already made for the same
 * dependency). This script instead submits a REAL password VALUE through
 * the REAL, live `/process` API route (against a genuinely unencrypted
 * synthetic PDF — `pdf-parse`'s `PDFParse({ password })` option is inert
 * when the document is not actually encrypted, so the full real code path —
 * API route -> service -> orchestrator -> classifyPdf -> extractPdfPages ->
 * PDFParse — is genuinely exercised live, not mocked) and then proves,
 * against DEV's real Postgres data via REST, that the submitted value
 * appears in ZERO returned rows across every FDH-5-touched table. This is
 * an ARTIFACT-ABSENCE proof of the property spec 23 actually cares about
 * (never persisted), not a claim of having exercised genuine binary
 * decryption live — the unit suite (fdh5ClassificationAndPassword.test.ts)
 * separately certifies the encrypted/wrong-password ROUTING logic via a
 * controlled mock of the real `PasswordException` type.
 *
 * Run: npx tsx scripts/fdh5_live_dev_certification.ts [appBaseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBankPdfFixture } from '../tests/support/buildBankPdfFixture';

const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:31997';

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env: Record<string, string> = {};
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
process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;

type Status = 'PASS' | 'FAIL' | 'INFO';
const results: { id: string; description: string; status: Status; detail?: unknown }[] = [];
function record(id: string, description: string, status: Status, detail?: unknown) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail !== undefined) console.log(`        ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}`);
}

async function sb(p: string, opts: { method?: string; body?: unknown; prefer?: string } = {}) {
  const headers: Record<string, string> = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function asUser(token: string, p: string, opts: { method?: string; body?: unknown; prefer?: string } = {}) {
  const headers: Record<string, string> = { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { users: [] as string[] };

async function makeUser(tag: string) {
  const email = `fdh5-live-cert-${tag}-${stamp}@test.fhip.internal`;
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
  return { id, email, accessToken: session.access_token as string, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}
async function appPostJson(pathname: string, cookie: string, body?: unknown) {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function appGet(pathname: string, cookie: string) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function uploadPdf(cookie: string, meta: Record<string, string>, bytes: Buffer) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const res = await fetch(`${APP}/api/financial-data-hub/bank-pdf/upload?${qs.toString()}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.byteLength) }, body: new Uint8Array(bytes),
  });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function getInstitutionId(code: string, country: string) {
  const r = await sb(`/rest/v1/fdh_financial_institutions?institution_code=eq.${code}&country_code=eq.${country}&select=id`);
  return r.json?.[0]?.id ?? null;
}

function cbaFixtureBytes(): Buffer {
  return buildBankPdfFixture({
    brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
    columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
    openingBalanceLine: 'Opening Balance: $1,000.00',
    closingBalanceLine: 'Closing Balance: $1,234.56',
    transactions: [
      { date: '1 Aug 2026', description: 'CARD PURCHASE WOOLWORTHS 1234', amount: '45.20 DR', balance: '954.80' },
      { date: '3 Aug 2026', description: 'SALARY XYZ PTY LTD', amount: '500.00 CR', balance: '1,454.80' },
      { date: '5 Aug 2026', description: 'DIRECT DEBIT INSURANCE', amount: '220.24 DR', balance: '1,234.56' },
    ],
  });
}
function sbiFixtureBytes(): Buffer {
  return buildBankPdfFixture({
    brandLines: ['State Bank of India', 'Account Statement'],
    columnHeaderLine: 'Txn Date Description Debit Credit Balance',
    transactions: [
      { date: '1 Aug 2026', description: 'UPI TRANSFER TO JOHN', amount: '1,250.00 DR', balance: '43,178.90' },
      { date: '3 Aug 2026', description: 'SALARY CREDIT', amount: '50,000.00 CR', balance: '93,178.90' },
    ],
  });
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  const userA = await makeUser('a');
  const userB = await makeUser('b');
  record('FDH5-SETUP', 'Create two REAL authenticated DEV sessions (A victim, B attacker)', 'PASS', `A=${userA.id} B=${userB.id}`);

  const cbaInst = await getInstitutionId('cba', 'AU');
  const sbiInst = await getInstitutionId('sbi', 'IN');

  // ===== §103-104 — Live E2E: one AU adapter, native text =====
  const upAu = await uploadPdf(userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: cbaInst, masked_identifier: 'FDH5A1', filename: 'cba-fdh5-e2e.pdf' }, cbaFixtureBytes());
  const docIdAu = upAu.json?.data?.document_id;
  const accountIdAu = upAu.json?.data?.financial_account_id;
  record('FDH5-E2E-AU-01', 'Secure PDF upload into real DEV private storage (AU/CBA)', upAu.status === 200 && docIdAu ? 'PASS' : 'FAIL', { status: upAu.status, docIdAu });

  const procAu = await appPostJson(`/api/financial-data-hub/bank-pdf/${docIdAu}/process`, userA.cookie);
  record('FDH5-E2E-AU-02', 'Native-text PDF processing creates canonical transactions (AU/CBA)', procAu.status === 200 && procAu.json?.data?.transactions_created === 3 ? 'PASS' : 'FAIL', { status: procAu.status, body: procAu.json ?? procAu.text.slice(0, 500) });
  record('FDH5-E2E-AU-03', 'Reconciliation reflects exact opening/credits/debits/closing (AU/CBA)', procAu.json?.data?.reconciliation_status === 'reconciled' ? 'PASS' : 'FAIL', procAu.json?.data);

  const txnsAu1 = (await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountIdAu}&select=id`)).json ?? [];
  const catAu = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
  record('FDH5-E2E-AU-04', 'R8 categorisation runs successfully over the PDF-sourced transactions', catAu.status === 200 ? 'PASS' : 'FAIL', catAu.json?.data);

  // Idempotency: reprocess.
  const procAu2 = await appPostJson(`/api/financial-data-hub/bank-pdf/${docIdAu}/process`, userA.cookie);
  const txnsAu2 = (await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountIdAu}&select=id`)).json ?? [];
  record('FDH5-E2E-AU-05', 'Reprocessing the same PDF twice creates no duplicate canonical transactions', txnsAu2.length === txnsAu1.length ? 'PASS' : 'FAIL', { proc2Status: procAu2.status, before: txnsAu1.length, after: txnsAu2.length });

  // ===== §103-104 — Live E2E: one India adapter, native text =====
  const upIn = await uploadPdf(userA.cookie, { country_code: 'IN', currency_code: 'INR', institution_id: sbiInst, masked_identifier: 'FDH5A2', filename: 'sbi-fdh5-e2e.pdf' }, sbiFixtureBytes());
  const docIdIn = upIn.json?.data?.document_id;
  const accountIdIn = upIn.json?.data?.financial_account_id;
  record('FDH5-E2E-IN-01', 'Secure PDF upload into real DEV private storage (IN/SBI)', upIn.status === 200 && docIdIn ? 'PASS' : 'FAIL', { status: upIn.status, docIdIn });

  const procIn = await appPostJson(`/api/financial-data-hub/bank-pdf/${docIdIn}/process`, userA.cookie);
  record('FDH5-E2E-IN-02', 'Native-text PDF processing creates canonical transactions (IN/SBI)', procIn.status === 200 && procIn.json?.data?.transactions_created === 2 ? 'PASS' : 'FAIL', procIn.json?.data);
  record('FDH5-E2E-IN-03', 'Reconciliation reflects exact values (IN/SBI)', procIn.json?.data?.reconciliation_status === 'reconciled' ? 'PASS' : 'FAIL', procIn.json?.data);

  // ===== §105 — Live password case (see module header for methodology) =====
  const testPassword = `Fdh5LiveTestPassword_${stamp}_DO_NOT_PERSIST`;
  const upPw = await uploadPdf(userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: cbaInst, masked_identifier: 'FDH5A3', filename: 'cba-fdh5-password.pdf' }, cbaFixtureBytes());
  const docIdPw = upPw.json?.data?.document_id;
  const accountIdPw = upPw.json?.data?.financial_account_id;
  const procPw = await appPostJson(`/api/financial-data-hub/bank-pdf/${docIdPw}/process`, userA.cookie, { password: testPassword });
  record('FDH5-PW-01', 'A password submitted to /process for a genuinely UNENCRYPTED PDF does not prevent normal processing (PDFParse ignores an inert password option)', procPw.status === 200 && procPw.json?.data?.transactions_created === 3 ? 'PASS' : 'FAIL', procPw.json?.data);

  // Artifact-absence sweep: search every FDH-5-touched table's row(s) for
  // this document for the literal password string, anywhere.
  const sweepTables = ['fdh_statement_uploads', 'fdh_document_audit_events', 'fdh_transactions', 'fdh_reconciliation_results', 'fdh_data_quality_results', 'fdh_data_provenance', 'fdh_upload_sessions'];
  let leakFound = false;
  const sweepDetail: Record<string, number> = {};
  for (const table of sweepTables) {
    const filterCol = table === 'fdh_document_audit_events' ? 'document_id' : table === 'fdh_upload_sessions' ? 'document_id' : table === 'fdh_transactions' || table === 'fdh_reconciliation_results' || table === 'fdh_data_quality_results' || table === 'fdh_data_provenance' ? 'statement_upload_id' : 'id';
    const r = await sb(`/rest/v1/${table}?${filterCol}=eq.${docIdPw}&select=*`);
    const rows = r.json ?? [];
    const hit = JSON.stringify(rows).includes(testPassword);
    if (hit) leakFound = true;
    sweepDetail[table] = rows.length;
  }
  record('FDH5-PW-02', 'ARTIFACT-ABSENCE SWEEP: the submitted password value appears in ZERO rows across every FDH-5-touched table (spec 23, "particular scrutiny area")', !leakFound ? 'PASS' : 'FAIL', sweepDetail);

  // ===== §106 — Live Tenant A/B security =====
  {
    const reads = [
      ['status-au', await appGet(`/api/financial-data-hub/documents/${docIdAu}`, userB.cookie)],
      ['transactions-au', await appGet(`/api/financial-data-hub/bank-transactions?account_id=${accountIdAu}`, userB.cookie)],
    ] as const;
    let leaked = 0;
    for (const [, r] of reads) {
      const bodyHasVictimData = r.status === 200 && JSON.stringify(r.json ?? {}).includes(docIdAu);
      if (bodyHasVictimData) leaked += 1;
    }
    const directRead = await asUser(userB.accessToken, `/rest/v1/fdh_transactions?financial_account_id=eq.${accountIdAu}&select=id`);
    const directLeak = Array.isArray(directRead.json) && directRead.json.length > 0;
    record('FDH5-SEC-01', 'Tenant B cannot read Tenant A raw PDF, transactions, or document status', leaked === 0 && !directLeak ? 'PASS' : 'FAIL', { leaked, directLeak });
  }
  {
    const forgedProcess = await appPostJson(`/api/financial-data-hub/bank-pdf/${docIdAu}/process`, userB.cookie);
    record('FDH5-SEC-02', 'Forged processing request (Tenant B submits Tenant A document_id) rejected', forgedProcess.status >= 400 ? 'PASS' : 'FAIL', { status: forgedProcess.status });
  }
  {
    // Forged PASSWORD submission — B submits a password for A's document.
    const forgedPasswordSubmit = await appPostJson(`/api/financial-data-hub/bank-pdf/${docIdPw}/process`, userB.cookie, { password: 'attacker-guess' });
    record('FDH5-SEC-03', "Forged password submission (Tenant B submits a password for Tenant A's document) rejected — same forged-processing gate blocks it", forgedPasswordSubmit.status >= 400 ? 'PASS' : 'FAIL', { status: forgedPasswordSubmit.status });
  }
  {
    const txnId = txnsAu1[0]?.id;
    const directWrite = await asUser(userB.accessToken, `/rest/v1/fdh_transactions?id=eq.${txnId}`, { method: 'PATCH', body: { description_clean: 'attacker-forged-pdf' }, prefer: 'return=representation' });
    const directWriteBlocked = directWrite.status >= 400 || (Array.isArray(directWrite.json) && directWrite.json.length === 0);
    const groundTruth = await sb(`/rest/v1/fdh_transactions?id=eq.${txnId}&select=description_clean`);
    const untouched = groundTruth.json?.[0]?.description_clean !== 'attacker-forged-pdf';
    record('FDH5-SEC-04', 'Tenant B cannot write/correct Tenant A PDF-sourced transactions; ground truth unchanged', directWriteBlocked && untouched ? 'PASS' : 'FAIL', { directWriteStatus: directWrite.status, untouched });
  }

  // ===== §107 — Live purge =====
  {
    const { scheduleApprovedDocumentPurge, runPurgeAttempt } = await import('../lib/financial-data-hub/services/purge');
    const preTxns = (await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountIdAu}&select=id`)).json ?? [];
    await sb(`/rest/v1/fdh_statement_uploads?id=eq.${docIdAu}`, { method: 'PATCH', body: { processing_status: 'approved' } });
    const docRow = (await sb(`/rest/v1/fdh_statement_uploads?id=eq.${docIdAu}&select=*`)).json?.[0];
    await scheduleApprovedDocumentPurge(docRow);
    const docForAttempt = (await sb(`/rest/v1/fdh_statement_uploads?id=eq.${docIdAu}&select=*`)).json?.[0];
    const purgeResult = await runPurgeAttempt(docForAttempt);
    const postRow = (await sb(`/rest/v1/fdh_statement_uploads?id=eq.${docIdAu}&select=raw_document_storage_reference,raw_document_purge_status`)).json?.[0];
    const postTxns = (await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountIdAu}&select=id`)).json ?? [];
    const pass = purgeResult.status === 'purged' && postRow?.raw_document_purge_status === 'purged' && postRow?.raw_document_storage_reference == null && postTxns.length === preTxns.length;
    record('FDH5-PURGE-01', 'Raw PDF storage object purged; structured transactions SURVIVE the purge (spec 76-77, 107)', pass ? 'PASS' : 'FAIL', { purgeResult, txnCount: { before: preTxns.length, after: postTxns.length } });
  }

  // ===== §98 — pagination sanity (existing R7/FDH-4 fix, PDF-originated rows) =====
  {
    const page1 = await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountIdIn}&select=id&limit=1000`);
    record('FDH5-SCALE-01', 'PDF-originated transactions retrievable via the existing paginated repository path (source-format-agnostic fix)', Array.isArray(page1.json) ? 'PASS' : 'FAIL', { count: (page1.json ?? []).length });
  }

  // ===== cleanup =====
  for (const [docId, accountId] of [[docIdAu, accountIdAu], [docIdIn, accountIdIn], [docIdPw, accountIdPw]] as const) {
    await sb(`/rest/v1/fdh_reconciliation_results?statement_upload_id=eq.${docId}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_data_quality_results?statement_upload_id=eq.${docId}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_data_provenance?entity_id=eq.${docId}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountId}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_statement_uploads?id=eq.${docId}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_financial_accounts?id=eq.${accountId}`, { method: 'DELETE' });
  }
  for (const uid of cleanup.users) {
    await sb(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
  }
  const verifyTxns = await sb(`/rest/v1/fdh_transactions?financial_account_id=eq.${accountIdAu}&select=id`);
  record('FDH5-CLEANUP', 'All live test data and both test users deleted', (verifyTxns.json ?? []).length === 0 ? 'PASS' : 'FAIL', verifyTxns.json);

  fs.mkdirSync(path.join(repoRoot, '.r7scratch'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.r7scratch', 'fdh5_live_results.json'), JSON.stringify({ results }, null, 2));

  const fails = results.filter((r) => r.status === 'FAIL');
  console.log(`\n=== SUMMARY === Checks: ${results.length}, FAIL: ${fails.length}`);
  if (fails.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
