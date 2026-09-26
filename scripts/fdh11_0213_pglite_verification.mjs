// Canonical-upload programme (WP-12) -- PGlite verification for migration
// 0213_fdh11_investment_integrity.sql.
//
// The real migration chain is replayed up to (not including) 0213, a small
// synthetic two-tenant world is seeded, and every defect 0213 claims to close
// is first PROVEN TO EXIST (anti-vacuity), then 0213 is applied and every
// claim is re-checked, then 0213 is applied a second time (must change nothing
// and move no row).
//
// Every check prints PASS/FAIL with a name; the process exits non-zero on any
// FAIL, and refuses to report a pass if fewer checks ran than expected.
//
// Run: node scripts/fdh11_0213_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0213_fdh11_investment_integrity.sql';
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
const cols = async (db, table) => (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name = $1`, [table])).rows.map((r) => r.column_name);
const errorOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const asAuthenticated = async (db, uid, fn) => {
  await db.exec(`set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '${uid}'`);
  try { return await fn(); } finally { await db.exec('rollback').catch(() => {}); await db.exec(`reset request.jwt.claim.role; reset request.jwt.claim.sub`); }
};
const asServiceRole = async (db, fn) => {
  await db.exec(`set request.jwt.claim.role = 'service_role'`);
  try { return await fn(); } finally { await db.exec('rollback').catch(() => {}); await db.exec(`reset request.jwt.claim.role`); }
};
const schemaFingerprint = async (db) => {
  const c = (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows;
  const i = (await db.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`)).rows;
  const t = (await db.query(`select tgname, tgrelid::regclass::text r from pg_trigger where not tgisinternal order by 1,2`)).rows;
  const f = (await db.query(`select proname, md5(prosrc) h from pg_proc where pronamespace = 'public'::regnamespace order by 1,2`)).rows;
  const k = (await db.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).rows;
  return JSON.stringify({ c, i, t, f, k });
};

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const II_ACC_A = 'a0000000-0000-0000-0000-0000000000a1';
const II_ACC_B = 'b0000000-0000-0000-0000-0000000000b1';
const INS = 'c0000000-0000-0000-0000-0000000000c1';
const UP_A = 'a2000000-0000-0000-0000-0000000000a2';
const UP_B = 'b2000000-0000-0000-0000-0000000000b2';
const ST_A = 'a3000000-0000-0000-0000-0000000000a3';
const ST_A_APPROVED = 'a3000000-0000-0000-0000-0000000000a4';
const POS_OLD_1 = 'a4000000-0000-0000-0000-0000000000a1';
const POS_OLD_2 = 'a4000000-0000-0000-0000-0000000000a2';
const POS_APPLIED = 'a4000000-0000-0000-0000-0000000000a3';

async function seed(db) {
  for (const [id, email] of [[A, 'a@t.test'], [B, 'b@t.test']]) {
    await db.exec(`insert into auth.users(id, email) values ('${id}', '${email}') on conflict do nothing`);
    await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  }
  await db.exec(`
    insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
      ('${II_ACC_A}', '${A}', 'AU', 'AUD', 'broker', 'CommSec'),
      ('${II_ACC_B}', '${B}', 'AU', 'AUD', 'broker', 'SelfWealth');
    insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency) values
      ('${INS}', 'BHP Group Ltd', 'equity', 'AU', 'AUD');
    insert into fdh_statement_uploads (id, user_id, source_type, document_type, country_code, currency_code, processing_status) values
      ('${UP_A}', '${A}', 'csv', 'investment_statement', 'AU', 'AUD', 'queued'),
      ('${UP_B}', '${B}', 'csv', 'investment_statement', 'AU', 'AUD', 'queued');
    insert into fdh_investment_statements (id, user_id, statement_upload_id, statement_type, base_currency) values
      ('${ST_A}', '${A}', '${UP_A}', 'portfolio_csv', 'AUD'),
      ('${ST_A_APPROVED}', '${A}', '${UP_A}', 'portfolio_csv', 'AUD');
    -- Positions written exactly as persistAuInvestmentEvidence did before WP-12: no apply_status.
    insert into fdh_investment_statement_positions (id, user_id, statement_id, security_name_raw, quantity, market_value, currency_code, valuation_date) values
      ('${POS_OLD_1}', '${A}', '${ST_A}', 'BHP Group Ltd', 100, 4500, 'AUD', '2026-08-31'),
      ('${POS_OLD_2}', '${A}', '${ST_A_APPROVED}', 'BHP Group Ltd', 100, 4500, 'AUD', '2026-08-31'),
      ('${POS_APPLIED}', '${A}', '${ST_A_APPROVED}', 'CBA', 10, 1300, 'AUD', '2026-08-31');
  `);
}

/** Needs a request role; run only AFTER the fresh-session (true NULL role) checks. */
async function seedApproved(db) {
  await db.exec(`
    set request.jwt.claim.role = 'service_role';
    update fdh_investment_statements set approval_status = 'approved', approved_at = now(), approved_by = '${A}', canonical_account_id = '${II_ACC_A}' where id = '${ST_A_APPROVED}';
    update fdh_investment_statement_positions set apply_status = 'applied', applied_at = now(), applied_by = '${A}' where id = '${POS_APPLIED}';
    reset request.jwt.claim.role;
  `);
}

const forgedStatementInsert = (id, extra) => `insert into fdh_investment_statements (id, user_id, statement_upload_id, statement_type, base_currency${extra.cols}) values ('${id}', '${A}', '${UP_A}', 'portfolio_csv', 'AUD'${extra.vals})`;
const snapshotInsert = (user, account, date) => `insert into ii_holding_snapshots (user_id, account_id, instrument_id, currency_code, as_of_date, units, value) values ('${user}', '${account}', '${INS}', 'AUD', '${date}', 100, 4500)`;
const txnInsert = (user, account, date) => `insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount) values ('${user}', '${account}', '${INS}', 'AUD', 'purchase', '${date}', 4500)`;

// ============================================================================
console.log('Case A -- full chain to 0212 (this branch: 0207), two tenants, then 0213 (twice)');
{
  const db = await replayUpToTarget();
  await seed(db);

  // FIRST, in a session that has never set a request role (exactly the SQL
  // editor: auth.role() is NULL, not ''): the 0106 update guard refuses a
  // plain backfill, which is why 0213's backfill claims service_role.
  const nullRole = await one(db, `select auth.role() is null n`);
  check('setup: this session has a true NULL request role (as the SQL editor has)', nullRole.n === true);
  const rawBackfill = await errorOf(db, `update fdh_investment_statement_positions set apply_status = 'pending' where id = '${POS_OLD_1}'`);
  check("anti-vacuity: a plain backfill UPDATE with a NULL request role (the SQL editor) is REFUSED by the 0106 guard -- 0213's backfill must claim service_role", rawBackfill !== null && /system-authoritative/.test(rawBackfill), rawBackfill ?? 'accepted');
  await seedApproved(db);

  // ---------------- BEFORE 0213: every defect is real ----------------
  const posStatus = await one(db, `select apply_status s from fdh_investment_statement_positions where id = '${POS_OLD_1}'`);
  check("anti-vacuity (INV-G2): a position inserted without apply_status defaults to 'not_applicable' -- Apply (which claims 'pending') can never reach it", posStatus.s === 'not_applicable', posStatus.s);
  check('anti-vacuity: positions have no apply_rejected_reason column before 0213', !(await cols(db, 'fdh_investment_statement_positions')).includes('apply_rejected_reason'));

  const forgedBefore = await asAuthenticated(db, A, () => errorOf(db, forgedStatementInsert('a9000000-0000-0000-0000-000000000001', { cols: ', approval_status, approved_at, approved_by, canonical_account_id', vals: `, 'approved', now(), '${A}', '${II_ACC_B}'` })));
  check("anti-vacuity (INV-G5): before 0213 an authenticated INSERT of an ALREADY-APPROVED statement pointing at ANOTHER user's ii account is accepted", forgedBefore === null, forgedBefore ?? 'accepted');
  const forgedPosBefore = await asAuthenticated(db, A, () => errorOf(db, `insert into fdh_investment_statement_positions (user_id, statement_id, security_name_raw, quantity, currency_code, valuation_date, apply_status, security_match_status, matched_instrument_id) values ('${A}', '${ST_A}', 'X', 1, 'AUD', '2026-08-31', 'pending', 'matched', '${INS}')`));
  check('anti-vacuity (INV-G5): before 0213 an authenticated INSERT of a pre-MATCHED position is accepted (review bypassed)', forgedPosBefore === null, forgedPosBefore ?? 'accepted');
  const crossSnapBefore = await asServiceRole(db, () => errorOf(db, snapshotInsert(A, II_ACC_B, '2026-01-01')));
  check("anti-vacuity (INV-G5): before 0213 the service-role bridge can write a snapshot with user A into user B's account", crossSnapBefore === null, crossSnapBefore ?? 'accepted');
  const crossTxnBefore = await asServiceRole(db, () => errorOf(db, txnInsert(A, II_ACC_B, '2026-01-01')));
  check("anti-vacuity (INV-G5): before 0213 an ii_transactions row with user A in user B's account is accepted", crossTxnBefore === null, crossTxnBefore ?? 'accepted');
  const crossStmtBefore = await asServiceRole(db, () => errorOf(db, `update fdh_investment_statements set canonical_account_id = '${II_ACC_B}' where id = '${ST_A}'`));
  check("anti-vacuity: before 0213 a statement of user A can point at user B's ii account", crossStmtBefore === null, crossStmtBefore ?? 'accepted');
  await asServiceRole(db, () => db.exec(`update fdh_investment_statements set canonical_account_id = null where id = '${ST_A}'`));
  await db.exec(`delete from ii_holding_snapshots where account_id = '${II_ACC_B}'; delete from ii_transactions where account_id = '${II_ACC_B}'; delete from fdh_investment_statements where id = 'a9000000-0000-0000-0000-000000000001'; delete from fdh_investment_statement_positions where security_name_raw = 'X'`);
  const appliedXminBefore = (await one(db, `select xmin::text x from fdh_investment_statement_positions where id = '${POS_APPLIED}'`)).x;

  // ---------------- APPLY 0213 ----------------
  const applyErr = await errorOf(db, target);
  check('0213 applies cleanly on top of the real chain (no request role -- as the SQL editor would run it)', applyErr === null, applyErr ?? '');

  // ---------------- AFTER 0213 ----------------
  const afterBackfill = (await db.query(`select id, apply_status s from fdh_investment_statement_positions order by id`)).rows;
  check("backfill: both never-applicable positions (pending AND approved statement) are now 'pending'",
    afterBackfill.find((r) => r.id === POS_OLD_1)?.s === 'pending' && afterBackfill.find((r) => r.id === POS_OLD_2)?.s === 'pending');
  check("backfill: an already-'applied' position is untouched (same xmin)",
    afterBackfill.find((r) => r.id === POS_APPLIED)?.s === 'applied' && (await one(db, `select xmin::text x from fdh_investment_statement_positions where id = '${POS_APPLIED}'`)).x === appliedXminBefore);
  const roleAfter = await one(db, `select coalesce(auth.role(), '<null>') r`);
  check('the backfill role claim does not leak out of the migration transaction', roleAfter.r === '<null>' || roleAfter.r === '', roleAfter.r);
  const def = await one(db, `select column_default d from information_schema.columns where table_name='fdh_investment_statement_positions' and column_name='apply_status'`);
  check("positions.apply_status default is now 'pending'", /'pending'/.test(def.d ?? ''), def.d);
  await db.exec(`insert into fdh_investment_statement_positions (id, user_id, statement_id, security_name_raw, quantity, currency_code, valuation_date) values ('a4000000-0000-0000-0000-0000000000a9', '${A}', '${ST_A}', 'Default', 1, 'AUD', '2026-08-31')`);
  check("a new position with no apply_status is 'pending'", (await one(db, `select apply_status s from fdh_investment_statement_positions where id = 'a4000000-0000-0000-0000-0000000000a9'`)).s === 'pending');
  check('positions.apply_rejected_reason exists', (await cols(db, 'fdh_investment_statement_positions')).includes('apply_rejected_reason'));

  // B. authoritative INSERT
  const forgedApproved = await asAuthenticated(db, A, () => errorOf(db, forgedStatementInsert('a9000000-0000-0000-0000-000000000002', { cols: ', approval_status', vals: `, 'approved'` })));
  check("a forged authenticated INSERT with approval_status='approved' is REFUSED", forgedApproved !== null && /system-authoritative/.test(forgedApproved), forgedApproved ?? 'accepted');
  const forgedOwnAccount = await asAuthenticated(db, A, () => errorOf(db, forgedStatementInsert('a9000000-0000-0000-0000-000000000003', { cols: ', canonical_account_id', vals: `, '${II_ACC_A}'` })));
  check('an authenticated INSERT that pre-sets canonical_account_id (even its own) is REFUSED', forgedOwnAccount !== null && /system-authoritative/.test(forgedOwnAccount), forgedOwnAccount ?? 'accepted');
  const forgedForeign = await asAuthenticated(db, A, () => errorOf(db, forgedStatementInsert('a9000000-0000-0000-0000-000000000004', { cols: ', canonical_account_id', vals: `, '${II_ACC_B}'` })));
  check("a cross-tenant canonical_account_id on an authenticated INSERT is REFUSED", forgedForeign !== null, forgedForeign ?? 'accepted');
  const plainInsert = await asAuthenticated(db, A, () => errorOf(db, forgedStatementInsert('a9000000-0000-0000-0000-000000000005', { cols: '', vals: '' })));
  check('an authenticated INSERT with only default system columns is still accepted (RLS behaviour unchanged)', plainInsert === null, plainInsert ?? '');
  const forgedPos = await asAuthenticated(db, A, () => errorOf(db, `insert into fdh_investment_statement_positions (user_id, statement_id, security_name_raw, quantity, currency_code, valuation_date, security_match_status, matched_instrument_id) values ('${A}', '${ST_A}', 'X', 1, 'AUD', '2026-08-31', 'matched', '${INS}')`));
  check('an authenticated INSERT of a pre-matched position is REFUSED', forgedPos !== null && /system-authoritative/.test(forgedPos), forgedPos ?? 'accepted');
  const forgedPosApplied = await asAuthenticated(db, A, () => errorOf(db, `insert into fdh_investment_statement_positions (user_id, statement_id, security_name_raw, quantity, currency_code, valuation_date, apply_status) values ('${A}', '${ST_A}', 'X', 1, 'AUD', '2026-08-31', 'applied')`));
  check("an authenticated INSERT of an 'applied' position is REFUSED", forgedPosApplied !== null, forgedPosApplied ?? 'accepted');
  const forgedAct = await asAuthenticated(db, A, () => errorOf(db, `insert into fdh_investment_statement_activities (user_id, statement_id, activity_type, trade_date, amount, currency_code, bank_match_status) values ('${A}', '${ST_A}', 'BUY', '2026-08-01', 100, 'AUD', 'matched')`));
  check('an authenticated INSERT of a pre-bank-matched activity is REFUSED', forgedAct !== null && /system-authoritative/.test(forgedAct), forgedAct ?? 'accepted');
  const plainAct = await asAuthenticated(db, A, () => errorOf(db, `insert into fdh_investment_statement_activities (user_id, statement_id, activity_type, trade_date, amount, currency_code) values ('${A}', '${ST_A}', 'BUY', '2026-08-01', 100, 'AUD')`));
  check('an authenticated INSERT of a plain activity is still accepted', plainAct === null, plainAct ?? '');
  const systemInsert = await asServiceRole(db, () => errorOf(db, forgedStatementInsert('a9000000-0000-0000-0000-000000000006', { cols: ', approval_status, approved_at, approved_by, canonical_account_id', vals: `, 'approved', now(), '${A}', '${II_ACC_A}'` })));
  check('the service-role bridge may still insert system columns (same-tenant account)', systemInsert === null, systemInsert ?? '');

  // UPDATE guard on positions now includes the new column; the old checks still bite.
  const authReason = await asAuthenticated(db, A, () => errorOf(db, `update fdh_investment_statement_positions set apply_rejected_reason = 'forged' where id = '${POS_OLD_1}'`));
  check('an authenticated UPDATE of apply_rejected_reason is REFUSED', authReason !== null && /system-authoritative/.test(authReason), authReason ?? 'accepted');
  const authStatus = await asAuthenticated(db, A, () => errorOf(db, `update fdh_investment_statement_positions set apply_status = 'applied' where id = '${POS_OLD_1}'`));
  check('the 0106 UPDATE guard still refuses an authenticated apply_status change', authStatus !== null && /system-authoritative/.test(authStatus), authStatus ?? 'accepted');
  const svcReason = await asServiceRole(db, () => errorOf(db, `update fdh_investment_statement_positions set apply_status = 'skipped', apply_rejected_reason = 'no market value' where id = '${POS_OLD_1}'`));
  check('the service-role bridge can record a skip reason', svcReason === null, svcReason ?? '');

  // C. same-tenant guards, every role.
  const crossSnap = await asServiceRole(db, () => errorOf(db, snapshotInsert(A, II_ACC_B, '2026-02-01')));
  check("a snapshot with user A in user B's account is REFUSED even for service_role", crossSnap !== null && /cross-tenant/.test(crossSnap), crossSnap ?? 'accepted');
  const crossSnapNoRole = await errorOf(db, snapshotInsert(A, II_ACC_B, '2026-02-02'));
  check('... and with no request role at all', crossSnapNoRole !== null && /cross-tenant/.test(crossSnapNoRole), crossSnapNoRole ?? 'accepted');
  const ownSnap = await asServiceRole(db, () => errorOf(db, snapshotInsert(A, II_ACC_A, '2026-02-03')));
  check('a same-tenant snapshot is accepted', ownSnap === null, ownSnap ?? '');
  const upsertOwn = await asServiceRole(db, () => errorOf(db, `${snapshotInsert(A, II_ACC_A, '2026-02-03')} on conflict (account_id, instrument_id, as_of_date) do update set value = excluded.value, user_id = excluded.user_id, account_id = excluded.account_id`));
  check('the bridge upsert-on-conflict path (updates user_id/account_id) still works same-tenant', upsertOwn === null, upsertOwn ?? '');
  const moveSnap = await errorOf(db, `update ii_holding_snapshots set account_id = '${II_ACC_B}' where account_id = '${II_ACC_A}'`);
  check("moving A's snapshot into B's account is REFUSED", moveSnap !== null && /cross-tenant/.test(moveSnap), moveSnap ?? 'accepted');
  const crossTxn = await asServiceRole(db, () => errorOf(db, txnInsert(A, II_ACC_B, '2026-02-01')));
  check("an ii_transactions row with user A in user B's account is REFUSED", crossTxn !== null && /cross-tenant/.test(crossTxn), crossTxn ?? 'accepted');
  const ownTxn = await asServiceRole(db, () => errorOf(db, txnInsert(A, II_ACC_A, '2026-02-01')));
  check('a same-tenant ii_transactions row is accepted', ownTxn === null, ownTxn ?? '');
  const crossStmt = await asServiceRole(db, () => errorOf(db, `update fdh_investment_statements set canonical_account_id = '${II_ACC_B}' where id = '${ST_A}'`));
  check("pointing A's statement at B's ii account is REFUSED even for service_role", crossStmt !== null && /cross-tenant/.test(crossStmt), crossStmt ?? 'accepted');
  const ghostStmt = await asServiceRole(db, () => errorOf(db, `update fdh_investment_statements set canonical_account_id = 'd0000000-0000-0000-0000-00000000dead' where id = '${ST_A}'`));
  check('pointing a statement at a non-existent ii account is REFUSED', ghostStmt !== null && /does not exist/.test(ghostStmt), ghostStmt ?? 'accepted');
  const ownStmt = await asServiceRole(db, () => errorOf(db, `update fdh_investment_statements set canonical_account_id = '${II_ACC_A}' where id = '${ST_A}'`));
  check("pointing A's statement at A's own ii account is accepted", ownStmt === null, ownStmt ?? '');

  // Re-apply: byte-identical and moves no row.
  const snapBefore = (await db.query(`select id, apply_status, xmin::text x from fdh_investment_statement_positions order by id`)).rows;
  const fp1 = await schemaFingerprint(db);
  const reErr = await errorOf(db, target);
  const fp2 = await schemaFingerprint(db);
  const snapAfter = (await db.query(`select id, apply_status, xmin::text x from fdh_investment_statement_positions order by id`)).rows;
  check('re-applying 0213 raises nothing', reErr === null, reErr ?? '');
  check('re-applying 0213 changes no constraint, index, trigger, function body or column', fp1 === fp2);
  check('re-applying 0213 updates no position row (backfill is a no-op the second time)', JSON.stringify(snapBefore) === JSON.stringify(snapAfter), `${snapBefore.length} rows compared`);
  const trigCount = await one(db, `select count(*)::int n from pg_trigger where not tgisinternal and tgname like '%_0213'`);
  check('exactly six 0213 triggers exist after two applies', trigCount.n === 6, `${trigCount.n}`);
}

// ============================================================================
console.log('Case B -- 0213 applied in a session that never set a request role (true NULL, the SQL editor)');
{
  const db = await replayUpToTarget();
  await seed(db);
  check('setup: true NULL request role', (await one(db, `select auth.role() is null n`)).n === true);
  const err = await errorOf(db, target);
  check('0213 applies with a NULL request role (its backfill claims service_role for its own transaction)', err === null, err ?? '');
  const rows = (await db.query(`select apply_status s from fdh_investment_statement_positions`)).rows;
  check("every never-applicable position is 'pending' after 0213", rows.length === 3 && rows.every((r) => r.s === 'pending'), JSON.stringify(rows));
  check('the service_role claim did not outlive the migration (auth.role() is not service_role)', ((await one(db, `select coalesce(auth.role(), '') r`)).r) !== 'service_role');
}

const total = pass + fail;
console.log(`\n=== fdh11 0213 PGlite verification: ${pass} PASS, ${fail} FAIL (${total} checks) ===`);
if (total < 35) { console.error('too few checks executed -- refusing to report a vacuous pass'); process.exit(2); }
process.exit(fail === 0 ? 0 : 1);
