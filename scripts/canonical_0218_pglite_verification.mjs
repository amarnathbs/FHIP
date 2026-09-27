// Canonical-upload programme, stage-3 security review -- PGlite verification
// for migration 0218_canonical_security_review_hardening.sql.
//
// Case A: the real chain replayed up to 0218 (exclusive), a synthetic two-
//   tenant household seeded, then ANTI-VACUITY: every gap 0218 closes is shown
//   to be real BEFORE 0218 (the same forged writes that were reproduced live on
//   DEV succeed here too). 0218 is then shown to REFUSE to apply while a cross-
//   tenant split line exists (pre-check), and to apply once the PO remedy ran.
//   After 0218 every forged write is refused, every legitimate path (the
//   statement persist, approve, the ledger Apply with allocations, the user's
//   own split, the asset Apply in the right currency) still works, and a
//   second apply is a no-op.
//
// Every check prints PASS/FAIL; exit code is non-zero on any FAIL, and the
// run asserts a minimum number of checks so a vacuous green is impossible.
//
// Run: node scripts/canonical_0218_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0218_canonical_security_review_hardening.sql';
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
const schemaFingerprint = async (db) => {
  const c = (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows;
  const i = (await db.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`)).rows;
  const t = (await db.query(`select tgname, tgrelid::regclass::text r, tgattr::text a from pg_trigger where not tgisinternal order by 1,2`)).rows;
  const f = (await db.query(`select proname, md5(prosrc) h, proacl::text acl from pg_proc where pronamespace = 'public'::regnamespace order by 1,2`)).rows;
  const k = (await db.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).rows;
  return JSON.stringify({ c, i, t, f, k });
};

/** Runs `fn` as the authenticated role with auth.uid() = uid (RLS enforced). */
async function asUser(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('rollback').catch(() => {});
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
/** The service role as PostgREST presents it (JWT role claim; the DB role stays the owner). */
async function asService(db, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  try { return await fn(); } finally { await db.query(`select set_config('request.jwt.claims', '{}', false)`); }
}
const rpc = async (db, sql, params) => {
  try { return (await one(db, sql, params)).r; } catch (e) { return { ok: false, code: 'SQL_ERROR', error: e.message }; }
};

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ACC_A = 'a0000000-0000-0000-0000-00000000000a';
const ACC_B = 'b0000000-0000-0000-0000-00000000000b';
const UP_A = 'a2000000-0000-0000-0000-000000000001';   // approved AUD bank statement, closing 10400
const UP_B = 'b2000000-0000-0000-0000-00000000000b';
const UP_CARD = 'a3000000-0000-0000-0000-0000000000c1'; // queued card document (the legitimate persist path)
const UP_LOAN = 'a3000000-0000-0000-0000-0000000000c2'; // queued loan document
const TX_A = 'a4000000-0000-0000-0000-000000000001';
const TX_B = 'b4000000-0000-0000-0000-000000000001';
const ASSET_INR = 'a8000000-0000-0000-0000-000000000001';

async function seed(db) {
  for (const [id, email] of [[A, 'a@t.test'], [B, 'b@t.test']]) {
    await db.exec(`insert into auth.users(id, email) values ('${id}', '${email}') on conflict do nothing`);
    await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  }
  await db.exec(`
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name) values
      ('${ACC_A}', '${A}', 'transaction', 'AU', 'AUD', 'Everyday A'),
      ('${ACC_B}', '${B}', 'transaction', 'AU', 'AUD', 'Everyday B');
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, document_type, country_code, currency_code, processing_status, statement_period_start, statement_period_end) values
      ('${UP_A}', '${A}', '${ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'approved', '2026-08-01', '2026-08-31'),
      ('${UP_B}', '${B}', '${ACC_B}', 'csv', 'bank_statement', 'AU', 'AUD', 'extracted', '2026-08-01', '2026-08-31');
    insert into fdh_statement_uploads (id, user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status) values
      ('${UP_CARD}', '${A}', 'csv', 'credit_card_statement', 'AU', 'AUD', 'text/csv', 'queued'),
      ('${UP_LOAN}', '${A}', 'csv', 'loan_statement', 'AU', 'AUD', 'text/csv', 'queued');
    insert into fdh_reconciliation_results (user_id, statement_upload_id, reported_closing_balance, currency_code) values ('${A}', '${UP_A}', 10400, 'AUD');
    insert into fdh_transactions (id, user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type) values
      ('${TX_A}', '${A}', '${ACC_A}', '${UP_A}', '2026-08-10', 120, 'AUD', 'debit', 'expense'),
      ('${TX_B}', '${B}', '${ACC_B}', '${UP_B}', '2026-08-10', 120, 'AUD', 'debit', 'expense');
    update fdh_transactions set approval_status = 'pending' where id in ('${TX_A}', '${TX_B}');
    insert into assets (id, user_id, asset_name, asset_class, current_value, currency_code) values ('${ASSET_INR}', '${A}', 'Savings (INR)', 'cash', 50, 'INR');
  `);
}

const forgedStatement = (extra) => {
  const { __upload = 'null', ...rest } = extra;
  const k = Object.keys(rest);
  const v = Object.values(rest);
  return `insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code${k.map((x) => ', ' + x).join('')})
    values ('${A}', ${__upload}, 'credit_card', 'credit_card', 'AU', 'AUD'${v.map((x) => ', ' + x).join('')})`;
};

async function makeProposal(db, uid, p) {
  return asUser(db, uid, async () => {
    const id = (await one(db, `insert into fhip_import_proposals (user_id, target_domain, source_kind, currency_code, target_entity_id, recommended_apply_mode, source_statement_upload_id, source_liability_statement_id, status)
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'ready') returning id`,
      [uid, p.domain, p.kind, p.currency ?? 'AUD', p.target ?? null, p.mode, p.statement ?? null, p.liabilityStatement ?? null])).id;
    for (const f of p.fields) {
      await db.query(`insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, reason_code) values ($1, $2, $3, $4, $5, $6, 'test')`,
        [uid, id, f[0], f[1], f[2], f[3] ?? null]);
    }
    return id;
  });
}
const applyAsset = (db, uid, id, decision, fields = null) => asUser(db, uid, () => rpc(db, `select fdh15_apply_asset_proposal($1, $2, $3) r`, [id, decision, fields]));
const persist = (db, uid, upload, statement, activities) => asUser(db, uid, () => rpc(db, `select fdh10_persist_liability_statement($1::uuid, $2::jsonb, $3::jsonb) r`, [upload, JSON.stringify(statement), JSON.stringify(activities)]));

// ============================================================================
console.log('Case A -- full chain to 0214, forged writes BEFORE 0218, pre-check, then 0218 (twice)');
{
  const db = await replayUpToTarget();
  await seed(db);

  // ---------------- BEFORE 0218: every gap is real ----------------
  const g1 = await asUser(db, A, () => errorOf(db, forgedStatement({ approval_status: `'approved'`, approved_at: 'now()', approved_by: `'${A}'` })));
  check('anti-vacuity: before 0218 a user INSERTs an already-APPROVED card statement with no document', g1 === null, g1 ?? '');
  const g2 = await asUser(db, A, () => errorOf(db, forgedStatement({ ledger_status: `'applied'`, ledger_applied_at: 'now()' })));
  check('anti-vacuity: before 0218 a user INSERTs a statement already ledger_status=applied', g2 === null, g2 ?? '');
  const g3 = await asUser(db, A, () => errorOf(db, `insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${TX_B}', 1, 'expense', 1, 'AUD')`));
  check("anti-vacuity: before 0218 user A attaches a split line to user B's transaction", g3 === null, g3 ?? '');
  const inrBefore = await makeProposal(db, A, { domain: 'asset', kind: 'bank_statement', currency: 'INR', mode: 'add_new', statement: UP_A,
    fields: [['asset_name', 'text', 'Cash'], ['asset_class', 'enum', 'cash'], ['current_value', 'money', '10400.00'], ['currency_code', 'enum', 'INR']] });
  const inrBeforeRes = await applyAsset(db, A, inrBefore, 'add_new');
  check('anti-vacuity: before 0218 an AUD 10,400 balance is applied as an INR asset', inrBeforeRes?.ok === true, JSON.stringify(inrBeforeRes));
  // Supabase grants EXECUTE on every new public function to anon by default privilege (observed live on
  // DEV: anon reached the function body). PGlite has no such default, so it is emulated here.
  await db.exec(`grant execute on function fdh15_apply_asset_proposal(uuid, text, text[]) to anon; grant execute on function fdh15_apply_expense_proposals(jsonb) to anon;`);
  check('anti-vacuity: (Supabase default privilege emulated) anon may execute both WP-15 entry points',
    (await one(db, `select has_function_privilege('anon', 'fdh15_apply_asset_proposal(uuid, text, text[])', 'execute') a, has_function_privilege('anon', 'fdh15_apply_expense_proposals(jsonb)', 'execute') b`)).a === true);

  // ---------------- Pre-check refuses while a cross-tenant split line exists ----------------
  const pre = await errorOf(db, target);
  check('0218 REFUSES to apply while a cross-tenant split line exists', pre !== null && /PRE-CHECK FAILED/.test(pre), pre ?? 'applied');
  check('...and nothing of 0218 was applied (atomic)', (await one(db, `select count(*)::int n from pg_trigger where tgname like '%_0218'`)).n === 0);
  await db.exec(`delete from fdh_transaction_allocations a using fdh_transactions t where t.id = a.transaction_id and t.user_id <> a.user_id;`);
  // Undo the INR asset the gap created (the PO would review such rows).
  await db.exec(`begin; select set_config('fhip.import_bridge_internal_write','true',true); delete from assets where user_id = '${A}' and source_type = 'bank_statement_import'; commit;`);

  // ---------------- APPLY 0218 ----------------
  const applyErr = await errorOf(db, target);
  check('0218 applies cleanly once the PO remedy ran', applyErr === null, applyErr ?? '');

  // ---------------- A. Liability evidence INSERT ----------------
  for (const [label, extra] of [
    ['already approved', { approval_status: `'approved'`, approved_at: 'now()', approved_by: `'${A}'`, __upload: `'${UP_CARD}'` }],
    ['ledger_status applied', { ledger_status: `'applied'`, ledger_applied_at: 'now()', __upload: `'${UP_CARD}'` }],
    ['ledger rejected reason preset', { ledger_rejected_reason: `'x'`, __upload: `'${UP_CARD}'` }],
    ['user_corrected_fields preset', { user_corrected_fields: `array['closing_balance']`, __upload: `'${UP_CARD}'` }],
    ['no document at all (pending)', {}],
  ]) {
    const e = await asUser(db, A, () => errorOf(db, forgedStatement(extra)));
    check(`authenticated INSERT refused: statement ${label}`, e !== null && /system-authoritative/.test(e), e ?? 'accepted');
  }
  const svcIns = await asService(db, () => errorOf(db, forgedStatement({ approval_status: `'approved'`, approved_at: 'now()', approved_by: `'${A}'`, __upload: `'${UP_A}'` })));
  check('the service role is unaffected (server-side paths and fixtures)', svcIns === null, svcIns ?? '');
  await db.exec(`delete from fdh_liability_statements where statement_upload_id = '${UP_A}'`);

  // The legitimate path: the 0208 persist (authenticated, SECURITY INVOKER).
  const card = await persist(db, A, UP_CARD,
    { statement_type: 'credit_card', facility_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', closing_balance: 220, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', extraction_warnings: [] },
    [{ activity_type: 'PURCHASE', activity_date: '2026-08-14', amount: 200, currency_code: 'AUD', description_raw: 'SHOP A', source_row_number: 1 },
     { activity_type: 'PURCHASE', activity_date: '2026-08-15', amount: 20, currency_code: 'AUD', description_raw: 'SHOP B', source_row_number: 2 }]);
  check('the statement persist (the only authenticated writer) still works', card?.ok === true && card.activity_count === 2, JSON.stringify(card));
  const cardSt = card.statement_id;
  const addPending = await asUser(db, A, () => errorOf(db, `insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code) values ('${A}', '${cardSt}', 'FEE', '2026-08-20', 1, 'AUD')`));
  check('a line can still be added while the statement awaits review (pending) -- unchanged', addPending === null, addPending ?? '');
  await db.exec(`delete from fdh_liability_statement_activities where statement_id = '${cardSt}' and activity_type = 'FEE'`);
  const presetLedger = await asUser(db, A, () => errorOf(db, `insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code, ledger_disposition) values ('${A}', '${cardSt}', 'FEE', '2026-08-20', 1, 'AUD', 'duplicate_of_existing')`));
  check('authenticated INSERT refused: activity with ledger_disposition preset', presetLedger !== null && /system-authoritative/.test(presetLedger), presetLedger ?? 'accepted');
  const approve = await asUser(db, A, () => rpc(db, `select fdh10_approve_liability_statement($1) r`, [cardSt]));
  check('approve still works', approve?.ok === true, JSON.stringify(approve));
  const addApproved = await asUser(db, A, () => errorOf(db, `insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code, description_raw) values ('${A}', '${cardSt}', 'PURCHASE', '2026-08-21', 777.77, 'AUD', 'FORGED AFTER APPROVAL')`));
  check('authenticated INSERT refused: a new line on an already-APPROVED statement', addApproved !== null && /awaiting review/.test(addApproved), addApproved ?? 'accepted');
  const cardProp = await makeProposal(db, A, { domain: 'liability', kind: 'credit_card_statement', mode: 'add_new', liabilityStatement: cardSt,
    fields: [['liability_name', 'text', 'Card'], ['debt_type', 'enum', 'credit_card'], ['balance', 'money', '220'], ['currency_code', 'enum', 'AUD']] });
  const cardApply = await asUser(db, A, () => rpc(db, `select fdh10_apply_liability_proposal($1::uuid, 'add_new', array['liability_name','debt_type','balance','currency_code'], 'self') r`, [cardProp]));
  check('the ledger Apply still writes exactly the 2 reviewed purchases', cardApply?.ok === true && cardApply.ledger?.transactions_created === 2, JSON.stringify(cardApply).slice(0, 300));

  // Loan with a decomposed payment: the Apply inserts allocations (same-tenant trigger must let it through).
  const loan = await persist(db, A, UP_LOAN,
    { statement_type: 'loan', facility_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD', closing_principal: 18450, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31' },
    [{ activity_type: 'PAYMENT', activity_date: '2026-08-16', amount: 2000, currency_code: 'AUD', principal_component: 1550, interest_component: 430, fee_component: 20, description_raw: 'REPAYMENT', source_row_number: 1 }]);
  await asUser(db, A, () => rpc(db, `select fdh10_approve_liability_statement($1) r`, [loan.statement_id]));
  const loanProp = await makeProposal(db, A, { domain: 'liability', kind: 'loan_statement', mode: 'add_new', liabilityStatement: loan.statement_id,
    fields: [['liability_name', 'text', 'Loan'], ['debt_type', 'enum', 'personal_loan'], ['balance', 'money', '18450'], ['currency_code', 'enum', 'AUD']] });
  const loanApply = await asUser(db, A, () => rpc(db, `select fdh10_apply_liability_proposal($1::uuid, 'add_new', array['liability_name','debt_type','balance','currency_code'], 'self') r`, [loanProp]));
  check('loan Apply: header + 3 allocations (1,550 / 430 / 20) still written', loanApply?.ok === true && loanApply.ledger?.allocations_created === 3, JSON.stringify(loanApply).slice(0, 300));

  // ---------------- B. Split lines ----------------
  const xAlloc = await asUser(db, A, () => errorOf(db, `insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${TX_B}', 1, 'expense', 1, 'AUD')`));
  check("user A can no longer attach a split line to user B's transaction", xAlloc !== null && /cross-tenant/.test(xAlloc), xAlloc ?? 'accepted');
  const xAllocSvc = await asService(db, () => errorOf(db, `insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${TX_B}', 1, 'expense', 1, 'AUD')`));
  check('...not even through the service role (every role)', xAllocSvc !== null && /cross-tenant/.test(xAllocSvc), xAllocSvc ?? 'accepted');
  const ownSplit = await asUser(db, A, () => rpc(db, `select fdh8_replace_transaction_allocations($1, $2::jsonb, true) r`, [TX_A, JSON.stringify([{ economic_transaction_type: 'expense', amount: 100 }, { economic_transaction_type: 'expense', amount: 20 }])]));
  check('the user still splits their OWN transaction', Array.isArray(ownSplit) && ownSplit.length === 2, JSON.stringify(ownSplit).slice(0, 200));
  const moveAlloc = await asService(db, () => errorOf(db, `update fdh_transaction_allocations set user_id = '${B}' where transaction_id = '${TX_A}'`));
  check('an existing split line cannot be re-owned to another user', moveAlloc !== null && /cross-tenant/.test(moveAlloc), moveAlloc ?? 'accepted');
  const bSplit = await asUser(db, B, () => rpc(db, `select fdh8_replace_transaction_allocations($1, $2::jsonb, true) r`, [TX_B, JSON.stringify([{ economic_transaction_type: 'expense', amount: 120 }])]));
  check("user B's own split is not blocked by anything A tried", Array.isArray(bSplit) && bSplit.length === 1, JSON.stringify(bSplit).slice(0, 200));

  // ---------------- C. Asset currency ----------------
  const inr = await makeProposal(db, A, { domain: 'asset', kind: 'bank_statement', currency: 'INR', mode: 'add_new', statement: UP_A,
    fields: [['asset_name', 'text', 'Cash'], ['asset_class', 'enum', 'cash'], ['current_value', 'money', '10400.00'], ['currency_code', 'enum', 'INR']] });
  const inrRes = await applyAsset(db, A, inr, 'add_new');
  check('an AUD balance proposed as INR is refused CURRENCY_MISMATCH', inrRes?.ok === false && inrRes.code === 'CURRENCY_MISMATCH', JSON.stringify(inrRes));
  check('...and wrote nothing (proposal still ready, no linked asset)',
    (await one(db, `select status from fhip_import_proposals where id = $1`, [inr])).status === 'ready'
    && (await one(db, `select count(*)::int n from assets where source_financial_account_id = '${ACC_A}'`)).n === 0);
  const upd = await makeProposal(db, A, { domain: 'asset', kind: 'bank_statement', mode: 'update_existing', statement: UP_A, target: ASSET_INR,
    fields: [['current_value', 'money', '10400.00', '50.00'], ['currency_code', 'enum', 'AUD', 'INR']] });
  const updRes = await applyAsset(db, A, upd, 'apply_selected_fields', ['current_value']);
  check('"update existing" on an INR asset with the currency tick cleared is refused (no forging needed)', updRes?.ok === false && updRes.code === 'CURRENCY_MISMATCH', JSON.stringify(updRes));
  check('...the INR asset still holds 50', (await one(db, `select current_value::text v from assets where id = '${ASSET_INR}'`)).v === '50.00');
  const aud = await makeProposal(db, A, { domain: 'asset', kind: 'bank_statement', mode: 'add_new', statement: UP_A,
    fields: [['asset_name', 'text', 'Cash'], ['asset_class', 'enum', 'cash'], ['current_value', 'money', '10400.00'], ['currency_code', 'enum', 'AUD']] });
  const audRes = await applyAsset(db, A, aud, 'add_new');
  check('the same balance in its own currency (AUD) still applies', audRes?.ok === true, JSON.stringify(audRes));

  // ---------------- D. anon ----------------
  const anon = await one(db, `select has_function_privilege('anon', 'fdh15_apply_asset_proposal(uuid, text, text[])', 'execute') a, has_function_privilege('anon', 'fdh15_apply_expense_proposals(jsonb)', 'execute') b,
    has_function_privilege('authenticated', 'fdh15_apply_asset_proposal(uuid, text, text[])', 'execute') c, has_function_privilege('authenticated', 'fdh15_apply_expense_proposals(jsonb)', 'execute') d`);
  check('anon may no longer execute either WP-15 entry point; authenticated still may', anon.a === false && anon.b === false && anon.c === true && anon.d === true, JSON.stringify(anon));

  // ---------------- Re-apply 0218: no-op ----------------
  const fp1 = await schemaFingerprint(db);
  const reErr = await errorOf(db, target);
  const fp2 = await schemaFingerprint(db);
  check('re-applying 0218 raises nothing', reErr === null, reErr ?? '');
  check('re-applying 0218 changes no constraint, index, trigger, function body, grant or column', fp1 === fp2);
}

const total = pass + fail;
console.log(`\n=== canonical 0218 PGlite verification: ${pass} PASS, ${fail} FAIL (${total} checks) ===`);
if (total < 30) { console.error(`expected at least 30 checks, ran ${total}`); process.exit(2); }
process.exit(fail === 0 ? 0 : 1);
