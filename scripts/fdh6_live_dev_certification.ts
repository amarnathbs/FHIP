/**
 * FDH-6 — Financial Classification, Transfer, Duplicate & Recurring
 * Intelligence: live DEV certification (spec sections 105-113).
 *
 * Talks to: (a) the real running Next.js app for every user-facing action
 * (upload, classify, review, correct), (b) the real DEV Supabase project via
 * REST with the service-role key for test-data SETUP (the CSV/PDF live
 * cases go through the real upload API; the transfer/missing-counterpart
 * setup transactions are inserted directly, matching R8's own live-cert
 * precedent — `scripts/r8_live_dev_certification.mjs`) and ground-truth
 * VERIFICATION/CLEANUP only.
 *
 * Mirrors the proven shape of `scripts/r7final_live_dev_certification.mjs`
 * and `scripts/fdh5_live_dev_certification.ts` (same helper functions, same
 * cleanup discipline).
 *
 * Run: npx tsx scripts/fdh6_live_dev_certification.ts [appBaseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBankPdfFixture } from '../tests/support/buildBankPdfFixture';

const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3217';
const FIXDIR = path.join(repoRoot, 'tests', 'fixtures', 'r7-bank-csv');

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

type Status = 'PASS' | 'FAIL' | 'INFO';
const results: { id: string; description: string; status: Status; detail?: unknown }[] = [];
function record(id: string, description: string, status: Status, detail?: unknown) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail !== undefined) console.log(`        ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sb(p: string, opts: { method?: string; body?: unknown; prefer?: string } = {}): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const headers: Record<string, string> = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function asUser(token: string, p: string, opts: { method?: string; body?: unknown; prefer?: string } = {}): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { users: [] as string[] };

async function makeUser(tag: string) {
  const email = `fdh6-live-cert-${tag}-${stamp}@test.fhip.internal`;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function appPostJson(pathname: string, cookie: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function uploadBytes(pathname: string, cookie: string, meta: Record<string, string>, bytes: Buffer, contentType: string) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const res = await fetch(`${APP}${pathname}?${qs.toString()}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) }, body: new Uint8Array(bytes),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function getInstitutionId(code: string, country: string) {
  const r = await sb(`/rest/v1/fdh_financial_institutions?institution_code=eq.${code}&country_code=eq.${country}&select=id`);
  return r.json?.[0]?.id ?? null;
}
async function insertAccount(userId: string, opts: { account_type: string; country_code?: string; currency_code?: string; display_name: string }) {
  const r = await sb('/rest/v1/fdh_financial_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: opts.account_type, country_code: opts.country_code ?? 'AU', currency_code: opts.currency_code ?? 'AUD', display_name: opts.display_name, status: 'active' },
  });
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!row?.id) throw new Error(`account insert failed: ${r.text}`);
  return row.id as string;
}
async function insertTransactions(rows: Record<string, unknown>[]) {
  const r = await sb('/rest/v1/fdh_transactions', { method: 'POST', prefer: 'return=representation', body: rows });
  if (!Array.isArray(r.json)) throw new Error(`transaction insert failed: ${r.text}`);
  return r.json as Array<Record<string, unknown>>;
}
async function getTxn(id: string) {
  const r = await sb(`/rest/v1/fdh_transactions?id=eq.${id}&select=*`);
  return r.json?.[0] ?? null;
}
async function getUserTransactions(userId: string) {
  const r = await sb(`/rest/v1/fdh_transactions?user_id=eq.${userId}&select=*&order=transaction_date.asc,id.asc&limit=5000`);
  return (r.json ?? []) as Array<Record<string, unknown>>;
}
async function getLinksForUser(userId: string) {
  const r = await sb(`/rest/v1/fdh_transaction_links?user_id=eq.${userId}&select=*`);
  return (r.json ?? []) as Array<Record<string, unknown>>;
}

function cbaSalaryTransferPdfBytes(): Buffer {
  return buildBankPdfFixture({
    brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
    columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
    openingBalanceLine: 'Opening Balance: $1,000.00',
    closingBalanceLine: 'Closing Balance: $980.30',
    transactions: [
      { date: '1 Aug 2026', description: 'SALARY XYZ PTY LTD', amount: '5,200.00 CR', balance: '6,200.00' },
      { date: '3 Aug 2026', description: 'BROKER FUNDING COMMSEC', amount: '2,000.00 DR', balance: '4,200.00' },
      { date: '5 Aug 2026', description: 'ATM WITHDRAWAL CBA BRANCH', amount: '200.00 DR', balance: '4,000.00' },
    ],
  });
}

function readFixtureBytes(name: string) {
  return fs.readFileSync(path.join(FIXDIR, name));
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  const userA = await makeUser('a');
  const userB = await makeUser('b');
  record('FDH6-SETUP-USERS', 'Create two real authenticated DEV sessions (A, B)', 'PASS', `A=${userA.id} B=${userB.id}`);

  const cbaInst = await getInstitutionId('cba', 'AU');

  // =========================================================================
  // §106 — Live CSV case: a certified AU adapter (CBA), full downstream FDH-6 path.
  // =========================================================================
  const csvBytes = readFixtureBytes('au_cba_debit_credit.csv');
  const upCsv = await uploadBytes('/api/financial-data-hub/bank-csv/upload', userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: cbaInst, masked_identifier: 'FDH6CSV', filename: 'fdh6-cba.csv' }, csvBytes, 'text/csv');
  const csvDocId = upCsv.json?.data?.document_id;
  record('FDH6-CSV-01', 'Real CSV upload through the live app (R7/FDH-4 certified CBA adapter)', upCsv.status === 200 && csvDocId ? 'PASS' : 'FAIL', { status: upCsv.status, csvDocId });

  await appPostJson(`/api/financial-data-hub/bank-csv/${csvDocId}/detect`, userA.cookie);
  const procCsv = await appPostJson(`/api/financial-data-hub/bank-csv/${csvDocId}/process`, userA.cookie);
  record('FDH6-CSV-02', 'CSV processed into real canonical transactions', procCsv.status === 200 ? 'PASS' : 'FAIL', procCsv.json?.data ?? procCsv.text.slice(0, 400));

  const classifyCsv = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
  record('FDH6-CSV-03', 'FDH-6/R8 classification runs over the CSV-sourced transactions (full downstream chain: CSV -> canonical -> merchant/category -> economic class)', classifyCsv.status === 200 ? 'PASS' : 'FAIL', classifyCsv.json?.data);

  // =========================================================================
  // §107 — Live PDF case: an FDH-5 native-text adapter, SAME downstream path.
  // =========================================================================
  const upPdf = await uploadBytes('/api/financial-data-hub/bank-pdf/upload', userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: cbaInst, masked_identifier: 'FDH6PDF', filename: 'fdh6-cba.pdf' }, cbaSalaryTransferPdfBytes(), 'application/pdf');
  const pdfDocId = upPdf.json?.data?.document_id;
  record('FDH6-PDF-01', 'Real PDF upload through the live app (FDH-5 certified native-text adapter)', upPdf.status === 200 && pdfDocId ? 'PASS' : 'FAIL', { status: upPdf.status, pdfDocId });

  const procPdf = await appPostJson(`/api/financial-data-hub/bank-pdf/${pdfDocId}/process`, userA.cookie);
  const pdfTxnCount = procPdf.json?.data?.transactions_created;
  record('FDH6-PDF-02', 'PDF processed into real canonical transactions', procPdf.status === 200 && pdfTxnCount === 3 ? 'PASS' : 'FAIL', procPdf.json?.data);

  const classifyPdf = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
  record('FDH6-PDF-03', 'FDH-6/R8 classification runs over the PDF-sourced transactions (SAME downstream chain as CSV)', classifyPdf.status === 200 ? 'PASS' : 'FAIL', classifyPdf.json?.data);

  const pdfTxns = (await getUserTransactions(userA.id)).filter((t) => t.statement_upload_id === pdfDocId);
  const salaryTxn = pdfTxns.find((t) => String(t.description_clean).includes('SALARY'));
  const brokerTxn = pdfTxns.find((t) => String(t.description_clean).includes('BROKER FUNDING'));
  const atmTxn = pdfTxns.find((t) => String(t.description_clean).includes('ATM WITHDRAWAL'));
  record('FDH6-PDF-04', 'PDF-sourced salary credit classified INCOME', salaryTxn?.economic_transaction_type === 'income' ? 'PASS' : 'FAIL', salaryTxn);
  record('FDH6-PDF-05', 'PDF-sourced "BROKER FUNDING" classified ASSET_PURCHASE (FDH-6 gap closure, migration 0075) — same downstream path as CSV', brokerTxn?.economic_transaction_type === 'asset_purchase' ? 'PASS' : 'FAIL', brokerTxn);
  record('FDH6-PDF-06', 'PDF-sourced ATM withdrawal classified CASH_WITHDRAWAL, not immediate expense', atmTxn?.economic_transaction_type === 'cash_withdrawal' ? 'PASS' : 'FAIL', atmTxn);

  // =========================================================================
  // §108 — Live matched transfer pair + §22/128 no double-counting proof.
  // =========================================================================
  const tA1 = await insertAccount(userA.id, { account_type: 'transaction', display_name: 'FDH6 A Everyday' });
  const tA2 = await insertAccount(userA.id, { account_type: 'savings', display_name: 'FDH6 A Savings' });
  const [debitT, creditT] = await insertTransactions([
    { user_id: userA.id, financial_account_id: tA1, transaction_date: '2026-08-10', description_raw: 'INTERNAL TRANSFER TO SAVINGS', description_clean: 'INTERNAL TRANSFER TO SAVINGS', amount_original: 750.0, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'FDH6-XFER-A' },
    { user_id: userA.id, financial_account_id: tA2, transaction_date: '2026-08-10', description_raw: 'INTERNAL TRANSFER FROM EVERYDAY', description_clean: 'INTERNAL TRANSFER FROM EVERYDAY', amount_original: 750.0, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'FDH6-XFER-B' },
  ]);
  const classifyXfer = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
  record('FDH6-XFER-01', 'Classification proposes a transfer link for the matched pair', classifyXfer.status === 200 ? 'PASS' : 'FAIL', classifyXfer.json?.data);

  const linksAfterClassify = await getLinksForUser(userA.id);
  const proposedLink = linksAfterClassify.find(
    (l) => (l.transaction_id_from === debitT.id && l.transaction_id_to === creditT.id) || (l.transaction_id_from === creditT.id && l.transaction_id_to === debitT.id),
  );
  record('FDH6-XFER-02', 'A pending internal_transfer link exists for the matched pair, status=pending (never auto-confirmed)', proposedLink?.status === 'pending' && proposedLink?.link_type === 'internal_transfer' ? 'PASS' : 'FAIL', proposedLink);

  const beforeDebit = await getTxn(debitT.id as string);
  const beforeCredit = await getTxn(creditT.id as string);
  record('FDH6-XFER-03', 'Before confirmation, neither side is yet economic_transaction_type=transfer', beforeDebit?.economic_transaction_type !== 'transfer' && beforeCredit?.economic_transaction_type !== 'transfer' ? 'PASS' : 'FAIL', { before: beforeDebit?.economic_transaction_type, beforeCredit: beforeCredit?.economic_transaction_type });

  const confirmXfer = await appPostJson(`/api/financial-data-hub/transaction-links/${proposedLink!.id}/review`, userA.cookie, { decision: 'confirm' });
  record('FDH6-XFER-04', 'User confirms the transfer link via the real review API', confirmXfer.status === 200 && confirmXfer.json?.data?.status === 'confirmed' ? 'PASS' : 'FAIL', confirmXfer.json?.data);

  const afterDebit = await getTxn(debitT.id as string);
  const afterCredit = await getTxn(creditT.id as string);
  record('FDH6-XFER-05', 'FDH-6 gap closure PROVEN LIVE: confirming the link writes economic_transaction_type=transfer back onto BOTH transactions (spec sections 20-22)', afterDebit?.economic_transaction_type === 'transfer' && afterCredit?.economic_transaction_type === 'transfer' ? 'PASS' : 'FAIL', { debit: afterDebit?.economic_transaction_type, credit: afterCredit?.economic_transaction_type });
  record('FDH6-XFER-06', 'No income/expense double-counting: neither confirmed side is classified income or expense (spec sections 22, 128, 136)', !['income', 'expense'].includes(String(afterDebit?.economic_transaction_type)) && !['income', 'expense'].includes(String(afterCredit?.economic_transaction_type)) ? 'PASS' : 'FAIL', null);

  const corrRows = await sb(`/rest/v1/fdh_transaction_corrections?transaction_id=in.(${debitT.id},${creditT.id})&select=*`);
  record('FDH6-XFER-07', 'Both transfer confirmations were recorded as auditable corrections (spec section 68)', Array.isArray(corrRows.json) && corrRows.json.length >= 2 ? 'PASS' : 'FAIL', { count: corrRows.json?.length });

  // =========================================================================
  // §109 — Live missing-counterpart transfer.
  // =========================================================================
  const tA3 = await insertAccount(userA.id, { account_type: 'transaction', display_name: 'FDH6 A Missing-Counterpart' });
  const [onlySide] = await insertTransactions([
    { user_id: userA.id, financial_account_id: tA3, transaction_date: '2026-08-12', description_raw: 'OWN ACCOUNT TRANSFER TO EXTERNAL BANK', description_clean: 'OWN ACCOUNT TRANSFER TO EXTERNAL BANK', amount_original: 333.0, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'FDH6-MISSING-A' },
  ]);
  await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
  const linksAfterMissing = await getLinksForUser(userA.id);
  const openLink = linksAfterMissing.find((l) => l.transaction_id_from === onlySide.id && l.transaction_id_to === null);
  record('FDH6-MISSING-01', 'A transfer-looking narrative with no counterpart produces a PERSISTENT OPEN link (MISSING_COUNTERPART_ACCOUNT), never a fabricated match, never forced to income/expense', openLink && openLink.status === 'pending' ? 'PASS' : 'FAIL', openLink);
  const onlySideTxn = await getTxn(onlySide.id as string);
  record('FDH6-MISSING-02', 'The lone transaction itself stays UNKNOWN/pending review, never guessed', onlySideTxn?.economic_transaction_type === 'unknown' && onlySideTxn?.review_status === 'pending' ? 'PASS' : 'FAIL', { type: onlySideTxn?.economic_transaction_type, review: onlySideTxn?.review_status });

  // =========================================================================
  // §110 — Live user correction.
  // =========================================================================
  // NOTE: category_key 'food' (not 'groceries') is FDH-2's real top-level
  // food category — verified against real DEV data
  // (`fdh_categories?category_key=ilike.*food*` returned exactly one row,
  // `food`). An earlier draft of this script guessed 'groceries', which
  // does not exist on DEV — that was a bug in THIS SCRIPT's own fixture
  // assumption, not in `correctTransaction()`; see FDH6_COMPLETION_REPORT.md
  // section 13 for the full account of catching and fixing it before this
  // certification was taken as final. The correction TARGET is the ATM
  // withdrawal transaction (already successfully classified `cash_
  // withdrawal` above) rather than the BROKER FUNDING one, decoupling this
  // check from the separately-disclosed migration-0075-not-yet-live gap.
  const foodCat = (await sb(`/rest/v1/fdh_categories?category_key=eq.food&select=id`)).json?.[0]?.id;
  const beforeCorrection = atmTxn ? await getTxn(atmTxn.id as string) : null;
  const correctionTargetId = atmTxn?.id as string;
  const correction = await appPostJson(`/api/financial-data-hub/bank-transactions/${correctionTargetId}/correction`, userA.cookie, { field_name: 'category_id', corrected_value: foodCat, reason: 'FDH-6 live-cert manual correction test' });
  record('FDH6-CORRECT-01', 'User correction saved via the real API', correction.status === 200 ? 'PASS' : 'FAIL', correction.json?.data);
  const afterCorrection = await getTxn(correctionTargetId);
  record('FDH6-CORRECT-02', 'Correction persisted (category_id changed), user_override=true, history retained', afterCorrection?.category_id === foodCat && afterCorrection?.user_override === true ? 'PASS' : 'FAIL', { before: beforeCorrection?.category_id, after: afterCorrection?.category_id, user_override: afterCorrection?.user_override });
  const globalRuleUnchanged = await sb(`/rest/v1/fdh_classification_rules?rule_key=eq.cash_atm_withdrawal_generic&select=*`);
  record('FDH6-CORRECT-03', "The global rule this transaction originally matched is completely unchanged by the user's personal correction (spec sections 13-14)", globalRuleUnchanged.json?.[0]?.action_definition?.economic_transaction_type === 'cash_withdrawal' ? 'PASS' : 'FAIL', globalRuleUnchanged.json?.[0]);

  // =========================================================================
  // §112 — Live split allocation (existing FDH-1 domain/schema, exercised live).
  // =========================================================================
  const [splitParent] = await insertTransactions([
    { user_id: userA.id, financial_account_id: tA1, transaction_date: '2026-08-13', description_raw: 'COSTCO WHOLESALE', description_clean: 'COSTCO WHOLESALE', amount_original: 300.0, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'FDH6-SPLIT-A' },
  ]);
  const allocA = await asUser(userA.accessToken, '/rest/v1/fdh_transaction_allocations', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userA.id, transaction_id: splitParent.id, allocation_sequence: 1, economic_transaction_type: 'expense', amount: 220.0, currency_code: 'AUD', note: 'Groceries share' },
  });
  const allocB = await asUser(userA.accessToken, '/rest/v1/fdh_transaction_allocations', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userA.id, transaction_id: splitParent.id, allocation_sequence: 2, economic_transaction_type: 'expense', amount: 80.0, currency_code: 'AUD', note: 'Household share' },
  });
  record('FDH6-SPLIT-01', 'Two split allocations created via the user\'s own RLS-scoped session (no service-role)', allocA.status === 201 && allocB.status === 201 ? 'PASS' : 'FAIL', { statusA: allocA.status, statusB: allocB.status });
  const allocationsRead = await sb(`/rest/v1/fdh_transaction_allocations?transaction_id=eq.${splitParent.id}&select=*`);
  const sum = (allocationsRead.json ?? []).reduce((s: number, a: { amount: number }) => s + Math.round(a.amount * 10000), 0) / 10000;
  record('FDH6-SPLIT-02', 'sum(allocations) EXACTLY equals the parent transaction amount (300.00), integer minor-unit arithmetic — spec sections 65-66', Math.abs(sum - 300) < 1e-9 ? 'PASS' : 'FAIL', { sum, expected: 300 });

  // =========================================================================
  // §111 — Live tenant attack (Tenant B against Tenant A's data).
  // =========================================================================
  const bReadA = await asUser(userB.accessToken, `/rest/v1/fdh_transactions?id=eq.${debitT.id}&select=*`);
  record('FDH6-SEC-01', "Tenant B cannot read Tenant A's transaction via RLS-scoped REST", (bReadA.json ?? []).length === 0 ? 'PASS' : 'FAIL', bReadA.json);

  const bClassify = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userB.cookie);
  const bTxnsAfter = await getUserTransactions(userB.id);
  record('FDH6-SEC-02', "Tenant B's own classify call touches only B's own (zero) transactions, never A's", bClassify.status === 200 && bTxnsAfter.length === 0 ? 'PASS' : 'FAIL', { status: bClassify.status, bTxnCount: bTxnsAfter.length });

  const bForgeReview = await appPostJson(`/api/financial-data-hub/transaction-links/${proposedLink!.id}/review`, userB.cookie, { decision: 'confirm' });
  record('FDH6-SEC-03', "Forged transfer-link review (Tenant B targets Tenant A's link_id) rejected", bForgeReview.status >= 400 ? 'PASS' : 'FAIL', { status: bForgeReview.status });

  const bForgeCorrection = await appPostJson(`/api/financial-data-hub/bank-transactions/${debitT.id}/correction`, userB.cookie, { field_name: 'economic_transaction_type', corrected_value: 'expense' });
  record('FDH6-SEC-04', "Forged correction (Tenant B targets Tenant A's transaction_id) rejected", bForgeCorrection.status >= 400 ? 'PASS' : 'FAIL', { status: bForgeCorrection.status });

  const bReadARules = await asUser(userB.accessToken, `/rest/v1/fdh_user_classification_rules?user_id=eq.${userA.id}&select=*`);
  record('FDH6-SEC-05', "Tenant B cannot read Tenant A's personal classification rules", (bReadARules.json ?? []).length === 0 ? 'PASS' : 'FAIL', bReadARules.json);

  const bReadASplits = await asUser(userB.accessToken, `/rest/v1/fdh_transaction_allocations?transaction_id=eq.${splitParent.id}&select=*`);
  record('FDH6-SEC-06', "Tenant B cannot read Tenant A's split allocations", (bReadASplits.json ?? []).length === 0 ? 'PASS' : 'FAIL', bReadASplits.json);

  const bForgeLinkInsert = await asUser(userB.accessToken, '/rest/v1/fdh_transaction_links', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userA.id, transaction_id_from: debitT.id, transaction_id_to: creditT.id, link_type: 'internal_transfer', status: 'confirmed', created_by_method: 'user_manual', user_confirmed: true },
  });
  record('FDH6-SEC-07', "Forged direct INSERT into fdh_transaction_links impersonating Tenant A (RLS with-check) rejected", bForgeLinkInsert.status >= 400 ? 'PASS' : 'FAIL', { status: bForgeLinkInsert.status });

  // =========================================================================
  // Cleanup — delete every synthetic user; verify cascade independently.
  // =========================================================================
  for (const uid of cleanup.users) {
    await sb(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
  }
  const residualTxnsA = await getUserTransactions(userA.id);
  const residualAccountsA = await sb(`/rest/v1/fdh_financial_accounts?user_id=eq.${userA.id}&select=id`);
  const userStillExists = await sb(`/auth/v1/admin/users/${userA.id}`);
  record('FDH6-CLEANUP-01', 'All synthetic transactions cascade-deleted with the user', residualTxnsA.length === 0 ? 'PASS' : 'FAIL', { residual: residualTxnsA.length });
  record('FDH6-CLEANUP-02', 'All synthetic accounts cascade-deleted with the user', (residualAccountsA.json ?? []).length === 0 ? 'PASS' : 'FAIL', residualAccountsA.json);
  record('FDH6-CLEANUP-03', 'Both synthetic auth users are genuinely gone (404 on lookup)', userStillExists.status === 404 ? 'PASS' : 'FAIL', { status: userStillExists.status });

  // =========================================================================
  // Summary
  // =========================================================================
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n===== FDH-6 LIVE DEV CERTIFICATION: ${pass} PASS, ${fail} FAIL (of ${results.length}) =====`);
  if (fail > 0) {
    console.log('FAILED CASES:', results.filter((r) => r.status === 'FAIL').map((r) => r.id).join(', '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
