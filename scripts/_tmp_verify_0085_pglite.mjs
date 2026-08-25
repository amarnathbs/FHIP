// Standalone PGlite verification of migration 0085's
// fdh7_transaction_has_blocking_issue() fix — direct SQL-level proof,
// independent of the Next.js app layer.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const SHIM = path.join(HERE, 'db-rebuild-check', 'shim.sql');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; console.log(`  FAIL  ${label} ${detail}`); }
};

const db = await PGlite.create();
await db.exec(fs.readFileSync(SHIM, 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log('fresh rebuild through 0085 complete\n');

const U = '33333333-3333-3333-3333-333333333333';
const ACCT = 'c0000000-0000-0000-0000-00000000000c';
await db.exec(`insert into auth.users(id,email) values ('${U}','u@t.test');`);
await db.exec(`
  insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name, masked_identifier, status)
  values ('${ACCT}', '${U}', 'transaction', 'AU', 'AUD', 'Verify Everyday', '****9999', 'active');
`);

// Case 1: 'unknown', no allocations at all -> still blocked.
const T1 = 'd0000000-0000-0000-0000-000000000001';
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
  values ('${T1}', '${U}', '${ACCT}', '2026-07-01', 100.00, 'AUD', 'debit', 'unknown');
`);
const r1 = await db.query(`select fdh7_transaction_has_blocking_issue($1, $2) as blocked`, [U, T1]);
check("Case 1: 'unknown', NO allocations -> still BLOCKED (unchanged behaviour)", r1.rows[0].blocked === true);

// Case 2: 'unknown', allocations exist but under-allocated ($60 of $100) -> still blocked.
const T2 = 'd0000000-0000-0000-0000-000000000002';
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
  values ('${T2}', '${U}', '${ACCT}', '2026-07-02', 100.00, 'AUD', 'debit', 'unknown');
`);
await db.exec(`
  insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code)
  values ('${U}', '${T2}', 1, 'expense', 60.00, 'AUD');
`);
const r2 = await db.query(`select fdh7_transaction_has_blocking_issue($1, $2) as blocked`, [U, T2]);
check("Case 2: 'unknown', UNDER-allocated split ($60 of $100) -> still BLOCKED", r2.rows[0].blocked === true);

// Case 3: 'unknown', allocations reconcile exactly ($220+$80=$300) -> NOT blocked (the fix).
const T3 = 'd0000000-0000-0000-0000-000000000003';
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
  values ('${T3}', '${U}', '${ACCT}', '2026-07-03', 300.00, 'AUD', 'debit', 'unknown');
`);
await db.exec(`
  insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code)
  values
    ('${U}', '${T3}', 1, 'expense', 220.00, 'AUD'),
    ('${U}', '${T3}', 2, 'expense', 80.00, 'AUD');
`);
const r3 = await db.query(`select fdh7_transaction_has_blocking_issue($1, $2) as blocked`, [U, T3]);
check("Case 3: 'unknown', RECONCILED split ($220+$80=$300) -> NOT blocked (the fix)", r3.rows[0].blocked === false);

// Case 4: 'unknown', allocations OVER-allocated ($350 of $300) -> still blocked.
// (Inserted BEFORE the role switch below — superuser context, avoids the
// r7_block_authenticated_insert trigger entirely, same as every other insert
// in this script.)
const T4 = 'd0000000-0000-0000-0000-000000000004';
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
  values ('${T4}', '${U}', '${ACCT}', '2026-07-04', 300.00, 'AUD', 'debit', 'unknown');
`);
await db.exec(`
  insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code)
  values
    ('${U}', '${T4}', 1, 'expense', 220.00, 'AUD'),
    ('${U}', '${T4}', 2, 'expense', 130.00, 'AUD');
`);
const r4 = await db.query(`select fdh7_transaction_has_blocking_issue($1, $2) as blocked`, [U, T4]);
check("Case 4: 'unknown', OVER-allocated split ($220+$130=$350 of $300) -> still BLOCKED", r4.rows[0].blocked === true);

// Case 5 (unchanged-behaviour control): NOT 'unknown' (a normal clean expense, no split) -> not blocked by this clause.
const T5 = 'd0000000-0000-0000-0000-000000000005';
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
  values ('${T5}', '${U}', '${ACCT}', '2026-07-05', 50.00, 'AUD', 'debit', 'expense');
`);
const r5 = await db.query(`select fdh7_transaction_has_blocking_issue($1, $2) as blocked`, [U, T5]);
check('Case 5 CONTROL: ordinary classified expense, no split -> NOT blocked (unrelated to this fix, unchanged)', r5.rows[0].blocked === false);

// Case 3b: actually approve T3 via the real UPDATE + trigger path (not just
// the RPC) — the genuine, un-bypassable DB-level enforcement. Switch role
// LAST, after every superuser insert above is already done.
await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U, role: 'authenticated' })]);
await db.exec(`set role authenticated;`);
let approveError = null;
try {
  await db.query(
    `update fdh_transactions set approval_status = 'approved', approved_by = $1 where id = $2 and user_id = $1`,
    [U, T3],
  );
} catch (e) {
  approveError = e.message;
}
await db.exec(`reset role;`);
await db.query(`select set_config('request.jwt.claims', '{}', false)`);
const t3after = await db.query(`select approval_status, approved_at, approved_by from fdh_transactions where id = $1`, [T3]);
check('Case 3b: real UPDATE through the DB trigger succeeds (no exception)', approveError === null, approveError ? `error: ${approveError}` : '');
check("Case 3b: parent's approval_status is now 'approved'", t3after.rows[0]?.approval_status === 'approved', JSON.stringify(t3after.rows[0]));

console.log(`\n=== 0085 VERIFICATION: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
