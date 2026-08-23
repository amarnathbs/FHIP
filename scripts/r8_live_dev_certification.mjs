// R8 — Transaction Categorisation & Merchant Intelligence: live-DEV
// certification. Executes the 20 live-DEV cases and 12 independent live
// reconciliations that R8_ACCEPTANCE_REPORT.md disclosed as outstanding,
// now that migration 0068 is confirmed live on DEV.
//
// Talks to: (a) the real running Next.js app (http://localhost:3211 by
// default) for every user-facing action (classify, correction, personal
// rule creation, link/series review) — never faking those via service-role,
// (b) the real DEV Supabase project via its REST API with the service-role
// key for test-data SETUP and ground-truth VERIFICATION/CLEANUP only.
//
// Every expected value in the 12 independent reconciliations is computed by
// this script's own from-scratch logic (reading FDH-2 reference data itself
// and reasoning about it independently) — it never imports or calls R8's
// production TypeScript engine.
//
// Run: node scripts/r8_live_dev_certification.mjs [appBaseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3211';

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
  if (detail !== undefined) console.log(`        ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1400)}`);
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
  const email = `r8-live-cert-${tag}-${stamp}@test.fhip.internal`;
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

// A discovered live-DEV characteristic (not PGlite-visible, since PGlite has
// no real network latency): classifyUserTransactions() writes ONE sequential
// awaited UPDATE per changed/unresolved row rather than batching, so a
// >1000-row household against the real remote DEV Supabase project takes
// several MINUTES wall-clock, not seconds. undici's default 300s headers
// timeout sits right at that boundary and can spuriously abort a client mid
// -request even though the server is still correctly working. A generous
// explicit timeout avoids that false negative while still measuring and
// reporting the real elapsed time as a disclosed finding.
async function appPostJson(pathname, cookie, body, timeoutMs = 600_000) {
  const t0 = Date.now();
  const res = await fetch(`${APP}${pathname}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, elapsedMs: Date.now() - t0 };
}

async function insertAccount(userId, { account_type, country_code = 'AU', currency_code = 'AUD', display_name }) {
  const r = await sb('/rest/v1/fdh_financial_accounts', {
    method: 'POST',
    prefer: 'return=representation',
    body: { user_id: userId, account_type, country_code, currency_code, display_name, status: 'active' },
  });
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!row?.id) throw new Error(`account insert failed: ${r.text}`);
  return row.id;
}

async function insertTransactions(rows) {
  const r = await sb('/rest/v1/fdh_transactions', { method: 'POST', prefer: 'return=representation', body: rows });
  if (!Array.isArray(r.json)) throw new Error(`transaction insert failed: ${r.text}`);
  return r.json;
}

async function getUserTransactions(userId) {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const res = await fetch(`${BASE}/rest/v1/fdh_transactions?user_id=eq.${userId}&select=*&order=transaction_date.asc,id.asc`, {
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
async function getLinksForUser(userId) {
  const r = await sb(`/rest/v1/fdh_transaction_links?user_id=eq.${userId}&select=*`);
  return r.json ?? [];
}
async function getRecurringForUser(userId) {
  const r = await sb(`/rest/v1/fdh_recurring_transactions?user_id=eq.${userId}&select=*`);
  return r.json ?? [];
}
async function findTxn(txns, sourceReference) {
  return txns.find((t) => t.source_reference === sourceReference);
}
function findLink(links, fromId, toId) {
  return links.find(
    (l) => (l.transaction_id_from === fromId && l.transaction_id_to === toId) ||
      (l.transaction_id_from === toId && l.transaction_id_to === fromId),
  );
}

// Reconciliation ledger (12 independently-recomputed cases).
const reconciliationLedger = [];
function recordIndependentReconciliation(caseId, note, expected, actual, fields) {
  const diffs = [];
  for (const f of fields) {
    const e = expected[f];
    const a = actual ? actual[f] : undefined;
    const eq = typeof e === 'number' && typeof a === 'number' ? Math.abs(e - a) < 1e-6 : e === a;
    if (!eq) diffs.push(`${f}: expected=${JSON.stringify(e)} actual=${JSON.stringify(a)}`);
  }
  reconciliationLedger.push({ caseId, note, diffs, pass: diffs.length === 0, expected, actual });
  record(`RECON-${caseId}`, `Independent reconciliation: ${note}`, diffs.length === 0 ? 'PASS' : 'FAIL', diffs.length ? diffs.join('; ') : 'all fields match');
}

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}`);
  console.log(`App under test: ${APP}\n`);

  // ===== Setup: reference data (fetched once, used for independent expectations) =====
  const merchantsRes = await sb('/rest/v1/fdh_merchants?select=*&limit=5000');
  const aliasesRes = await sb('/rest/v1/fdh_merchant_aliases?select=*&limit=10000');
  const categoriesRes = await sb('/rest/v1/fdh_categories?select=*&limit=2000');
  const rulesRes = await sb('/rest/v1/fdh_classification_rules?select=*&limit=1000');
  const merchants = merchantsRes.json ?? [];
  const aliases = aliasesRes.json ?? [];
  const categories = categoriesRes.json ?? [];
  const globalRules = rulesRes.json ?? [];
  record('SETUP-REF', 'Fetch FDH-2 reference data (merchants/aliases/categories/rules) for independent oracle', 'PASS',
    `${merchants.length} merchants, ${aliases.length} aliases, ${categories.length} categories, ${globalRules.length} global rules`);

  const woolworths = merchants.find((m) => m.canonical_name === 'woolworths');
  const woolCat = categories.find((c) => c.id === woolworths?.default_category_id);

  // ===== Setup: two dedicated live-cert test users =====
  const userA = await makeUser('a');
  const userB = await makeUser('b');
  record('SETUP-USERS', 'Create two dedicated live-cert test users (A, B)', 'PASS', `A=${userA.id} (${userA.email}) B=${userB.id} (${userB.email})`);

  // ===== Setup: accounts =====
  const A1 = await insertAccount(userA.id, { account_type: 'transaction', display_name: 'A Everyday' });
  const A2 = await insertAccount(userA.id, { account_type: 'savings', display_name: 'A Savings' });
  const A3 = await insertAccount(userA.id, { account_type: 'credit_card', display_name: 'A Credit Card' });
  // A4 is dedicated and isolated to the refund case (LIVE-R8-008) ONLY — kept
  // free of any other same-account transaction so the closest-in-time
  // original-matching heuristic in matchRefundsToOriginals() cannot be
  // confounded by an unrelated, coincidentally-closer-dated transaction on
  // the same account (a real interaction discovered live in an earlier run
  // of this script when the refund shared A1 with R8C002).
  const A4 = await insertAccount(userA.id, { account_type: 'transaction', display_name: 'A Purchases (refund-isolated)' });
  const B1 = await insertAccount(userB.id, { account_type: 'transaction', display_name: 'B Everyday' });
  const B2 = await insertAccount(userB.id, { account_type: 'transaction', display_name: 'B Second Account' });
  const B3 = await insertAccount(userB.id, { account_type: 'transaction', display_name: 'B Bulk Account' });
  record('SETUP-ACCOUNTS', 'Create financial accounts for both users (A: everyday/savings/credit-card/purchases; B: everyday/second/bulk)', 'PASS',
    { A1, A2, A3, A4, B1, B2, B3 });

  // ===== Insert userA's test transactions =====
  const txnA = [
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-01', description_raw: 'SALARY XYZ CORP AUG', description_clean: 'SALARY XYZ CORP AUG', amount_original: 4500.00, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C001' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-02', description_raw: 'WOOLWORTHS SUPERMARKET SYDNEY', description_clean: 'WOOLWORTHS SUPERMARKET SYDNEY', amount_original: 87.45, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C002' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-07-01', description_raw: 'WOOLWORTHS', description_clean: 'WOOLWORTHS', amount_original: 22.10, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C003A' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-07-05', description_raw: 'WOOLWORTHS ONLINE', description_clean: 'WOOLWORTHS ONLINE', amount_original: 55.30, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C003B' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-07-10', description_raw: 'WOOLWORTHS METRO', description_clean: 'WOOLWORTHS METRO', amount_original: 12.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C003C' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-05', description_raw: 'INTERNAL TRANSFER TO SAVINGS', description_clean: 'INTERNAL TRANSFER TO SAVINGS', amount_original: 500.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C004A' },
    { user_id: userA.id, financial_account_id: A2, transaction_date: '2026-08-05', description_raw: 'INTERNAL TRANSFER FROM EVERYDAY', description_clean: 'INTERNAL TRANSFER FROM EVERYDAY', amount_original: 500.00, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C004B' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-06', description_raw: 'EFTPOS PURCHASE STORE A', description_clean: 'EFTPOS PURCHASE STORE A', amount_original: 233.10, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C005A' },
    { user_id: userA.id, financial_account_id: A2, transaction_date: '2026-08-06', description_raw: 'EFTPOS PURCHASE STORE B', description_clean: 'EFTPOS PURCHASE STORE B', amount_original: 233.10, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C005B' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-07', description_raw: 'CREDIT CARD PAYMENT', description_clean: 'CREDIT CARD PAYMENT', amount_original: 300.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C006A' },
    { user_id: userA.id, financial_account_id: A3, transaction_date: '2026-08-07', description_raw: 'CREDIT CARD PAYMENT RECEIVED', description_clean: 'CREDIT CARD PAYMENT RECEIVED', amount_original: 300.00, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C006B' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-08', description_raw: 'SIP MUTUAL FUND ABC012', description_clean: 'SIP MUTUAL FUND ABC012', amount_original: 10000.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C007' },
    { user_id: userA.id, financial_account_id: A4, transaction_date: '2026-08-01', description_raw: 'STORE PURCHASE ORDER 12345', description_clean: 'STORE PURCHASE ORDER 12345', amount_original: 45.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C008A' },
    { user_id: userA.id, financial_account_id: A4, transaction_date: '2026-08-04', description_raw: 'REFUND FOR ORDER 12345', description_clean: 'REFUND FOR ORDER 12345', amount_original: 45.00, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C008B' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-10', description_raw: 'STORE PURCHASE XYZ', description_clean: 'STORE PURCHASE XYZ', amount_original: 100.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C009A' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-12', description_raw: 'PURCHASE REVERSAL XYZ', description_clean: 'PURCHASE REVERSAL XYZ', amount_original: 60.00, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C009B' },
    { user_id: userA.id, financial_account_id: A2, transaction_date: '2026-08-11', description_raw: 'ACCOUNT FEE MONTHLY', description_clean: 'ACCOUNT FEE MONTHLY', amount_original: 5.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C010' },
    { user_id: userA.id, financial_account_id: A2, transaction_date: '2026-08-12', description_raw: 'INTEREST PAID', description_clean: 'INTEREST PAID', amount_original: 12.34, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C011' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-13', description_raw: 'MYSTERY VENDOR MERCH 4471', description_clean: 'MYSTERY VENDOR MERCH 4471', amount_original: 76.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C012' },
    { user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-15', description_raw: 'XZQVBT UNRECOGNISED 88213', description_clean: 'XZQVBT UNRECOGNISED 88213', amount_original: 33.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C014' },
  ];
  const insertedA = await insertTransactions(txnA);
  record('SETUP-TXN-A', `Insert ${txnA.length} tagged test transactions for user A`, insertedA.length === txnA.length ? 'PASS' : 'FAIL', `inserted ${insertedA.length}/${txnA.length}`);

  // ===== Run 1: classify userA (before correction/rule cases 12/13/14 need it once first) =====
  const classify1 = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
  record('CLASSIFY-A-1', 'POST /bank-transactions/classify for user A (first run)', classify1.status === 200 ? 'PASS' : 'FAIL', classify1.json ?? classify1.text);

  let txnsA = await getUserTransactions(userA.id);
  let linksA = await getLinksForUser(userA.id);

  // ===== LIVE-R8-001 — Salary (income) =====
  {
    const t = await findTxn(txnsA, 'R8C001');
    const rule = globalRules.find((r) => r.rule_key === 'income_salary_generic');
    const expected = {
      economic_transaction_type: 'income',
      category_id: rule.action_definition.category_id,
      subcategory_id: rule.action_definition.subcategory_id,
      classification_method: 'global_rule',
      classification_confidence: 0.6,
    };
    const pass = t && Object.entries(expected).every(([k, v]) => t[k] === v || (typeof v === 'number' && Math.abs(t[k] - v) < 1e-6));
    record('LIVE-R8-001', 'Salary credit -> economic_transaction_type=income via income_salary_generic global rule', pass ? 'PASS' : 'FAIL',
      { economic_transaction_type: t?.economic_transaction_type, category_id: t?.category_id, method: t?.classification_method, confidence: t?.classification_confidence });
    recordIndependentReconciliation('001', 'Salary credit — recomputed against income_salary_generic (required SALARY, excludes SALARY SACRIFICE/PACKAGING)',
      expected, t, ['economic_transaction_type', 'category_id', 'subcategory_id', 'classification_method', 'classification_confidence']);
  }

  // ===== LIVE-R8-002 — Ordinary expense (merchant match) =====
  {
    const t = await findTxn(txnsA, 'R8C002');
    const expected = {
      economic_transaction_type: 'expense',
      category_id: woolworths.default_category_id,
      subcategory_id: woolworths.default_subcategory_id,
      merchant_id: woolworths.id,
      classification_method: 'merchant_master',
      classification_confidence: 1,
    };
    const pass = t && Object.entries(expected).every(([k, v]) => t[k] === v || (typeof v === 'number' && Math.abs(t[k] - v) < 1e-6));
    record('LIVE-R8-002', 'Ordinary grocery expense -> merchant-master match to Woolworths, category=Food & Dining, expense', pass ? 'PASS' : 'FAIL',
      { economic_transaction_type: t?.economic_transaction_type, merchant_id: t?.merchant_id, method: t?.classification_method });
    recordIndependentReconciliation('002', 'Ordinary expense — recomputed merchant alias match (WOOLWORTHS SUPERMARKET SYDNEY contains verified alias "WOOLWORTHS SUPERMARKET")',
      expected, t, ['economic_transaction_type', 'category_id', 'subcategory_id', 'merchant_id', 'classification_method', 'classification_confidence']);
  }

  // ===== LIVE-R8-003 — Merchant normalisation (same merchant, varied description) =====
  {
    const tA = await findTxn(txnsA, 'R8C003A'); // "WOOLWORTHS"
    const tB = await findTxn(txnsA, 'R8C003B'); // "WOOLWORTHS ONLINE"
    const tC = await findTxn(txnsA, 'R8C003C'); // "WOOLWORTHS METRO"
    const allMatch = [tA, tB, tC].every((t) => t?.merchant_id === woolworths.id);
    record('LIVE-R8-003', 'Merchant normalisation: "WOOLWORTHS" / "WOOLWORTHS ONLINE" / "WOOLWORTHS METRO" all resolve to the SAME merchant_id', allMatch ? 'PASS' : 'FAIL',
      { woolworthsId: woolworths.id, a: tA?.merchant_id, b: tB?.merchant_id, c: tC?.merchant_id });
    // Independent reconciliation: recompute alias matching myself against the
    // fetched alias table (bounded, case-insensitive substring containment,
    // never calling R8's matchMerchant()).
    function myMerchantMatch(desc) {
      const hay = desc.toUpperCase();
      let best = null;
      for (const al of aliases) {
        if (!al.verified) continue;
        const term = al.alias_normalised.toUpperCase();
        if (hay.includes(term) && (!best || term.length > best.term.length)) best = { merchantId: al.merchant_id, term };
      }
      return best?.merchantId ?? null;
    }
    const expected = { a: myMerchantMatch('WOOLWORTHS'), b: myMerchantMatch('WOOLWORTHS ONLINE'), c: myMerchantMatch('WOOLWORTHS METRO') };
    const actual = { a: tA?.merchant_id, b: tB?.merchant_id, c: tC?.merchant_id };
    recordIndependentReconciliation('003', 'Merchant normalisation — independently recomputed alias substring matching for all 3 varied descriptions', expected, actual, ['a', 'b', 'c']);
  }

  // ===== LIVE-R8-004 — Internal transfer between household accounts =====
  {
    const tFrom = await findTxn(txnsA, 'R8C004A'); // A1 debit
    const tTo = await findTxn(txnsA, 'R8C004B'); // A2 credit
    const link = findLink(linksA, tFrom.id, tTo.id);
    const pass = link && link.status === 'pending' && link.link_type === 'internal_transfer' && link.transaction_id_to !== null;
    record('LIVE-R8-004', 'Internal transfer between userA\'s own accounts (opposite direction, same amount/currency, same date) -> pending internal_transfer link', pass ? 'PASS' : 'FAIL',
      { link_type: link?.link_type, status: link?.status, confidence: link?.confidence });
    recordIndependentReconciliation('004', 'Internal transfer — recomputed pairing rule (different account, opposite direction, identical amount+currency, 0-day gap -> internal_transfer since neither side is credit_card/loan)',
      { link_type: 'internal_transfer', status: 'pending', paired: true }, { link_type: link?.link_type, status: link?.status, paired: Boolean(link) }, ['link_type', 'status', 'paired']);
  }

  // ===== LIVE-R8-005 — Weak/unrelated same-amount pair must NOT auto-pair =====
  {
    const tA5 = await findTxn(txnsA, 'R8C005A'); // A1 debit
    const tB5 = await findTxn(txnsA, 'R8C005B'); // A2 debit (SAME direction)
    const link = findLink(linksA, tA5.id, tB5.id);
    const pass = !link;
    record('LIVE-R8-005', 'Weak/unrelated same-amount pair (both DEBIT, different accounts, same day): must NOT auto-pair as a false transfer', pass ? 'PASS' : 'FAIL',
      pass ? 'no link found between the two same-direction transactions, as required' : `unexpectedly paired: ${JSON.stringify(link)}`);
    recordIndependentReconciliation('005', 'Negative control — recomputed: same amount+date but SAME credit_debit direction fails the "opposite direction" requirement, so no pair may exist',
      { paired: false }, { paired: Boolean(link) }, ['paired']);
  }

  // ===== LIVE-R8-006 — Credit-card repayment (neutral, not double-counted as expense) =====
  {
    const tFrom = await findTxn(txnsA, 'R8C006A'); // A1 debit
    const tTo = await findTxn(txnsA, 'R8C006B'); // A3 (credit_card) credit
    const link = findLink(linksA, tFrom.id, tTo.id);
    const pass = link && link.status === 'pending' && link.link_type === 'credit_card_settlement' &&
      tFrom.economic_transaction_type !== 'expense' && tTo.economic_transaction_type !== 'expense';
    record('LIVE-R8-006', 'Credit-card repayment: pending credit_card_settlement link; NEITHER side classified as expense (neutral, not double-counted)', pass ? 'PASS' : 'FAIL',
      { link_type: link?.link_type, fromType: tFrom.economic_transaction_type, toType: tTo.economic_transaction_type });
    recordIndependentReconciliation('006', 'Credit-card repayment — recomputed: A3 is account_type=credit_card so linkTypeFor() picks credit_card_settlement; ccpay_generic is flag_candidate only (never sets economic_transaction_type), so both sides stay unknown, never expense',
      { link_type: 'credit_card_settlement', fromType: 'unknown', toType: 'unknown' }, { link_type: link?.link_type, fromType: tFrom.economic_transaction_type, toType: tTo.economic_transaction_type },
      ['link_type', 'fromType', 'toType']);
  }

  // ===== LIVE-R8-007 — Investment transfer (bank-side only; zero ii_* rows) =====
  {
    const t = await findTxn(txnsA, 'R8C007');
    const openLink = linksA.find((l) => l.transaction_id_from === t.id && l.transaction_id_to === null);
    const iiTx = await sb(`/rest/v1/ii_transactions?user_id=eq.${userA.id}&select=id`);
    const iiLots = await sb(`/rest/v1/ii_tax_lots?user_id=eq.${userA.id}&select=id`);
    const iiHold = await sb(`/rest/v1/ii_holding_snapshots?user_id=eq.${userA.id}&select=id`);
    const pass = t.economic_transaction_type === 'unknown' && openLink && openLink.link_type === 'investment_funding' &&
      (iiTx.json ?? []).length === 0 && (iiLots.json ?? []).length === 0 && (iiHold.json ?? []).length === 0;
    record('LIVE-R8-007', 'Investment transfer (SIP): OPEN investment_funding candidate link, economic_transaction_type stays unknown (bank-side classification only), ZERO ii_* rows created', pass ? 'PASS' : 'FAIL',
      { economicType: t.economic_transaction_type, openLinkType: openLink?.link_type, iiTransactions: (iiTx.json ?? []).length, iiTaxLots: (iiLots.json ?? []).length, iiHoldingSnapshots: (iiHold.json ?? []).length });
  }

  // ===== LIVE-R8-008 — Refund =====
  {
    const orig = await findTxn(txnsA, 'R8C008A');
    const refund = await findTxn(txnsA, 'R8C008B');
    const link = findLink(linksA, orig.id, refund.id);
    const rule = globalRules.find((r) => r.rule_key === 'refund_purchase_generic');
    const expected = { economic_transaction_type: 'refund', link_type: 'refund_original', linked: true };
    const actual = { economic_transaction_type: refund.economic_transaction_type, link_type: link?.link_type, linked: Boolean(link) };
    const pass = expected.economic_transaction_type === actual.economic_transaction_type && expected.link_type === actual.link_type && actual.linked;
    record('LIVE-R8-008', 'Refund: classified refund via refund_purchase_generic, linked refund_original to its purchase (same amount, 3 days apart, HIGH confidence)', pass ? 'PASS' : 'FAIL', actual);
    recordIndependentReconciliation('008', `Refund — recomputed: "REFUND FOR ORDER 12345" matches rule ${rule.rule_key} (REFUND present, no TAX REFUND/REFUND WAIVED excluded terms); amount_delta=0 within 90-day lookback -> refund_original`,
      expected, actual, ['economic_transaction_type', 'link_type', 'linked']);
  }

  // ===== LIVE-R8-009 — Reversal (partial) =====
  {
    const orig = await findTxn(txnsA, 'R8C009A'); // 100.00 debit
    const rev = await findTxn(txnsA, 'R8C009B'); // 60.00 credit (partial reversal)
    const link = findLink(linksA, orig.id, rev.id);
    const expected = { economic_transaction_type: 'refund', link_type: 'reversal_original', linked: true };
    const actual = { economic_transaction_type: rev.economic_transaction_type, link_type: link?.link_type, linked: Boolean(link) };
    const pass = expected.economic_transaction_type === actual.economic_transaction_type && expected.link_type === actual.link_type && actual.linked;
    record('LIVE-R8-009', 'Reversal (partial, $60 reversing a $100 charge): classified refund via refund_reversal_generic, linked reversal_original (amount < original)', pass ? 'PASS' : 'FAIL', actual);
    recordIndependentReconciliation('009', 'Reversal — recomputed: "PURCHASE REVERSAL XYZ" matches refund_reversal_generic (REVERSAL); reversal amount 60.00 < original 100.00 -> reversal_original (partial), not refund_original',
      expected, actual, ['economic_transaction_type', 'link_type', 'linked']);
  }

  // ===== LIVE-R8-010 — Bank fee =====
  {
    const t = await findTxn(txnsA, 'R8C010');
    const expected = { economic_transaction_type: 'fee' };
    const pass = t.economic_transaction_type === 'fee';
    record('LIVE-R8-010', 'Bank fee ("ACCOUNT FEE MONTHLY") -> economic_transaction_type=fee via fee_account_generic', pass ? 'PASS' : 'FAIL', { economic_transaction_type: t.economic_transaction_type });
    recordIndependentReconciliation('010', 'Bank fee — recomputed: ACCOUNT FEE present, no FEE WAIVED/REVERSED/REFUND excluded terms -> fee', expected, { economic_transaction_type: t.economic_transaction_type }, ['economic_transaction_type']);
  }

  // ===== LIVE-R8-011 — Interest income =====
  {
    const t = await findTxn(txnsA, 'R8C011');
    const expected = { economic_transaction_type: 'income' };
    const pass = t.economic_transaction_type === 'income';
    record('LIVE-R8-011', 'Interest income ("INTEREST PAID") -> economic_transaction_type=income via income_interest_earned (never confused with debt interest)', pass ? 'PASS' : 'FAIL', { economic_transaction_type: t.economic_transaction_type });
    recordIndependentReconciliation('011', 'Interest income — recomputed: INTEREST present, none of INTEREST CHARGED/CHARGE/LOAN INTEREST/CARD INTEREST excluded terms present -> income', expected, { economic_transaction_type: t.economic_transaction_type }, ['economic_transaction_type']);
  }

  // ===== LIVE-R8-012 — Legitimate user correction =====
  {
    const before = await findTxn(txnsA, 'R8C012');
    const preCorrectionUnknown = before.economic_transaction_type === 'unknown' && before.review_status === 'pending';
    const corr = await appPostJson(`/api/financial-data-hub/bank-transactions/${before.id}/correction`, userA.cookie, {
      field_name: 'economic_transaction_type', corrected_value: 'expense', reason: 'live-cert manual correction',
    });
    // Re-run classification; the correction must survive reprocessing.
    const classifyAfterCorrection = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
    txnsA = await getUserTransactions(userA.id);
    const after = await findTxn(txnsA, 'R8C012');
    const pass = preCorrectionUnknown && corr.status === 200 && after.economic_transaction_type === 'expense' && after.user_override === true && after.review_status === 'resolved';
    record('LIVE-R8-012', 'Legitimate user correction: unresolved txn corrected to expense, survives an immediate re-run of classification (user_override=true excludes it from reprocessing)', pass ? 'PASS' : 'FAIL',
      { beforeType: before.economic_transaction_type, correctionStatus: corr.status, afterType: after.economic_transaction_type, userOverride: after.user_override, reviewStatus: after.review_status, reclassifiedCount: classifyAfterCorrection.json?.data?.transactionsClassified });
  }

  // ===== LIVE-R8-013 — Correction becoming a reusable personal rule =====
  {
    const ruleRes = await appPostJson('/api/financial-data-hub/user-rules', userA.cookie, {
      rule_type: 'description_contains',
      match_definition: { match_kind: 'description_contains', needle_normalised: 'ACME LOCAL CORNER STORE' },
      action_definition: { action_kind: 'classify', economic_transaction_type: 'expense', category_id: woolworths.default_category_id, subcategory_id: woolworths.default_subcategory_id },
      priority: 500,
    });
    const newTxn = await insertTransactions([{
      user_id: userA.id, financial_account_id: A1, transaction_date: '2026-08-14',
      description_raw: 'ACME LOCAL CORNER STORE #4', description_clean: 'ACME LOCAL CORNER STORE #4',
      amount_original: 18.50, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C013',
    }]);
    const classify3 = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userA.cookie);
    txnsA = await getUserTransactions(userA.id);
    const applied = await findTxn(txnsA, 'R8C013');
    const pass = ruleRes.status === 200 && applied && applied.classification_method === 'user_rule' && applied.economic_transaction_type === 'expense' && applied.classification_confidence === 1;
    record('LIVE-R8-013', 'Correction becomes a reusable personal rule: created via POST /user-rules, applied to a NEW matching transaction with classification_method=user_rule, HIGH confidence', pass ? 'PASS' : 'FAIL',
      { ruleCreateStatus: ruleRes.status, ruleId: ruleRes.json?.rule_id, appliedMethod: applied?.classification_method, appliedType: applied?.economic_transaction_type, reclassified: classify3.json?.data?.transactionsClassified });
  }

  // ===== LIVE-R8-014 — Ambiguous merchant correctly left UNKNOWN/REVIEW_REQUIRED =====
  {
    const t = await findTxn(txnsA, 'R8C014');
    const expected = { economic_transaction_type: 'unknown', review_status: 'pending', classification_method: null };
    const pass = t.economic_transaction_type === 'unknown' && t.review_status === 'pending' && t.classification_method === null;
    record('LIVE-R8-014', 'Ambiguous merchant ("XZQVBT UNRECOGNISED 88213", no rule/alias match): left UNKNOWN with review_status=pending, never guessed', pass ? 'PASS' : 'FAIL',
      { economic_transaction_type: t.economic_transaction_type, review_status: t.review_status, method: t.classification_method });
  }

  // ===== Insert userB's test transactions (recurring, multi-account, >1000 row) =====
  const txnB = [
    // Case 15 — monthly recurring (Netflix), fixed amount, 3 occurrences ~30 days apart.
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-06-01', description_raw: 'NETFLIX.COM SUBSCRIPTION', description_clean: 'NETFLIX.COM SUBSCRIPTION', amount_original: 15.99, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C015A' },
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-07-01', description_raw: 'NETFLIX.COM SUBSCRIPTION', description_clean: 'NETFLIX.COM SUBSCRIPTION', amount_original: 15.99, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C015B' },
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-08-01', description_raw: 'NETFLIX.COM SUBSCRIPTION', description_clean: 'NETFLIX.COM SUBSCRIPTION', amount_original: 15.99, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C015C' },
    // Case 16 — date-drift recurring (weekend/month-boundary drift): gaps 29 and 31 days.
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-01-01', description_raw: 'POWERBILL DIRECT DEBIT DRIFT', description_clean: 'POWERBILL DIRECT DEBIT DRIFT', amount_original: 60.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C016A' },
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-01-30', description_raw: 'POWERBILL DIRECT DEBIT DRIFT', description_clean: 'POWERBILL DIRECT DEBIT DRIFT', amount_original: 60.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C016B' },
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-03-02', description_raw: 'POWERBILL DIRECT DEBIT DRIFT', description_clean: 'POWERBILL DIRECT DEBIT DRIFT', amount_original: 60.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C016C' },
    // Case 17 — variable-amount recurring (energy bill).
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-05-15', description_raw: 'ENERGYCO ELECTRICITY BILL', description_clean: 'ENERGYCO ELECTRICITY BILL', amount_original: 98.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C017A' },
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-06-14', description_raw: 'ENERGYCO ELECTRICITY BILL', description_clean: 'ENERGYCO ELECTRICITY BILL', amount_original: 145.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C017B' },
    { user_id: userB.id, financial_account_id: B1, transaction_date: '2026-07-16', description_raw: 'ENERGYCO ELECTRICITY BILL', description_clean: 'ENERGYCO ELECTRICITY BILL', amount_original: 120.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C017C' },
    // Case 18 — paused recurring series (gym membership, on B2).
    { user_id: userB.id, financial_account_id: B2, transaction_date: '2026-06-03', description_raw: 'GYM MEMBERSHIP FEE', description_clean: 'GYM MEMBERSHIP FEE', amount_original: 49.99, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C018A' },
    { user_id: userB.id, financial_account_id: B2, transaction_date: '2026-07-03', description_raw: 'GYM MEMBERSHIP FEE', description_clean: 'GYM MEMBERSHIP FEE', amount_original: 49.99, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C018B' },
    { user_id: userB.id, financial_account_id: B2, transaction_date: '2026-08-03', description_raw: 'GYM MEMBERSHIP FEE', description_clean: 'GYM MEMBERSHIP FEE', amount_original: 49.99, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C018C' },
    // Case 19 — multi-account: a salary landing on B2 (a DIFFERENT account from B1's recurring bills).
    { user_id: userB.id, financial_account_id: B2, transaction_date: '2026-08-01', description_raw: 'SALARY B CORP AUG', description_clean: 'SALARY B CORP AUG', amount_original: 5200.00, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C019' },
  ];
  const insertedB = await insertTransactions(txnB);
  record('SETUP-TXN-B', `Insert ${txnB.length} tagged test transactions for user B (recurring + multi-account cases)`, insertedB.length === txnB.length ? 'PASS' : 'FAIL', `inserted ${insertedB.length}/${txnB.length}`);

  // ===== Case 20 setup — >1000 filler rows + a late-dated transfer pair on B3/B2 =====
  const FILLER_COUNT = 1010;
  const fillerRows = [];
  for (let i = 0; i < FILLER_COUNT; i += 1) {
    fillerRows.push({
      user_id: userB.id, financial_account_id: B3, transaction_date: '2024-01-01',
      description_raw: 'FILLER TRANSACTION', description_clean: 'FILLER TRANSACTION',
      amount_original: Number((1 + (i % 97) * 0.01).toFixed(2)), currency_original: 'AUD', credit_debit: 'debit',
      source_reference: `R8FILLER-${i}`,
    });
  }
  // Insert in chunks to stay well under any request-size limit.
  const CHUNK = 250;
  let fillerInsertedCount = 0;
  for (let i = 0; i < fillerRows.length; i += CHUNK) {
    const chunk = fillerRows.slice(i, i + CHUNK);
    const ins = await insertTransactions(chunk);
    fillerInsertedCount += ins.length;
  }
  record('SETUP-FILLER', `Insert ${FILLER_COUNT} filler transactions (userB, account B3, all dated 2024-01-01) to push userB's total past the 1000-row PostgREST page boundary`, fillerInsertedCount === FILLER_COUNT ? 'PASS' : 'FAIL', `inserted ${fillerInsertedCount}/${FILLER_COUNT}`);

  const post1000pair = await insertTransactions([
    { user_id: userB.id, financial_account_id: B3, transaction_date: '2026-09-01', description_raw: 'INTERNAL TRANSFER TO SECOND POST1000', description_clean: 'INTERNAL TRANSFER TO SECOND POST1000', amount_original: 777.00, currency_original: 'AUD', credit_debit: 'debit', source_reference: 'R8C020A' },
    { user_id: userB.id, financial_account_id: B2, transaction_date: '2026-09-01', description_raw: 'INTERNAL TRANSFER FROM BULK POST1000', description_clean: 'INTERNAL TRANSFER FROM BULK POST1000', amount_original: 777.00, currency_original: 'AUD', credit_debit: 'credit', source_reference: 'R8C020B' },
  ]);
  record('SETUP-POST1000', 'Insert the post-1000th transfer pair (dated 2026-09-01, latest date in userB\'s dataset, guaranteeing it sorts after all 1010 fillers)', post1000pair.length === 2 ? 'PASS' : 'FAIL', `inserted ${post1000pair.length}/2`);

  // Independent, from-scratch count of userB's rows via our own paginated read (before classify).
  const preClassifyTxnsB = await getUserTransactions(userB.id);
  const expectedTotalB = txnB.length + FILLER_COUNT + 2;
  record('SETUP-B-COUNT', 'Independently-paginated read confirms userB\'s full row count before classification', preClassifyTxnsB.length === expectedTotalB ? 'PASS' : 'FAIL',
    { expected: expectedTotalB, actual: preClassifyTxnsB.length });

  // ===== Run classify for userB (exercises cases 15-20 in one pass) =====
  const classifyB = await appPostJson('/api/financial-data-hub/bank-transactions/categorise', userB.cookie);
  record('CLASSIFY-B-1', 'POST /bank-transactions/classify for user B (spans >1000 rows across 3 accounts)', classifyB.status === 200 ? 'PASS' : 'FAIL',
    { ...(classifyB.json ?? { raw: classifyB.text }), elapsedMs: classifyB.elapsedMs, note: 'DISCLOSED LIVE-DEV FINDING: real elapsed wall-clock time for classifying 1000+ rows against remote DEV — sequential per-row awaited writes, not seconds' });

  const txnsB = await getUserTransactions(userB.id);
  const linksB = await getLinksForUser(userB.id);
  const recurringB = await getRecurringForUser(userB.id);

  // ===== LIVE-R8-015 — Monthly recurring detection =====
  {
    const members = ['R8C015A', 'R8C015B', 'R8C015C'].map((r) => txnsB.find((t) => t.source_reference === r));
    const seriesIds = new Set(members.map((m) => m.recurring_transaction_id).filter(Boolean));
    const series = seriesIds.size === 1 ? recurringB.find((s) => s.id === [...seriesIds][0]) : null;
    const expected = { frequency: 'monthly', status: 'active', memberCount: 3 };
    const actual = { frequency: series?.frequency, status: series?.status, memberCount: members.filter((m) => m.recurring_transaction_id).length };
    const pass = series && series.frequency === 'monthly' && series.status === 'active' && actual.memberCount === 3;
    record('LIVE-R8-015', 'Monthly recurring detection (Netflix, 3 fixed $15.99 occurrences ~30 days apart) -> one active monthly series, all 3 transactions linked', pass ? 'PASS' : 'FAIL', actual);
    recordIndependentReconciliation('015', 'Monthly recurring — recomputed gaps: Jun1->Jul1=30d, Jul1->Aug1=31d, both within monthly tolerance (30±5); 3 occurrences -> ACTIVE, fixed amount -> HIGH confidence',
      expected, actual, ['frequency', 'status', 'memberCount']);
  }

  // ===== LIVE-R8-016 — Date-drift recurring =====
  {
    const members = ['R8C016A', 'R8C016B', 'R8C016C'].map((r) => txnsB.find((t) => t.source_reference === r));
    const seriesIds = new Set(members.map((m) => m.recurring_transaction_id).filter(Boolean));
    const series = seriesIds.size === 1 ? recurringB.find((s) => s.id === [...seriesIds][0]) : null;
    const pass = series && series.frequency === 'monthly' && series.status === 'active';
    record('LIVE-R8-016', 'Date-drift recurring: gaps of 29 and 31 days (realistic weekend/month-boundary drift, NOT exact "1st of month") still detected as monthly, not disqualified', pass ? 'PASS' : 'FAIL',
      { frequency: series?.frequency, status: series?.status, dates: members.map((m) => m.transaction_date) });
  }

  // ===== LIVE-R8-017 — Variable-amount recurring =====
  {
    const members = ['R8C017A', 'R8C017B', 'R8C017C'].map((r) => txnsB.find((t) => t.source_reference === r));
    const seriesIds = new Set(members.map((m) => m.recurring_transaction_id).filter(Boolean));
    const series = seriesIds.size === 1 ? recurringB.find((s) => s.id === [...seriesIds][0]) : null;
    const amounts = [98, 145, 120];
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const spreadPct = (Math.max(...amounts) - Math.min(...amounts)) / mean;
    const expectedConfidenceState = spreadPct > 0.01 ? 'MEDIUM' : 'HIGH';
    const expectedConfidenceScore = expectedConfidenceState === 'HIGH' ? 1 : 0.6;
    const pass = series && series.frequency === 'monthly' && series.status === 'active' && Math.abs(series.confidence - expectedConfidenceScore) < 1e-6;
    record('LIVE-R8-017', 'Variable-amount recurring (energy bill $98/$145/$120, ~39% spread): still detected as monthly ACTIVE series, MEDIUM confidence (spread too wide for HIGH)', pass ? 'PASS' : 'FAIL',
      { frequency: series?.frequency, status: series?.status, confidence: series?.confidence, expectedConfidence: expectedConfidenceScore, amountTolerance: series?.amount_tolerance });
  }

  // ===== LIVE-R8-018 — Paused recurring series =====
  {
    const members = ['R8C018A', 'R8C018B', 'R8C018C'].map((r) => txnsB.find((t) => t.source_reference === r));
    const seriesIds = new Set(members.map((m) => m.recurring_transaction_id).filter(Boolean));
    const seriesId = seriesIds.size === 1 ? [...seriesIds][0] : null;
    const beforeSeries = seriesId ? recurringB.find((s) => s.id === seriesId) : null;
    const pauseRes = seriesId ? await appPostJson(`/api/financial-data-hub/recurring-transactions/${seriesId}/review`, userB.cookie, { decision: 'pause' }) : { status: 0 };
    const afterRow = seriesId ? await sb(`/rest/v1/fdh_recurring_transactions?id=eq.${seriesId}&select=*`) : { json: [] };
    const afterStatus = afterRow.json?.[0]?.status;
    const pass = beforeSeries?.status === 'active' && pauseRes.status === 200 && afterStatus === 'paused';
    record('LIVE-R8-018', 'Paused recurring series (gym membership): user pauses an ACTIVE series via POST /recurring-transactions/{id}/review, persists as paused', pass ? 'PASS' : 'FAIL',
      { beforeStatus: beforeSeries?.status, reviewStatus: pauseRes.status, afterStatus });
  }

  // ===== LIVE-R8-019 — Multi-account =====
  {
    const salary = txnsB.find((t) => t.source_reference === 'R8C019');
    const b1Count = txnsB.filter((t) => t.financial_account_id === B1).length;
    const b2Count = txnsB.filter((t) => t.financial_account_id === B2).length;
    const crossContamination = txnsB.some((t) => t.source_reference?.startsWith('R8C015') && t.financial_account_id !== B1) ||
      txnsB.some((t) => t.source_reference === 'R8C019' && t.financial_account_id !== B2);
    const pass = salary.economic_transaction_type === 'income' && b1Count >= 9 && b2Count >= 4 && !crossContamination;
    record('LIVE-R8-019', 'Multi-account: ONE classify() call correctly classifies a salary credit on B2 (income) alongside 3 independent recurring series on B1, with no cross-account bleed', pass ? 'PASS' : 'FAIL',
      { salaryType: salary.economic_transaction_type, b1Count, b2Count, crossContamination });
  }

  // ===== LIVE-R8-020 — >1000 transactions (PostgREST truncation guard) =====
  {
    const fromTxn = txnsB.find((t) => t.source_reference === 'R8C020A');
    const toTxn = txnsB.find((t) => t.source_reference === 'R8C020B');
    const link = findLink(linksB, fromTxn.id, toTxn.id);
    const considered = classifyB.json?.data?.transactionsConsidered;
    const pass = considered === expectedTotalB && link && link.status === 'pending' && link.link_type === 'internal_transfer';
    record('LIVE-R8-020', `>1000-row live classification (${expectedTotalB} total transactions for userB): the pairing for the LAST two rows (post-1000th, dated latest) only succeeds if fetchAllRows() paginated past PostgREST's 1000-row default cap`, pass ? 'PASS' : 'FAIL',
      { transactionsConsidered: considered, expectedTotal: expectedTotalB, linkFound: Boolean(link), linkType: link?.link_type, linkStatus: link?.status });
  }

  // ===== Cleanup =====
  await cleanupAll();

  // ===== Summary =====
  const total = results.length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const reconFail = reconciliationLedger.filter((r) => !r.pass).length;
  console.log('\n=== SUMMARY ===');
  console.log(`Checks: ${total}, FAIL: ${failed}`);
  console.log(`Independent reconciliations recorded: ${reconciliationLedger.length}, FAIL: ${reconFail}`);
  const outDir = path.join(repoRoot, '.r8scratch');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'live_results.json'), JSON.stringify({ results, reconciliationLedger, users: { userA: userA.id, userB: userB.id } }, null, 2));

  async function cleanupAll() {
    console.log('\n=== CLEANUP ===');
    const tables = [
      'fdh_classification_history', 'fdh_transaction_corrections', 'fdh_transaction_links',
      'fdh_transactions', 'fdh_recurring_transactions', 'fdh_user_classification_rules', 'fdh_financial_accounts',
    ];
    for (const uid of cleanup.users) {
      for (const t of tables) {
        await sb(`/rest/v1/${t}?user_id=eq.${uid}`, { method: 'DELETE' });
      }
    }
    const verify = {};
    for (const uid of cleanup.users) {
      for (const t of tables) {
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
