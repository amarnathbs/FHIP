// R8 — Transaction Categorisation & Merchant Intelligence: PGlite-based
// security certification.
//
// Proves migration 0067's authoritative-write hardening (spec sections
// 59-64, 82) against a fresh, fully-migrated database — no live DEV DDL
// credential exists in this environment (disclosed; see
// R8_ASSUMPTION_RECONCILIATION.md and R8_ACCEPTANCE_REPORT.md), so this is
// the mechanism used for the required negative controls. Follows the exact
// pattern established by scripts/db-rebuild-check/rls.mjs and
// scripts/fdh2_rls_certification.mjs: PGlite clean rebuild, real two-tenant
// data, `set_config('request.jwt.claims', ...)` + `set role` to exercise
// each Postgres role for real, genuine negative controls (RED before the
// fix / GREEN after), never a vacuous assertion.
//
// Usage: node scripts/r8_security_certification.mjs
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

/** Builds a fresh PGlite database replaying every migration whose numeric
 * prefix is <= `throughVersion`. */
async function buildDb(throughVersion) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const version = parseInt(f.slice(0, 4), 10);
    if (version > throughVersion) continue;
    await db.exec(
      fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''),
    );
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}

/**
 * NEVER NEST asRole() CALLS. `reset role` only undoes the Postgres role
 * switch — it does NOT restore a previous `request.jwt.claims` GUC value,
 * because that GUC is session-scoped, not role-scoped. A nested call (B's
 * callback calling asRole(..., A, ...) internally) would leave the GUC
 * pointing at A even after the inner call's `finally` runs, silently
 * corrupting the OUTER B-context for every statement after it — this is
 * exactly the bug this comment exists to prevent a regression of (found
 * live during this script's own development: see git history / R8
 * documentation for the reproduction).
 */
async function asRole(db, role, uid, fn) {
  // auth.role()/auth.uid() read the `request.jwt.claims` GUC, exactly
  // mirroring PostgREST's real JWT-decoding behaviour — the Postgres `role`
  // switch alone does NOT make auth.role() report 'service_role'; the JWT
  // claim must be set too (see scripts/r7final_reconciliation_status_
  // forgery_negative_control.mjs, the established precedent this mirrors).
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role })]);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
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
    insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, description_clean, amount_original, currency_original, credit_debit, economic_transaction_type, classification_method)
    values
      ('11111111-0000-0000-0000-000000000001', '${A}', 'a0000000-0000-0000-0000-00000000000a', '2026-03-01', 'TEST TXN A', 50.00, 'AUD', 'debit', 'unknown', 'unclassified'),
      ('22222222-0000-0000-0000-000000000002', '${B}', 'b0000000-0000-0000-0000-00000000000b', '2026-03-01', 'TEST TXN B', 50.00, 'AUD', 'debit', 'unknown', 'unclassified');
  `);
}

console.log('=== R8 Security Certification ===\n');

console.log('--- Building baseline DB through migration 0066 (pre-fix, RED expected) ---');
const dbBefore = await buildDb(66);
await seedBaseline(dbBefore);

console.log('--- Building full DB through migration 0068 (post-fix, GREEN expected) ---');
const db = await buildDb(68);
await seedBaseline(db);

// =============================================================================
console.log('\n=== NEGATIVE CONTROL — same-user forgery of economic_transaction_type WAS possible before 0067 ===');
{
  const before = await asRole(dbBefore, 'authenticated', A, () =>
    dbBefore.query(`update fdh_transactions set economic_transaction_type='income' where id='11111111-0000-0000-0000-000000000001' returning economic_transaction_type`),
  ).catch((e) => ({ error: e.message }));
  check(
    'RED: pre-0067 DB allowed the forged economic_transaction_type write',
    !before.error && before.rows?.[0]?.economic_transaction_type === 'income',
    before.error ? `(unexpectedly blocked: ${before.error})` : '',
  );
}

// =============================================================================
console.log('\n=== SAME-USER FORGERY — fdh_transactions classification fields (0067 in place) ===');

async function attemptForge(sql) {
  try {
    await db.query(sql);
    return { blocked: false };
  } catch (e) {
    return { blocked: true, message: e.message };
  }
}

await asRole(db, 'authenticated', A, async () => {
  const r1 = await attemptForge(
    `update fdh_transactions set economic_transaction_type='income' where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('economic_transaction_type: bare forgery (no correction row) is BLOCKED', r1.blocked, r1.message ?? '');

  const r2 = await attemptForge(
    `update fdh_transactions set category_id=gen_random_uuid() where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('category_id: bare forgery is BLOCKED', r2.blocked, r2.message ?? '');

  const r3 = await attemptForge(
    `update fdh_transactions set classification_confidence=1.0 where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('classification_confidence: forgery is BLOCKED outright (no correction vocabulary covers it)', r3.blocked, r3.message ?? '');

  const r4 = await attemptForge(
    `update fdh_transactions set classification_method='ai' where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('classification_method: forgery is BLOCKED outright', r4.blocked, r4.message ?? '');

  const r5 = await attemptForge(
    `update fdh_transactions set recurring_flag=true where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('recurring_flag: forgery is BLOCKED outright', r5.blocked, r5.message ?? '');

  const r6 = await attemptForge(
    `update fdh_transactions set transfer_flag=true where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('transfer_flag: forgery is BLOCKED outright', r6.blocked, r6.message ?? '');

  const r7 = await attemptForge(
    `update fdh_transactions set review_status='resolved' where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('review_status: forgery to resolved with NO correction evidence is BLOCKED', r7.blocked, r7.message ?? '');

  const r8 = await attemptForge(
    `update fdh_transactions set recurring_transaction_id=gen_random_uuid() where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('recurring_transaction_id: forgery is BLOCKED outright', r8.blocked, r8.message ?? '');
});

console.log('\n=== LEGITIMATE EVIDENCED CORRECTION — mirrors correctTransaction()\'s real write order ===');
await asRole(db, 'authenticated', A, async () => {
  // Step 1 (as the real service does): insert the correction row FIRST.
  await db.query(
    `insert into fdh_transaction_corrections (user_id, transaction_id, field_name, previous_value, corrected_value)
     values ('${A}', '11111111-0000-0000-0000-000000000001', 'economic_transaction_type', '"unknown"'::jsonb, '"income"'::jsonb)`,
  );
  // Step 2: the matching UPDATE now succeeds.
  const r = await attemptForge(
    `update fdh_transactions set economic_transaction_type='income', user_override=true, review_status='resolved' where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('economic_transaction_type: EVIDENCED correction (matching corrections row) is ALLOWED', !r.blocked, r.message ?? '');

  const verify = await db.query(`select economic_transaction_type, review_status from fdh_transactions where id='11111111-0000-0000-0000-000000000001'`);
  check('the corrected value is durably persisted', verify.rows[0].economic_transaction_type === 'income' && verify.rows[0].review_status === 'resolved');

  // A value that does NOT match any recorded correction is still blocked,
  // even with an (irrelevant) correction row present for a DIFFERENT value.
  const r2 = await attemptForge(
    `update fdh_transactions set category_id=gen_random_uuid() where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('a field with NO matching correction row remains BLOCKED even after an unrelated correction exists', r2.blocked, r2.message ?? '');
});

console.log('\n=== fdh_transaction_links — engine-only INSERT, guarded UPDATE ===');
await asRole(db, 'authenticated', A, async () => {
  const insertAttempt = await attemptForge(
    `insert into fdh_transaction_links (user_id, transaction_id_from, link_type, status, created_by_method)
     values ('${A}', '11111111-0000-0000-0000-000000000001', 'internal_transfer', 'confirmed', 'user_manual')`,
  );
  check('direct INSERT of a forged CONFIRMED link is BLOCKED', insertAttempt.blocked, insertAttempt.message ?? '');
});

// Seed a real pending link via service_role (as the engine would) to test
// the legitimate review transition.
const linkId = 'c0000000-0000-0000-0000-00000000000c';
await asRole(db, 'service_role', null, () =>
  db.query(
    `insert into fdh_transaction_links (id, user_id, transaction_id_from, link_type, confidence, status, created_by_method, match_evidence)
     values ('${linkId}', '${A}', '11111111-0000-0000-0000-000000000001', 'internal_transfer', 0.6, 'pending', 'algorithm', '{"rule":"test"}'::jsonb)`,
  ),
);

await asRole(db, 'authenticated', A, async () => {
  const forgeEvidence = await attemptForge(`update fdh_transaction_links set confidence=1.0 where id='${linkId}'`);
  check('confidence on a link cannot be forged by the authenticated role', forgeEvidence.blocked, forgeEvidence.message ?? '');

  const badTransition = await attemptForge(`update fdh_transaction_links set status='superseded' where id='${linkId}'`);
  check('status pending -> superseded (not a permitted user transition) is BLOCKED', badTransition.blocked, badTransition.message ?? '');

  const legit = await attemptForge(`update fdh_transaction_links set status='confirmed', user_confirmed=true where id='${linkId}'`);
  check('status pending -> confirmed with user_confirmed=true (the legitimate review action) is ALLOWED', !legit.blocked, legit.message ?? '');
});

console.log('\n=== fdh_recurring_transactions — engine-only INSERT, guarded UPDATE ===');
await asRole(db, 'authenticated', A, async () => {
  const insertAttempt = await attemptForge(
    `insert into fdh_recurring_transactions (user_id, frequency, status) values ('${A}', 'monthly', 'active')`,
  );
  check('direct INSERT of a forged recurring series is BLOCKED', insertAttempt.blocked, insertAttempt.message ?? '');
});

const recurringId = 'd0000000-0000-0000-0000-00000000000d';
await asRole(db, 'service_role', null, () =>
  db.query(
    `insert into fdh_recurring_transactions (id, user_id, frequency, status, confidence) values ('${recurringId}', '${A}', 'monthly', 'candidate', 0.6)`,
  ),
);
await asRole(db, 'authenticated', A, async () => {
  const forgeFreq = await attemptForge(`update fdh_recurring_transactions set frequency='weekly' where id='${recurringId}'`);
  check('frequency on a recurring series cannot be forged', forgeFreq.blocked, forgeFreq.message ?? '');

  const forgeSkip = await attemptForge(`update fdh_recurring_transactions set status='ended' where id='${recurringId}'`);
  // candidate -> ended IS a permitted transition (see ALLOWED_SERIES_TRANSITIONS)
  check('candidate -> ended is a permitted user transition (allowed)', !forgeSkip.blocked, forgeSkip.message ?? '');
});

const recurringId2 = 'e0000000-0000-0000-0000-00000000000e';
await asRole(db, 'service_role', null, () =>
  db.query(
    `insert into fdh_recurring_transactions (id, user_id, frequency, status, confidence) values ('${recurringId2}', '${A}', 'monthly', 'active', 0.6)`,
  ),
);
await asRole(db, 'authenticated', A, async () => {
  const badTransition = await attemptForge(`update fdh_recurring_transactions set status='candidate' where id='${recurringId2}'`);
  check('active -> candidate (moving BACKWARD) is BLOCKED', badTransition.blocked, badTransition.message ?? '');

  const legit = await attemptForge(`update fdh_recurring_transactions set status='paused' where id='${recurringId2}'`);
  check('active -> paused (the legitimate user pause action) is ALLOWED', !legit.blocked, legit.message ?? '');
});

console.log('\n=== fdh_classification_history — actor-restricted INSERT ===');
await asRole(db, 'authenticated', A, async () => {
  const fakeSystem = await attemptForge(
    `insert into fdh_classification_history (user_id, transaction_id, new_economic_transaction_type, classification_method, changed_by_type)
     values ('${A}', '11111111-0000-0000-0000-000000000001', 'income', 'global_rule', 'system')`,
  );
  check('a fabricated changed_by_type=system audit row is BLOCKED', fakeSystem.blocked, fakeSystem.message ?? '');

  const realUser = await attemptForge(
    `insert into fdh_classification_history (user_id, transaction_id, new_economic_transaction_type, classification_method, changed_by_type)
     values ('${A}', '11111111-0000-0000-0000-000000000001', 'income', 'user_manual', 'user')`,
  );
  check('a genuine changed_by_type=user audit row is ALLOWED', !realUser.blocked, realUser.message ?? '');
});

console.log('\n=== SERVICE-ROLE BYPASS — the engine itself can write freely ===');
await asRole(db, 'service_role', null, async () => {
  const r = await attemptForge(
    `update fdh_transactions set economic_transaction_type='expense', classification_confidence=1.0, classification_method='global_rule' where id='22222222-0000-0000-0000-000000000002'`,
  );
  check('service-role write to authoritative fields succeeds (engine unaffected by the hardening)', !r.blocked, r.message ?? '');
});

console.log('\n=== CROSS-USER SECURITY ===');
await asRole(db, 'authenticated', B, async () => {
  const read = await db.query(`select count(*)::int c from fdh_transactions where user_id='${A}'`);
  check('Tenant B cannot read Tenant A transactions', read.rows[0].c === 0);

  const readLinks = await db.query(`select count(*)::int c from fdh_transaction_links where user_id='${A}'`);
  check('Tenant B cannot read Tenant A transaction links', readLinks.rows[0].c === 0);

  const readRecurring = await db.query(`select count(*)::int c from fdh_recurring_transactions where user_id='${A}'`);
  check('Tenant B cannot read Tenant A recurring series', readRecurring.rows[0].c === 0);

  // RLS denial on an UPDATE is not an exception — the `USING` clause simply
  // hides the row, so the statement succeeds having matched ZERO rows. The
  // real assertion is "no row changed", not "an error was thrown".
  const crossUserUpdate = await db.query(
    `update fdh_transactions set economic_transaction_type='expense' where id='11111111-0000-0000-0000-000000000001'`,
  );
  check('Tenant B cannot modify Tenant A transaction at all (RLS hides the row; 0 rows affected)', crossUserUpdate.affectedRows === 0, `(affected ${crossUserUpdate.affectedRows})`);

  const linkReviewAttempt = await db.query(`update fdh_transaction_links set status='confirmed' where id='${linkId}'`);
  check('Tenant B cannot review Tenant A transaction link (RLS hides the row; 0 rows affected)', linkReviewAttempt.affectedRows === 0, `(affected ${linkReviewAttempt.affectedRows})`);
});

// Deliberately OUTSIDE the B block above — never nest asRole() calls (see
// its own header comment for why).
const stillA = await asRole(db, 'authenticated', A, () =>
  db.query(`select economic_transaction_type from fdh_transactions where id='11111111-0000-0000-0000-000000000001'`),
);
check('Tenant A transaction value is genuinely unchanged after Tenant B\'s attempt', stillA.rows[0].economic_transaction_type === 'income');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
