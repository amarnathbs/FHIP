// FDH-7 — Reconciliation, Transaction Review & User Approval Workflow:
// PGlite-based DB-level certification (real Postgres 18, no live DEV DDL
// credential exists in this environment — migration 0076 is not yet applied
// to DEV, disclosed as the CONDITIONAL gap). Follows the exact pattern
// established by scripts/db-rebuild-check/rls.mjs, r7_security_certification.mjs
// and r8_security_certification.mjs: fresh clean rebuild, real two-tenant
// data, `set_config('request.jwt.claims', ...)` + `set role authenticated`
// to exercise RLS/triggers for real, and negative controls that prove every
// PASS above them is not vacuous.
//
// Usage: node scripts/fdh7_certification.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const SHIM = path.join(HERE, 'db-rebuild-check', 'shim.sql');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${detail}`); }
};

async function buildDb() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}

async function asRole(db, role, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role })]);
  await db.exec(`set role ${role};`);
  try { return await fn(); } finally {
    await db.exec(`reset role;`);
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function seedBaseline(db) {
  await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);
  await db.exec(`
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name, status)
    values
      ('a0000000-0000-0000-0000-00000000000a', '${A}', 'transaction', 'AU', 'AUD', 'A Everyday', 'active'),
      ('b0000000-0000-0000-0000-00000000000b', '${B}', 'transaction', 'AU', 'AUD', 'B Everyday', 'active');
  `);
  await db.exec(`
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, country_code, currency_code, processing_status, reconciliation_status)
    values
      ('c0000000-0000-0000-0000-00000000000c', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'csv', 'AU', 'AUD', 'ready_for_approval', 'reconciled'),
      ('d0000000-0000-0000-0000-00000000000d', '${B}', 'b0000000-0000-0000-0000-00000000000b', 'csv', 'AU', 'AUD', 'ready_for_approval', 'reconciled');
  `);
}

console.log('=== FDH-7 DB Certification (PGlite) ===\n');
const db = await buildDb();
await seedBaseline(db);

// fdh_transactions/fdh_reconciliation_results/fdh_duplicate_candidates are
// "engine-authoritative" (R7/R8 migrations 0064/0068 — INSERT blocked for
// role 'authenticated'). Seed them here, OUTSIDE any asRole() wrapper (the
// default PGlite connection is not the 'authenticated' role, matching every
// prior certification script's own established precedent for this exact
// class of table).
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
  values
    ('11111111-0000-0000-0000-000000000001', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c', '2026-03-01', 50.00, 'AUD', 'debit', 'expense'),
    ('11111111-0000-0000-0000-000000000002', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c', '2026-03-01', 10.00, 'AUD', 'debit', 'unknown'),
    ('11111111-0000-0000-0000-000000000003', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c', '2026-03-01', 300.00, 'AUD', 'debit', 'expense'),
    ('11111111-0000-0000-0000-000000000004', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c', '2026-03-01', 25.00, 'AUD', 'debit', 'expense');
`);
console.log('fresh rebuild + baseline seed complete\n');

// =============================================================================
// SECTION 1 — fdh7_transaction_has_blocking_issue() correctness
// =============================================================================
console.log('=== SECTION 1: transaction blocking-issue function ===');
await asRole(db, 'authenticated', A, async () => {
  // txn 004 is dedicated to this one "genuinely clean" assertion — kept
  // decoupled from every other fixture so nothing else in this section can
  // accidentally make it non-clean.
  let r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000004')`);
  check('clean expense transaction does NOT block', r.rows[0].fdh7_transaction_has_blocking_issue === false);

  r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000002')`);
  check('unknown economic_transaction_type blocks (spec 53)', r.rows[0].fdh7_transaction_has_blocking_issue === true);

  // Blocking review item blocks (fdh_review_items has no authenticated-insert
  // block — this IS the table application code writes to directly).
  await db.query(`insert into fdh_review_items (id, user_id, transaction_id, review_type, severity, status, title_code)
    values ('22222222-1111-0000-0000-000000000001', '${A}', '11111111-0000-0000-0000-000000000001', 'reconciliation_failure', 'blocking', 'open', 'test.blocking')`);
  r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000001')`);
  check('open blocking review item blocks', r.rows[0].fdh7_transaction_has_blocking_issue === true);
  // A 'warning'-severity item must NOT block.
  await db.query(`update fdh_review_items set severity = 'warning' where id = '22222222-1111-0000-0000-000000000001'`);
  r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000001')`);
  check('warning-severity review item does NOT block (spec 53 blocking vs non-blocking)', r.rows[0].fdh7_transaction_has_blocking_issue === false);
  await db.query(`delete from fdh_review_items where id = '22222222-1111-0000-0000-000000000001'`);
});

// fdh_duplicate_candidates is engine-authoritative — seed outside asRole.
await db.exec(`
  insert into fdh_duplicate_candidates (id, user_id, transaction_id_a, transaction_id_b, match_method, status)
  values ('33333333-0000-0000-0000-000000000001', '${A}', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000004', 'exact_hash', 'pending');
`);
await asRole(db, 'authenticated', A, async () => {
  // Pending duplicate candidate blocks (now touches BOTH 001 and 004).
  let r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000001')`);
  check('pending duplicate candidate blocks', r.rows[0].fdh7_transaction_has_blocking_issue === true);
  await db.query(`update fdh_duplicate_candidates set status = 'not_duplicate', resolved_at = now() where id = '33333333-0000-0000-0000-000000000001'`);
  r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000001')`);
  check('resolved duplicate candidate no longer blocks', r.rows[0].fdh7_transaction_has_blocking_issue === false);

  // Split 0.01 mismatch blocks (spec 45-46, 87, 127). fdh_transaction_
  // allocations has no authenticated-insert block — the real split service
  // writes here directly via the RLS-scoped session client.
  await db.query(`insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code)
    values ('${A}', '11111111-0000-0000-0000-000000000003', 1, 'expense', 220.00, 'AUD'), ('${A}', '11111111-0000-0000-0000-000000000003', 2, 'expense', 79.99, 'AUD')`);
  r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000003')`);
  check('split off by exactly $0.01 blocks approval (spec 87 negative control)', r.rows[0].fdh7_transaction_has_blocking_issue === true);
  await db.query(`update fdh_transaction_allocations set amount = 80.00 where transaction_id = '11111111-0000-0000-0000-000000000003' and allocation_sequence = 2`);
  r = await db.query(`select fdh7_transaction_has_blocking_issue('${A}', '11111111-0000-0000-0000-000000000003')`);
  check('split summing exactly to the parent no longer blocks', r.rows[0].fdh7_transaction_has_blocking_issue === false);
});

// =============================================================================
// SECTION 2 — transaction approval trigger
// =============================================================================
console.log('\n=== SECTION 2: transaction approval trigger (fdh7_guard_transaction_approval) ===');
await asRole(db, 'authenticated', A, async () => {
  let blocked = false;
  try {
    await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '11111111-0000-0000-0000-000000000002'`); // unknown class
  } catch (e) { blocked = /blocking review issue/.test(e.message); }
  check('cannot approve a transaction with unknown classification (server-side, spec 110)', blocked);

  let approvedByRequired = false;
  try {
    await db.query(`update fdh_transactions set approval_status = 'approved' where id = '11111111-0000-0000-0000-000000000001'`); // no approved_by
  } catch (e) { approvedByRequired = /must name the approving user/.test(e.message); }
  check('approval without naming approved_by is rejected', approvedByRequired);

  const r = await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '11111111-0000-0000-0000-000000000001' returning approved_at, approved_by`);
  check('clean transaction approves successfully', r.rows.length === 1 && r.rows[0].approved_by === A && r.rows[0].approved_at !== null);

  const idem = await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '11111111-0000-0000-0000-000000000001' returning approved_at`);
  check('re-approving an already-approved transaction is a harmless no-op (idempotency, spec 73)', idem.rows.length === 1);

  await db.query(`update fdh_transactions set approval_status = 'pending' where id = '11111111-0000-0000-0000-000000000001'`);
  const reverted = await db.query(`select approved_at, approved_by from fdh_transactions where id = '11111111-0000-0000-0000-000000000001'`);
  check('reverting approval clears approved_at/approved_by', reverted.rows[0].approved_at === null && reverted.rows[0].approved_by === null);
  // Re-approve for later sections. Transaction 002 is deliberately left
  // 'unknown' forever in this fixture set (reclassifying it would require
  // going through R8's own recorded-correction path, which is exactly
  // classificationReviewService.ts's job, not this DB-level script's) — it
  // is removed from the statement before section 3's "clean statement"
  // assertions run, below.
  await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '11111111-0000-0000-0000-000000000001'`);
  await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '11111111-0000-0000-0000-000000000003'`);
  await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '11111111-0000-0000-0000-000000000004'`);
});
// Remove the deliberately-permanent-'unknown' fixture from the statement so
// SECTION 3's "clean statement" assertions are about the statement-level
// policy, not a re-litigation of section 1's already-proven per-transaction
// block.
await db.exec(`delete from fdh_transactions where id = '11111111-0000-0000-0000-000000000002';`);

console.log('\n=== NEGATIVE CONTROL: prove the transaction-approval guard is not vacuous ===');
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
  values ('11111111-0000-0000-0000-000000000099', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c', '2026-03-01', 10.00, 'AUD', 'debit', 'unknown');
`);
await db.exec(`drop trigger trg_fdh7_guard_transaction_approval on fdh_transactions;`);
await asRole(db, 'authenticated', A, async () => {
  let succeeded = false;
  try {
    // approved_at set explicitly here (the dropped trigger normally does
    // this) so the ONLY variable under test is the trigger's blocking
    // logic, not the separate chk_fdh_txn_approval_requires_fields
    // constraint.
    await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}', approved_at = now() where id = '11111111-0000-0000-0000-000000000099'`);
    succeeded = true;
  } catch { /* still blocked by something else */ }
  check('control: WITHOUT the trigger, an unknown-classification transaction WOULD approve (proves the earlier PASS was real)', succeeded);
});
await db.exec(`create trigger trg_fdh7_guard_transaction_approval before update of approval_status on fdh_transactions for each row execute function fdh7_guard_transaction_approval();`);
await db.exec(`update fdh_transactions set approval_status = 'pending', approved_by = null where id = '11111111-0000-0000-0000-000000000099';`);
await asRole(db, 'authenticated', A, async () => {
  let blocked = false;
  try { await db.query(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '11111111-0000-0000-0000-000000000099'`); }
  catch { blocked = true; }
  check('control: trigger restored -> blocked again', blocked);
});
await db.exec(`delete from fdh_transactions where id = '11111111-0000-0000-0000-000000000099';`);

// =============================================================================
// SECTION 3 — statement approval trigger + reconciliation 0.01 negative control
// =============================================================================
console.log('\n=== SECTION 3: statement approval trigger + reconciliation negative control (spec 18, 127) ===');
await asRole(db, 'authenticated', A, async () => {
  let r = await db.query(`select fdh7_statement_has_blocking_issue('${A}', 'c0000000-0000-0000-0000-00000000000c')`);
  check('clean statement (all transactions clean/approved) does not block', r.rows[0].fdh7_statement_has_blocking_issue === false);
});
await db.exec(`
  insert into fdh_reconciliation_results (user_id, statement_upload_id, opening_balance, expected_closing_balance, reported_closing_balance, variance, status, currency_code)
  values ('${A}', 'c0000000-0000-0000-0000-00000000000c', 1000.00, 1000.00, 999.99, -0.01, 'failed', 'AUD');
`);
await asRole(db, 'authenticated', A, async () => {
  let r = await db.query(`select fdh7_statement_has_blocking_issue('${A}', 'c0000000-0000-0000-0000-00000000000c')`);
  check('reconciliation status=failed (even by $0.01) blocks statement approval (spec 18, 127)', r.rows[0].fdh7_statement_has_blocking_issue === true);

  let blocked = false;
  try { await db.query(`update fdh_statement_uploads set approved_by = '${A}' where id = 'c0000000-0000-0000-0000-00000000000c'`); }
  catch (e) { blocked = /unresolved blocking review issues/.test(e.message); }
  check('server rejects statement approval while reconciliation has failed (spec 123 state-bypass attack)', blocked);

  await db.query(`update fdh_reconciliation_results set status = 'reconciled', variance = 0, reported_closing_balance = 1000.00 where statement_upload_id = 'c0000000-0000-0000-0000-00000000000c'`);
  r = await db.query(`select fdh7_statement_has_blocking_issue('${A}', 'c0000000-0000-0000-0000-00000000000c')`);
  check('fixing the variance to exactly 0 clears the block', r.rows[0].fdh7_statement_has_blocking_issue === false);

  // Mirrors approvalService.ts#approveStatement's own step 3: advance
  // processing_status to 'approved' via the reused, unmodified lifecycle
  // guard BEFORE stamping approved_by — chk_fdh_uploads_approved_at
  // (FDH-3, migration 0046) requires processing_status to already be
  // 'approved'/'purge_pending'/'purged' whenever approved_at is set.
  await db.query(`update fdh_statement_uploads set processing_status = 'approved' where id = 'c0000000-0000-0000-0000-00000000000c'`);

  const approved = await db.query(`update fdh_statement_uploads set approved_by = '${A}' where id = 'c0000000-0000-0000-0000-00000000000c' returning approval_version, approved_at`);
  check('clean statement approves successfully, approval_version increments to 1', approved.rows[0].approval_version === 1 && approved.rows[0].approved_at !== null);

  // Reopen: approved_by -> null clears approved_at, stamps reopened_at.
  await db.query(`update fdh_statement_uploads set approved_by = null, reopened_by = '${A}', reopen_reason = 'test reopen' where id = 'c0000000-0000-0000-0000-00000000000c'`);
  const reopened = await db.query(`select approved_at, reopened_at, approval_version from fdh_statement_uploads where id = 'c0000000-0000-0000-0000-00000000000c'`);
  check('reopen clears approved_at, stamps reopened_at, PRESERVES approval_version (spec 63 — history not erased)', reopened.rows[0].approved_at === null && reopened.rows[0].reopened_at !== null && reopened.rows[0].approval_version === 1);

  // Re-approve: version increments to 2.
  const reapproved = await db.query(`update fdh_statement_uploads set approved_by = '${A}' where id = 'c0000000-0000-0000-0000-00000000000c' returning approval_version`);
  check('re-approval after reopen increments approval_version to 2', reapproved.rows[0].approval_version === 2);
});

// =============================================================================
// SECTION 4 — processing_status state-transition guard (spec 109, 127)
// =============================================================================
console.log('\n=== SECTION 4: processing_status state-transition guard ===');
await asRole(db, 'authenticated', A, async () => {
  const cases = [
    ['created -> ready_for_approval (skips the whole pipeline)', 'c0000000-0000-0000-0000-00000000000c', 'created'],
  ];
  // Set up a fresh document in 'created' to test forward-skip, and one in
  // 'rejected'/'purged' (terminal) to test the explicit FAIL-condition
  // examples from spec 109.
  await db.query(`insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, country_code, currency_code, processing_status)
    values ('e0000000-0000-0000-0000-00000000000e', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'csv', 'AU', 'AUD', 'created')`);
  let blocked = false;
  try { await db.query(`update fdh_statement_uploads set processing_status = 'approved' where id = 'e0000000-0000-0000-0000-00000000000e'`); }
  catch { blocked = true; }
  check("PENDING/created -> approved (skipping the pipeline) is rejected", blocked);

  await db.query(`insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, country_code, currency_code, processing_status)
    values ('f0000000-0000-0000-0000-00000000000f', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'csv', 'AU', 'AUD', 'purged')`);
  blocked = false;
  try { await db.query(`update fdh_statement_uploads set processing_status = 'approved' where id = 'f0000000-0000-0000-0000-00000000000f'`); }
  catch { blocked = true; }
  check("PURGED -> APPROVED is rejected (spec 109's own explicit example)", blocked);

  await db.query(`insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, country_code, currency_code, processing_status)
    values ('10000000-0000-0000-0000-000000000010', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'csv', 'AU', 'AUD', 'rejected')`);
  blocked = false;
  try { await db.query(`update fdh_statement_uploads set processing_status = 'approved' where id = '10000000-0000-0000-0000-000000000010'`); }
  catch { blocked = true; }
  check("REJECTED -> APPROVED without reopen is rejected (spec 109's own explicit example)", blocked);

  // Sanity/non-vacuous control: a genuinely LEGITIMATE transition on a fresh
  // row must still succeed — proves the trigger rejects only bad edges, not
  // everything.
  await db.query(`insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, country_code, currency_code, processing_status)
    values ('12000000-0000-0000-0000-000000000012', '${A}', 'a0000000-0000-0000-0000-00000000000a', 'csv', 'AU', 'AUD', 'created')`);
  const legit = await db.query(`update fdh_statement_uploads set processing_status = 'uploaded' where id = '12000000-0000-0000-0000-000000000012' returning processing_status`);
  check('sanity: a genuinely legitimate transition (created -> uploaded) still succeeds (control not vacuous)', legit.rows.length === 1 && legit.rows[0].processing_status === 'uploaded');
});

// =============================================================================
// SECTION 5 — tenant isolation on fdh_approved_financial_summaries + RLS
// negative control (spec 77-81, 122, 127)
// =============================================================================
console.log('\n=== SECTION 5: fdh_approved_financial_summaries tenant isolation ===');
await asRole(db, 'authenticated', A, async () => {
  await db.query(`insert into fdh_approved_financial_summaries (user_id, statement_upload_id, financial_account_id, approval_version, currency_code, approved_transaction_count, income_total, approved_by)
    values ('${A}', 'c0000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000a', 1, 'AUD', 3, 3000.00, '${A}')`);
});
await asRole(db, 'authenticated', B, async () => {
  await db.query(`insert into fdh_approved_financial_summaries (user_id, statement_upload_id, financial_account_id, approval_version, currency_code, approved_transaction_count, income_total, approved_by)
    values ('${B}', 'd0000000-0000-0000-0000-00000000000d', 'b0000000-0000-0000-0000-00000000000b', 1, 'AUD', 1, 500.00, '${B}')`);
});

await asRole(db, 'authenticated', B, async () => {
  const leak = await db.query(`select count(*)::int c from fdh_approved_financial_summaries where user_id = '${A}'`);
  check('Tenant B cannot read Tenant A approved summary', leak.rows[0].c === 0);
  const own = await db.query(`select count(*)::int c from fdh_approved_financial_summaries where user_id = '${B}'`);
  check('Tenant B reads own approved summary (positive control)', own.rows[0].c === 1);
});

console.log('\n=== SECTION 5b: forged cross-tenant actions (spec 78, 122) — all must fail ===');
await asRole(db, 'authenticated', B, async () => {
  // Forged transaction approval on A's own transaction.
  const r1 = await db.query(`update fdh_transactions set approval_status = 'pending' where id = '11111111-0000-0000-0000-000000000001' returning id`);
  check("Tenant B cannot even TOUCH Tenant A's transaction row (0 rows affected, RLS)", r1.rows.length === 0);

  // Forged statement approval on A's statement.
  const r2 = await db.query(`update fdh_statement_uploads set approved_by = '${B}' where id = 'c0000000-0000-0000-0000-00000000000c' returning id`);
  check("Tenant B cannot forge-approve Tenant A's statement (0 rows affected, RLS)", r2.rows.length === 0);

  // Forged split: B inserts an allocation row it OWNS (RLS with check on
  // user_id permits this — the row's user_id is B) naming A's transaction_id
  // as the parent. RLS alone cannot stop this because fdh_transaction_
  // allocations.transaction_id is a plain FK with no owner-match constraint
  // — this is the pre-existing, already-disclosed FDH1-F1 class of gap, not
  // a new FDH-7 regression, and is why splitTransaction() in the real
  // service ALWAYS re-fetches the parent via transactionsRepository.
  // getForUser(userId, transactionId) first and 404s if it is not the
  // caller's own row, rather than relying on RLS alone for this specific
  // FK.
  await db.query(`insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code)
    values ('${B}', '11111111-0000-0000-0000-000000000001', 9, 'expense', 1.00, 'AUD')`);
  const ownRowCheck = await db.query(`select transaction_id from fdh_transaction_allocations where user_id='${B}' and allocation_sequence = 9`);
  // NOTE: as B, this SELECT cannot itself confirm WHOSE transaction 001
  // really is — RLS on fdh_transactions correctly hides that from B even in
  // a join. The orphan is confirmed independently below, service-role side.
  check(
    'FDH1-F1 (disclosed, pre-existing, reconfirmed here): RLS with-check on user_id alone does not stop a same-tenant-owned allocation row from being INSERTED naming a FOREIGN transaction_id (the insert succeeds)',
    ownRowCheck.rows.length === 1 && ownRowCheck.rows[0].transaction_id === '11111111-0000-0000-0000-000000000001',
  );
});
// Confirm the orphan independently, outside RLS (service-role equivalent —
// the default PGlite connection), proving it really does point at A's row
// and is not merely an artifact of the test harness.
const orphanConfirm = await db.query(`select t.user_id as txn_owner from fdh_transaction_allocations a join fdh_transactions t on t.id = a.transaction_id where a.user_id='${B}' and a.allocation_sequence = 9`);
check('FDH1-F1 independently confirmed: the orphaned allocation really does reference Tenant A\'s own transaction row — reads are still RLS-safe (Tenant B never sees this fact itself), but application code must never rely on RLS alone for this FK', orphanConfirm.rows.length === 1 && orphanConfirm.rows[0].txn_owner === A);
await db.query(`delete from fdh_transaction_allocations where user_id = '${B}' and allocation_sequence = 9`);
await asRole(db, 'authenticated', B, async () => {

  // Forged read of A's approved summary via approved-summary API shape (RLS read).
  const r3 = await db.query(`select * from fdh_approved_financial_summaries where statement_upload_id = 'c0000000-0000-0000-0000-00000000000c'`);
  check("Tenant B's own-session query for Tenant A's statement's approved summary returns nothing", r3.rows.length === 0);
});

console.log('\n=== NEGATIVE CONTROL: disable RLS on fdh_approved_financial_summaries -> leak MUST appear ===');
await db.exec(`alter table fdh_approved_financial_summaries disable row level security;`);
await asRole(db, 'authenticated', B, async () => {
  const leak = await db.query(`select count(*)::int c from fdh_approved_financial_summaries where user_id = '${A}'`);
  check('control: RLS off -> Tenant B DOES see Tenant A (proves the earlier isolation test is not vacuous)', leak.rows[0].c === 1);
});
await db.exec(`alter table fdh_approved_financial_summaries enable row level security;`);
await asRole(db, 'authenticated', B, async () => {
  const restored = await db.query(`select count(*)::int c from fdh_approved_financial_summaries where user_id = '${A}'`);
  check('control: isolation restored', restored.rows[0].c === 0);
});

// =============================================================================
// SUMMARY
// =============================================================================
console.log(`\n=== FDH-7 DB CERTIFICATION: ${pass} PASS, ${fail} FAIL ===`);
if (fail > 0) process.exit(1);
