// WP-13 -- PGlite verification for migration 0211_fdh12_retirement_apply_guards.sql.
//
// Replays the REAL migration chain up to (not including) 0211 on real Postgres
// (PGlite), seeds two synthetic tenants, then:
//   1. BEFORE 0211 -- anti-vacuity: every defect 0211 fixes is demonstrated
//      live on the predecessor (0119 apply RPC, 0112/0113 triggers);
//   2. applies 0211 and proves every acceptance claim on the same database;
//   3. re-applies 0211 and proves it is a byte-identical no-op.
//
// Authenticated calls run as `set role authenticated` + request.jwt.claims,
// so RLS, grants and triggers are all live -- the FDH-12 certification harness
// pattern (scripts/fdh12_certification.mjs).
//
// Every check prints PASS/FAIL; the process exits non-zero on any FAIL or if
// fewer checks ran than expected (a green run with zero checks is impossible).
//
// Run: node scripts/fdh12_0211_pglite_verification.mjs
// Optional: --json  prints a final JSON line with the rows the unit test
//           (tests/unit/fdh12RetirementApplyGuards.test.ts) feeds into the
//           canonical read models.

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0211_fdh12_retirement_apply_guards.sql';
const EXPECTED_MIN_CHECKS = 60;
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) pass++; else { fail++; failures.push(label); }
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};

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

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const errorOf = async (db, sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const execErrorOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };

async function as(db, role, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role })]);
  await db.exec(`set role ${role};`);
  try { return await fn(); } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
const asUser = (db, uid, fn) => as(db, 'authenticated', uid, fn);
const rpc = (db, uid, sql, params) => asUser(db, uid, async () => {
  try { return (await one(db, sql, params)).r; } catch (e) { return { ok: false, code: 'SQL_ERROR', error: e.message }; }
});

const schemaFingerprint = async (db) => {
  const c = (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows;
  const i = (await db.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`)).rows;
  const t = (await db.query(`select tgname, tgrelid::regclass::text r, tgenabled from pg_trigger where not tgisinternal order by 1,2`)).rows;
  const f = (await db.query(`select proname, md5(prosrc) h, proacl::text a from pg_proc where pronamespace = 'public'::regnamespace order by 1,2`)).rows;
  const k = (await db.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).rows;
  const p = (await db.query(`select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2`)).rows;
  return JSON.stringify({ c, i, t, f, k, p });
};

// ---------------------------------------------------------------------------
// Synthetic tenants
// ---------------------------------------------------------------------------
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const MEM_A = 'a0000000-0000-0000-0000-0000000000aa';
const ACC_SUPER_A = 'a1000000-0000-0000-0000-000000000001';   // Hostplus, has no contributions yet
const ACC_MANUAL_A = 'a1000000-0000-0000-0000-000000000002';  // AustralianSuper, manual $1,000/month employer
const ACC_ROLL_FROM = 'a1000000-0000-0000-0000-000000000003'; // Fund A (rollover out)
const ACC_ROLL_TO = 'a1000000-0000-0000-0000-000000000004';   // Fund B (rollover in)
const ACC_SMSF_A = 'a1000000-0000-0000-0000-000000000005';
const ACC_POS_A = 'a1000000-0000-0000-0000-000000000006';     // holdings case
const BANK_ACC_A = 'a2000000-0000-0000-0000-000000000001';
const BANK_UP_A = 'a3000000-0000-0000-0000-000000000001';
const TXN_CONTRIB = 'a4000000-0000-0000-0000-000000000001';  // $500 BPAY to super, currently 'expense'
const TXN_PENSION = 'a4000000-0000-0000-0000-000000000002';  // $2,000 pension credit, currently 'transfer'
const TXN_OVERRIDE = 'a4000000-0000-0000-0000-000000000003'; // $300 debit the user categorised themselves
const TXN_WRONG_DIR = 'a4000000-0000-0000-0000-000000000004'; // a $750 CREDIT wrongly linked to a contribution
const TXN_GROCERY = 'a4000000-0000-0000-0000-000000000005';  // $200 Woolworths, ordinary spending

async function seed(db) {
  for (const [id, email] of [[A, 'a@t.test'], [B, 'b@t.test']]) {
    await db.exec(`insert into auth.users(id, email) values ('${id}', '${email}') on conflict do nothing`);
    await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  }
  await db.exec(`
    insert into retirement_members (id, user_id, member_type, target_retirement_age, is_active) values ('${MEM_A}', '${A}', 'self', 67, true);
    insert into retirement_accounts (id, user_id, account_name, account_type, current_balance, currency_code, country_code, owner, is_active, retirement_member_id) values
      ('${ACC_SUPER_A}', '${A}', 'Hostplus', 'super', 100000.00, 'AUD', 'AU', 'self', true, '${MEM_A}'),
      ('${ACC_MANUAL_A}', '${A}', 'AustralianSuper', 'super', 80000.00, 'AUD', 'AU', 'self', true, '${MEM_A}'),
      ('${ACC_ROLL_FROM}', '${A}', 'Old Fund', 'super', 50000.00, 'AUD', 'AU', 'self', true, '${MEM_A}'),
      ('${ACC_ROLL_TO}', '${A}', 'New Fund', 'super', 0.00, 'AUD', 'AU', 'self', true, '${MEM_A}'),
      ('${ACC_POS_A}', '${A}', 'Aware Super', 'super', 150000.00, 'AUD', 'AU', 'self', true, '${MEM_A}');
    update retirement_accounts set employer_contribution = 1000.00, contribution_frequency = 'monthly' where id = '${ACC_MANUAL_A}';
    insert into retirement_accounts (id, user_id, account_name, account_type, current_balance, currency_code, country_code, owner, is_active, master_item_key)
      values ('${ACC_SMSF_A}', '${A}', 'Family SMSF', 'super', 400000.00, 'AUD', 'AU', 'self', true, 'smsf');
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name)
      values ('${BANK_ACC_A}', '${A}', 'transaction', 'AU', 'AUD', 'Everyday A');
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, document_type, country_code, currency_code, processing_status)
      values ('${BANK_UP_A}', '${A}', '${BANK_ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'queued');
    insert into fdh_transactions (id, user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, user_override, description_clean) values
      ('${TXN_CONTRIB}', '${A}', '${BANK_ACC_A}', '${BANK_UP_A}', '2026-08-10', 500.00, 'AUD', 'debit', 'expense', false, 'BPAY HOSTPLUS SUPER'),
      ('${TXN_PENSION}', '${A}', '${BANK_ACC_A}', '${BANK_UP_A}', '2026-08-15', 2000.00, 'AUD', 'credit', 'transfer', false, 'HOSTPLUS PENSION'),
      ('${TXN_OVERRIDE}', '${A}', '${BANK_ACC_A}', '${BANK_UP_A}', '2026-08-11', 300.00, 'AUD', 'debit', 'expense', true, 'BPAY HOSTPLUS'),
      ('${TXN_WRONG_DIR}', '${A}', '${BANK_ACC_A}', '${BANK_UP_A}', '2026-08-12', 750.00, 'AUD', 'credit', 'income', false, 'REFUND'),
      ('${TXN_GROCERY}', '${A}', '${BANK_ACC_A}', '${BANK_UP_A}', '2026-08-13', 200.00, 'AUD', 'debit', 'expense', false, 'WOOLWORTHS');
  `);
}

async function statement(db, uid, over = {}) {
  const cols = {
    user_id: uid, statement_type: 'super_annual_statement', retirement_jurisdiction: 'AU', account_type: 'industry_super',
    fund_name: 'Hostplus', currency_code: 'AUD', opening_balance: '100000.00', closing_balance: '113500.00',
    statement_start_date: '2025-07-01', statement_end_date: '2026-06-30', extraction_status: 'extracted',
    approval_status: 'approved', approved_at: new Date().toISOString(), retirement_member_id: uid === A ? MEM_A : null, ...over,
  };
  const keys = Object.keys(cols);
  const r = await db.query(`insert into fdh_retirement_statements(${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, keys.map((k) => cols[k]));
  return r.rows[0].id;
}

async function activity(db, uid, statementId, over) {
  const cols = { user_id: uid, statement_id: statementId, currency_code: 'AUD', ...over };
  const keys = Object.keys(cols);
  const r = await db.query(`insert into fdh_retirement_statement_activities(${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, keys.map((k) => cols[k]));
  return r.rows[0].id;
}

/** A proposal exactly as the adapter persists one: contributions are NOT
 * recommended and REQUIRE confirmation; the balance is recommended. */
async function proposal(db, uid, statementId, targetId, fields, mode = 'update_existing') {
  const p = await one(db, `insert into fhip_import_proposals(user_id, target_domain, source_kind, source_retirement_statement_id, currency_code, target_entity_id, recommended_apply_mode, status)
    values ($1,'retirement','retirement_statement',$2,'AUD',$3,$4,'ready') returning id`, [uid, statementId, targetId, mode]);
  for (const f of fields) {
    await db.query(`insert into fhip_import_proposal_fields(user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, reason_code)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'test')`, [uid, p.id, f.name, f.kind, f.proposed, f.existing ?? null, f.rec ?? true, f.confirm ?? false]);
  }
  return p.id;
}
const contributionFields = (existingBalance, annualEmployer, existingEmployer = null, existingFreq = null) => [
  { name: 'current_balance', kind: 'money', proposed: '113500.00', existing: existingBalance },
  { name: 'employer_contribution', kind: 'money', proposed: annualEmployer, existing: existingEmployer, rec: false, confirm: true },
  { name: 'contribution_frequency', kind: 'enum', proposed: 'annually', existing: existingFreq, rec: false, confirm: true },
];
const account = (db, id) => one(db, `select current_balance::text b, employer_contribution::text e, personal_contribution::text p, contribution_frequency f, source_type s from retirement_accounts where id = $1`, [id]);
const apply = (db, uid, pid, mode, fields) => rpc(db, uid, `select fdh12_apply_retirement_proposal($1, $2, $3) r`, [pid, mode, fields]);
const confirmLeg = (db, uid, actId) => rpc(db, uid, `select fdh12_confirm_retirement_bank_leg($1) r`, [actId]);

// ============================================================================
console.log(`WP-13 0211 PGlite verification -- real chain to ${files[files.indexOf(TARGET) - 1]}, then ${TARGET} (twice)\n`);
const db = await replayUpToTarget();
await seed(db);
const out = {};

// Shared fixtures (inserted by the superuser = the service-role processing path).
const STMT_ANNUAL = await statement(db, A, { canonical_account_id: ACC_SUPER_A, employer_contributions: '12000.00' });
const STMT_PENDING = await statement(db, A, { approval_status: 'pending', approved_at: null, fund_name: 'Hostplus (unapproved)' });
const ACT_CONTRIB = await activity(db, A, STMT_ANNUAL, { activity_type: 'PERSONAL_CONTRIBUTION', amount: '500.00', activity_date: '2026-08-11', bank_match_status: 'matched', linked_transaction_id: TXN_CONTRIB });
const ACT_PENSION = await activity(db, A, STMT_ANNUAL, { activity_type: 'PENSION_PAYMENT', amount: '2000.00', activity_date: '2026-08-15', bank_match_status: 'matched', linked_transaction_id: TXN_PENSION });
const ACT_OVERRIDE = await activity(db, A, STMT_ANNUAL, { activity_type: 'PERSONAL_CONTRIBUTION', amount: '300.00', activity_date: '2026-08-11', bank_match_status: 'matched', linked_transaction_id: TXN_OVERRIDE });
const ACT_WRONG_DIR = await activity(db, A, STMT_ANNUAL, { activity_type: 'PERSONAL_CONTRIBUTION', amount: '750.00', activity_date: '2026-08-12', bank_match_status: 'matched', linked_transaction_id: TXN_WRONG_DIR });
const ACT_FEE = await activity(db, A, STMT_ANNUAL, { activity_type: 'FEE', amount: '120.00', activity_date: '2026-06-30' });
const ACT_UNAPPROVED = await activity(db, A, STMT_PENDING, { activity_type: 'PERSONAL_CONTRIBUTION', amount: '200.00', bank_match_status: 'no_match' });

// ---------------- 1. BEFORE 0211: every defect is real ----------------
console.log('1. BEFORE 0211 -- the predecessor (0119 RPC, 0112/0113 triggers)');
{
  const pid = await proposal(db, A, STMT_ANNUAL, ACC_SUPER_A, contributionFields('100000.00', '12000.00'));
  const r = await apply(db, A, pid, 'update_existing', null);
  const acc = await account(db, ACC_SUPER_A);
  check('anti-vacuity GAP-RET-01: 0119 update_existing with NO selection applies the UNTICKED, confirmation-gated employer_contribution',
    r.ok === true && acc.e === '12000.00' && (r.applied_fields ?? []).includes('employer_contribution'), JSON.stringify(r).slice(0, 160));
  await db.exec(`update retirement_accounts set current_balance = 100000.00, employer_contribution = null, contribution_frequency = null where id = '${ACC_SUPER_A}'`);

  const pid2 = await proposal(db, A, STMT_ANNUAL, ACC_SUPER_A, contributionFields('100000.00', '12000.00'));
  const r2 = await apply(db, A, pid2, 'apply_selected_fields', ['employer_contribution']);
  const acc2 = await account(db, ACC_SUPER_A);
  check('anti-vacuity GAP-RET-02: 0119 applies a contribution AMOUNT without its frequency (null frequency is then read as monthly)',
    r2.ok === true && acc2.e === '12000.00' && acc2.f === null, `${JSON.stringify(r2).slice(0, 120)} freq=${acc2.f}`);
  await db.exec(`update retirement_accounts set current_balance = 100000.00, employer_contribution = null, contribution_frequency = null where id = '${ACC_SUPER_A}'`);

  const pid3 = await proposal(db, A, STMT_ANNUAL, ACC_MANUAL_A, [
    { name: 'contribution_frequency', kind: 'enum', proposed: 'annually', existing: 'monthly', rec: false, confirm: true },
  ]);
  const r3 = await apply(db, A, pid3, 'apply_selected_fields', ['contribution_frequency']);
  const acc3 = await account(db, ACC_MANUAL_A);
  check('anti-vacuity GAP-RET-02: 0119 lets a frequency change silently re-mean an existing manual $1,000/month employer contribution',
    r3.ok === true && acc3.e === '1000.00' && acc3.f === 'annually', `${JSON.stringify(r3).slice(0, 100)} -> ${acc3.e} ${acc3.f}`);
  await db.exec(`update retirement_accounts set contribution_frequency = 'monthly' where id = '${ACC_MANUAL_A}'`);

  const forgedStmt = await asUser(db, A, () => errorOf(db,
    `insert into fdh_retirement_statements (user_id, statement_type, retirement_jurisdiction, account_type, currency_code, closing_balance, approval_status, approved_at, extraction_status, reconciliation_status)
     values ($1, 'super_member_statement', 'AU', 'industry_super', 'AUD', 9999999.00, 'approved', now(), 'extracted', 'reconciled')`, [A]));
  check('anti-vacuity GAP-RET-09: an authenticated user CAN insert a forged APPROVED statement before 0211', forgedStmt === null, forgedStmt ?? 'inserted');
  const forgedAct = await asUser(db, A, () => errorOf(db,
    `insert into fdh_retirement_statement_activities (user_id, statement_id, activity_type, amount, currency_code, bank_match_status) values ($1, $2, 'EMPLOYER_CONTRIBUTION', 1.00, 'AUD', 'matched')`, [A, STMT_ANNUAL]));
  check('anti-vacuity GAP-RET-09: ... and a forged activity', forgedAct === null, forgedAct ?? 'inserted');
  const forgedPos = await asUser(db, A, () => errorOf(db,
    `insert into fdh_retirement_statement_positions (user_id, statement_id, option_name_raw, market_value, currency_code) values ($1, $2, 'Forged', 1.00, 'AUD')`, [A, STMT_ANNUAL]));
  check('anti-vacuity GAP-RET-09: ... and a forged position', forgedPos === null, forgedPos ?? 'inserted');
  await db.exec(`delete from fdh_retirement_statement_positions where option_name_raw = 'Forged'; delete from fdh_retirement_statement_activities where amount = 1.00 and activity_type = 'EMPLOYER_CONTRIBUTION'; delete from fdh_retirement_statements where closing_balance = 9999999.00;`);

  const warnErase = await asUser(db, A, () => errorOf(db, `update fdh_retirement_statements set extraction_warnings = '[]'::jsonb where id = $1`, [STMT_ANNUAL]));
  check('anti-vacuity GAP-RET-05: an authenticated user CAN overwrite extraction_warnings before 0211', warnErase === null, warnErase ?? 'accepted');

  const fn = await one(db, `select count(*)::int n from pg_proc where proname = 'fdh12_confirm_retirement_bank_leg'`);
  check('anti-vacuity GAP-RET-07: no confirmation path exists before 0211 -- the $500 BPAY to super stays a household expense', fn.n === 0);
  const leg = await one(db, `select economic_transaction_type t from fdh_transactions where id = $1`, [TXN_CONTRIB]);
  check('anti-vacuity GAP-RET-07: the matched $500 contribution debit is economic type expense', leg.t === 'expense');
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'fdh_retirement_statement_activities'`)).rows.map((x) => x.column_name);
  check('anti-vacuity: no bank_leg_confirmed_* columns before 0211', !cols.includes('bank_leg_confirmed_at') && !cols.includes('bank_leg_confirmed_type'));
  const anonBefore = await one(db, `select has_function_privilege('anon', 'fdh12_apply_retirement_proposal(uuid, text, text[])', 'execute') a`);
  check('anti-vacuity: 0119 revoked PUBLIC only -- anon still holds the default-privilege EXECUTE grant on the apply RPC', anonBefore.a === true);
}

// ---------------- APPLY 0211 ----------------
console.log('\n2. APPLY 0211');
const applyErr = await execErrorOf(db, target);
check('0211 applies cleanly on top of the real chain', applyErr === null, applyErr ?? '');
const tmpErr = await execErrorOf(db, `set role authenticated; reset role;`);
check('harness sanity: role switching still works after 0211', tmpErr === null, tmpErr ?? '');

// ---------------- 3. AFTER 0211 ----------------
console.log('\n3. AFTER 0211 -- confirmation-respecting apply (GAP-RET-01 / X-01, D-12)');
{
  const pid = await proposal(db, A, STMT_ANNUAL, ACC_SUPER_A, contributionFields('100000.00', '12000.00'));
  const r = await apply(db, A, pid, 'update_existing', null);
  const acc = await account(db, ACC_SUPER_A);
  check('update_existing with NO selection applies the recommended balance', r.ok === true && acc.b === '113500.00', JSON.stringify(r).slice(0, 140));
  check('... and leaves the UNTICKED employer_contribution unchanged (null)', acc.e === null, `employer=${acc.e}`);
  check('... and leaves contribution_frequency unchanged (null)', acc.f === null);
  check('... applied_fields names only current_balance', JSON.stringify(r.applied_fields) === '["current_balance"]', JSON.stringify(r.applied_fields));
  const again = await apply(db, A, pid, 'update_existing', null);
  check('idempotent: a second apply is ALREADY_APPLIED', again.ok === false && again.code === 'ALREADY_APPLIED');
  const apps = await one(db, `select count(*)::int n from fhip_import_applications where proposal_id = $1`, [pid]);
  check('exactly one application row for the proposal', apps.n === 1);
  await db.exec(`select set_config('fhip.import_bridge_internal_write','true',false); update retirement_accounts set current_balance = 100000.00 where id = '${ACC_SUPER_A}'; select set_config('fhip.import_bridge_internal_write','false',false);`);

  const pidNone = await proposal(db, A, STMT_ANNUAL, ACC_SUPER_A, [
    { name: 'employer_contribution', kind: 'money', proposed: '12000.00', existing: null, rec: false, confirm: true },
    { name: 'contribution_frequency', kind: 'enum', proposed: 'annually', existing: null, rec: false, confirm: true },
  ]);
  const rNone = await apply(db, A, pidNone, 'update_existing', null);
  check('update_existing with nothing recommended-and-unconfirmed selects nothing -> NO_FIELDS_SELECTED (never "everything")', rNone.ok === false && rNone.code === 'NO_FIELDS_SELECTED', JSON.stringify(rNone).slice(0, 120));

  const pid2 = await proposal(db, A, STMT_ANNUAL, ACC_SUPER_A, contributionFields('100000.00', '12000.00'));
  const r2 = await apply(db, A, pid2, 'apply_selected_fields', ['employer_contribution']);
  const acc2 = await account(db, ACC_SUPER_A);
  check('a contribution AMOUNT without its frequency is refused (DOMAIN_VALIDATION_FAILED)', r2.ok === false && r2.code === 'DOMAIN_VALIDATION_FAILED' && r2.field === 'contribution_frequency', JSON.stringify(r2).slice(0, 140));
  check('... and nothing was written', acc2.e === null && acc2.b === '100000.00');
  const st2 = await one(db, `select status from fhip_import_proposals where id = $1`, [pid2]);
  check('... and the proposal stays ready (not consumed by a refusal)', st2.status === 'ready');

  const r3 = await apply(db, A, pid2, 'update_existing', ['current_balance', 'employer_contribution', 'contribution_frequency']);
  const acc3 = await account(db, ACC_SUPER_A);
  check('D-12: ticking the annualised amount WITH its frequency applies both', r3.ok === true && acc3.e === '12000.00' && acc3.f === 'annually', `${acc3.e} ${acc3.f}`);
  out.annualAccount = { id: ACC_SUPER_A, account_name: 'Hostplus', account_type: 'super', current_balance: Number(acc3.b), currency_code: 'AUD', owner: 'self', employer_contribution: Number(acc3.e), personal_contribution: null, contribution_frequency: acc3.f, source_type: acc3.s, retirement_member_id: MEM_A };

  const pidOneOff = await proposal(db, A, STMT_ANNUAL, ACC_ROLL_TO, [
    { name: 'employer_contribution', kind: 'money', proposed: '500.00', existing: null, rec: false, confirm: true },
    { name: 'contribution_frequency', kind: 'enum', proposed: 'one_off', existing: null, rec: false, confirm: true },
  ]);
  const rOneOff = await apply(db, A, pidOneOff, 'apply_selected_fields', ['employer_contribution', 'contribution_frequency']);
  check("a frequency that is not a rate ('one_off') is refused", rOneOff.ok === false && rOneOff.code === 'DOMAIN_VALIDATION_FAILED', JSON.stringify(rOneOff).slice(0, 120));

  const pid4 = await proposal(db, A, STMT_ANNUAL, ACC_MANUAL_A, [
    { name: 'personal_contribution', kind: 'money', proposed: '2400.00', existing: null, rec: false, confirm: true },
    { name: 'contribution_frequency', kind: 'enum', proposed: 'annually', existing: 'monthly', rec: false, confirm: true },
  ]);
  const r4 = await apply(db, A, pid4, 'apply_selected_fields', ['personal_contribution', 'contribution_frequency']);
  const acc4 = await account(db, ACC_MANUAL_A);
  check('a frequency change that would re-mean the existing manual $1,000/month employer contribution is refused', r4.ok === false && r4.code === 'DOMAIN_VALIDATION_FAILED' && r4.field === 'employer_contribution', JSON.stringify(r4).slice(0, 160));
  check('... and the manual row is untouched ($1,000 monthly)', acc4.e === '1000.00' && acc4.f === 'monthly' && acc4.p === null);
  const pid5 = await proposal(db, A, STMT_ANNUAL, ACC_MANUAL_A, [
    { name: 'employer_contribution', kind: 'money', proposed: '12000.00', existing: '1000.00', rec: false, confirm: true },
    { name: 'personal_contribution', kind: 'money', proposed: '2400.00', existing: null, rec: false, confirm: true },
    { name: 'contribution_frequency', kind: 'enum', proposed: 'annually', existing: 'monthly', rec: false, confirm: true },
  ]);
  const r5 = await apply(db, A, pid5, 'apply_selected_fields', ['employer_contribution', 'personal_contribution', 'contribution_frequency']);
  const acc5 = await account(db, ACC_MANUAL_A);
  check('positive control: restating the existing contribution at the new frequency is accepted ($12,000 + $2,400 annually)', r5.ok === true && acc5.e === '12000.00' && acc5.p === '2400.00' && acc5.f === 'annually', `${JSON.stringify(r5).slice(0, 80)} ${acc5.e} ${acc5.p} ${acc5.f}`);
}

console.log('\n4. AFTER 0211 -- carried predecessor guards (SMSF, member, forbidden field, stale)');
{
  const pS = await proposal(db, A, STMT_ANNUAL, ACC_SMSF_A, [{ name: 'current_balance', kind: 'money', proposed: '1.00', existing: '400000.00' }]);
  const rS = await apply(db, A, pS, 'update_existing', null);
  const smsf = await account(db, ACC_SMSF_A);
  check('SMSF boundary: an SMSF target is still refused SMSF_ACCOUNT_NOT_IMPORTABLE', rS.ok === false && rS.code === 'SMSF_ACCOUNT_NOT_IMPORTABLE', JSON.stringify(rS).slice(0, 100));
  check('... and the SMSF balance is untouched', smsf.b === '400000.00');

  const MEM_SPOUSE = 'a0000000-0000-0000-0000-0000000000bb';
  await db.exec(`insert into retirement_members (id, user_id, member_type, target_retirement_age, is_active) values ('${MEM_SPOUSE}', '${A}', 'spouse', 65, true)`);
  const stmtSpouse = await statement(db, A, { retirement_member_id: MEM_SPOUSE, fund_name: 'Spouse fund' });
  const pM = await proposal(db, A, stmtSpouse, ACC_ROLL_FROM, [{ name: 'current_balance', kind: 'money', proposed: '1.00', existing: '50000.00' }]);
  const rM = await apply(db, A, pM, 'update_existing', null);
  check('member boundary: MEMBER_MISMATCH is still refused', rM.ok === false && rM.code === 'MEMBER_MISMATCH', JSON.stringify(rM).slice(0, 100));

  const pF = await proposal(db, A, STMT_ANNUAL, ACC_ROLL_FROM, [
    { name: 'current_balance', kind: 'money', proposed: '1.00', existing: '50000.00' },
    { name: 'target_retirement_age', kind: 'int', proposed: '50', existing: '67' },
  ]);
  const rF = await apply(db, A, pF, 'apply_selected_fields', ['current_balance', 'target_retirement_age']);
  check('allow-list: target_retirement_age is still FORBIDDEN_FIELD', rF.ok === false && rF.code === 'FORBIDDEN_FIELD');

  const pU = await proposal(db, A, STMT_PENDING, ACC_ROLL_FROM, [{ name: 'current_balance', kind: 'money', proposed: '1.00', existing: '50000.00' }]);
  const rU = await apply(db, A, pU, 'update_existing', null);
  check('unapproved evidence is still EVIDENCE_NOT_APPROVED', rU.ok === false && rU.code === 'EVIDENCE_NOT_APPROVED');

  const pStale = await proposal(db, A, STMT_ANNUAL, ACC_ROLL_FROM, [{ name: 'current_balance', kind: 'money', proposed: '1.00', existing: '49999.00' }]);
  const rStale = await apply(db, A, pStale, 'update_existing', null);
  check('a stale proposal is still STALE_PROPOSAL', rStale.ok === false && rStale.code === 'STALE_PROPOSAL');

  const pB = await proposal(db, A, STMT_ANNUAL, ACC_ROLL_FROM, [{ name: 'current_balance', kind: 'money', proposed: '1.00', existing: '50000.00' }]);
  const rB = await apply(db, B, pB, 'update_existing', null);
  check("cross-tenant: user B cannot apply user A's proposal (PROPOSAL_NOT_FOUND)", rB.ok === false && rB.code === 'PROPOSAL_NOT_FOUND');
  const priv = await one(db, `select has_function_privilege('anon', 'fdh12_apply_retirement_proposal(uuid, text, text[])', 'execute') a,
    has_function_privilege('authenticated', 'fdh12_apply_retirement_proposal(uuid, text, text[])', 'execute') u`);
  check('grants unchanged: authenticated may execute the apply RPC, anon may not', priv.u === true && priv.a === false);
}

console.log('\n5. AFTER 0211 -- INSERT-forgery guard (GAP-RET-09) and extraction_warnings (GAP-RET-05)');
{
  const forgedStmt = await asUser(db, A, () => errorOf(db,
    `insert into fdh_retirement_statements (user_id, statement_type, retirement_jurisdiction, account_type, currency_code, closing_balance, approval_status, approved_at, extraction_status, reconciliation_status)
     values ($1, 'super_member_statement', 'AU', 'industry_super', 'AUD', 9999999.00, 'approved', now(), 'extracted', 'reconciled')`, [A]));
  check('a forged APPROVED statement INSERT by the authenticated role is refused', forgedStmt !== null && /system-authoritative/.test(forgedStmt), forgedStmt ?? 'inserted');
  const forgedPending = await asUser(db, A, () => errorOf(db,
    `insert into fdh_retirement_statements (user_id, statement_type, retirement_jurisdiction, account_type, currency_code) values ($1, 'super_member_statement', 'AU', 'industry_super', 'AUD')`, [A]));
  check('... even a default (pending) statement INSERT is refused -- the service role is the only inserter', forgedPending !== null && /system-authoritative/.test(forgedPending), forgedPending ?? 'inserted');
  const forgedAct = await asUser(db, A, () => errorOf(db,
    `insert into fdh_retirement_statement_activities (user_id, statement_id, activity_type, amount, currency_code, bank_match_status) values ($1, $2, 'EMPLOYER_CONTRIBUTION', 1.00, 'AUD', 'matched')`, [A, STMT_ANNUAL]));
  check('a forged activity INSERT is refused', forgedAct !== null && /system-authoritative/.test(forgedAct), forgedAct ?? 'inserted');
  const forgedPos = await asUser(db, A, () => errorOf(db,
    `insert into fdh_retirement_statement_positions (user_id, statement_id, option_name_raw, market_value, currency_code) values ($1, $2, 'Forged', 1.00, 'AUD')`, [A, STMT_ANNUAL]));
  check('a forged position INSERT is refused', forgedPos !== null && /system-authoritative/.test(forgedPos), forgedPos ?? 'inserted');
  const forgedCount = await one(db, `select (select count(*) from fdh_retirement_statements where closing_balance = 9999999.00) + (select count(*) from fdh_retirement_statement_positions where option_name_raw = 'Forged') n`);
  check('... and no forged row exists', Number(forgedCount.n) === 0);

  const svc = await as(db, 'service_role', A, () => errorOf(db,
    `insert into fdh_retirement_statements (user_id, statement_type, retirement_jurisdiction, account_type, currency_code, fund_name) values ($1, 'super_member_statement', 'AU', 'industry_super', 'AUD', 'service role insert')`, [A]));
  check('positive control: the service-role processing path can still insert', svc === null, svc ?? '');
  const svcAct = await as(db, 'service_role', A, () => errorOf(db,
    `insert into fdh_retirement_statement_activities (user_id, statement_id, activity_type, amount, currency_code) values ($1, $2, 'FEE', 10.00, 'AUD')`, [A, STMT_ANNUAL]));
  check('positive control: the service role can still insert activities', svcAct === null, svcAct ?? '');
  const svcWarn = await as(db, 'service_role', A, () => errorOf(db,
    `update fdh_retirement_statements set extraction_warnings = '[{"code":"unrecognised_summary_rows","count":2}]'::jsonb where id = $1`, [STMT_ANNUAL]));
  check('positive control: the service role can record extraction_warnings', svcWarn === null, svcWarn ?? '');

  const warnErase = await asUser(db, A, () => errorOf(db, `update fdh_retirement_statements set extraction_warnings = '[]'::jsonb where id = $1`, [STMT_ANNUAL]));
  check('an authenticated user can no longer erase extraction_warnings', warnErase !== null && /system-authoritative/.test(warnErase), warnErase ?? 'accepted');
  const nick = await asUser(db, A, () => errorOf(db, `update fdh_retirement_statements set nickname = 'My super', fund_name = 'Hostplus Balanced' where id = $1`, [STMT_ANNUAL]));
  check('positive control: the user-correctable fields (nickname, fund_name) stay writable', nick === null, nick ?? '');
  const approvedForge = await asUser(db, A, () => errorOf(db, `update fdh_retirement_statements set approval_status = 'approved' where id = $1`, [STMT_PENDING]));
  check('the 0112/0113 UPDATE guard is carried: approval_status still refused', approvedForge !== null && /system-authoritative/.test(approvedForge), approvedForge ?? 'accepted');
  const confirmForge = await asUser(db, A, () => errorOf(db, `update fdh_retirement_statement_activities set bank_leg_confirmed_at = now(), bank_leg_confirmed_type = 'transfer' where id = $1`, [ACT_CONTRIB]));
  check('an authenticated user cannot forge the bank-leg confirmation columns', confirmForge !== null && /system-authoritative/.test(confirmForge), confirmForge ?? 'accepted');
  const linkForge = await asUser(db, A, () => errorOf(db, `update fdh_retirement_statement_activities set linked_transaction_id = null where id = $1`, [ACT_CONTRIB]));
  check('the 0112 activity UPDATE guard is carried: linked_transaction_id still refused', linkForge !== null && /system-authoritative/.test(linkForge), linkForge ?? 'accepted');
  const badType = await as(db, 'service_role', A, () => errorOf(db, `update fdh_retirement_statement_activities set bank_leg_confirmed_at = now(), bank_leg_confirmed_type = 'expense' where id = $1`, [ACT_FEE]));
  check("bank_leg_confirmed_type outside (transfer, income) is refused by the CHECK", badType !== null && /bank_leg_confirmed/.test(badType), badType ?? 'accepted');
}

console.log('\n6. AFTER 0211 -- user-confirmed bank leg (GAP-RET-07): the $500 personal contribution oracle');
{
  const before = await one(db, `select economic_transaction_type t from fdh_transactions where id = $1`, [TXN_CONTRIB]);
  out.bankLegsBefore = (await db.query(`select id, economic_transaction_type, amount_original, credit_debit, user_override from fdh_transactions where user_id = $1 order by id`, [A])).rows;
  const unapproved = await confirmLeg(db, A, ACT_UNAPPROVED);
  check('an activity on an UNAPPROVED statement cannot be confirmed', unapproved.ok === false && unapproved.code === 'EVIDENCE_NOT_APPROVED', JSON.stringify(unapproved).slice(0, 100));
  const fee = await confirmLeg(db, A, ACT_FEE);
  check('an internal activity (FEE) is not a bank movement', fee.ok === false && fee.code === 'NOT_A_BANK_MOVEMENT');
  const foreign = await confirmLeg(db, B, ACT_CONTRIB);
  check("cross-tenant: user B cannot confirm user A's activity (NOT_FOUND)", foreign.ok === false && foreign.code === 'NOT_FOUND');
  const wrongDir = await confirmLeg(db, A, ACT_WRONG_DIR);
  const wrongDirTxn = await one(db, `select economic_transaction_type t from fdh_transactions where id = $1`, [TXN_WRONG_DIR]);
  check('a contribution linked to a bank CREDIT is refused (BANK_MATCH_INCONSISTENT), leg unchanged', wrongDir.ok === false && wrongDir.code === 'BANK_MATCH_INCONSISTENT' && wrongDirTxn.t === 'income', JSON.stringify(wrongDir).slice(0, 100));

  const r = await confirmLeg(db, A, ACT_CONTRIB);
  const after = await one(db, `select economic_transaction_type t, user_override o from fdh_transactions where id = $1`, [TXN_CONTRIB]);
  check("confirming the $500 PERSONAL_CONTRIBUTION reclassifies the bank debit expense -> transfer", before.t === 'expense' && r.ok === true && r.outcome === 'reclassified' && after.t === 'transfer', JSON.stringify(r).slice(0, 140));
  check('... without marking the leg as a user override', after.o === false);
  const corr = await one(db, `select count(*)::int n from fdh_transaction_corrections where transaction_id = $1 and field_name = 'economic_transaction_type' and previous_value = '"expense"'::jsonb and corrected_value = '"transfer"'::jsonb`, [TXN_CONTRIB]);
  check('... with a recorded correction (history preserved)', corr.n === 1);
  const aud = await one(db, `select count(*)::int n from fdh_document_audit_events where event_type = 'bank_leg_reclassified_by_import' and metadata->>'transaction_id' = $1 and metadata->>'source_kind' = 'retirement_statement_activity'`, [TXN_CONTRIB]);
  check("... audited 'bank_leg_reclassified_by_import' with source_kind retirement_statement_activity", aud.n === 1);
  const stamp = await one(db, `select bank_leg_confirmed_type t, bank_leg_confirmed_at is not null c from fdh_retirement_statement_activities where id = $1`, [ACT_CONTRIB]);
  check('... and the activity records the confirmation (transfer)', stamp.t === 'transfer' && stamp.c === true);
  const again = await confirmLeg(db, A, ACT_CONTRIB);
  const corr2 = await one(db, `select count(*)::int n from fdh_transaction_corrections where transaction_id = $1`, [TXN_CONTRIB]);
  check('idempotent: a second confirmation is ALREADY_CONFIRMED and writes no second correction', again.ok === true && again.code === 'ALREADY_CONFIRMED' && corr2.n === 1);

  const pension = await confirmLeg(db, A, ACT_PENSION);
  const pensionTxn = await one(db, `select economic_transaction_type t from fdh_transactions where id = $1`, [TXN_PENSION]);
  check('a PENSION_PAYMENT credit is classified ONCE, as income', pension.ok === true && pension.new_type === 'income' && pensionTxn.t === 'income', JSON.stringify(pension).slice(0, 120));
  const override = await confirmLeg(db, A, ACT_OVERRIDE);
  const overrideTxn = await one(db, `select economic_transaction_type t from fdh_transactions where id = $1`, [TXN_OVERRIDE]);
  check("a leg the user categorised themselves is left alone ('skipped_user_override')", override.ok === true && override.outcome === 'skipped_user_override' && overrideTxn.t === 'expense', JSON.stringify(override).slice(0, 120));
  const grocery = await one(db, `select economic_transaction_type t from fdh_transactions where id = $1`, [TXN_GROCERY]);
  check('an unrelated $200 grocery debit is untouched (still expense)', grocery.t === 'expense');
  const priv = await one(db, `select has_function_privilege('anon', 'fdh12_confirm_retirement_bank_leg(uuid)', 'execute') a, has_function_privilege('authenticated', 'fdh12_confirm_retirement_bank_leg(uuid)', 'execute') u`);
  check('the confirm RPC is executable by authenticated, not anon', priv.u === true && priv.a === false);
  const gucLeak = await one(db, `select coalesce(current_setting('fhip.import_bridge_internal_write', true), '') v`);
  check('the internal-write GUC does not leak out of the RPCs', gucLeak.v !== 'true', `'${gucLeak.v}'`);
  out.bankLegsAfter = (await db.query(`select id, economic_transaction_type, amount_original, credit_debit, user_override from fdh_transactions where user_id = $1 order by id`, [A])).rows;
}

console.log('\n7. AFTER 0211 -- rollover neutrality, holdings never double Net Worth, employer super is one effect');
{
  const counts = async () => one(db, `select (select count(*) from fdh_transactions)::int t, (select count(*) from income_sources)::int i, (select count(*) from expense_items)::int e,
    (select count(*) from retirement_accounts)::int r, (select count(*) from fdh_retirement_statement_positions)::int p`);
  const totalRollover = async () => (await one(db, `select sum(current_balance)::text s from retirement_accounts where id in ($1, $2)`, [ACC_ROLL_FROM, ACC_ROLL_TO])).s;
  const c0 = await counts();
  const nw0 = await totalRollover();
  const sOut = await statement(db, A, { fund_name: 'Old Fund', opening_balance: '50000.00', closing_balance: '0.00', rollovers_out: '50000.00', canonical_account_id: ACC_ROLL_FROM });
  await activity(db, A, sOut, { activity_type: 'ROLLOVER_OUT', amount: '50000.00', activity_date: '2026-03-01' });
  const sIn = await statement(db, A, { fund_name: 'New Fund', opening_balance: '0.00', closing_balance: '50000.00', rollovers_in: '50000.00', canonical_account_id: ACC_ROLL_TO });
  await activity(db, A, sIn, { activity_type: 'ROLLOVER_IN', amount: '50000.00', activity_date: '2026-03-03' });
  const rOut = await apply(db, A, await proposal(db, A, sOut, ACC_ROLL_FROM, [{ name: 'current_balance', kind: 'money', proposed: '0.00', existing: '50000.00' }]), 'update_existing', null);
  const rIn = await apply(db, A, await proposal(db, A, sIn, ACC_ROLL_TO, [{ name: 'current_balance', kind: 'money', proposed: '50000.00', existing: '0.00' }]), 'update_existing', null);
  const nw1 = await totalRollover();
  const c1 = await counts();
  check('rollover A -> B: both statements apply', rOut.ok === true && rIn.ok === true);
  check('rollover A -> B: household retirement total (Net Worth contribution) delta = 0', nw0 === nw1 && nw1 === '50000.00', `${nw0} -> ${nw1}`);
  check('rollover A -> B: income 0 / expense 0 -- no transaction, income source or expense item was created', c1.t === c0.t && c1.i === c0.i && c1.e === c0.e, JSON.stringify({ c0, c1 }));
  check('rollover A -> B: no retirement account was created or removed', c1.r === c0.r);

  const sPos = await statement(db, A, { fund_name: 'Aware Super', opening_balance: '150000.00', closing_balance: '200000.00', canonical_account_id: ACC_POS_A });
  for (const [name, mv] of [['High Growth', '120000.00'], ['Balanced', '80000.00']]) {
    await db.query(`insert into fdh_retirement_statement_positions (user_id, statement_id, option_name_raw, market_value, currency_code) values ($1, $2, $3, $4, 'AUD')`, [A, sPos, name, mv]);
  }
  const posSum = await one(db, `select sum(market_value)::text s from fdh_retirement_statement_positions where statement_id = $1`, [sPos]);
  check('anti-vacuity: the holdings inside the fund sum to the same $200,000 as the balance (a naive sum would be $400,000)', posSum.s === '200000.0000', posSum.s);
  const rPos = await apply(db, A, await proposal(db, A, sPos, ACC_POS_A, [{ name: 'current_balance', kind: 'money', proposed: '200000.00', existing: '150000.00' }]), 'update_existing', null);
  const posAcc = await account(db, ACC_POS_A);
  const inv = await one(db, `select count(*)::int n from investments where user_id = $1`, [A]);
  check('holdings: applying the statement sets the fund balance to $200,000 and nothing else', rPos.ok === true && posAcc.b === '200000.00');
  check('holdings: no investment row was created from the positions (Net Worth counts $200,000 once)', inv.n === 0);
  out.rolloverAccounts = (await db.query(`select id, account_name, account_type, current_balance::float8 current_balance, currency_code, owner, employer_contribution::float8 employer_contribution, personal_contribution::float8 personal_contribution, contribution_frequency, source_type, retirement_member_id from retirement_accounts where user_id = $1 and master_item_key is distinct from 'smsf' order by id`, [A])).rows;
  out.positionsMarketValue = Number(posSum.s);

  const pay = await one(db, `insert into fdh_payroll_events (user_id, country_code, currency_code, pay_frequency, pay_frequency_source, employer_name, employer_retirement_contribution) values ($1, 'AU', 'AUD', 'monthly', 'stated_on_payslip', 'Acme', 1000.00) returning id`, [A]);
  const sEmp = await statement(db, A, { fund_name: 'Hostplus', closing_balance: '114500.00', employer_contributions: '1000.00', canonical_account_id: ACC_SUPER_A });
  await activity(db, A, sEmp, { activity_type: 'EMPLOYER_CONTRIBUTION', amount: '1000.00', activity_date: '2026-07-14', payslip_match_status: 'matched', matched_payroll_event_id: pay.id });
  const second = await errorOf(db, `insert into fdh_retirement_statement_activities (user_id, statement_id, activity_type, amount, currency_code, matched_payroll_event_id) values ($1, $2, 'EMPLOYER_CONTRIBUTION', 1000.00, 'AUD', $3)`, [A, sEmp, pay.id]);
  check('employer super: one payslip evidences at most ONE fund contribution (unique index)', second !== null && /duplicate key|unique/i.test(second), second ?? 'accepted');
  const c2 = await counts();
  const rEmp = await apply(db, A, await proposal(db, A, sEmp, ACC_SUPER_A, [{ name: 'current_balance', kind: 'money', proposed: '114500.00', existing: '113500.00' }]), 'update_existing', null);
  const c3 = await counts();
  check('employer super payslip + fund: applying creates no income source and no transaction (one effect: the balance)', rEmp.ok === true && c3.i === c2.i && c3.t === c2.t, JSON.stringify(rEmp).slice(0, 100));
}

// ---------------- 8. re-apply ----------------
console.log('\n8. RE-APPLY 0211');
{
  const fp1 = await schemaFingerprint(db);
  const data1 = JSON.stringify((await db.query(`select id, current_balance, employer_contribution, contribution_frequency from retirement_accounts order by id`)).rows);
  const reErr = await execErrorOf(db, target);
  const fp2 = await schemaFingerprint(db);
  const data2 = JSON.stringify((await db.query(`select id, current_balance, employer_contribution, contribution_frequency from retirement_accounts order by id`)).rows);
  check('re-applying 0211 raises nothing', reErr === null, reErr ?? '');
  check('re-applying 0211 changes no constraint, index, trigger, function, grant, policy or column', fp1 === fp2);
  check('re-applying 0211 changes no data', data1 === data2);
  const trig = await one(db, `select count(*)::int n from pg_trigger where tgname like 'trg_fdh_retirement_%_authoritative_insert'`);
  check('exactly three INSERT guards exist after re-apply', trig.n === 3);
  const con = await one(db, `select count(*)::int n from pg_constraint where conname = 'chk_fdh_retirement_activities_bank_leg_confirmed_0211'`);
  check('exactly one confirmation CHECK exists after re-apply', con.n === 1);
}

const total = pass + fail;
console.log(`\n=== WP-13 0211 PGlite verification: ${pass} PASS, ${fail} FAIL (${total} checks) ===`);
if (total < EXPECTED_MIN_CHECKS) { console.log(`FAIL: only ${total} checks ran (expected >= ${EXPECTED_MIN_CHECKS})`); process.exitCode = 1; }
if (fail > 0) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exitCode = 1; }
if (process.argv.includes('--json')) console.log('JSON:' + JSON.stringify({ pass, fail, total, ...out }));
