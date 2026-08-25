/**
 * Standalone, minimal reproduction of FDH8-C6-01b — the split-transaction
 * approval gate defect. Run this script BEFORE the migration fix to prove
 * the failure, then AGAIN after the migration fix to prove success.
 *
 * Flow: create a real user, a real $300 'unknown'-typed parent transaction,
 * POST /split into $220 Groceries + $80 Household (finalize=true, no
 * correction workaround), then POST /approve directly. Reports the exact
 * DB/API rejection (BEFORE) or the exact approved total (AFTER).
 *
 * Run: npx tsx scripts/_tmp_fdh8_c6_01b_repro.ts [appBaseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3231';

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
async function appGet(pathname: string, cookie: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
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

const stamp = Date.now();
const cleanup = { users: [] as string[] };

async function makeUser(tag: string) {
  const email = `fdh8-c601b-repro-${tag}-${stamp}@test.fhip.internal`;
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
  return { id, email, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function insertAccount(userId: string) {
  const r = await sb('/rest/v1/fdh_financial_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'C6-01b Repro Everyday', status: 'active' },
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
async function getCategoryId(nameLike: string, economicType: string): Promise<string> {
  const r = await sb(`/rest/v1/fdh_categories?display_name=ilike.*${encodeURIComponent(nameLike)}*&economic_type=eq.${economicType}&active=eq.true&select=id,display_name&limit=1`);
  const row = r.json?.[0];
  if (!row?.id) throw new Error(`no active '${economicType}' category matching '${nameLike}' found — cannot proceed`);
  return row.id as string;
}
async function getTxn(id: string) {
  const r = await sb(`/rest/v1/fdh_transactions?id=eq.${id}&select=*`);
  return r.json?.[0] ?? null;
}

async function cleanupAll() {
  for (const uid of cleanup.users) {
    await sb(`/rest/v1/fdh_transaction_allocations?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_transactions?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_financial_accounts?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
  }
  let orphanTxns = 0;
  let orphanUsers = 0;
  for (const uid of cleanup.users) {
    const t = await sb(`/rest/v1/fdh_transactions?user_id=eq.${uid}&select=id`);
    orphanTxns += (t.json ?? []).length;
    const u = await sb(`/auth/v1/admin/users/${uid}`);
    if (u.status === 200) orphanUsers += 1;
  }
  console.log(`\n=== CLEANUP: orphan transactions=${orphanTxns}, orphan users=${orphanUsers} ===`);
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  const userA = await makeUser('a');
  const acctA1 = await insertAccount(userA.id);
  const groceriesCat = await getCategoryId('Food & Dining', 'expense');
  const householdCat = await getCategoryId('Housing', 'expense');
  console.log(`User A: ${userA.id}, Account: ${acctA1}`);

  const [splitTxn] = await insertTransactions([
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-20', description_clean: 'FDH8-C6-01b repro Costco', amount_original: 300.0, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'unknown' },
  ]);
  console.log(`\nParent transaction created: id=${splitTxn.id}, amount=$300.00, economic_transaction_type='unknown'`);

  const splitReq = await appPostJson(`/api/financial-data-hub/bank-transactions/${splitTxn.id}/split`, userA.cookie, {
    allocations: [
      { economic_transaction_type: 'expense', category_id: groceriesCat, amount: 220 },
      { economic_transaction_type: 'expense', category_id: householdCat, amount: 80 },
    ],
    finalize: true,
  });
  console.log(`\nPOST /split (Groceries $220 + Household $80 = $300, finalize=true): status=${splitReq.status}`);
  console.log(JSON.stringify(splitReq.json, null, 2));

  const parentAfterSplit = await getTxn(splitTxn.id as string);
  console.log(`\nParent row after split: economic_transaction_type='${parentAfterSplit?.economic_transaction_type}', approval_status='${parentAfterSplit?.approval_status}'`);

  console.log('\n--- Attempting POST /approve WITHOUT any correction workaround ---');
  const approveReq = await appPostJson(`/api/financial-data-hub/bank-transactions/${splitTxn.id}/approve`, userA.cookie);
  console.log(`POST /approve: status=${approveReq.status}`);
  console.log(JSON.stringify(approveReq.json, null, 2));

  const parentAfterApprove = await getTxn(splitTxn.id as string);
  console.log(`\nParent row after approve attempt: approval_status='${parentAfterApprove?.approval_status}'`);

  if (approveReq.status === 200 && parentAfterApprove?.approval_status === 'approved') {
    console.log('\n=== RESULT: APPROVE SUCCEEDED without workaround ===');
    const spend = await appGet(`/api/financial-data-hub/activity/spending?period=custom&from=2026-07-20&to=2026-07-20&account_id=${acctA1}`, userA.cookie);
    const row = spend.json?.data?.breakdown?.find((r: { currencyCode: string }) => r.currencyCode === 'AUD');
    const groceriesRow = row?.categories?.find((c: { categoryId: string }) => c.categoryId === groceriesCat);
    const householdRow = row?.categories?.find((c: { categoryId: string }) => c.categoryId === householdCat);
    console.log(`Approved expense total = $${row?.totalApproved}`);
    console.log(`Groceries allocation = $${groceriesRow?.total}`);
    console.log(`Household allocation = $${householdRow?.total}`);
    const overview = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-07-20&to=2026-07-20&account_id=${acctA1}`, userA.cookie);
    const ovApproved = overview.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
    console.log(`Overview approved.expense_total = $${ovApproved?.expense_total}`);
    console.log(`EXACT MATCH TO $300.00: ${row?.totalApproved === 300 || Math.abs((row?.totalApproved ?? -1) - 300) < 0.005 ? 'YES' : 'NO'}`);
  } else {
    console.log('\n=== RESULT: APPROVE REJECTED (this is the reproduced defect) ===');
  }

  await cleanupAll();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
