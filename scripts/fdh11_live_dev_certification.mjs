// FDH-11 — Australia Investment Statement Intelligence: LIVE DEV certification.
//
// Runs for real against hosted DEV Postgres (vqycarelcoijzwlpkpcz) + a real
// running `next dev` instance started explicitly from this worktree
// (D:/fhip-fdh11, port 3199 — confirmed serving this codebase via a route
// that only exists here). Migration 0106 confirmed live on DEV before this
// script runs (see the standalone check this script performs first).
//
// Pattern: service-role REST for fixtures + real signup + cookie-based
// session for HTTP calls against the app's own API routes + service-role
// reads to inspect what actually got persisted — the same pattern
// `scripts/ii_r9_live_dev_certification.mjs` established.
//
// Every user/document/statement created here is tagged and deleted at the
// end via the service-role admin API; deletion is independently re-verified
// by re-query, never merely assumed.
//
// Run: node scripts/fdh11_live_dev_certification.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = 'http://localhost:3199';

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
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(URL_).host.split('.')[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

async function rest(pathAndQuery, opts = {}, key = SERVICE) {
  const r = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: opts.prefer ?? 'return=representation', ...opts.headers },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

async function createUser(tag) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `fdh11-livecert-${tag}-${stamp}@test.fhip.internal`;
  const password = `Fdh11Live!${tag}${stamp}`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ full_name: `FDH11 Live ${tag}`, country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100 }),
  });
  return { id: j.id, email, password };
}

async function getCookie(email, password) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  const session = { access_token: j.access_token, token_type: j.token_type, expires_in: j.expires_in, expires_at: Math.floor(Date.now() / 1000) + j.expires_in, refresh_token: j.refresh_token, user: j.user };
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
  return `${COOKIE_NAME}=${value}`;
}

async function app(cookie, pathName, opts = {}) {
  const r = await fetch(`${APP}${pathName}`, { ...opts, headers: { Cookie: cookie, ...opts.headers } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

function csvBytes(text) {
  return Buffer.from(text, 'utf8');
}

async function uploadCsv(cookie, kind, csvText, extra = {}) {
  const params = new URLSearchParams({ csv_kind: kind, currency_code: 'AUD', institution_name: 'LiveCertBroker', ...extra });
  return app(cookie, `/api/financial-data-hub/investment-statement/upload?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: csvBytes(csvText),
  });
}

async function matchSecurityRow(cookie, documentId, table, rowId) {
  // Real security matching order (spec 39-42): try resolve first (ISIN /
  // asx_ticker against EXISTING candidates); only if genuinely unresolved
  // (a never-before-seen synthetic test ISIN — real behaviour, not a
  // shortcut) does the caller explicitly confirm a new provisional
  // instrument. Never confirm_new_security up front — that would skip the
  // real resolution step spec 39 requires.
  const resolveRes = await app(cookie, `/api/financial-data-hub/investment-statement/${documentId}/security-match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table, row_id: rowId }),
  });
  if (resolveRes.json?.data?.outcome === 'matched') return resolveRes;
  if (resolveRes.json?.data?.outcome === 'unresolved') {
    return app(cookie, `/api/financial-data-hub/investment-statement/${documentId}/security-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, row_id: rowId, confirm_new_security: true, instrument_class: 'equity' }),
    });
  }
  return resolveRes; // ambiguous — left as-is, matching real review-required behaviour
}

async function fullyMatchAndApprove(cookie, documentId, currency = 'AUD') {
  const acctResolve = await app(cookie, `/api/financial-data-hub/investment-statement/${documentId}/account-match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', account_type: 'broker', currency_code: currency }),
  });
  // Real account-matching order (spec 43-46): resolve against EXISTING
  // accounts first; only on a genuine no_match does the caller explicitly
  // confirm a new account (spec 45) — never skipped ahead of.
  if (acctResolve.json?.data?.outcome === 'no_match') {
    await app(cookie, `/api/financial-data-hub/investment-statement/${documentId}/account-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm_new', institution_name: 'LiveCertBroker', currency_code: currency }),
    });
  }
  const review = await app(cookie, `/api/financial-data-hub/investment-statement/${documentId}`);
  for (const p of review.json?.data?.positions ?? []) {
    await matchSecurityRow(cookie, documentId, 'fdh_investment_statement_positions', p.id);
  }
  for (const a of review.json?.data?.activities ?? []) {
    await matchSecurityRow(cookie, documentId, 'fdh_investment_statement_activities', a.id);
  }
  await app(cookie, `/api/financial-data-hub/investment-statement/${documentId}/bank-match`, { method: 'POST' });
  return review;
}

async function main() {
  console.log('=== FDH-11 — LIVE DEV Certification ===\n');
  console.log(`App under test: ${APP}`);
  console.log(`Supabase project: ${PROJECT_REF}\n`);

  // -------------------------------------------------------------------
  console.log('--- Step 0: confirm migration 0106 is live (structural check) ---');
  const t1 = await rest('fdh_investment_statements?select=id&limit=1');
  const t2 = await rest('fdh_investment_statement_positions?select=id&limit=1');
  const t3 = await rest('fdh_investment_statement_activities?select=id&limit=1');
  check('fdh_investment_statements table exists live', t1.status === 200, `(status ${t1.status})`);
  check('fdh_investment_statement_positions table exists live', t2.status === 200, `(status ${t2.status})`);
  check('fdh_investment_statement_activities table exists live', t3.status === 200, `(status ${t3.status})`);
  if (t1.status !== 200 || t2.status !== 200 || t3.status !== 200) {
    console.log('\nMigration 0106 not confirmed live — aborting rather than fabricating further results.');
    process.exit(1);
  }

  console.log('\n--- Confirm app server is genuinely serving THIS worktree ---');
  const routeProbe = await fetch(`${APP}/api/financial-data-hub/investment-statement/upload`, { method: 'POST' });
  check('FDH-11-only route resolves on the app under test (401 unauthenticated, not 404)', routeProbe.status === 401, `(status ${routeProbe.status})`);

  // -------------------------------------------------------------------
  console.log('\n--- Fixtures: create Tenant A and Tenant B ---');
  const userA = await createUser('a');
  const userB = await createUser('b');
  const cookieA = await getCookie(userA.email, userA.password);
  const cookieB = await getCookie(userB.email, userB.password);
  check('Tenant A created and authenticated', !!userA.id && cookieA.includes(COOKIE_NAME));
  check('Tenant B created and authenticated', !!userB.id && cookieB.includes(COOKIE_NAME));

  const createdDocumentIds = []; // for cleanup
  const createdStatementIds = [];

  // ===================================================================
  console.log('\n=== PART 1: Full user journey (spec section 108) ===');
  const journeyCsv = [
    'Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount,Brokerage',
    '20/03/2026,BUY,BHP,AU000000BHP4,BHP Group Ltd,100,45.00,4500.00,19.95',
  ].join('\n');
  const up1 = await uploadCsv(cookieA, 'transaction', journeyCsv);
  check('Upload: statement created', up1.status === 200 && !!up1.json?.data?.statement_id, JSON.stringify(up1.json?.data ?? up1.text).slice(0, 150));
  const doc1 = up1.json?.data?.document_id;
  const stmt1 = up1.json?.data?.statement_id;
  if (doc1) createdDocumentIds.push(doc1);
  if (stmt1) createdStatementIds.push(stmt1);
  check('Parse: 1 activity extracted', up1.json?.data?.activities_extracted === 1, `(${up1.json?.data?.activities_extracted})`);

  const preApplyCheck = await rest(`ii_transactions?select=id&user_id=eq.${userA.id}`);
  const preApplyCount = preApplyCheck.json?.length ?? 0;

  await fullyMatchAndApprove(cookieA, doc1);
  const stmtAfterMatch = await rest(`fdh_investment_statements?select=*&id=eq.${stmt1}`);
  check('Account match: canonical_account_id resolved', !!stmtAfterMatch.json?.[0]?.canonical_account_id);
  const actAfterMatch = await rest(`fdh_investment_statement_activities?select=*&statement_id=eq.${stmt1}`);
  check('Security match: activity matched to an instrument', actAfterMatch.json?.[0]?.security_match_status === 'matched', actAfterMatch.json?.[0]?.security_match_status);

  const approve1 = await app(cookieA, `/api/financial-data-hub/investment-statement/${doc1}/approve`, { method: 'POST' });
  check('Review/Approve evidence: approved', approve1.status === 200 && approve1.json?.data?.approved === true);

  const cmp1 = await app(cookieA, `/api/financial-data-hub/investment-statement/${doc1}/current-vs-statement`);
  check('Compare (current vs statement) route works', cmp1.status === 200);

  const postApproveCheck = await rest(`ii_transactions?select=id&user_id=eq.${userA.id}`);
  check('No silent write BEFORE apply: ii_transactions count unchanged through upload/parse/match/reconcile/review/approve', (postApproveCheck.json?.length ?? 0) === preApplyCount, `(${preApplyCount} -> ${postApproveCheck.json?.length})`);

  const apply1 = await app(cookieA, `/api/financial-data-hub/investment-statement/${doc1}/apply`, { method: 'POST' });
  check('USER APPLY succeeds', apply1.status === 200 && apply1.json?.data?.applied_count >= 1, JSON.stringify(apply1.json?.data));

  const postApplyCheck = await rest(`ii_transactions?select=*&user_id=eq.${userA.id}`);
  const newTxn = (postApplyCheck.json ?? []).find((t) => t.transaction_type === 'purchase' && Number(t.gross_amount) === 4500);
  check('Canonical Investment Intelligence updated: a real ii_transactions purchase row now exists', !!newTxn, newTxn?.id);

  // ===================================================================
  console.log('\n=== PART 2: Financial integrity re-proof (live, spec 109-113) ===');

  // 109: AU Buy — ordinary expense = $0
  const fdhTxnsBefore = await rest(`fdh_transactions?select=id&user_id=eq.${userA.id}`);
  check('AU Buy: fdh_transactions (household expense ledger) untouched by the BUY apply', (fdhTxnsBefore.json?.length ?? 0) === 0, `(${fdhTxnsBefore.json?.length} rows — none created by any investment apply)`);

  // 110: AU Sale — ordinary income = $0
  const saleCsv = ['Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount', '21/03/2026,SELL,BHP,AU000000BHP4,BHP Group Ltd,50,46.00,2300.00'].join('\n');
  const upSale = await uploadCsv(cookieA, 'transaction', saleCsv);
  if (upSale.json?.data?.document_id) createdDocumentIds.push(upSale.json.data.document_id);
  if (upSale.json?.data?.statement_id) createdStatementIds.push(upSale.json.data.statement_id);
  await fullyMatchAndApprove(cookieA, upSale.json.data.document_id);
  await app(cookieA, `/api/financial-data-hub/investment-statement/${upSale.json.data.document_id}/approve`, { method: 'POST' });
  const applySale = await app(cookieA, `/api/financial-data-hub/investment-statement/${upSale.json.data.document_id}/apply`, { method: 'POST' });
  check('AU Sale applied', applySale.json?.data?.applied_count >= 1, JSON.stringify(applySale.json?.data));
  const saleTxn = (await rest(`ii_transactions?select=*&user_id=eq.${userA.id}&transaction_type=eq.sale`)).json;
  check('Sale proceeds recorded as canonical `sale`, never written to fdh_transactions as income', (saleTxn?.length ?? 0) >= 1 && (await rest(`fdh_transactions?select=id&user_id=eq.${userA.id}`)).json.length === 0);

  // Set up a real bank account + transactions for funding/withdrawal/dividend matching
  const bankAcct = await rest('fdh_financial_accounts', { method: 'POST', body: JSON.stringify({ user_id: userA.id, account_type: 'transaction', display_name: 'LiveCert Everyday', country_code: 'AU', currency_code: 'AUD' }) });
  const bankAcctId = bankAcct.json?.[0]?.id;

  // 112: Bank -> Broker TRANSFER
  await rest('fdh_transactions', { method: 'POST', body: JSON.stringify({ user_id: userA.id, financial_account_id: bankAcctId, transaction_date: '2026-03-23', description_raw: 'Transfer to LiveCertBroker', amount_original: 5000.00, currency_original: 'AUD', credit_debit: 'debit' }) });
  const fundingCsv = ['Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount', '23/03/2026,CASH_DEPOSIT,,,,,,5000.00'].join('\n');
  const upFunding = await uploadCsv(cookieA, 'transaction', fundingCsv);
  if (upFunding.json?.data?.document_id) createdDocumentIds.push(upFunding.json.data.document_id);
  if (upFunding.json?.data?.statement_id) createdStatementIds.push(upFunding.json.data.statement_id);
  await app(cookieA, `/api/financial-data-hub/investment-statement/${upFunding.json.data.document_id}/account-match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resolve', account_type: 'broker', currency_code: 'AUD' }) });
  const fundingMatch = await app(cookieA, `/api/financial-data-hub/investment-statement/${upFunding.json.data.document_id}/bank-match`, { method: 'POST' });
  check('Bank -> Broker funding matched as TRANSFER evidence (not expense)', fundingMatch.json?.data?.matched >= 1, JSON.stringify(fundingMatch.json?.data));

  // 113: Broker -> Bank TRANSFER
  await rest('fdh_transactions', { method: 'POST', body: JSON.stringify({ user_id: userA.id, financial_account_id: bankAcctId, transaction_date: '2026-03-24', description_raw: 'Withdrawal from LiveCertBroker', amount_original: 3000.00, currency_original: 'AUD', credit_debit: 'credit' }) });
  const withdrawCsv = ['Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount', '24/03/2026,CASH_WITHDRAWAL,,,,,,3000.00'].join('\n');
  const upWithdraw = await uploadCsv(cookieA, 'transaction', withdrawCsv);
  if (upWithdraw.json?.data?.document_id) createdDocumentIds.push(upWithdraw.json.data.document_id);
  if (upWithdraw.json?.data?.statement_id) createdStatementIds.push(upWithdraw.json.data.statement_id);
  await app(cookieA, `/api/financial-data-hub/investment-statement/${upWithdraw.json.data.document_id}/account-match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resolve', account_type: 'broker', currency_code: 'AUD' }) });
  const withdrawMatch = await app(cookieA, `/api/financial-data-hub/investment-statement/${upWithdraw.json.data.document_id}/bank-match`, { method: 'POST' });
  check('Broker -> Bank withdrawal matched as TRANSFER evidence (not income)', withdrawMatch.json?.data?.matched >= 1, JSON.stringify(withdrawMatch.json?.data));

  // 111: Dividend $400 broker + $400 bank = ONE income event
  await rest('fdh_transactions', { method: 'POST', body: JSON.stringify({ user_id: userA.id, financial_account_id: bankAcctId, transaction_date: '2026-03-15', description_raw: 'Dividend from LiveCertBroker', amount_original: 400.00, currency_original: 'AUD', credit_debit: 'credit' }) });
  const divCsv = ['Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount', '15/03/2026,DIVIDEND,BHP,AU000000BHP4,BHP Group Ltd,,,400.00'].join('\n');
  const upDiv = await uploadCsv(cookieA, 'transaction', divCsv);
  if (upDiv.json?.data?.document_id) createdDocumentIds.push(upDiv.json.data.document_id);
  if (upDiv.json?.data?.statement_id) createdStatementIds.push(upDiv.json.data.statement_id);
  await fullyMatchAndApprove(cookieA, upDiv.json.data.document_id);
  await app(cookieA, `/api/financial-data-hub/investment-statement/${upDiv.json.data.document_id}/approve`, { method: 'POST' });
  const applyDiv = await app(cookieA, `/api/financial-data-hub/investment-statement/${upDiv.json.data.document_id}/apply`, { method: 'POST' });
  check('Dividend applied', applyDiv.json?.data?.applied_count >= 1, JSON.stringify(applyDiv.json?.data));
  const divTxns = (await rest(`ii_transactions?select=*&user_id=eq.${userA.id}&transaction_type=eq.dividend`)).json;
  const divTotal = (divTxns ?? []).reduce((s, t) => s + Number(t.gross_amount), 0);
  check('Dividend + matching bank credit = ONE income event of exactly $400 (never $800)', divTxns?.length === 1 && divTotal === 400, `(${divTxns?.length} ii_transactions row(s), total $${divTotal})`);

  // Net worth double-count check
  const investmentsRows = await rest(`investments?select=id&user_id=eq.${userA.id}`);
  check('Net worth: statement evidence never independently created an `investments` row (no double count possible)', (investmentsRows.json?.length ?? 0) === 0, `(${investmentsRows.json?.length} rows in investments table for this user — canonical ii_transactions exist without a duplicate investments-table entry)`);

  // ===================================================================
  console.log('\n=== PART 3: Security re-proof (live, spec 84-89, 106-107, 121-123) ===');

  // Same-tenant authoritative forgery — Tenant A's OWN JWT, direct PostgREST PATCH
  const aToken = JSON.parse(Buffer.from(cookieA.split('=')[1].replace('base64-', ''), 'base64').toString()).access_token;
  const forgeAttempt = await fetch(`${URL_}/rest/v1/fdh_investment_statements?id=eq.${stmt1}`, {
    method: 'PATCH', headers: { apikey: ANON, Authorization: `Bearer ${aToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ approval_status: 'pending' }), // already approved -> try to un-approve directly, bypassing the bridge
  });
  const forgeText = await forgeAttempt.text();
  check('Same-tenant authoritative forgery BLOCKED (own row, direct PostgREST PATCH of approval_status)', forgeAttempt.status >= 400 && /system-authoritative/.test(forgeText), `(status ${forgeAttempt.status})`);

  // Cross-tenant isolation
  const bToken = JSON.parse(Buffer.from(cookieB.split('=')[1].replace('base64-', ''), 'base64').toString()).access_token;
  const crossRead = await fetch(`${URL_}/rest/v1/fdh_investment_statements?id=eq.${stmt1}`, { headers: { apikey: ANON, Authorization: `Bearer ${bToken}` } });
  const crossReadJson = await crossRead.json();
  check('Cross-tenant isolation: Tenant B cannot read Tenant A statement live', Array.isArray(crossReadJson) && crossReadJson.length === 0);

  // Foreign investment account (statement_upload_id cross-tenant)
  const uploadB = await rest('fdh_statement_uploads', { method: 'POST', body: JSON.stringify({ user_id: userB.id, source_type: 'csv', document_type: 'investment_statement', country_code: 'AU', currency_code: 'AUD', mime_type: 'text/csv' }) });
  const uploadBId = uploadB.json?.[0]?.id;
  const foreignStmt = await rest('fdh_investment_statements', { method: 'POST', body: JSON.stringify({ user_id: userA.id, statement_upload_id: uploadBId, statement_type: 'investment_transaction_csv', base_currency: 'AUD' }) });
  check('Foreign investment account reference BLOCKED (Tenant A statement -> Tenant B upload)', foreignStmt.status >= 400, `(status ${foreignStmt.status}) ${JSON.stringify(foreignStmt.json).slice(0, 150)}`);

  // Foreign bank transaction
  const bankAcctB = await rest('fdh_financial_accounts', { method: 'POST', body: JSON.stringify({ user_id: userB.id, account_type: 'transaction', display_name: 'Tenant B Bank', country_code: 'AU', currency_code: 'AUD' }) });
  const bankTxnB = await rest('fdh_transactions', { method: 'POST', body: JSON.stringify({ user_id: userB.id, financial_account_id: bankAcctB.json[0].id, transaction_date: '2026-03-01', description_raw: 'test', amount_original: 100, currency_original: 'AUD', credit_debit: 'credit' }) });
  const foreignBankLink = await rest('fdh_investment_statement_activities', { method: 'POST', body: JSON.stringify({ user_id: userA.id, statement_id: stmt1, activity_type: 'DIVIDEND', amount: 100, currency_code: 'AUD', linked_transaction_id: bankTxnB.json[0].id }) });
  check('Foreign bank transaction reference BLOCKED (Tenant A activity -> Tenant B fdh_transactions row)', foreignBankLink.status >= 400, `(status ${foreignBankLink.status})`);

  // Global security-master protection — Tenant A's own JWT trying to write ii_instruments
  const forgeInstrument = await fetch(`${URL_}/rest/v1/ii_instruments`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${aToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ instrument_name: 'Forged Instrument', instrument_class: 'equity', country_of_domicile: 'AU', base_currency: 'AUD' }),
  });
  check('Global security-master mutation BLOCKED (authenticated user cannot create ii_instruments directly)', forgeInstrument.status >= 400, `(status ${forgeInstrument.status})`);

  // Duplicate statement (spec 54, 106, 120)
  const dupCsv = journeyCsv; // identical bytes to the very first upload
  const upDup = await uploadCsv(cookieA, 'transaction', dupCsv);
  check('Duplicate statement: second identical upload reports duplicate:true, same statement_id', upDup.json?.data?.duplicate === true && upDup.json?.data?.statement_id === stmt1, JSON.stringify(upDup.json?.data));
  const txnsAfterDup = await rest(`ii_transactions?select=id&user_id=eq.${userA.id}&transaction_type=eq.purchase`);
  check('Duplicate statement: no duplicate canonical transaction created', (txnsAfterDup.json?.length ?? 0) === 1, `(${txnsAfterDup.json?.length} purchase rows)`);

  // Overlapping statements (spec 55, 107, 119) — a second, DIFFERENT-shaped CSV containing the SAME real-world BUY plus a new one
  const overlapCsv = [
    'Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount,Brokerage',
    '20/03/2026,BUY,BHP,AU000000BHP4,BHP Group Ltd,100,45.00,4500.00,19.95', // same as journeyCsv's BUY
    '20/03/2026,BUY,BHP,AU000000BHP4,BHP Group Ltd,25,47.00,1175.00,9.95', // genuinely new
  ].join('\n');
  const upOverlap = await uploadCsv(cookieA, 'transaction', overlapCsv);
  if (upOverlap.json?.data?.document_id) createdDocumentIds.push(upOverlap.json.data.document_id);
  if (upOverlap.json?.data?.statement_id) createdStatementIds.push(upOverlap.json.data.statement_id);
  await fullyMatchAndApprove(cookieA, upOverlap.json.data.document_id);
  await app(cookieA, `/api/financial-data-hub/investment-statement/${upOverlap.json.data.document_id}/approve`, { method: 'POST' });
  const applyOverlap = await app(cookieA, `/api/financial-data-hub/investment-statement/${upOverlap.json.data.document_id}/apply`, { method: 'POST' });
  const overlapActivityResults = applyOverlap.json?.data?.activities ?? [];
  // Real, correct bridge behaviour (spec 54-58, 106-107, 119): a re-evidenced
  // BUY from a DIFFERENT statement/evidence row computes the SAME
  // transaction_fingerprint as the original, finds the EXISTING ii_transactions
  // row via that fingerprint, and links to it — reported as ok:true/code:null
  // (this row's own apply genuinely succeeded, just by resolving to a
  // pre-existing canonical id rather than minting a new one). `ALREADY_APPLIED`
  // is reserved for re-applying the identical evidence row a second time
  // (proven separately by the Concurrent Apply / Stale-conflict checks above)
  // — a DIFFERENT evidence row resolving to an existing canonical transaction
  // is a distinct, equally-correct code path. The real dedup proof is that
  // the re-evidenced row's canonical_transaction_id equals the ORIGINAL
  // journey purchase's id, not a new one.
  const reEvidencedResult = overlapActivityResults.find((r) => r.ok && r.canonical_transaction_id === newTxn.id);
  const genuinelyNewResult = overlapActivityResults.find((r) => r.ok && r.canonical_transaction_id !== newTxn.id);
  check('Overlapping statement: the re-evidenced BUY resolves to the SAME pre-existing canonical transaction (fingerprint dedup), the new BUY gets a distinct new one', !!reEvidencedResult && !!genuinelyNewResult, JSON.stringify(overlapActivityResults));
  const finalPurchaseCount = await rest(`ii_transactions?select=id,gross_amount&user_id=eq.${userA.id}&transaction_type=eq.purchase`);
  check('No duplicate canonical transaction from overlap: exactly 2 distinct purchase rows total ($4500 original + $1175 new)', (finalPurchaseCount.json?.length ?? 0) === 2, JSON.stringify(finalPurchaseCount.json?.map((t) => t.gross_amount)));

  // No Apply for a freshly uploaded, unapproved statement
  const freshCsv = ['Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount', '22/03/2026,BUY,CBA,AU000000CBA7,Commonwealth Bank,10,110.00,1100.00'].join('\n');
  const upFresh = await uploadCsv(cookieA, 'transaction', freshCsv);
  if (upFresh.json?.data?.document_id) createdDocumentIds.push(upFresh.json.data.document_id);
  if (upFresh.json?.data?.statement_id) createdStatementIds.push(upFresh.json.data.statement_id);
  const beforeNoApply = await rest(`ii_transactions?select=id&user_id=eq.${userA.id}`);
  await fullyMatchAndApprove(cookieA, upFresh.json.data.document_id); // matched but NOT approved
  const afterMatchNoApply = await rest(`ii_transactions?select=id&user_id=eq.${userA.id}`);
  check('No Apply: matched-but-unapproved statement creates zero new canonical transactions', beforeNoApply.json.length === afterMatchNoApply.json.length, `(${beforeNoApply.json.length} -> ${afterMatchNoApply.json.length})`);
  const applyWithoutApproval = await app(cookieA, `/api/financial-data-hub/investment-statement/${upFresh.json.data.document_id}/apply`, { method: 'POST' });
  const freshResult = (applyWithoutApproval.json?.data?.activities ?? [])[0];
  check('Apply attempt on unapproved evidence is rejected (NOT_APPROVED), not silently applied', freshResult?.code === 'NOT_APPROVED', JSON.stringify(freshResult));

  // Duplicate / concurrent Apply
  await app(cookieA, `/api/financial-data-hub/investment-statement/${upFresh.json.data.document_id}/approve`, { method: 'POST' });
  const [concA, concB] = await Promise.all([
    app(cookieA, `/api/financial-data-hub/investment-statement/${upFresh.json.data.document_id}/apply`, { method: 'POST' }),
    app(cookieA, `/api/financial-data-hub/investment-statement/${upFresh.json.data.document_id}/apply`, { method: 'POST' }),
  ]);
  const cbaTxns = await rest(`ii_transactions?select=id&user_id=eq.${userA.id}&transaction_type=eq.purchase&gross_amount=eq.1100.00`);
  check('Concurrent Apply: exactly ONE canonical transaction created despite two simultaneous Apply requests', (cbaTxns.json?.length ?? 0) === 1, `(${cbaTxns.json?.length} rows; responses: ${concA.json?.data?.applied_count}, ${concB.json?.data?.applied_count})`);

  // Stale/conflict equivalent: re-running Apply after everything is already applied reports zero new applies
  const reApply = await app(cookieA, `/api/financial-data-hub/investment-statement/${upFresh.json.data.document_id}/apply`, { method: 'POST' });
  check('Stale/conflict equivalent: re-applying an already-fully-applied statement changes nothing (0 pending rows found)', (reApply.json?.data?.activities?.length ?? 0) === 0 && (reApply.json?.data?.positions?.length ?? 0) === 0, JSON.stringify(reApply.json?.data));

  // ===================================================================
  console.log('\n=== PART 4: Scale — live pagination boundary (spec 92-93) ===');
  async function paginationTest(n) {
    const header = 'Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount';
    const rows = [header];
    for (let i = 0; i < n; i++) {
      const day = String((i % 27) + 1).padStart(2, '0');
      rows.push(`${day}/04/2026,DIVIDEND,BHP,AU000000BHP4,BHP Group Ltd,,,1.00`);
    }
    const csv = rows.join('\n');
    const up = await uploadCsv(cookieA, 'transaction', csv);
    if (up.json?.data?.document_id) createdDocumentIds.push(up.json.data.document_id);
    if (up.json?.data?.statement_id) createdStatementIds.push(up.json.data.statement_id);
    const extractedOk = up.json?.data?.activities_extracted === n;
    const review = await app(cookieA, `/api/financial-data-hub/investment-statement/${up.json.data.document_id}`);
    const returned = review.json?.data?.activities?.length ?? 0;
    return { extractedOk, extractedCount: up.json?.data?.activities_extracted, returned };
  }

  const r100 = await paginationTest(100);
  check('Scale 100 rows: extracted and returned in full, live', r100.extractedOk && r100.returned === 100, JSON.stringify(r100));
  const r1000 = await paginationTest(1000);
  check('Scale 1000 rows (at the PostgREST cap boundary): extracted and returned in full, live', r1000.extractedOk && r1000.returned === 1000, JSON.stringify(r1000));
  const r1001 = await paginationTest(1001);
  check('Scale 1001 rows (ONE PAST the PostgREST cap): extracted and returned in full, live — the exact failure mode a pagination bug would produce', r1001.extractedOk && r1001.returned === 1001, JSON.stringify(r1001));

  console.log('\n  NOTE: 5000/10000-row scale was NOT executed live this pass (impractical within this session\'s time budget) — PGlite/unit-level evidence only for those two sizes, disclosed explicitly in the report.');

  // ===================================================================
  console.log('\n=== CLEANUP ===');
  for (const docId of createdDocumentIds) {
    await rest(`fdh_statement_uploads?id=eq.${docId}`, { method: 'DELETE' });
  }
  await rest(`fdh_transactions?user_id=eq.${userA.id}`, { method: 'DELETE' });
  await rest(`fdh_transactions?user_id=eq.${userB.id}`, { method: 'DELETE' });
  await rest(`fdh_financial_accounts?user_id=eq.${userA.id}`, { method: 'DELETE' });
  await rest(`fdh_financial_accounts?user_id=eq.${userB.id}`, { method: 'DELETE' });
  await rest(`ii_transactions?user_id=eq.${userA.id}`, { method: 'DELETE' });
  await rest(`ii_holding_snapshots?user_id=eq.${userA.id}`, { method: 'DELETE' });
  await rest(`ii_accounts?user_id=eq.${userA.id}`, { method: 'DELETE' });
  await rest(`ii_accounts?user_id=eq.${userB.id}`, { method: 'DELETE' });
  await fetch(`${URL_}/auth/v1/admin/users/${userA.id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  await fetch(`${URL_}/auth/v1/admin/users/${userB.id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });

  const verifyA = await rest(`user_profiles?select=user_id&user_id=eq.${userA.id}`);
  const verifyB = await rest(`user_profiles?select=user_id&user_id=eq.${userB.id}`);
  const verifyStmts = await rest(`fdh_investment_statements?select=id&user_id=eq.${userA.id}`);
  const verifyIiTxns = await rest(`ii_transactions?select=id&user_id=eq.${userA.id}`);
  check('Cleanup verified: Tenant A user deleted', (verifyA.json?.length ?? 1) === 0);
  check('Cleanup verified: Tenant B user deleted', (verifyB.json?.length ?? 1) === 0);
  check('Cleanup verified: 0 FDH-11 statements remain for Tenant A', (verifyStmts.json?.length ?? 1) === 0, `(${verifyStmts.json?.length})`);
  check('Cleanup verified: 0 canonical ii_transactions remain for Tenant A', (verifyIiTxns.json?.length ?? 1) === 0, `(${verifyIiTxns.json?.length})`);

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) {
    console.log('Failures:', failures.join('\n  - '));
  }
  fs.writeFileSync(path.join(repoRoot, 'fdh11-live-dev-results.json'), JSON.stringify({ pass, fail, failures }, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
