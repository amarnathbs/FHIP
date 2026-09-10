// LR-3 — real, live-DEV, end-to-end bank-statement import journey, driven
// through the ACTUAL Next.js API routes: upload -> detect -> process ->
// categorise -> (manual correction where needed) -> approve -> Dashboard.
// Mirrors scripts/fdh4_anz_adapter_live_closure_check.ts's cookie-auth
// pattern and scripts/lr9_account_deletion_live_dev_e2e.mjs's structure.
//
// PART A -- the PO's own exact oracle, in isolation:
//   Starting Monthly Expenses = $500 (manual, baseline)
//   Imported approved groceries = $200 (bank-derived, 'expense')
//   Manual $200 corresponding expense marked superseded_by_bank_import=true
//   Expected Monthly Expenses = $700 -- NOT $900 (double-count), NOT $500
//   (bank import silently ignored). Then a "reload" (second fetch) proves
//   the result is stable, not a one-time fluke.
//
// PART B -- refund / debt_principal / transfer, added on top of Part A's
//   state, each verified by real classification AND by the exact expected
//   delta on totalMonthlyExpenses (refund nets OUT, debt_principal and
//   transfer are excluded entirely, matching BANK_EXPENSE_TRANSACTION_TYPES'
//   own documented economics in lib/services/dashboardData.ts).
//
// PART C -- duplicate/overlapping transaction: re-uploading the exact same
//   groceries row as a second statement must not double-count it.
//
// Run: node scripts/lr3_bank_import_oracle_live_dev_e2e.mjs [appBaseUrl]
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3000';
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(SUPA_URL).host.split('.')[0];
const admin = createClient(SUPA_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const stamp = Date.now();
const results = [];
const check = (name, expected, actual) => { results.push({ name, expected, actual }); console.log(`[${JSON.stringify(expected) === JSON.stringify(actual) ? 'OK' : '!!'}] ${name} -> ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`); };

async function makeAuthedUser(tag) {
  const email = `lr3-oracle-${tag}-${stamp}@fhip-test.invalid`;
  const password = `Test-${stamp}-${tag}-Aa1!`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw new Error(`createUser(${tag}) failed: ${createErr.message}`);
  const id = created.user.id;
  const tokRes = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await tokRes.json();
  if (!session?.access_token) throw new Error(`sign-in(${tag}) failed: ${JSON.stringify(session)}`);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}
async function countryConfirm(userId) {
  const now = new Date().toISOString();
  const { error } = await admin.from('user_profiles').update({
    full_name: 'LR3 Oracle', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true,
    country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
  }).eq('user_id', userId);
  if (error) throw new Error(`country-confirm failed: ${error.message}`);
}
async function uploadCsv(cookie, meta, bytes) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const res = await fetch(`${APP}/api/financial-data-hub/bank-csv/upload?${qs.toString()}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/csv', 'Content-Length': String(bytes.byteLength) }, body: new Uint8Array(bytes),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
async function appPost(pathname, cookie, body) {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json };
}
async function appGet(pathname, cookie) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json };
}
async function getInstitutionId(code, country) {
  const { data } = await admin.from('fdh_financial_institutions').select('id').eq('institution_code', code).eq('country_code', country).maybeSingle();
  return data?.id ?? null;
}
// Current-calendar-month dates (dashboardData.ts only counts the current month).
const now = new Date();
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const yyyy = now.getUTCFullYear();
function dOf(day) { return `${String(day).padStart(2, '0')}/${mm}/${yyyy}`; } // DD/MM/YYYY, ANZ format

let uidC, doc1Id, doc2Id, doc3Id;

try {
  console.log(`DEV project: ${new URL(SUPA_URL).host}`);
  console.log(`App under test: ${APP}`);
  console.log(`Using transaction month: ${yyyy}-${mm}\n`);

  const userC = await makeAuthedUser('c');
  uidC = userC.id;
  await countryConfirm(uidC);
  const anzInst = await getInstitutionId('anz', 'AU');
  if (!anzInst) throw new Error('ANZ institution not found in fdh_financial_institutions');

  // ============ PART A: the PO's own exact oracle ============
  console.log('=== PART A: $500 baseline + $200 bank import + $200 excluded manual = $700 ===');

  const { error: e1 } = await admin.from('expense_items').insert({
    user_id: uidC, expense_name: 'LR3 Oracle baseline expenses', expense_category: 'other', amount: 500, frequency: 'monthly', currency_code: 'AUD', superseded_by_bank_import: false,
  });
  if (e1) throw new Error(`seed baseline expense failed: ${e1.message}`);
  const { error: e2 } = await admin.from('expense_items').insert({
    user_id: uidC, expense_name: 'LR3 Oracle groceries (now tracked via bank import)', expense_category: 'food', amount: 200, frequency: 'monthly', currency_code: 'AUD', superseded_by_bank_import: true,
  });
  if (e2) throw new Error(`seed superseded expense failed: ${e2.message}`);
  console.log('Seeded manual expenses: $500 (counted) + $200 (superseded, excluded)');

  const csv1 = Buffer.from(
    `Date,Transaction Description,Debit Amount,Credit Amount,Balance\n${dOf(1)},Coles Supermarket,200.00,,4800.00\n`
  );
  const up1 = await uploadCsv(userC.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: anzInst, masked_identifier: 'LR3ORCL1', filename: 'lr3-oracle-groceries.csv' }, csv1);
  check('Part A upload succeeds', 200, up1.status);
  doc1Id = up1.json?.data?.document_id;

  const det1 = await appPost(`/api/financial-data-hub/bank-csv/${doc1Id}/detect`, userC.cookie);
  check('Part A detect succeeds, ANZ adapter resolved', 'au_anz_debit_credit_v1', det1.json?.data?.adapter_key);

  const proc1 = await appPost(`/api/financial-data-hub/bank-csv/${doc1Id}/process`, userC.cookie);
  check('Part A process creates exactly 1 transaction', 1, proc1.json?.data?.transactions_created);

  const cat1 = await appPost('/api/financial-data-hub/bank-transactions/categorise', userC.cookie);
  check('Part A categorise succeeds', 200, cat1.status);

  const { data: doc1Txns } = await admin.from('fdh_transactions').select('id, description_clean, economic_transaction_type').eq('user_id', uidC).eq('statement_upload_id', doc1Id);
  check('Part A groceries transaction auto-classified as expense', 'expense', doc1Txns?.[0]?.economic_transaction_type);
  const groceriesTxnId = doc1Txns?.[0]?.id;

  const appr1 = await appPost('/api/financial-data-hub/bank-transactions/bulk-approve', userC.cookie, { transaction_ids: [groceriesTxnId] });
  check('Part A approve succeeds', 200, appr1.status);

  const dash1 = await appGet('/api/dashboard/summary', userC.cookie);
  check('Part A totalMonthlyExpenses = $700 (not $900 double-counted, not $500 bank-import-ignored)', 700, dash1.json?.data?.totalMonthlyExpenses);
  check('Part A totalMonthlyExpenses is NOT $900', false, dash1.json?.data?.totalMonthlyExpenses === 900);
  check('Part A totalMonthlyExpenses is NOT $500', false, dash1.json?.data?.totalMonthlyExpenses === 500);
  check('Part A bankMonthlyExpenses = $200', 200, dash1.json?.data?.bankMonthlyExpenses);

  // "Reload" -- fetch again, confirm stable, not a one-time fluke.
  const dash1Reload = await appGet('/api/dashboard/summary', userC.cookie);
  check('Part A RELOAD: totalMonthlyExpenses still $700 on a second fetch', 700, dash1Reload.json?.data?.totalMonthlyExpenses);

  // ============ PART B: refund / debt_principal / transfer ============
  console.log('\n=== PART B: refund nets out, debt_principal and transfer are excluded ===');

  const csv2 = Buffer.from(
    `Date,Transaction Description,Debit Amount,Credit Amount,Balance\n` +
    `${dOf(3)},Purchase Refund Ref9981,,50.00,4850.00\n` +
    `${dOf(5)},Home Loan Principal Repayment,300.00,,4550.00\n` +
    `${dOf(7)},Credit Card Payment Ref4412,150.00,,4400.00\n`
  );
  const up2 = await uploadCsv(userC.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: anzInst, masked_identifier: 'LR3ORCL1', filename: 'lr3-oracle-scenarios.csv' }, csv2);
  check('Part B upload succeeds', 200, up2.status);
  doc2Id = up2.json?.data?.document_id;

  await appPost(`/api/financial-data-hub/bank-csv/${doc2Id}/detect`, userC.cookie);
  const proc2 = await appPost(`/api/financial-data-hub/bank-csv/${doc2Id}/process`, userC.cookie);
  check('Part B process creates exactly 3 transactions', 3, proc2.json?.data?.transactions_created);

  await appPost('/api/financial-data-hub/bank-transactions/categorise', userC.cookie);

  const { data: doc2Txns } = await admin.from('fdh_transactions').select('id, description_clean, economic_transaction_type').eq('user_id', uidC).eq('statement_upload_id', doc2Id);
  const refundTxn = doc2Txns?.find((t) => t.description_clean?.toLowerCase().includes('refund'));
  const debtTxn = doc2Txns?.find((t) => t.description_clean?.toLowerCase().includes('principal'));
  const cardTxn = doc2Txns?.find((t) => t.description_clean?.toLowerCase().includes('credit card'));
  check('refund transaction auto-classified as refund', 'refund', refundTxn?.economic_transaction_type);
  check('loan-principal transaction auto-classified as debt_principal', 'debt_principal', debtTxn?.economic_transaction_type);

  // transfer isn't reachable via an auto-classify rule -- manual correction, per design.
  const corr = await appPost(`/api/financial-data-hub/bank-transactions/${cardTxn.id}/correction`, userC.cookie, { field_name: 'economic_transaction_type', corrected_value: 'transfer', reason: 'LR3 oracle: credit-card settlement is a transfer, not a second expense' });
  check('manual correction to transfer succeeds', 200, corr.status);
  const { data: cardTxnAfter } = await admin.from('fdh_transactions').select('economic_transaction_type, user_override').eq('id', cardTxn.id).single();
  check('credit-card transaction now classified transfer (user_override)', { economic_transaction_type: 'transfer', user_override: true }, cardTxnAfter);

  // The classification/narrative-match step also PROPOSES fdh_transaction_links
  // (pending) for anything description-shaped like a refund/settlement --
  // these block approval independently of economic_transaction_type until
  // confirmed or rejected (fdh7_transaction_has_blocking_issue's own "still
  // PENDING transfer/refund/reversal/duplicate link" clause). Neither of my
  // synthetic rows has a real matching counter-transaction, so the correct
  // resolution is to reject the proposed link (a real user would do the same
  // when the suggested match is wrong).
  const { data: pendingLinks } = await admin.from('fdh_transaction_links').select('id, transaction_id_from, transaction_id_to, link_type')
    .eq('user_id', uidC).eq('status', 'pending')
    .or(`transaction_id_from.eq.${refundTxn.id},transaction_id_to.eq.${refundTxn.id},transaction_id_from.eq.${cardTxn.id},transaction_id_to.eq.${cardTxn.id}`);
  console.log(`  found ${pendingLinks?.length ?? 0} pending transaction link(s) proposed for refund/card rows:`, JSON.stringify(pendingLinks));
  for (const link of pendingLinks ?? []) {
    const rej = await appPost(`/api/financial-data-hub/transaction-links/${link.id}/review`, userC.cookie, { decision: 'reject' });
    check(`pending link ${link.link_type} rejected (no real counter-transaction in this synthetic test)`, 200, rej.status);
  }

  const appr2 = await appPost('/api/financial-data-hub/bank-transactions/bulk-approve', userC.cookie, { transaction_ids: [refundTxn.id, debtTxn.id, cardTxn.id] });
  console.log('  bulk-approve response:', JSON.stringify(appr2.json, null, 2));
  check('Part B approve succeeds for all 3 transactions', { requested: 3, succeeded: 3, failed: 0 }, { requested: appr2.json?.data?.requested, succeeded: appr2.json?.data?.succeeded, failed: appr2.json?.data?.failed });

  // Expected: previous $700, refund nets -$50, debt_principal and transfer excluded entirely -> $650.
  const dash2 = await appGet('/api/dashboard/summary', userC.cookie);
  check('Part B totalMonthlyExpenses = $650 (refund netted, debt_principal + transfer excluded)', 650, dash2.json?.data?.totalMonthlyExpenses);
  check('Part B totalMonthlyExpenses is NOT $1150 (debt_principal/transfer wrongly counted as expenses)', false, dash2.json?.data?.totalMonthlyExpenses === 1150);
  check('Part B bankMonthlyExpenses = $150 ($200 groceries - $50 refund)', 150, dash2.json?.data?.bankMonthlyExpenses);

  // ============ PART C: duplicate / overlapping transaction ============
  console.log('\n=== PART C: re-importing the same transaction from an overlapping statement must not double-count ===');

  const up3 = await uploadCsv(userC.cookie, { country_code: 'AU', currency_code: 'AUD', institution_id: anzInst, masked_identifier: 'LR3ORCL1', filename: 'lr3-oracle-overlap.csv' }, csv1); // exact same bytes as csv1
  check('Part C (duplicate) upload succeeds', 200, up3.status);
  doc3Id = up3.json?.data?.document_id;
  await appPost(`/api/financial-data-hub/bank-csv/${doc3Id}/detect`, userC.cookie);
  const proc3 = await appPost(`/api/financial-data-hub/bank-csv/${doc3Id}/process`, userC.cookie);
  const dupSkipped = (proc3.json?.data?.duplicates_skipped ?? 0);
  const dupCandidates = (proc3.json?.data?.duplicate_candidates ?? 0);
  check('Part C duplicate is recognised (auto-skipped or flagged as a candidate, not silently accepted as new)', true, dupSkipped > 0 || dupCandidates > 0);
  console.log(`  process response: transactions_created=${proc3.json?.data?.transactions_created}, duplicates_skipped=${dupSkipped}, duplicate_candidates=${dupCandidates}`);

  await appPost('/api/financial-data-hub/bank-transactions/categorise', userC.cookie);
  // If it landed as a genuine new (non-duplicate) row for any reason, approve it too --
  // the real assertion is the FINAL total, not how many rows exist along the way.
  const { data: doc3Txns } = await admin.from('fdh_transactions').select('id, approval_status').eq('user_id', uidC).eq('statement_upload_id', doc3Id).eq('approval_status', 'pending');
  if (doc3Txns?.length) {
    await appPost('/api/financial-data-hub/bank-transactions/bulk-approve', userC.cookie, { transaction_ids: doc3Txns.map((t) => t.id) });
  }

  const dash3 = await appGet('/api/dashboard/summary', userC.cookie);
  check('Part C totalMonthlyExpenses UNCHANGED at $650 (the duplicate groceries row was not double-counted)', 650, dash3.json?.data?.totalMonthlyExpenses);

  const failed = results.filter((r) => JSON.stringify(r.expected) !== JSON.stringify(r.actual));
  console.log(`\n${results.length - failed.length}/${results.length} checks matched expected (LR-3 real end-to-end bank-import oracle) — ${failed.length} unexpected result(s).`);
  if (failed.length) process.exitCode = 1;
} finally {
  // The uploaded CSVs live in fdh-source-documents Storage (buildOpaqueStorageKey
  // shape: ${userId}/${documentId}/${documentId}.bin) -- deleteUser()'s DB
  // cascade does NOT touch Storage (this is exactly LR-9's own concern), so
  // purge it explicitly here rather than leaving synthetic test files orphaned.
  if (uidC) {
    try {
      const { data: folders } = await admin.storage.from('fdh-source-documents').list(uidC, { limit: 1000 });
      const keys = [];
      for (const folder of folders ?? []) {
        const { data: inner } = await admin.storage.from('fdh-source-documents').list(`${uidC}/${folder.name}`, { limit: 1000 });
        for (const obj of inner ?? []) keys.push(`${uidC}/${folder.name}/${obj.name}`);
      }
      if (keys.length) await admin.storage.from('fdh-source-documents').remove(keys);
      console.log(`purged ${keys.length} Storage object(s) from fdh-source-documents for User C.`);
    } catch { /* best-effort */ }
    try { await admin.auth.admin.deleteUser(uidC); } catch { /* best-effort */ }
  }
  console.log('cleaned up disposable User C (cascade removes all seeded financial/FDH rows; Storage purged explicitly above).');
}
