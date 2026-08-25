/**
 * FDH-8 — Financial Activity Experience: 5,000/10,000-row LIVE DEV scale
 * certification (closure spec Phases E/F/G).
 *
 * Generates a controlled synthetic dataset directly against the real DEV
 * Supabase project (service-role REST, matching the established setup
 * pattern of every other live-cert script in this codebase), independently
 * computes expected totals IN THIS SCRIPT (never by calling FDH-8's own
 * aggregation code), then hits the REAL running Next.js app's FDH-8 API
 * routes and asserts exact agreement.
 *
 * Run: npx tsx scripts/fdh8_scale_live_certification.ts [appBaseUrl]
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
  if (detail !== undefined) console.log(`        ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sb(p: string, opts: { method?: string; body?: unknown; prefer?: string; headers?: Record<string, string> } = {}): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const headers: Record<string, string> = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${BASE}${p}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function sbCount(p: string): Promise<number> {
  const res = await fetch(`${BASE}${p}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const range = res.headers.get('content-range'); // "0-0/12345"
  return range ? Number(range.split('/')[1]) : -1;
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

const stamp = Date.now();

async function makeUser(tag: string) {
  const email = `fdh8-scale-cert-${tag}-${stamp}@test.fhip.internal`;
  const password = 'TestPass!' + stamp + tag;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function insertAccount(userId: string, display_name: string) {
  const r = await sb('/rest/v1/fdh_financial_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name, status: 'active' },
  });
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!row?.id) throw new Error(`account insert failed: ${r.text}`);
  return row.id as string;
}
async function getCategoryIds(): Promise<{ groceries: string; household: string; fuel: string }> {
  async function one(nameLike: string) {
    const r = await sb(`/rest/v1/fdh_categories?display_name=ilike.*${encodeURIComponent(nameLike)}*&economic_type=eq.expense&active=eq.true&select=id&limit=1`);
    const row = r.json?.[0];
    if (!row?.id) throw new Error(`no category matching '${nameLike}'`);
    return row.id as string;
  }
  // Real, active category master names on this DEV project (top-level:
  // "Food & Dining", "Housing", "Transport") stand in for the spec's
  // illustrative "Groceries"/"Household"/"Fuel" example names.
  return { groceries: await one('Food & Dining'), household: await one('Housing'), fuel: await one('Transport') };
}
async function getMerchantId(nameLike: string): Promise<string | null> {
  const r = await sb(`/rest/v1/fdh_merchants?display_name=ilike.*${encodeURIComponent(nameLike)}*&active=eq.true&select=id&limit=1`);
  return r.json?.[0]?.id ?? null;
}

interface PlannedTxn {
  user_id: string; financial_account_id: string; transaction_date: string; description_clean: string;
  amount_original: number; currency_original: string; credit_debit: 'credit' | 'debit';
  economic_transaction_type: string; category_id: string | null; merchant_id: string | null;
  // Every key present on every row, even when null — PostgREST's bulk
  // insert rejects a batch whose objects don't all share the identical key
  // set ("All object keys must match"), so approved_at/approved_by must
  // never be conditionally OMITTED for pending rows, only set to null.
  approval_status: 'approved' | 'pending'; approved_at: string | null; approved_by: string | null;
}

/** Deterministically builds N transactions with a realistic mixture and
 * returns both the rows AND the independently-computed expected totals
 * (computed here with plain arithmetic, never via any FDH-8 code path). */
function buildDataset(n: number, userId: string, accountIds: string[], cats: { groceries: string; household: string; fuel: string }, merchantId: string | null) {
  const rows: PlannedTxn[] = [];
  let expectedApprovedIncome = 0;
  let expectedApprovedExpense = 0;
  let expectedPendingCount = 0;
  const expectedCategoryTotals: Record<string, number> = { [cats.groceries]: 0, [cats.household]: 0, [cats.fuel]: 0 };
  const expectedMerchantTotal = { total: 0, count: 0 };

  for (let i = 0; i < n; i += 1) {
    const day = 1 + (i % 27);
    const month = 1 + Math.floor(i / 27) % 12;
    const date = `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const account = accountIds[i % accountIds.length];
    const bucket = i % 10;
    const approved = bucket !== 9; // 10% pending — deterministic, exact-countable
    const isTransfer = bucket === 8;
    let type: string; let cat: string | null; let amount: number; let credit: 'credit' | 'debit'; let merch: string | null = null;

    if (bucket === 0) { type = 'income'; cat = null; amount = 3000 + (i % 5) * 10; credit = 'credit'; }
    else if (isTransfer) { type = 'transfer'; cat = null; amount = 50 + (i % 20); credit = i % 2 === 0 ? 'debit' : 'credit'; }
    else if (bucket === 7) { type = 'expense'; cat = cats.fuel; amount = 40 + (i % 15); credit = 'debit'; }
    else if (bucket % 2 === 0) { type = 'expense'; cat = cats.groceries; amount = 20 + (i % 30); credit = 'debit'; merch = merchantId; }
    else { type = 'expense'; cat = cats.household; amount = 15 + (i % 25); credit = 'debit'; }

    const row: PlannedTxn = {
      user_id: userId, financial_account_id: account, transaction_date: date,
      description_clean: `SCALE-${n}-${i}`, amount_original: Math.round(amount * 100) / 100, currency_original: 'AUD',
      credit_debit: credit, economic_transaction_type: type, category_id: cat, merchant_id: merch,
      approval_status: approved ? 'approved' : 'pending',
      approved_at: approved ? new Date().toISOString() : null,
      approved_by: approved ? userId : null,
    };
    rows.push(row);

    if (!approved) { expectedPendingCount += 1; continue; }
    if (type === 'income') expectedApprovedIncome += row.amount_original;
    else if (type === 'expense') {
      expectedApprovedExpense += row.amount_original;
      if (cat) expectedCategoryTotals[cat] = (expectedCategoryTotals[cat] ?? 0) + row.amount_original;
      if (merch) { expectedMerchantTotal.total += row.amount_original; expectedMerchantTotal.count += 1; }
    }
    // transfer contributes 0 to both by construction — never added anywhere.
  }
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    rows,
    expected: {
      approvedIncome: round2(expectedApprovedIncome),
      approvedExpense: round2(expectedApprovedExpense),
      netCashFlow: round2(expectedApprovedIncome - expectedApprovedExpense),
      pendingCount: expectedPendingCount,
      categoryTotals: Object.fromEntries(Object.entries(expectedCategoryTotals).map(([k, v]) => [k, round2(v)])),
      merchantTotal: round2(expectedMerchantTotal.total),
      merchantCount: expectedMerchantTotal.count,
    },
  };
}

async function insertInBatches(rows: PlannedTxn[], batchSize = 500) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const r = await sb('/rest/v1/fdh_transactions', { method: 'POST', prefer: 'return=minimal', body: batch });
    if (!r.ok) throw new Error(`batch insert failed at offset ${i}: ${r.text.slice(0, 500)}`);
  }
}

async function certifyScale(n: number, userId: string, cookie: string, accountIds: string[], cats: { groceries: string; household: string; fuel: string }, merchantId: string | null) {
  console.log(`\n=== Certifying at N=${n} ===`);
  const { rows, expected } = buildDataset(n, userId, accountIds, cats, merchantId);
  const t0 = Date.now();
  await insertInBatches(rows);
  console.log(`  inserted ${n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const groundTruthCount = await sbCount(`/rest/v1/fdh_transactions?user_id=eq.${userId}&description_clean=like.SCALE-${n}-*`);
  record(`FDH8-SCALE-${n}-01`, `Ground-truth count() confirms exactly ${n} rows were inserted (service-role, bypasses any app-layer cap)`, groundTruthCount === n ? 'PASS' : 'FAIL', { groundTruthCount });

  const from = '2025-01-01';
  const to = '2025-12-31';
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.02;
  const pf = (cond: unknown): Status => (cond === true ? 'PASS' : 'FAIL');

  const ov = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=${from}&to=${to}`, cookie);
  const approved = ov.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
  const pending = ov.json?.data?.pending?.find((p: { currency_code: string }) => p.currency_code === 'AUD');

  record(`FDH8-SCALE-${n}-02`, `Live FDH-8 overview: approved income EXACT ($${expected.approvedIncome.toFixed(2)})`, pf(approved && eq(approved.income_total, expected.approvedIncome)), { got: approved?.income_total, expected: expected.approvedIncome });
  record(`FDH8-SCALE-${n}-03`, `Live FDH-8 overview: approved expense EXACT ($${expected.approvedExpense.toFixed(2)})`, pf(approved && eq(approved.expense_total, expected.approvedExpense)), { got: approved?.expense_total, expected: expected.approvedExpense });
  record(`FDH8-SCALE-${n}-04`, `Live FDH-8 overview: net cash flow EXACT ($${expected.netCashFlow.toFixed(2)})`, pf(approved && eq(approved.net_cash_flow, expected.netCashFlow)), { got: approved?.net_cash_flow, expected: expected.netCashFlow });
  record(`FDH8-SCALE-${n}-05`, `Live FDH-8 overview: pending-review count EXACT (${expected.pendingCount})`, pf(pending ? pending.transaction_count === expected.pendingCount : expected.pendingCount === 0), { got: pending?.transaction_count, expected: expected.pendingCount });

  // /spending returns { period, breakdown: CategoryBreakdownResult[] }.
  const spend = await appGet(`/api/financial-data-hub/activity/spending?period=custom&from=${from}&to=${to}`, cookie);
  const spendAud = spend.json?.data?.breakdown?.find((r: { currencyCode: string }) => r.currencyCode === 'AUD');
  for (const [catId, expectedTotal] of Object.entries(expected.categoryTotals)) {
    const row = spendAud?.categories?.find((c: { categoryId: string }) => c.categoryId === catId);
    record(`FDH8-SCALE-${n}-06 cat=${catId.slice(0, 8)}`, `Category total EXACT ($${expectedTotal.toFixed(2)})`, pf(row && eq(row.total, expectedTotal)), { got: row?.total, expected: expectedTotal });
  }

  if (merchantId) {
    const merch = await appGet(`/api/financial-data-hub/activity/merchants?period=custom&from=${from}&to=${to}`, cookie);
    const merchAud = merch.json?.data?.merchants?.find((r: { currencyCode: string }) => r.currencyCode === 'AUD');
    const row = merchAud?.merchants?.find((m: { merchantId: string }) => m.merchantId === merchantId);
    record(`FDH8-SCALE-${n}-07`, `Merchant total EXACT ($${expected.merchantTotal.toFixed(2)}, ${expected.merchantCount} txns)`, pf(row && eq(row.totalSpent, expected.merchantTotal) && row.transactionCount === expected.merchantCount), { got: row, expected: expected.merchantTotal });
  }

  // Filters/search/sort/pagination at scale — Transaction Explorer.
  const explorerAll = await appGet(`/api/financial-data-hub/activity/transactions?limit=500&sort=newest`, cookie);
  record(`FDH8-SCALE-${n}-08`, `Transaction Explorer returns a full page (500) without error at N=${n} scale`, (explorerAll.json?.data?.transactions?.length ?? 0) === 500 || (explorerAll.json?.data?.transactions?.length ?? 0) === n ? 'PASS' : 'FAIL', { count: explorerAll.json?.data?.transactions?.length });

  const searchRes = await appGet(`/api/financial-data-hub/activity/transactions?search=SCALE-${n}-0&limit=10`, cookie);
  record(`FDH8-SCALE-${n}-09`, `Search filter narrows results at scale (search=SCALE-${n}-0 finds >=1 match)`, (searchRes.json?.data?.transactions?.length ?? 0) >= 1 ? 'PASS' : 'FAIL', { count: searchRes.json?.data?.transactions?.length });

  const accountFilterRes = await appGet(`/api/financial-data-hub/activity/transactions?account_id=${accountIds[0]}&limit=500`, cookie);
  const allSameAccount = (accountFilterRes.json?.data?.transactions ?? []).every((t: { financial_account_id: string }) => t.financial_account_id === accountIds[0]);
  record(`FDH8-SCALE-${n}-10`, `Account filter returns only that account's rows at scale`, pf(allSameAccount), { count: accountFilterRes.json?.data?.transactions?.length });

  const sortHighest = await appGet(`/api/financial-data-hub/activity/transactions?sort=highest&limit=50`, cookie);
  const amounts = (sortHighest.json?.data?.transactions ?? []).map((t: { amount_original: number }) => t.amount_original);
  const isSortedDesc = amounts.every((v: number, i: number) => i === 0 || amounts[i - 1] >= v);
  record(`FDH8-SCALE-${n}-11`, `Sort=highest is genuinely descending at scale`, isSortedDesc ? 'PASS' : 'FAIL', { first5: amounts.slice(0, 5) });

  return { rows, expected };
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  const user = await makeUser('scale');
  const acct1 = await insertAccount(user.id, 'FDH8 Scale Acct 1');
  const acct2 = await insertAccount(user.id, 'FDH8 Scale Acct 2');
  const cats = await getCategoryIds();
  const merchantId = await getMerchantId('woolworths') ?? await getMerchantId('coles');
  record('FDH8-SCALE-SETUP', 'Real DEV user + 2 accounts + categories + merchant resolved', 'PASS', { userId: user.id, acct1, acct2, cats, merchantId });

  await certifyScale(5000, user.id, user.cookie, [acct1, acct2], cats, merchantId);

  // Cleanup between runs so 10,000 starts from a clean, independently
  // countable slate (avoids the two runs' rows being conflated).
  await sb(`/rest/v1/fdh_transactions?user_id=eq.${user.id}`, { method: 'DELETE' });
  const midCount = await sbCount(`/rest/v1/fdh_transactions?user_id=eq.${user.id}`);
  record('FDH8-SCALE-MIDCLEAN', 'All 5,000-row fixtures deleted before starting the 10,000-row run', midCount === 0 ? 'PASS' : 'FAIL', { midCount });

  await certifyScale(10000, user.id, user.cookie, [acct1, acct2], cats, merchantId);

  // =========================================================================
  // Phase G — Pagination negative control. Re-derive the SAME query
  // fetchScopedTransactions() issues but artificially cap it at 1000 rows
  // (the PostgREST db-max-rows itself, i.e. simulate the PRE-FIX behaviour)
  // to prove the 10,000-row PASS above is not vacuous. This queries via
  // PostgREST directly with an explicit Range header capped at 999 (1000
  // rows), matching what the analytics module issued BEFORE this closure's
  // pagination fix.
  // =========================================================================
  const cappedRes = await fetch(`${BASE}/rest/v1/fdh_transactions?user_id=eq.${user.id}&approval_status=eq.approved&select=amount_original,economic_transaction_type&order=transaction_date.asc,id.asc`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Range: '0-999' },
  });
  const cappedRows = (await cappedRes.json()) as { amount_original: number; economic_transaction_type: string }[];
  const cappedExpense = cappedRows.filter((r) => r.economic_transaction_type === 'expense').reduce((s, r) => s + Number(r.amount_original), 0);
  // A SINGLE request, even with a huge Range header, does NOT bypass
  // PostgREST's server-side db-max-rows cap (it caps every response
  // regardless of what Range was requested) — a real multi-page walk is
  // required to see the true row set, exactly what fetchAllRows() does in
  // the app code. This mirrors that here rather than naively trusting one
  // wide Range request (an earlier version of this script made exactly
  // that mistake and reported a false "0 rows lost" — the capped and
  // "full" requests were BOTH silently truncated at 1,000, giving equal,
  // misleadingly-matching totals for the wrong reason).
  const fullRows: { amount_original: number; economic_transaction_type: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await fetch(`${BASE}/rest/v1/fdh_transactions?user_id=eq.${user.id}&approval_status=eq.approved&select=amount_original,economic_transaction_type&order=transaction_date.asc,id.asc`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Range: `${from}-${from + 999}` },
    });
    const rows = (await page.json()) as { amount_original: number; economic_transaction_type: string }[];
    fullRows.push(...rows);
    if (rows.length < 1000) break;
  }
  const fullExpense = fullRows.filter((r) => r.economic_transaction_type === 'expense').reduce((s, r) => s + Number(r.amount_original), 0);
  record(
    'FDH8-PAGINATION-NEGATIVE-CONTROL',
    `A query artificially capped at 1,000 rows (simulating the pre-fix behaviour) WOULD under-report expense ($${cappedExpense.toFixed(2)} vs true $${fullExpense.toFixed(2)}) — proving the fix (fetchAllRows) is genuinely load-bearing, not a no-op`,
    cappedRows.length === 1000 && fullRows.length > 1000 && Math.abs(cappedExpense - fullExpense) > 1 ? 'PASS' : 'FAIL',
    { cappedRowCount: cappedRows.length, fullRowCount: fullRows.length, cappedExpense, fullExpense },
  );
  const liveOv = await appGet(`/api/financial-data-hub/activity/overview?period=custom&from=2025-01-01&to=2025-12-31`, user.cookie);
  const liveApproved = liveOv.json?.data?.approved?.find((a: { currency_code: string }) => a.currency_code === 'AUD');
  record(
    'FDH8-PAGINATION-FIX-CONFIRMED',
    'The REAL live FDH-8 API (post-fix) matches the FULL 10,000-row ground truth, not the artificially-capped 1,000-row figure',
    liveApproved && Math.abs(liveApproved.expense_total - fullExpense) < 0.5 ? 'PASS' : 'FAIL',
    { liveExpense: liveApproved?.expense_total, fullGroundTruthExpense: fullExpense, cappedGroundTruthExpense: cappedExpense },
  );

  // Cleanup.
  console.log('\n=== Cleanup ===');
  await sb(`/rest/v1/fdh_transactions?user_id=eq.${user.id}`, { method: 'DELETE' });
  await sb(`/rest/v1/fdh_financial_accounts?user_id=eq.${user.id}`, { method: 'DELETE' });
  await sb(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
  const orphanCount = await sbCount(`/rest/v1/fdh_transactions?user_id=eq.${user.id}`);
  record('FDH8-SCALE-CLEANUP', 'Independent re-query: 0 leftover scale-certification rows', orphanCount === 0 ? 'PASS' : 'FAIL', { orphanCount });

  console.log(`\n=== FDH-8 SCALE CERTIFICATION: ${results.filter((r) => r.status === 'PASS').length} PASS, ${failCount} FAIL (of ${results.length}) ===`);
  fs.writeFileSync(path.join(repoRoot, 'scripts', 'fdh8-scale-live-cert-results.json'), JSON.stringify(results, null, 2));
  if (failCount > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
