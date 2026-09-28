// AIE-1 / Approved Upload -> Canonical programme, FINAL PRODUCTION CLOSURE
// mission (2026-09-28) -- PGlite verification for migration
// 0224_aie1_canonical_close_r20_provenance_gaps.sql.
//
// Anti-vacuity, both gaps, exactly as the report reproduced them live:
//   R20(a) a hand-crafted "planned expense from actual spending" proposal
//          with no real transaction behind it, applied via
//          fdh15_apply_expense_proposals.
//   R20(b) an ordinary bank-statement upload repurposed into fabricated
//          liability evidence via fdh10_persist_liability_statement.
// Both are shown to SUCCEED before 0224 (the same defect the report proved
// live), then REFUSED after 0224, then every legitimate path (real evidence
// within bound, a real credit-card/loan document persist) is shown to still
// work unchanged.
//
// Run: node scripts/canonical_0224_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0224_aie1_canonical_close_r20_provenance_gaps.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

async function replayUpToTarget() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (f >= TARGET) break;
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  return db;
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const errorOf = async (db, sql, params) => { try { if (params) await db.query(sql, params); else await db.exec(sql); return null; } catch (e) { return e.message; } };

async function asUser(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('rollback').catch(() => {});
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
const rpc = async (db, sql, params) => {
  try { return (await one(db, sql, params)).r; } catch (e) { return { ok: false, code: 'SQL_ERROR', error: e.message }; }
};

const A = '11111111-1111-1111-1111-111111111111';
const ACC_A = 'a0000000-0000-0000-0000-00000000000a';
const UP_BANK = 'a2000000-0000-0000-0000-000000000001';   // ordinary bank-CSV upload, attempt 1
const UP_BANK2 = 'a2000000-0000-0000-0000-000000000002';  // ordinary bank-CSV upload, attempt 2 (after 0224)
const UP_BANK3 = 'a2000000-0000-0000-0000-000000000003';  // ordinary bank-CSV upload, attempt 3 (after 0224, card variant)
const UP_CARD = 'a3000000-0000-0000-0000-0000000000c1';   // queued credit-card document (legitimate)
const UP_LOAN = 'a3000000-0000-0000-0000-0000000000c2';   // queued loan document (legitimate)
const UP_CARD2 = 'a3000000-0000-0000-0000-0000000000c3';  // queued credit-card document (mismatch test)
const EXP_ITEM = 'a5000000-0000-0000-0000-000000000001';

async function seed(db) {
  await db.exec(`insert into auth.users(id, email) values ('${A}', 'a@t.test') on conflict do nothing`);
  await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${A}'`);
  await db.exec(`
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name) values
      ('${ACC_A}', '${A}', 'transaction', 'AU', 'AUD', 'Everyday A');
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, document_type, country_code, currency_code, processing_status) values
      ('${UP_BANK}', '${A}', '${ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'queued'),
      ('${UP_BANK2}', '${A}', '${ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'queued'),
      ('${UP_BANK3}', '${A}', '${ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'queued');
    insert into fdh_statement_uploads (id, user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status) values
      ('${UP_CARD}', '${A}', 'csv', 'credit_card_statement', 'AU', 'AUD', 'text/csv', 'queued'),
      ('${UP_LOAN}', '${A}', 'csv', 'loan_statement', 'AU', 'AUD', 'text/csv', 'queued'),
      ('${UP_CARD2}', '${A}', 'csv', 'credit_card_statement', 'AU', 'AUD', 'text/csv', 'queued');
    insert into expense_items (id, user_id, expense_name, expense_category, master_item_key, amount, frequency, currency_code, is_active) values
      ('${EXP_ITEM}', '${A}', 'Groceries', 'food', 'groceries', 80.00, 'monthly', 'AUD', true);
  `);
}

const persist = (db, uid, upload, statement, activities) =>
  asUser(db, uid, () => rpc(db, `select fdh10_persist_liability_statement($1::uuid, $2::jsonb, $3::jsonb) r`, [upload, JSON.stringify(statement), JSON.stringify(activities)]));

async function makeExpenseProposal(db, uid, { windowFrom, windowTo, proposedAmount, existingAmount }) {
  return asUser(db, uid, async () => {
    const id = (await one(db, `insert into fhip_import_proposals (user_id, target_domain, source_kind, currency_code, target_entity_id, target_entity_updated_at, recommended_apply_mode, source_window_from, source_window_to, status)
      values ($1, 'expense', 'bank_statement', 'AUD', $2, (select updated_at from expense_items where id = $2), 'update_existing', $3, $4, 'ready') returning id`,
      [uid, EXP_ITEM, windowFrom, windowTo])).id;
    await db.query(`insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, reason_code) values ($1, $2, 'amount', 'money', $3, $4, 'test')`,
      [uid, id, String(proposedAmount), existingAmount]);
    return id;
  });
}
const applyExpense = (db, uid, id, decision = 'apply_selected_fields', fields = ['amount']) =>
  asUser(db, uid, () => rpc(db, `select fdh15_apply_expense_proposals($1::jsonb) r`,
    [JSON.stringify([{ proposal_id: id, decision, selected_fields: fields }])]));

console.log('AIE-1/Canonical closure -- 0224 R20 provenance-gap verification');
{
  const db = await replayUpToTarget();
  await seed(db);

  // =========================================================================
  // ANTI-VACUITY: both gaps are real BEFORE 0224.
  // =========================================================================
  const forgedLoanOnBankDoc = await persist(db, A, UP_BANK,
    { statement_type: 'loan', facility_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD', closing_principal: 499999.99, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31' },
    [{ activity_type: 'PAYMENT', activity_date: '2026-08-16', amount: 499999.99, currency_code: 'AUD', description_raw: 'FORGED PAYOFF', source_row_number: 1 }]);
  check('anti-vacuity: BEFORE 0224 a bank-CSV upload is repurposed into a $499,999.99 loan statement', forgedLoanOnBankDoc?.ok === true, JSON.stringify(forgedLoanOnBankDoc));

  const forgedExpNoEvidence = await makeExpenseProposal(db, A, { windowFrom: '2026-08-01', windowTo: '2026-08-31', proposedAmount: '999999.99', existingAmount: '80.00' });
  const forgedExpResBefore = await applyExpense(db, A, forgedExpNoEvidence);
  check('anti-vacuity: BEFORE 0224 a $999,999.99/month expense proposal with NO real transactions behind it is applied', forgedExpResBefore?.ok === true, JSON.stringify(forgedExpResBefore));
  await db.exec(`begin; select set_config('fhip.import_bridge_internal_write','true',true); update expense_items set amount = 80.00 where id = '${EXP_ITEM}'; update fhip_import_proposals set status='ready', applied_at=null where id='${forgedExpNoEvidence}'; delete from fhip_import_applications where proposal_id='${forgedExpNoEvidence}'; commit;`);

  // =========================================================================
  // APPLY 0224.
  // =========================================================================
  const applyErr = await errorOf(db, target);
  check('0224 applies cleanly', applyErr === null, applyErr ?? '');

  // =========================================================================
  // AFTER 0224: both gaps are closed.
  // =========================================================================
  const stillForgedLoan = await persist(db, A, UP_BANK2,
    { statement_type: 'loan', facility_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD', closing_principal: 499999.99, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31' },
    [{ activity_type: 'PAYMENT', activity_date: '2026-08-16', amount: 499999.99, currency_code: 'AUD', description_raw: 'FORGED PAYOFF', source_row_number: 1 }]);
  check('AFTER 0224: bank-CSV upload -> fabricated loan statement is REFUSED', stillForgedLoan?.ok === false && stillForgedLoan.code === 'DOCUMENT_TYPE_MISMATCH', JSON.stringify(stillForgedLoan));

  const stillForgedCard = await persist(db, A, UP_BANK3,
    { statement_type: 'credit_card', facility_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', closing_balance: 499999.99, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31' },
    [{ activity_type: 'PURCHASE', activity_date: '2026-08-16', amount: 499999.99, currency_code: 'AUD', description_raw: 'FORGED', source_row_number: 1 }]);
  check('AFTER 0224: bank-CSV upload -> fabricated credit-card statement is ALSO refused', stillForgedCard?.ok === false && stillForgedCard.code === 'DOCUMENT_TYPE_MISMATCH', JSON.stringify(stillForgedCard));

  const noEvidence = await makeExpenseProposal(db, A, { windowFrom: '2026-08-01', windowTo: '2026-08-31', proposedAmount: '999999.99', existingAmount: '80.00' });
  const noEvidenceRes = await applyExpense(db, A, noEvidence);
  check('AFTER 0224: a $999,999.99/month proposal with NO real transactions is REFUSED', noEvidenceRes?.ok === false && noEvidenceRes.code === 'NO_SUPPORTING_TRANSACTIONS', JSON.stringify(noEvidenceRes));

  // Real evidence exists ($100 approved expense in window) but the proposal
  // still asks for more than that total: refused, not silently capped.
  await db.exec(`
    insert into fdh_transactions (id, user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, approval_status, approved_at, approved_by)
    values ('a4000000-0000-0000-0000-000000000001', '${A}', '${ACC_A}', '${UP_BANK}', '2026-08-10', 100, 'AUD', 'debit', 'expense', 'approved', now(), '${A}');
  `);
  const overEvidence = await makeExpenseProposal(db, A, { windowFrom: '2026-08-01', windowTo: '2026-08-31', proposedAmount: '500.00', existingAmount: '80.00' });
  const overEvidenceRes = await applyExpense(db, A, overEvidence);
  check('AFTER 0224: a $500/month proposal against only $100 of real evidence is REFUSED', overEvidenceRes?.ok === false && overEvidenceRes.code === 'PROVENANCE_UNVERIFIED', JSON.stringify(overEvidenceRes));

  // =========================================================================
  // Legitimate paths still work, unchanged.
  // =========================================================================
  const legitCard = await persist(db, A, UP_CARD,
    { statement_type: 'credit_card', facility_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', closing_balance: 220, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', extraction_warnings: [] },
    [{ activity_type: 'PURCHASE', activity_date: '2026-08-14', amount: 200, currency_code: 'AUD', description_raw: 'SHOP A', source_row_number: 1 },
     { activity_type: 'PURCHASE', activity_date: '2026-08-15', amount: 20, currency_code: 'AUD', description_raw: 'SHOP B', source_row_number: 2 }]);
  check('legitimate credit-card persist (right document class) still succeeds', legitCard?.ok === true && legitCard.activity_count === 2, JSON.stringify(legitCard));

  const legitLoan = await persist(db, A, UP_LOAN,
    { statement_type: 'loan', facility_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD', closing_principal: 18450, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31' },
    [{ activity_type: 'PAYMENT', activity_date: '2026-08-16', amount: 2000, currency_code: 'AUD', principal_component: 1550, interest_component: 430, fee_component: 20, description_raw: 'REPAYMENT', source_row_number: 1 }]);
  check('legitimate loan persist (right document class) still succeeds', legitLoan?.ok === true, JSON.stringify(legitLoan));

  const mismatch = await persist(db, A, UP_CARD2,
    { statement_type: 'loan', facility_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD', closing_principal: 5000, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31' },
    [{ activity_type: 'PAYMENT', activity_date: '2026-08-16', amount: 500, currency_code: 'AUD', description_raw: 'X', source_row_number: 1 }]);
  check('a credit-card document cannot be persisted as a loan statement either way round', mismatch?.ok === false && mismatch.code === 'DOCUMENT_TYPE_MISMATCH', JSON.stringify(mismatch));

  const withinEvidence = await makeExpenseProposal(db, A, { windowFrom: '2026-08-01', windowTo: '2026-08-31', proposedAmount: '90.00', existingAmount: '80.00' });
  const withinEvidenceRes = await applyExpense(db, A, withinEvidence);
  check('a $90/month proposal within $100 of real approved evidence is APPLIED', withinEvidenceRes?.ok === true && withinEvidenceRes.results?.[0]?.outcome === 'applied', JSON.stringify(withinEvidenceRes));
  const liveAmount = await one(db, `select amount from expense_items where id = '${EXP_ITEM}'`);
  check('...and the planned expense amount actually changed to 90.00', Number(liveAmount.amount) === 90, JSON.stringify(liveAmount));
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0 || pass < 12) { console.error('FAIL: insufficient or failing checks (anti-vacuity threshold not met)'); process.exit(1); }
process.exit(0);
