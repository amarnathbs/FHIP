/**
 * FDH-8 — Financial Activity Experience: LIVE DEV certification (closure
 * spec Phase C/D). Talks to: (a) the real running Next.js app (started
 * separately with `next dev --webpack`) for every FDH-8 read and every
 * FDH-7 review/approval action, (b) the real DEV Supabase project via REST
 * with the service-role key for test-data SETUP and ground-truth
 * verification/cleanup only — mirrors the established shape of
 * `scripts/fdh6_live_dev_certification.ts` / `scripts/r7final_live_dev_certification.mjs`.
 *
 * Run: npx tsx scripts/fdh8_live_dev_certification.ts [appBaseUrl]
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

type Status = 'PASS' | 'FAIL' | 'INFO';
const results: { id: string; description: string; status: Status; detail?: unknown }[] = [];
let failCount = 0;
function record(id: string, description: string, status: Status, detail?: unknown) {
  results.push({ id, description, status, detail });
  if (status === 'FAIL') failCount += 1;
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
  const email = `fdh8-live-cert-${tag}-${stamp}@test.fhip.internal`;
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

async function insertAccount(userId: string, opts: { account_type?: string; country_code?: string; currency_code?: string; display_name: string }) {
  const r = await sb('/rest/v1/fdh_financial_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: opts.account_type ?? 'transaction', country_code: opts.country_code ?? 'AU', currency_code: opts.currency_code ?? 'AUD', display_name: opts.display_name, status: 'active' },
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
async function getCategoryId(nameLike: string, economicType: string): Promise<string> {
  const r = await sb(`/rest/v1/fdh_categories?display_name=ilike.*${encodeURIComponent(nameLike)}*&economic_type=eq.${economicType}&active=eq.true&select=id,display_name&limit=1`);
  const row = r.json?.[0];
  if (!row?.id) throw new Error(`no active '${economicType}' category matching '${nameLike}' found — cannot proceed`);
  return row.id as string;
}
async function insertLink(userId: string, from: string, to: string, linkType: string, status = 'pending') {
  const r = await sb('/rest/v1/fdh_transaction_links', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, transaction_id_from: from, transaction_id_to: to, link_type: linkType, status, created_by_method: 'system_rule' },
  });
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!row?.id) throw new Error(`link insert failed: ${r.text}`);
  return row.id as string;
}
async function insertDuplicateCandidate(userId: string, a: string, b: string) {
  const r = await sb('/rest/v1/fdh_duplicate_candidates', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, transaction_id_a: a, transaction_id_b: b, match_method: 'exact_hash', status: 'pending' },
  });
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!row?.id) throw new Error(`duplicate candidate insert failed: ${r.text}`);
  return row.id as string;
}
function approxEqual(a: number, b: number, eps = 0.005) { return Math.abs(a - b) < eps; }
/** Converts a boolean (or a value that IS one, incl. `false` sentinels for
 * "row not found") into a proper Status string — record()'s 3rd argument
 * must always be 'PASS'|'FAIL'|'INFO', never a raw boolean. */
function pf(cond: unknown): Status { return cond === true ? 'PASS' : 'FAIL'; }

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  // Environment identity proof (standing constraint) — printed once, no
  // secret values, just the project host so a human can visually confirm
  // this is the DEV project this whole program has used throughout.
  record('FDH8-ENV-00', `Target Supabase project host is ${new URL(BASE).host} (DEV, matches every prior FDH/II certification doc)`, 'INFO');

  const userA = await makeUser('a');
  const userB = await makeUser('b');
  record('FDH8-SETUP-USERS', 'Create two real authenticated DEV sessions (Tenant A, Tenant B)', 'PASS', `A=${userA.id} B=${userB.id}`);

  const acctA1 = await insertAccount(userA.id, { display_name: 'FDH8 A Everyday' });
  const acctA2 = await insertAccount(userA.id, { display_name: 'FDH8 A Savings', account_type: 'savings' });
  const acctB1 = await insertAccount(userB.id, { display_name: 'FDH8 B Everyday' });
  record('FDH8-SETUP-ACCOUNTS', 'Real accounts created for both tenants (2 accounts for A, satisfying spec Case 7 multi-account)', 'PASS', { acctA1, acctA2, acctB1 });

  // This DEV project's active category master uses top-level names ("Food &
  // Dining", "Housing") rather than the spec's illustrative "Groceries"/
  // "Household" example names — real, active, existing categories are used
  // rather than inventing new master-data rows (spec forbids adding
  // categories; the WORKED NUMBERS $220/$80/$300 are what is certified,
  // not the specific category label).
  const groceriesCat = await getCategoryId('Food & Dining', 'expense');
  const householdCat = await getCategoryId('Housing', 'expense');

  async function approveTxn(userCookie: string, id: string) {
    return appPostJson(`/api/financial-data-hub/bank-transactions/${id}/approve`, userCookie);
  }

  // =========================================================================
  // Live Case 1 — Approved Expense
  // =========================================================================
  const [c1] = await insertTransactions([
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-05', description_clean: 'FDH8 C1 Groceries', amount_original: 100.0, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', category_id: groceriesCat },
  ]);
  const approveC1 = await approveTxn(userA.cookie, c1.id as string);
  record('FDH8-C1-01', 'Real POST /approve succeeds for a clean expense', approveC1.status === 200 ? 'PASS' : 'FAIL', approveC1.json ?? approveC1.text.slice(0, 300));

  const ovC1 = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-07-01&to=2026-07-31`, userA.cookie);
  const c1Approved = ovC1.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
  record('FDH8-C1-02', 'Live FDH-8 overview reports Approved expense = $100.00 for this period', approxEqual(c1Approved?.expense_total ?? -1, 100) ? 'PASS' : 'FAIL', c1Approved);

  // =========================================================================
  // Live Case 2 — THE HIGHEST-PRIORITY CLOSURE TEST: Approved $4,250 + Pending $180
  // =========================================================================
  const period2 = { from: '2026-06-01', to: '2026-06-30' };
  const approvedRows2 = [
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-06-05', description_clean: 'FDH8 C2 Salary', amount_original: 4250.0, currency_original: 'AUD', credit_debit: 'credit', economic_transaction_type: 'income' },
  ];
  const [approvedC2] = await insertTransactions(approvedRows2);
  const approveC2 = await approveTxn(userA.cookie, approvedC2.id as string);
  record('FDH8-C2-01', 'Real POST /approve succeeds for the $4,250 income row', approveC2.status === 200 ? 'PASS' : 'FAIL', approveC2.json);

  const [pendingC2] = await insertTransactions([
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-06-10', description_clean: 'FDH8 C2 Unreviewed spend', amount_original: 180.0, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', category_id: groceriesCat, review_status: 'pending' },
  ]);
  // Deliberately NOT approved — approval_status remains its DB default
  // 'pending' (migration 0076). This is the actual live row FDH-8's
  // pending-disclosure query must pick up separately.
  record('FDH8-C2-02', 'The $180 row is left genuinely pending (never approved) — real live row', pendingC2.approval_status === 'pending' ? 'PASS' : 'FAIL', pendingC2);

  const ovC2 = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=${period2.from}&to=${period2.to}`, userA.cookie);
  const c2Approved = ovC2.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
  const c2Pending = ovC2.json?.data?.pending?.find((p: { currency_code: string }) => p.currency_code === 'AUD');
  record(
    'FDH8-C2-03 [MOST SCRUTINISED]',
    'Live FDH-8 API: Approved income = $4,250.00 exactly (not $4,430)',
    approxEqual(c2Approved?.income_total ?? -1, 4250) ? 'PASS' : 'FAIL',
    { income_total: c2Approved?.income_total, expense_total: c2Approved?.expense_total },
  );
  record(
    'FDH8-C2-04 [MOST SCRUTINISED]',
    'Live FDH-8 API: Pending review disclosed SEPARATELY as $180.00, not merged into approved',
    approxEqual(c2Pending?.expense_total ?? -1, 180) ? 'PASS' : 'FAIL',
    c2Pending,
  );
  record(
    'FDH8-C2-05 [MOST SCRUTINISED]',
    'Live FDH-8 API never produces the forbidden $4,430 figure anywhere in the response',
    JSON.stringify(ovC2.json).includes('4430') || JSON.stringify(ovC2.json).includes('4,430') ? 'FAIL' : 'PASS',
  );

  // Negative-control query variant — proves the test is non-vacuous. This
  // does NOT alter production code or RLS; it is an isolated query run only
  // in this script, using the service-role key so it can freely read across
  // approval_status (service-role bypasses RLS by design, same as every
  // other live-cert script in this codebase uses it for ground truth).
  const allC2 = await sb(`/rest/v1/fdh_transactions?user_id=eq.${userA.id}&transaction_date=gte.${period2.from}&transaction_date=lte.${period2.to}&select=amount_original,credit_debit,economic_transaction_type`);
  const negControlIncome = (allC2.json ?? [])
    .filter((t: { economic_transaction_type: string; credit_debit: string }) => t.economic_transaction_type === 'income')
    .reduce((sum: number, t: { amount_original: number }) => sum + Number(t.amount_original), 0);
  // The $180 row is economic_transaction_type='expense', not income, so the
  // literal same-currency income-side negative control is $4,250 either
  // way; the forbidden-number proof here is on the EXPENSE side instead —
  // dropping the approval_status filter merges the $180 pending expense
  // into what should be $0 approved expense for this period.
  const negControlExpense = (allC2.json ?? [])
    .filter((t: { economic_transaction_type: string }) => t.economic_transaction_type === 'expense')
    .reduce((sum: number, t: { amount_original: number }) => sum + Number(t.amount_original), 0);
  record(
    'FDH8-C2-06 NEGATIVE CONTROL',
    `Dropping the approval_status filter (raw query, this script only) WOULD wrongly include the $180 pending expense (raw sum=$${negControlExpense.toFixed(2)}) — proving the live test above is genuinely scoped, not vacuous`,
    approxEqual(negControlExpense, 180) && !approxEqual(c2Approved?.expense_total ?? -1, 180) ? 'PASS' : 'FAIL',
    { negControlExpense, negControlIncome, liveApprovedExpense: c2Approved?.expense_total ?? 0 },
  );

  // =========================================================================
  // Live Case 3 — Confirmed Transfer
  // =========================================================================
  const [debitT3, creditT3] = await insertTransactions([
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-12', description_clean: 'FDH8 C3 Transfer out', amount_original: 500.0, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'transfer' },
    { user_id: userA.id, financial_account_id: acctA2, transaction_date: '2026-07-12', description_clean: 'FDH8 C3 Transfer in', amount_original: 500.0, currency_original: 'AUD', credit_debit: 'credit', economic_transaction_type: 'transfer' },
  ]);
  const linkC3 = await insertLink(userA.id, debitT3.id as string, creditT3.id as string, 'internal_transfer', 'pending');
  const confirmC3 = await appPostJson(`/api/financial-data-hub/transaction-links/${linkC3}/review`, userA.cookie, { decision: 'confirm' });
  record('FDH8-C3-01', 'Real POST /transaction-links/{id}/review confirm succeeds for the transfer pair', confirmC3.status === 200 ? 'PASS' : 'FAIL', confirmC3.json);
  await approveTxn(userA.cookie, debitT3.id as string);
  await approveTxn(userA.cookie, creditT3.id as string);

  // Explicit, unambiguous transfer-exclusion assertion via getAccounts'
  // per-account view. The accounts API nests each account's activity row
  // under accounts[].activity (never a flat perAccount array) — flattened
  // here to a lookup by accountId.
  const acctsC3 = await appGet(`/api/financial-data-hub/activity/accounts?period=custom&from=2026-07-12&to=2026-07-12`, userA.cookie);
  type AcctActivityRow = { incomeTotal: number; expenseTotal: number; transferTotal: number };
  type AcctRow = { id: string; activity: AcctActivityRow[] };
  const acctsListC3 = (acctsC3.json?.data?.accounts ?? []) as AcctRow[];
  const a1Row = acctsListC3.find((r) => r.id === acctA1)?.activity?.[0];
  const a2Row = acctsListC3.find((r) => r.id === acctA2)?.activity?.[0];
  record('FDH8-C3-03', 'Transfer-out leg: Income=$0, Expense=$0 (never counted as spending)', a1Row ? (approxEqual(a1Row.incomeTotal, 0) && approxEqual(a1Row.expenseTotal, 0) ? 'PASS' : 'FAIL') : 'FAIL', a1Row);
  record('FDH8-C3-04', 'Transfer-in leg: Income=$0, Expense=$0 (never counted as income)', a2Row ? (approxEqual(a2Row.incomeTotal, 0) && approxEqual(a2Row.expenseTotal, 0) ? 'PASS' : 'FAIL') : 'FAIL', a2Row);

  // =========================================================================
  // Live Case 4 — Duplicate
  // =========================================================================
  // dedup_status: 'duplicate_candidate' is REQUIRED on both rows before a
  // fdh_duplicate_candidates row is created — migration 0064's own trigger
  // only permits dedup_status to move from 'duplicate_candidate' to a
  // 'user_confirmed_*' resolution, matching exactly how the real R8
  // detection pipeline sets both together (bank-csv/dedup.ts).
  const [dupA, dupB] = await insertTransactions([
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-15', description_clean: 'FDH8 C4 Coffee', amount_original: 6.5, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', category_id: groceriesCat, dedup_status: 'duplicate_candidate' },
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-15', description_clean: 'FDH8 C4 Coffee', amount_original: 6.5, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', category_id: groceriesCat, dedup_status: 'duplicate_candidate' },
  ]);
  const dupCandidate = await insertDuplicateCandidate(userA.id, dupA.id as string, dupB.id as string);
  const resolveDup = await appPostJson(`/api/financial-data-hub/bank-transactions/${dupA.id}/duplicate-resolution`, userA.cookie, { duplicate_candidate_id: dupCandidate, resolution: 'removed_b' });
  record('FDH8-C4-01', 'Real POST /duplicate-resolution succeeds (removed_b)', resolveDup.status === 200 ? 'PASS' : 'FAIL', resolveDup.json);
  await approveTxn(userA.cookie, dupA.id as string);
  const afterDupB = await getTxn(dupB.id as string);
  record('FDH8-C4-02', 'The removed duplicate (B) has dedup_status marking it excluded', pf(afterDupB?.dedup_status === 'user_confirmed_duplicate'), { dedup_status: afterDupB?.dedup_status });

  const ovC4 = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-07-15&to=2026-07-15&account_id=${acctA1}`, userA.cookie);
  const c4Approved = ovC4.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
  record('FDH8-C4-03', 'Duplicate counted ONCE — expense total for this day is $6.50, not $13.00', pf(c4Approved && approxEqual(c4Approved.expense_total, 6.5)), c4Approved);

  // =========================================================================
  // Live Case 5 — Refund
  // =========================================================================
  const [expenseC5, refundC5] = await insertTransactions([
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-18', description_clean: 'FDH8 C5 Purchase', amount_original: 100.0, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', category_id: groceriesCat },
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-19', description_clean: 'FDH8 C5 Refund', amount_original: 20.0, currency_original: 'AUD', credit_debit: 'credit', economic_transaction_type: 'refund', category_id: null },
  ]);
  const linkC5 = await insertLink(userA.id, refundC5.id as string, expenseC5.id as string, 'refund_original', 'pending');
  const confirmC5 = await appPostJson(`/api/financial-data-hub/transaction-links/${linkC5}/review`, userA.cookie, { decision: 'confirm' });
  record('FDH8-C5-01', 'Real POST refund link confirm succeeds', confirmC5.status === 200 ? 'PASS' : 'FAIL', confirmC5.json);
  await approveTxn(userA.cookie, expenseC5.id as string);
  await approveTxn(userA.cookie, refundC5.id as string);

  const ovC5 = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-07-18&to=2026-07-19&account_id=${acctA1}`, userA.cookie);
  const c5Approved = ovC5.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
  record('FDH8-C5-02', 'Refund nets against the original — expense total is $80.00 (FDH-7 oracle treatment, no separate FDH-8 refund arithmetic)', pf(c5Approved && approxEqual(c5Approved.expense_total, 80)), c5Approved);

  // =========================================================================
  // Live Case 6 — Split
  // =========================================================================
  const [splitTxn] = await insertTransactions([
    { user_id: userA.id, financial_account_id: acctA1, transaction_date: '2026-07-20', description_clean: 'FDH8 C6 Costco', amount_original: 300.0, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'unknown' },
  ]);
  const splitReq = await appPostJson(`/api/financial-data-hub/bank-transactions/${splitTxn.id}/split`, userA.cookie, {
    allocations: [
      { economic_transaction_type: 'expense', category_id: groceriesCat, amount: 220 },
      { economic_transaction_type: 'expense', category_id: householdCat, amount: 80 },
    ],
    finalize: true,
  });
  record('FDH8-C6-01', 'Real POST /split succeeds (Groceries $220 + Household $80 = $300)', splitReq.status === 200 ? 'PASS' : 'FAIL', splitReq.json ?? splitReq.text.slice(0, 300));

  // FIXED (migration 0085, 2026-08-25): splitTransaction() deliberately never
  // updates the PARENT row's economic_transaction_type (spec 44-48 — the
  // parent row is never altered by a split); fdh7_transaction_has_blocking_issue()
  // (migration 0076) used to block approval whenever economic_transaction_type
  // ='unknown' WITHOUT checking whether reconciled allocations already
  // existed, so a transaction split from an initially-uncategorised parent
  // could never be approved through the split action alone. Migration 0085
  // narrows that ONE check: 'unknown' no longer blocks approval when this
  // transaction's allocations already reconcile exactly to the parent
  // amount (every other blocking condition — no split, an incomplete/
  // mis-reconciled split, open review items, pending links/duplicates — is
  // completely unchanged). Reproduced live BEFORE the fix (real HTTP 409,
  // "this transaction has an unresolved review issue and cannot be approved
  // yet") and AFTER the fix (real HTTP 200, zero workaround) — see
  // scripts/_tmp_fdh8_c6_01b_repro.ts and the FDH8-C6 closure report. The
  // correction workaround this case used to require is no longer used here.
  const approveSplit = await approveTxn(userA.cookie, splitTxn.id as string);
  record('FDH8-C6-02', 'Split transaction approves cleanly via /approve alone — NO correction workaround (migration 0085 fix)', approveSplit.status === 200 ? 'PASS' : 'FAIL', approveSplit.json);

  // /spending returns { period, breakdown: CategoryBreakdownResult[] } — the
  // array is nested under `breakdown`, not returned directly.
  const spendC6 = await appGet(`/api/financial-data-hub/activity/spending?period=custom&from=2026-07-20&to=2026-07-20&account_id=${acctA1}`, userA.cookie);
  const spendResultC6 = spendC6.json?.data?.breakdown?.find((r: { currencyCode: string }) => r.currencyCode === 'AUD');
  const totalC6 = spendResultC6?.totalApproved;
  const groceriesRow = spendResultC6?.categories?.find((c: { categoryId: string }) => c.categoryId === groceriesCat);
  const householdRow = spendResultC6?.categories?.find((c: { categoryId: string }) => c.categoryId === householdCat);
  record('FDH8-C6-03', 'Total expense = $300.00 exactly (never $600 — the forbidden double-count)', approxEqual(totalC6 ?? -1, 300) ? 'PASS' : 'FAIL', { totalApproved: totalC6 });
  record('FDH8-C6-04', 'Groceries allocation = $220.00', pf(groceriesRow && approxEqual(groceriesRow.total, 220)), groceriesRow);
  record('FDH8-C6-05', 'Household allocation = $80.00', pf(householdRow && approxEqual(householdRow.total, 80)), householdRow);

  // =========================================================================
  // Live Case 7 — Multi-Account reconciliation (uses A1+A2 from Case 3)
  // =========================================================================
  // /accounts returns { period, household, accounts: [{ id, ..., activity:
  // AccountActivityRow[] }] } — per-account rows are nested under each
  // account's own `activity` array, never a flat top-level `perAccount`.
  const acctsC7 = await appGet(`/api/financial-data-hub/activity/accounts?period=custom&from=2026-07-01&to=2026-07-31`, userA.cookie);
  type AcctActivityRowC7 = { incomeTotal: number; expenseTotal: number };
  type AcctRowC7 = { id: string; activity: AcctActivityRowC7[] };
  const householdC7 = acctsC7.json?.data?.household?.find((h: { currency_code: string }) => h.currency_code === 'AUD');
  const acctsListC7 = (acctsC7.json?.data?.accounts ?? []) as AcctRowC7[];
  const perAcctRowsC7 = acctsListC7.flatMap((a) => a.activity ?? []);
  const perAcctSumIncome = perAcctRowsC7.reduce((s: number, r) => s + r.incomeTotal, 0);
  const perAcctSumExpense = perAcctRowsC7.reduce((s: number, r) => s + r.expenseTotal, 0);
  record(
    'FDH8-C7-01',
    'Household totals reconcile with the sum of all per-account totals (same fetched set, no drift between the two views)',
    pf(householdC7 && approxEqual(householdC7.income_total, perAcctSumIncome) && approxEqual(householdC7.expense_total, perAcctSumExpense)),
    { household: householdC7, perAcctSumIncome, perAcctSumExpense },
  );
  record('FDH8-C7-02', 'At least 2 real accounts are represented in the per-account breakdown', perAcctRowsC7.length >= 2 ? 'PASS' : 'FAIL', perAcctRowsC7.length);

  // =========================================================================
  // Live Case 8 — CSV path (real upload through the running app)
  // =========================================================================
  const FIXDIR = path.join(repoRoot, 'tests', 'fixtures', 'r7-bank-csv');
  let csvOk = false;
  try {
    const csvBytes = fs.readFileSync(path.join(FIXDIR, 'au_cba_debit_credit.csv'));
    const cbaInstRes = await sb('/rest/v1/fdh_financial_institutions?institution_code=eq.cba&country_code=eq.AU&select=id');
    const cbaInst = cbaInstRes.json?.[0]?.id ?? null;
    const upCsv = await uploadBytes('/api/financial-data-hub/bank-csv/upload', userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: cbaInst, masked_identifier: 'FDH8CSV', filename: 'fdh8-cba.csv' }, csvBytes, 'text/csv');
    const csvDocId = upCsv.json?.data?.document_id;
    record('FDH8-C8-01', 'Real CSV upload through the live app', upCsv.status === 200 && csvDocId ? 'PASS' : 'FAIL', { status: upCsv.status, csvDocId });
    if (csvDocId) {
      await appPostJson(`/api/financial-data-hub/bank-csv/${csvDocId}/detect`, userA.cookie);
      const procCsv = await appPostJson(`/api/financial-data-hub/bank-csv/${csvDocId}/process`, userA.cookie);
      record('FDH8-C8-02', 'CSV processed into real canonical transactions', procCsv.status === 200 ? 'PASS' : 'FAIL', procCsv.json?.data ?? procCsv.text.slice(0, 300));
      const classifyCsv = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
      record('FDH8-C8-03', 'FDH-6/R8 classification runs over CSV-sourced transactions', classifyCsv.status === 200 ? 'PASS' : 'FAIL', classifyCsv.json?.data);
      const csvTxnsRes = await sb(`/rest/v1/fdh_transactions?statement_upload_id=eq.${csvDocId}&select=id,economic_transaction_type,approval_status`);
      const csvTxns = (csvTxnsRes.json ?? []) as { id: string; economic_transaction_type: string; approval_status: string }[];
      let approvedAny = false;
      for (const t of csvTxns) {
        if (t.economic_transaction_type === 'unknown') continue;
        const res = await approveTxn(userA.cookie, t.id);
        if (res.status === 200) approvedAny = true;
      }
      record('FDH8-C8-04', 'At least one CSV-sourced transaction approved through the real FDH-7 approve endpoint', approvedAny ? 'PASS' : 'FAIL');
      const ovC8 = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-01-01&to=2026-12-31`, userA.cookie);
      record('FDH8-C8-05', 'FDH-8 overview loads without error after a CSV-sourced approval', ovC8.status === 200 ? 'PASS' : 'FAIL', { status: ovC8.status });
      csvOk = ovC8.status === 200;
    }
  } catch (e) {
    record('FDH8-C8-ERR', 'CSV path threw', 'FAIL', e instanceof Error ? e.message : String(e));
  }

  // =========================================================================
  // Live Case 9 — PDF path (real upload through the running app)
  // =========================================================================
  try {
    const { buildBankPdfFixture } = await import('../tests/support/buildBankPdfFixture');
    const pdfBytes = buildBankPdfFixture({
      brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
      columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
      openingBalanceLine: 'Opening Balance: $1,000.00',
      closingBalanceLine: 'Closing Balance: $940.00',
      transactions: [{ date: '2 Aug 2026', description: 'FDH8 C9 SALARY XYZ PTY LTD', amount: '60.00 DR', balance: '940.00' }],
    });
    const cbaInstRes = await sb('/rest/v1/fdh_financial_institutions?institution_code=eq.cba&country_code=eq.AU&select=id');
    const cbaInst = cbaInstRes.json?.[0]?.id ?? null;
    const upPdf = await uploadBytes('/api/financial-data-hub/bank-pdf/upload', userA.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: cbaInst, masked_identifier: 'FDH8PDF', filename: 'fdh8-cba.pdf' }, pdfBytes, 'application/pdf');
    const pdfDocId = upPdf.json?.data?.document_id;
    record('FDH8-C9-01', 'Real PDF upload through the live app', upPdf.status === 200 && pdfDocId ? 'PASS' : 'FAIL', { status: upPdf.status, pdfDocId });
    if (pdfDocId) {
      const procPdf = await appPostJson(`/api/financial-data-hub/bank-pdf/${pdfDocId}/process`, userA.cookie);
      record('FDH8-C9-02', 'PDF processed into real canonical transactions', procPdf.status === 200 ? 'PASS' : 'FAIL', procPdf.json?.data ?? procPdf.text.slice(0, 300));
      await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
      const pdfTxnsRes = await sb(`/rest/v1/fdh_transactions?statement_upload_id=eq.${pdfDocId}&select=id,economic_transaction_type`);
      const pdfTxns = (pdfTxnsRes.json ?? []) as { id: string; economic_transaction_type: string }[];
      let approvedAny = false;
      for (const t of pdfTxns) {
        if (t.economic_transaction_type === 'unknown') continue;
        const res = await approveTxn(userA.cookie, t.id);
        if (res.status === 200) approvedAny = true;
      }
      record('FDH8-C9-03', 'At least one PDF-sourced transaction approved through the real FDH-7 approve endpoint', approvedAny ? 'PASS' : 'FAIL');
      const ovC9 = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-01-01&to=2026-12-31`, userA.cookie);
      record('FDH8-C9-04', 'FDH-8 overview loads without error after a PDF-sourced approval', ovC9.status === 200 ? 'PASS' : 'FAIL', { status: ovC9.status });
      record('FDH8-C9-05', 'CSV and PDF paths both feed the SAME FDH-8 analytics surface (no format-specific FDH-8 branch)', csvOk && ovC9.status === 200 ? 'PASS' : 'INFO');
    }
  } catch (e) {
    record('FDH8-C9-ERR', 'PDF path threw', 'FAIL', e instanceof Error ? e.message : String(e));
  }

  // =========================================================================
  // Phase D — Live Tenant Isolation
  // =========================================================================
  const ovForged = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-01-01&to=2026-12-31&account_id=${acctA1}`, userB.cookie);
  const forgedApproved = ovForged.json?.data?.approved ?? [];
  record('FDH8-TENANT-01', 'Tenant B, forging Tenant A account_id, gets ZERO unauthorized aggregate contribution from FDH-8 overview', forgedApproved.length === 0 || forgedApproved.every((a: { approved_transaction_count: number }) => a.approved_transaction_count === 0) ? 'PASS' : 'FAIL', forgedApproved);

  const txnDirectB = await appGet(`/api/financial-data-hub/bank-transactions/${c1.id}`, userB.cookie);
  record('FDH8-TENANT-02', 'Tenant B direct access to a Tenant A transaction id is BLOCKED (404, RLS-enforced)', txnDirectB.status === 404 ? 'PASS' : 'FAIL', { status: txnDirectB.status });

  const txnsExplorerB = await appGet(`/api/financial-data-hub/activity/transactions?account_id=${acctA1}`, userB.cookie);
  const explorerRows = txnsExplorerB.json?.data?.transactions ?? [];
  record('FDH8-TENANT-03', 'Tenant B, forging Tenant A account_id in the Transaction Explorer, gets ZERO rows', explorerRows.length === 0 ? 'PASS' : 'FAIL', { count: explorerRows.length });

  const spendingB = await appGet(`/api/financial-data-hub/activity/spending?period=custom&from=2000-01-01&to=2099-12-31&account_id=${acctA1}`, userB.cookie);
  const spendingBRows = (spendingB.json?.data?.breakdown ?? []) as { categories: unknown[] }[];
  record('FDH8-TENANT-04', 'Tenant B spending breakdown for forged Tenant A account is empty', pf(spendingBRows.every((r) => (r.categories ?? []).length === 0)), spendingBRows);

  // Real-RLS-enforced direct REST check (anon key + Tenant B's own JWT — no
  // service-role bypass here) — complements the app-level checks above with
  // a check at the exact layer RLS operates.
  const directRestB = await asUser(userB.accessToken, `/rest/v1/fdh_transactions?id=eq.${c1.id}&select=id`);
  record('FDH8-TENANT-05', 'Direct PostgREST read of Tenant A row as Tenant B (real anon key + real user JWT, RLS enforced) returns 0 rows', Array.isArray(directRestB.json) && directRestB.json.length === 0 ? 'PASS' : 'FAIL', directRestB.json);

  // Control: Tenant B CAN see their own data (proves the isolation above is
  // not merely "nothing works").
  const [ownB] = await insertTransactions([
    { user_id: userB.id, financial_account_id: acctB1, transaction_date: '2026-07-01', description_clean: 'FDH8 Tenant B control row', amount_original: 42.0, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', category_id: groceriesCat },
  ]);
  await approveTxn(userB.cookie, ownB.id as string);
  const ovOwnB = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2026-07-01&to=2026-07-01`, userB.cookie);
  const ownBApproved = ovOwnB.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
  record('FDH8-TENANT-06 CONTROL', 'Tenant B genuinely CAN see their own approved data (isolation above is not blocking everything)', pf(ownBApproved && approxEqual(ownBApproved.expense_total, 42)), ownBApproved);

  // =========================================================================
  // Cleanup — delete every synthetic row this script created.
  // =========================================================================
  console.log('\n=== Cleanup ===');
  for (const uid of cleanup.users) {
    await sb(`/rest/v1/fdh_duplicate_candidates?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_transaction_links?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_transaction_allocations?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_transactions?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_document_audit_events?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_statement_uploads?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/rest/v1/fdh_financial_accounts?user_id=eq.${uid}`, { method: 'DELETE' });
    await sb(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
  }
  // Independent QUERY-based re-verification of cleanup (spec Phase R —
  // never trust cleanup script output alone).
  let orphanTxns = 0;
  let orphanUsers = 0;
  for (const uid of cleanup.users) {
    const t = await sb(`/rest/v1/fdh_transactions?user_id=eq.${uid}&select=id`);
    orphanTxns += (t.json ?? []).length;
    const u = await sb(`/auth/v1/admin/users/${uid}`);
    if (u.status === 200) orphanUsers += 1;
  }
  record('FDH8-CLEANUP-01', 'Independent re-query: 0 leftover FDH-8 certification transaction rows', orphanTxns === 0 ? 'PASS' : 'FAIL', { orphanTxns });
  record('FDH8-CLEANUP-02', 'Independent re-query: 0 leftover FDH-8 certification test users', orphanUsers === 0 ? 'PASS' : 'FAIL', { orphanUsers });

  console.log(`\n=== FDH-8 LIVE DEV CERTIFICATION: ${results.filter((r) => r.status === 'PASS').length} PASS, ${failCount} FAIL, ${results.filter((r) => r.status === 'INFO').length} INFO (of ${results.length}) ===`);
  fs.writeFileSync(path.join(repoRoot, 'scripts', 'fdh8-live-dev-cert-results.json'), JSON.stringify(results, null, 2));
  if (failCount > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
