// FDH-8 — Financial Activity Experience: PGlite-based DB-level certification.
// Follows the exact established pattern (scripts/fdh7_certification.mjs,
// scripts/r8_security_certification.mjs): fresh clean rebuild of every real
// migration on real Postgres (PGlite), real two-tenant data,
// `set_config('request.jwt.claims', ...)` + `set role authenticated` to
// exercise RLS for real, and negative controls that prove every PASS above
// them is not vacuous.
//
// THIS SCRIPT DELIBERATELY RE-ISSUES THE EXACT SQL SHAPE
// `lib/financial-data-hub/analytics/financialActivityAnalytics.ts`'s
// `fetchScopedTransactions()` issues (same table, same WHERE clause
// structure: user_id + approval_status + transaction_date range + optional
// account_id) so what is certified here is genuinely the query FDH-8 runs,
// not a hand-picked simplification of it.
//
// Usage: node scripts/fdh8_certification.mjs
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
const ACCT_A = 'a0000000-0000-0000-0000-00000000000a';
const ACCT_B = 'b0000000-0000-0000-0000-00000000000b';

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
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name, masked_identifier, status)
    values
      ('${ACCT_A}', '${A}', 'transaction', 'AU', 'AUD', 'A Everyday', '****1234', 'active'),
      ('${ACCT_B}', '${B}', 'transaction', 'AU', 'AUD', 'B Everyday', '****5678', 'active');
  `);
}

console.log('=== FDH-8 DB Certification (PGlite) ===\n');
const db = await buildDb();
await seedBaseline(db);
console.log('fresh rebuild + baseline seed complete\n');

// =============================================================================
// SECTION 1 — Approved vs Pending separation at the SQL layer (Product Owner
// critical requirement, spec 12/88). Re-issues FDH-8's exact query shape.
// =============================================================================
console.log('=== SECTION 1: approved vs pending — the query FDH-8 actually issues ===');
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, approval_status, approved_at, approved_by)
  values
    ('a1111111-0000-0000-0000-000000000001', '${A}', '${ACCT_A}', '2026-08-05', 4250.00, 'AUD', 'debit', 'expense', 'approved', now(), '${A}'),
    ('a1111111-0000-0000-0000-000000000002', '${A}', '${ACCT_A}', '2026-08-06', 180.00, 'AUD', 'debit', 'expense', 'pending', null, null);
`);

await asRole(db, 'authenticated', A, async () => {
  const approvedQ = await db.query(
    `select id, amount_original from fdh_transactions where user_id = $1 and approval_status = 'approved' and transaction_date >= $2 and transaction_date <= $3`,
    [A, '2026-08-01', '2026-08-31'],
  );
  const pendingQ = await db.query(
    `select id, amount_original from fdh_transactions where user_id = $1 and approval_status = 'pending' and transaction_date >= $2 and transaction_date <= $3`,
    [A, '2026-08-01', '2026-08-31'],
  );
  check('approved-scoped query returns exactly the $4,250 approved row', approvedQ.rows.length === 1 && Number(approvedQ.rows[0].amount_original) === 4250);
  check('pending-scoped query returns exactly the $180 pending row', pendingQ.rows.length === 1 && Number(pendingQ.rows[0].amount_original) === 180);
  check('the two scoped queries never share a row', !approvedQ.rows.some((r) => pendingQ.rows.some((p) => p.id === r.id)));

  // NEGATIVE CONTROL: prove what a regression (dropping the approval_status
  // filter) WOULD produce, so the PASS checks above are not vacuous.
  const unscopedQ = await db.query(
    `select id, amount_original from fdh_transactions where user_id = $1 and transaction_date >= $2 and transaction_date <= $3`,
    [A, '2026-08-01', '2026-08-31'],
  );
  const unscopedTotal = unscopedQ.rows.reduce((sum, r) => sum + Number(r.amount_original), 0);
  check('NEGATIVE CONTROL — dropping approval_status filter WOULD merge pending into the total ($4,430, the exact forbidden number, spec 12)', unscopedTotal === 4430);
  check('the correctly-scoped approved total ($4,250) differs from the unscoped negative control ($4,430)', 4250 !== unscopedTotal);
});

// =============================================================================
// SECTION 2 — Tenant isolation for the exact FDH-8 query shape, including a
// forged account_id filter (spec 116-118).
// =============================================================================
console.log('\n=== SECTION 2: tenant isolation (RLS) for FDH-8 activity queries ===');
await db.exec(`
  insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, approval_status, approved_at, approved_by)
  values ('b1111111-0000-0000-0000-000000000001', '${B}', '${ACCT_B}', '2026-08-05', 9999.00, 'AUD', 'debit', 'expense', 'approved', now(), '${B}');
`);

await asRole(db, 'authenticated', A, async () => {
  const forged = await db.query(
    `select id from fdh_transactions where user_id = $1 and financial_account_id = $2`,
    [A, ACCT_B], // Tenant A's own session, forging Tenant B's account_id
  );
  check('Tenant A querying with a forged Tenant-B account_id gets zero rows (server derives user_id, RLS blocks the rest)', forged.rows.length === 0);

  // Even without the app-layer user_id predicate at all (simulating a bug
  // that forgot to add .eq('user_id', ...)), RLS alone must still block it.
  const rlsOnly = await db.query(`select id from fdh_transactions where financial_account_id = $1`, [ACCT_B]);
  check('RLS alone (no app-layer user_id filter) still blocks Tenant A from Tenant B\'s account', rlsOnly.rows.length === 0);

  const accountsForged = await db.query(`select id from fdh_financial_accounts where id = $1`, [ACCT_B]);
  check('Tenant A cannot read Tenant B\'s account row directly by forged id', accountsForged.rows.length === 0);
});
await asRole(db, 'authenticated', B, async () => {
  const own = await db.query(`select id from fdh_transactions where financial_account_id = $1`, [ACCT_B]);
  check('control: Tenant B genuinely can see their own account\'s transaction (RLS is not blocking everything)', own.rows.length === 1);
});

// =============================================================================
// SECTION 3 — Scale & pagination correctness (spec 96-97): 1000/1001 rows,
// no silent truncation, exact count and exact sum at scale.
// =============================================================================
console.log('\n=== SECTION 3: scale — 1,001 approved transactions ===');
{
  const rows = [];
  for (let i = 0; i < 1001; i += 1) {
    rows.push(`('c${String(i).padStart(7, '0')}-0000-0000-0000-000000000001', '${A}', '${ACCT_A}', '2026-09-01', 1.00, 'AUD', 'debit', 'expense', 'approved', now(), '${A}')`);
  }
  // Batch the insert (PGlite handles one large statement fine; matches the
  // existing scale-certification scripts' pattern of a single multi-row insert).
  for (let batch = 0; batch < rows.length; batch += 200) {
    await db.exec(`insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, approval_status, approved_at, approved_by) values ${rows.slice(batch, batch + 200).join(',')};`);
  }
}
await asRole(db, 'authenticated', A, async () => {
  const countQ = await db.query(`select count(*)::int as n from fdh_transactions where user_id = $1 and transaction_date = '2026-09-01' and approval_status = 'approved'`, [A]);
  check('exact count() at 1,001 rows is 1,001, not capped at 1,000', countQ.rows[0].n === 1001);

  // Deterministic keyset walk: (transaction_date desc, id desc), same
  // convention as bank-transactions/route.ts and financialActivityAnalytics.ts.
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  while (true) {
    const q = cursor
      ? await db.query(
          `select id from fdh_transactions where user_id = $1 and transaction_date = '2026-09-01' and approval_status = 'approved' and (transaction_date, id) < ($2, $3) order by transaction_date desc, id desc limit 500`,
          [A, cursor.date, cursor.id],
        )
      : await db.query(
          `select id from fdh_transactions where user_id = $1 and transaction_date = '2026-09-01' and approval_status = 'approved' order by transaction_date desc, id desc limit 500`,
          [A],
        );
    if (q.rows.length === 0) break;
    for (const r of q.rows) seen.add(r.id);
    cursor = { date: '2026-09-01', id: q.rows[q.rows.length - 1].id };
    pages += 1;
    if (pages > 10) break; // safety valve, not expected to trigger
  }
  check('keyset pagination walk across the 1,001-row set collects all 1,001 ids with zero duplicates/gaps', seen.size === 1001, `(collected ${seen.size} across ${pages} pages)`);

  const sumQ = await db.query(`select sum(amount_original)::numeric as s from fdh_transactions where user_id = $1 and transaction_date = '2026-09-01' and approval_status = 'approved'`, [A]);
  check('exact sum at 1,001 rows is $1,001.00', Number(sumQ.rows[0].s) === 1001);
});

// =============================================================================
console.log(`\n=== FDH-8 DB Certification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
