// Canonical-upload programme (WP-08) -- PGlite verification for migration
// 0212_fdh_bank_approval_integrity.sql.
//
// One database: the real chain replayed up to 0211 (0207 included), a
// synthetic two-tenant fixture seeded, every defect reproduced BEFORE 0212
// (anti-vacuity -- the "before" scenarios run inside BEGIN ... ROLLBACK so
// they leave the fixture untouched), then 0212 applied and every acceptance
// claim checked, then 0212 applied a second time (must be a byte-identical
// no-op).
//
// Acceptance claims (the WP-08 plan):
//   * the same statement uploaded twice, the overlap resolved 'removed_b':
//     exactly 1x in the approved ledger, and the statement finalises;
//   * a 1,001-line statement: approve-all approves all 1,001 (trigger fired
//     per row), and reopen reverts all 1,001;
//   * split replace is all-or-nothing, refuses an approved parent and
//     'unknown' lines, and holds the parent row lock;
//   * the blocking policy is unchanged for every non-duplicate case.
// PGlite is a single connection: two genuinely concurrent sessions cannot be
// opened here, so concurrency is proven by (a) the parent-row FOR UPDATE lock
// being in the function body and (b) all-or-nothing rollback of a replace
// that fails half-way. The unit test fdhBankApprovalIntegrity.test.ts runs
// two interleaved replaces against the service.
//
// Run: node scripts/fdh_0212_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0212_fdh_bank_approval_integrity.sql';
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
const errorOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const claims = (uid) => `set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '${uid}';`;
const noClaims = `reset request.jwt.claim.role; reset request.jwt.claim.sub;`;
async function asUser(db, uid, fn) {
  await db.exec(claims(uid));
  try { return await fn(); } finally { await db.exec(noClaims); }
}
async function rpcAs(db, uid, sql) {
  return asUser(db, uid, async () => { try { return { rows: (await db.query(sql)).rows, error: null }; } catch (e) { return { rows: null, error: e }; } });
}
const constraintDef = async (db, table, name) => (await one(db, `select pg_get_constraintdef(oid) d from pg_constraint where conrelid = $1::regclass and conname = $2`, [table, name]))?.d ?? null;
const sharedChecks = async (db) => JSON.stringify({
  errorCode: await constraintDef(db, 'fdh_statement_uploads', 'fdh_statement_uploads_error_code_check'),
  eventType: await constraintDef(db, 'fdh_document_audit_events', 'fdh_document_audit_events_event_type_check'),
  reviewType: await constraintDef(db, 'fdh_review_items', 'fdh_review_items_review_type_check'),
  checkCode: await constraintDef(db, 'fdh_data_quality_results', 'fdh_data_quality_results_check_code_check'),
});
const schemaFingerprint = async (db) => {
  const c = (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows;
  const t = (await db.query(`select tgname, tgrelid::regclass::text r from pg_trigger where not tgisinternal order by 1,2`)).rows;
  const f = (await db.query(`select proname, md5(prosrc) h, proacl::text a from pg_proc where pronamespace = 'public'::regnamespace order by 1,2,3`)).rows;
  return JSON.stringify({ c, t, f });
};

// ---------------------------------------------------------------------------
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ACC = 'a0000000-0000-0000-0000-00000000000a';
const ACC_B = 'b0000000-0000-0000-0000-00000000000b';
const UP1 = 'a2000000-0000-0000-0000-000000000001'; // first upload of the statement (approved)
const UP2 = 'a2000000-0000-0000-0000-000000000002'; // same statement again
const UP3 = 'a2000000-0000-0000-0000-000000000003'; // an excluded duplicate still 'unknown'
const UPBIG = 'a2000000-0000-0000-0000-0000000000bb'; // 1,001 lines
const UPB = 'b2000000-0000-0000-0000-000000000001';
const G1 = 'a3000000-0000-0000-0000-000000000001'; // groceries $200 on UP1
const R1 = 'a3000000-0000-0000-0000-000000000002'; // rent $1500 on UP1
const G2 = 'a3000000-0000-0000-0000-000000000011'; // groceries $200 again on UP2 (the duplicate)
const R2 = 'a3000000-0000-0000-0000-000000000012'; // rent again on UP2, resolved kept (distinct side)
const N2 = 'a3000000-0000-0000-0000-000000000013'; // a genuinely new line on UP2
const U3 = 'a3000000-0000-0000-0000-000000000021'; // excluded duplicate, still unknown, on UP3
const U3K = 'a3000000-0000-0000-0000-000000000022'; // clean line on UP3
const TB = 'b3000000-0000-0000-0000-000000000001'; // user B's line
const DUP_G = 'a5000000-0000-0000-0000-000000000001';
const DUP_R = 'a5000000-0000-0000-0000-000000000002';
const DUP_U = 'a5000000-0000-0000-0000-000000000003';
// Blocking-policy parity scenarios (all on UP3, pending).
const S = {
  unknownUnsplit: 'a6000000-0000-0000-0000-000000000001',
  unknownReconciledSplit: 'a6000000-0000-0000-0000-000000000002',
  blockingItem: 'a6000000-0000-0000-0000-000000000003',
  pendingLink: 'a6000000-0000-0000-0000-000000000004',
  pendingDup: 'a6000000-0000-0000-0000-000000000005',
  badSplit: 'a6000000-0000-0000-0000-000000000006',
  clean: 'a6000000-0000-0000-0000-000000000007',
  linkPartner: 'a6000000-0000-0000-0000-000000000008',
  dupPartner: 'a6000000-0000-0000-0000-000000000009',
};
const SPLIT = 'a7000000-0000-0000-0000-000000000001'; // pending $100 to split
const SPLIT_APPROVED = 'a7000000-0000-0000-0000-000000000002'; // approved $50

const txnSql = (id, uid, acc, up, amount, type, extra = {}) => {
  const cols = { id, user_id: uid, financial_account_id: acc, statement_upload_id: up, transaction_date: extra.date ?? '2026-08-10', amount_original: amount, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: type, dedup_status: extra.dedup ?? 'unique', approval_status: 'pending' };
  const k = Object.keys(cols);
  return `insert into fdh_transactions (${k.join(', ')}) values (${k.map((c) => (cols[c] === null ? 'null' : typeof cols[c] === 'number' ? cols[c] : `'${cols[c]}'`)).join(', ')});`;
};

async function seed(db) {
  for (const [id, email] of [[A, 'a@t.test'], [B, 'b@t.test']]) {
    await db.exec(`insert into auth.users(id, email) values ('${id}', '${email}') on conflict do nothing`);
    await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  }
  await db.exec(`
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name) values
      ('${ACC}', '${A}', 'transaction', 'AU', 'AUD', 'Everyday A'),
      ('${ACC_B}', '${B}', 'transaction', 'AU', 'AUD', 'Everyday B');
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, document_type, country_code, currency_code, processing_status, statement_period_start, statement_period_end) values
      ('${UP1}', '${A}', '${ACC}', 'csv', 'bank_statement', 'AU', 'AUD', 'review_required', '2026-08-01', '2026-08-31'),
      ('${UP2}', '${A}', '${ACC}', 'csv', 'bank_statement', 'AU', 'AUD', 'review_required', '2026-08-01', '2026-08-31'),
      ('${UP3}', '${A}', '${ACC}', 'csv', 'bank_statement', 'AU', 'AUD', 'review_required', '2026-08-01', '2026-08-31'),
      ('${UPBIG}', '${A}', '${ACC}', 'csv', 'bank_statement', 'AU', 'AUD', 'review_required', '2026-07-01', '2026-07-31'),
      ('${UPB}', '${B}', '${ACC_B}', 'csv', 'bank_statement', 'AU', 'AUD', 'review_required', '2026-08-01', '2026-08-31');
    ${txnSql(G1, A, ACC, UP1, 200, 'expense')}
    ${txnSql(R1, A, ACC, UP1, 1500, 'expense')}
    ${txnSql(G2, A, ACC, UP2, 200, 'expense')}
    ${txnSql(R2, A, ACC, UP2, 1500, 'expense')}
    ${txnSql(N2, A, ACC, UP2, 42.5, 'expense', { date: '2026-08-20' })}
    ${txnSql(U3, A, ACC, UP3, 19.99, 'unknown', { dedup: 'user_confirmed_duplicate' })}
    ${txnSql(U3K, A, ACC, UP3, 10, 'expense')}
    ${txnSql(TB, B, ACC_B, UPB, 99, 'expense')}
    ${txnSql(S.unknownUnsplit, A, ACC, UP3, 30, 'unknown')}
    ${txnSql(S.unknownReconciledSplit, A, ACC, UP3, 30, 'unknown')}
    ${txnSql(S.blockingItem, A, ACC, UP3, 31, 'expense')}
    ${txnSql(S.pendingLink, A, ACC, UP3, 32, 'expense')}
    ${txnSql(S.pendingDup, A, ACC, UP3, 33, 'expense')}
    ${txnSql(S.badSplit, A, ACC, UP3, 34, 'expense')}
    ${txnSql(S.clean, A, ACC, UP3, 35, 'expense')}
    ${txnSql(S.linkPartner, A, ACC, UP3, 32, 'transfer')}
    ${txnSql(S.dupPartner, A, ACC, UP3, 33, 'expense')}
    ${txnSql(SPLIT, A, ACC, UP3, 100, 'unknown')}
    ${txnSql(SPLIT_APPROVED, A, ACC, UP1, 50, 'expense')}
    insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values
      ('${A}', '${S.unknownReconciledSplit}', 1, 'expense', 20, 'AUD'), ('${A}', '${S.unknownReconciledSplit}', 2, 'transfer', 10, 'AUD'),
      ('${A}', '${S.badSplit}', 1, 'expense', 10, 'AUD');
    insert into fdh_review_items (user_id, transaction_id, review_type, severity, status, title_code) values
      ('${A}', '${S.blockingItem}', 'other', 'blocking', 'open', 'test.blocking');
    insert into fdh_transaction_links (user_id, transaction_id_from, transaction_id_to, link_type, status, created_by_method) values
      ('${A}', '${S.pendingLink}', '${S.linkPartner}', 'internal_transfer', 'pending', 'algorithm');
    insert into fdh_duplicate_candidates (id, user_id, transaction_id_a, transaction_id_b, match_method, confidence, status) values
      ('${DUP_G}', '${A}', '${G1}', '${G2}', 'fuzzy_amount_date', 0.9, 'pending'),
      ('${DUP_R}', '${A}', '${R1}', '${R2}', 'fuzzy_amount_date', 0.9, 'pending'),
      ('${DUP_U}', '${A}', '${S.dupPartner}', '${S.pendingDup}', 'fuzzy_amount_date', 0.9, 'pending');
  `);
  // The overlap: the user resolves the groceries pair 'removed_b' and the rent
  // pair 'kept_both' -- exactly what resolveDuplicateCandidate writes.
  await db.exec(`
    update fdh_duplicate_candidates set status = 'confirmed_duplicate', user_resolution = 'removed_b', resolved_at = now() where id = '${DUP_G}';
    update fdh_transactions set dedup_status = 'user_confirmed_distinct' where id = '${G1}';
    update fdh_transactions set dedup_status = 'user_confirmed_duplicate' where id = '${G2}';
    update fdh_duplicate_candidates set status = 'not_duplicate', user_resolution = 'kept_both', resolved_at = now() where id = '${DUP_R}';
    update fdh_transactions set dedup_status = 'user_confirmed_distinct' where id in ('${R1}', '${R2}');
  `);
  // UP1's lines approved (in real life UP1 was approved before UP2 existed;
  // the candidates are resolved first here only because they are seeded
  // pending and a pending candidate blocks both sides).
  await db.exec(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id in ('${G1}', '${R1}', '${SPLIT_APPROVED}')`);
  // 1,001 clean lines.
  const values = [];
  for (let i = 1; i <= 1001; i += 1) {
    const id = `a8000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    values.push(`('${id}', '${A}', '${ACC}', '${UPBIG}', '2026-07-${String(1 + (i % 28)).padStart(2, '0')}', ${(i % 97) + 1}.25, 'AUD', 'debit', 'expense')`);
  }
  await db.exec(`insert into fdh_transactions (id, user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type) values ${values.join(',\n')};`);
}

const PARITY_IDS = Object.entries(S);
async function blockingSnapshot(db) {
  const out = {};
  for (const [k, id] of PARITY_IDS) out[k] = (await one(db, `select fdh7_transaction_has_blocking_issue('${A}', '${id}') b`)).b;
  return out;
}
const approvedGroceries = async (db) => Number((await one(db, `select coalesce(sum(amount_original), 0) s from fdh_transactions where id in ('${G1}', '${G2}') and approval_status = 'approved'`)).s);

// ============================================================================
console.log('Case A -- full chain to 0211, synthetic tenants, then 0212 (twice)');
const db = await replayUpToTarget();
await seed(db);

// ---------------- BEFORE 0212: every defect is real ----------------
const parityBefore = await blockingSnapshot(db);
check('anti-vacuity: the parity fixture exercises both outcomes (some lines block, some do not)',
  Object.values(parityBefore).includes(true) && Object.values(parityBefore).includes(false), JSON.stringify(parityBefore));
check('anti-vacuity: an excluded duplicate still "unknown" blocks its statement before 0212 (EXP-G4: can never finalise)',
  (await one(db, `select fdh7_statement_has_blocking_issue('${A}', '${UP3}') b`)).b === true
  && (await one(db, `select fdh7_transaction_has_blocking_issue('${A}', '${U3}') b`)).b === true);
// The pre-0212 cascade (approvalService.approveStatement): every pending line
// that is not blocked is approved one by one -- including the removed side.
await db.exec('begin');
await db.exec(`update fdh_transactions t set approval_status = 'approved', approved_by = '${A}' where t.statement_upload_id = '${UP2}' and t.approval_status = 'pending' and not fdh7_transaction_has_blocking_issue('${A}', t.id)`);
const doubleCounted = await approvedGroceries(db);
await db.exec('rollback');
check('anti-vacuity: the pre-0212 cascade approves the removed duplicate -- groceries count 2x ($400)', doubleCounted === 400, `approved groceries = ${doubleCounted}`);
await db.exec(`begin; delete from fdh_transactions where statement_upload_id = '${UP3}' and id not in ('${U3}', '${U3K}');`);
const stmtBlockedBefore = (await one(db, `select fdh7_statement_has_blocking_issue('${A}', '${UP3}') b`)).b;
await db.exec('rollback');
check('anti-vacuity: with only the excluded duplicate left open, its statement is STILL blocked before 0212', stmtBlockedBefore === true);
const fnsBefore = await one(db, `select count(*) filter (where proname = 'fdh8_replace_transaction_allocations')::int s, count(*) filter (where proname = 'fdh7_bulk_approve_transactions')::int b from pg_proc`);
check('anti-vacuity: neither new RPC exists before 0212', fnsBefore.s === 0 && fnsBefore.b === 0);
await db.exec('begin');
const directBefore = await errorOf(db, `insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${SPLIT_APPROVED}', 1, 'expense', 50, 'AUD')`);
await db.exec('rollback');
check('anti-vacuity: before 0212 an allocation can be written straight onto an APPROVED transaction (EXP-G5)', directBefore === null, directBefore ?? '');
await db.exec('begin');
const unknownAllocBefore = await errorOf(db, `insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${SPLIT}', 1, 'unknown', 100, 'AUD')`);
await db.exec('rollback');
check("anti-vacuity: before 0212 an 'unknown' allocation is accepted", unknownAllocBefore === null, unknownAllocBefore ?? '');
const sharedBefore = await sharedChecks(db);

// ---------------- APPLY 0212 ----------------
const applyErr = await errorOf(db, target);
check('0212 applies cleanly on top of the real chain (0207 included)', applyErr === null, applyErr ?? '');

// ---------------- AFTER 0212 ----------------
check('shared CHECKs (error_code, event_type, review_type, check_code) byte-identical -- nothing widened or revoked', (await sharedChecks(db)) === sharedBefore);

// A. Blocking policy.
const parityAfter = await blockingSnapshot(db);
check('blocking policy unchanged for every non-duplicate case (0085 parity)', JSON.stringify(parityAfter) === JSON.stringify(parityBefore), JSON.stringify(parityAfter));
check('an excluded duplicate no longer blocks (transaction level)', (await one(db, `select fdh7_transaction_has_blocking_issue('${A}', '${U3}') b`)).b === false);
const onlyDupLeft = `begin; delete from fdh_transactions where statement_upload_id = '${UP3}' and id not in ('${U3}', '${U3K}');`;
await db.exec(onlyDupLeft);
const stmtBlockedAfter = (await one(db, `select fdh7_statement_has_blocking_issue('${A}', '${UP3}') b`)).b;
await db.exec('rollback');
check('with only the excluded duplicate left open, its statement is no longer blocked', stmtBlockedAfter === false);

// C. The duplicate chain end to end: same statement twice, removed_b.
const up2Ids = (await db.query(`select id from fdh_transactions where statement_upload_id = '${UP2}' order by id`)).rows.map((r) => r.id);
const bulk = await rpcAs(db, A, `select fdh7_bulk_approve_transactions(array[${up2Ids.map((i) => `'${i}'`).join(',')}]::uuid[]) r`);
const r = bulk.rows?.[0]?.r;
check('bulk approve of the second upload returns without error', bulk.error === null, bulk.error?.message ?? '');
check('the removed duplicate is skipped, not approved', r && r.skipped_duplicates.includes(G2) && !r.approved.includes(G2), JSON.stringify(r));
check('the kept rent line and the new line are approved', r && r.approved.includes(R2) && r.approved.includes(N2) && r.approved.length === 2);
check('ORACLE: groceries count exactly 1x ($200) in the approved ledger', (await approvedGroceries(db)) === 200, `approved groceries = ${await approvedGroceries(db)}`);
const advance = (up) => `update fdh_statement_uploads set processing_status = 'ready_for_approval' where id = '${up}'; update fdh_statement_uploads set processing_status = 'approved' where id = '${up}';`;
const finalise = await errorOf(db, `${advance(UP2)} update fdh_statement_uploads set approved_by = '${A}' where id = '${UP2}';`);
check('the second upload FINALISES (statement approval trigger accepts it)', finalise === null && (await one(db, `select approved_by is not null a from fdh_statement_uploads where id = '${UP2}'`)).a, finalise ?? '');
const up3Unblocked = await errorOf(db, `begin; delete from fdh_transactions where statement_upload_id = '${UP3}' and id <> '${U3}' and id <> '${U3K}'; update fdh_transactions set approval_status='approved', approved_by='${A}' where id = '${U3K}'; ${advance(UP3)} update fdh_statement_uploads set approved_by = '${A}' where id = '${UP3}'; rollback;`);
await db.exec('rollback').catch(() => {});
check('a statement whose only open item is an excluded "unknown" duplicate finalises (EXP-G4 dead end closed)', up3Unblocked === null, up3Unblocked ?? '');

// C. Scale: 1,001 lines.
const bigIds = (await db.query(`select id from fdh_transactions where statement_upload_id = '${UPBIG}' order by id`)).rows.map((x) => x.id);
check('setup: the big statement has 1,001 lines', bigIds.length === 1001);
const chunks = [bigIds.slice(0, 500), bigIds.slice(500, 1000), bigIds.slice(1000)];
let approvedCount = 0;
for (const c of chunks) {
  const res = await rpcAs(db, A, `select fdh7_bulk_approve_transactions(array[${c.map((i) => `'${i}'`).join(',')}]::uuid[]) r`);
  approvedCount += res.rows?.[0]?.r?.approved?.length ?? 0;
}
check('approve-all in 500-id chunks approves all 1,001 lines (line 1,001 included)', approvedCount === 1001, `approved ${approvedCount}`);
const stamped = await one(db, `select count(*) filter (where approval_status='approved')::int a, count(*) filter (where approved_at is not null)::int t, count(*) filter (where approved_by = '${A}')::int b from fdh_transactions where statement_upload_id = '${UPBIG}'`);
check('the per-row approval guard trigger fired for every row (approved_at stamped by the trigger on all 1,001)', stamped.a === 1001 && stamped.t === 1001 && stamped.b === 1001, JSON.stringify(stamped));
check('the summary set covers 1,001 approved rows', Number((await one(db, `select count(*)::int n from fdh_transactions where statement_upload_id = '${UPBIG}' and approval_status = 'approved'`)).n) === 1001);
const again = await rpcAs(db, A, `select fdh7_bulk_approve_transactions(array[${bigIds.slice(0, 10).map((i) => `'${i}'`).join(',')}]::uuid[]) r`);
check('repeat approve is idempotent (already_approved, nothing re-approved)', again.rows?.[0]?.r?.approved?.length === 0 && again.rows?.[0]?.r?.already_approved?.length === 10);
await db.exec(`${advance(UPBIG)} update fdh_statement_uploads set approved_by = '${A}' where id = '${UPBIG}'`);
// Reopen: the set-based revert approvalService.reopenStatement issues.
await db.exec(`update fdh_statement_uploads set approved_by = null where id = '${UPBIG}'`);
const reverted = await db.query(`update fdh_transactions set approval_status = 'pending' where user_id = '${A}' and statement_upload_id = '${UPBIG}' and approval_status = 'approved' returning id`);
const cleared = await one(db, `select count(*) filter (where approval_status='pending' and approved_at is null and approved_by is null)::int n from fdh_transactions where statement_upload_id = '${UPBIG}'`);
check('reopen reverts all 1,001 lines in one statement (approved_at/by cleared by the trigger)', reverted.rows.length === 1001 && cleared.n === 1001, `reverted ${reverted.rows.length}, cleared ${cleared.n}`);

// Tenant scope.
const foreign = await rpcAs(db, B, `select fdh7_bulk_approve_transactions(array['${U3K}', '${TB}']::uuid[]) r`);
const fr = foreign.rows?.[0]?.r;
check("user B naming user A's line: not_found, nothing approved for A", fr && fr.not_found.includes(U3K) && !fr.approved.includes(U3K)
  && (await one(db, `select approval_status s from fdh_transactions where id = '${U3K}'`)).s === 'pending', JSON.stringify(fr));
check("user B's own line is approved by B", fr && fr.approved.includes(TB));
const anon = await errorOf(db, `select fdh7_bulk_approve_transactions(array['${U3K}']::uuid[])`);
check('a call with no authenticated user id raises', anon !== null && /authenticated user is required/.test(anon), anon ?? 'accepted');
const blockedRes = await rpcAs(db, A, `select fdh7_bulk_approve_transactions(array['${S.pendingLink}', '${S.clean}']::uuid[]) r`);
const br = blockedRes.rows?.[0]?.r;
check('a blocked line is reported blocked and left pending; a clean line beside it is approved', br && br.blocked.includes(S.pendingLink) && br.approved.includes(S.clean)
  && (await one(db, `select approval_status s from fdh_transactions where id = '${S.pendingLink}'`)).s === 'pending', JSON.stringify(br));

// B. Split replace.
const split = (uid, id, lines, finalize = true) => rpcAs(db, uid, `select fdh8_replace_transaction_allocations('${id}', '${JSON.stringify(lines)}'::jsonb, ${finalize}) r`);
const allocs = async (id) => (await db.query(`select allocation_sequence s, economic_transaction_type t, amount::text a from fdh_transaction_allocations where transaction_id = '${id}' order by 1`)).rows;
const s1 = await split(A, SPLIT, [{ economic_transaction_type: 'expense', amount: 80 }, { economic_transaction_type: 'transfer', amount: 20 }]);
check('replace: a reconciled 80 + 20 split of a $100 line is saved', s1.error === null && (await allocs(SPLIT)).length === 2, s1.error?.message ?? '');
check("the 'unknown' parent split into reconciled lines no longer blocks (0085 behaviour kept)", (await one(db, `select fdh7_transaction_has_blocking_issue('${A}', '${SPLIT}') b`)).b === false);
const s2 = await split(A, SPLIT, [{ economic_transaction_type: 'expense', amount: 100 }]);
check('replace: a second save REPLACES the set (1 line, not 3)', s2.error === null && JSON.stringify(await allocs(SPLIT)) === JSON.stringify([{ s: 1, t: 'expense', a: '100.0000' }]));
const beforeBad = JSON.stringify(await allocs(SPLIT));
const sUnknown = await split(A, SPLIT, [{ economic_transaction_type: 'unknown', amount: 100 }]);
check("replace: an 'unknown' line is refused (FH422) and the previous set is intact", sUnknown.error?.code === 'FH422' && JSON.stringify(await allocs(SPLIT)) === beforeBad, sUnknown.error?.message ?? 'accepted');
const sShort = await split(A, SPLIT, [{ economic_transaction_type: 'expense', amount: 60 }]);
check('replace: a finalised split that does not add up is refused and the previous set is intact', sShort.error?.code === 'FH422' && JSON.stringify(await allocs(SPLIT)) === beforeBad);
const sOver = await split(A, SPLIT, [{ economic_transaction_type: 'expense', amount: 60 }, { economic_transaction_type: 'fee', amount: 50 }], false);
check('replace: a draft may be short but never over-allocated', sOver.error?.code === 'FH422' && JSON.stringify(await allocs(SPLIT)) === beforeBad);
const sHalf = await split(A, SPLIT, [{ economic_transaction_type: 'expense', amount: 70 }, { economic_transaction_type: 'expense', amount: 30, category_id: '99999999-9999-9999-9999-999999999999' }]);
check('ALL-OR-NOTHING: a replace that fails on its 2nd line (FK violation) leaves the previous set exactly as it was', sHalf.error !== null && JSON.stringify(await allocs(SPLIT)) === beforeBad, sHalf.error?.message ?? 'accepted');
const sApproved = await split(A, SPLIT_APPROVED, [{ economic_transaction_type: 'expense', amount: 50 }]);
check('replace: an APPROVED parent is refused (FH409) until its statement is reopened', sApproved.error?.code === 'FH409', sApproved.error?.message ?? 'accepted');
const sForeign = await split(B, SPLIT, [{ economic_transaction_type: 'expense', amount: 100 }]);
check("replace: user B cannot touch user A's transaction (FH404) and A's set is intact", sForeign.error?.code === 'FH404' && JSON.stringify(await allocs(SPLIT)) === beforeBad);
const lockSrc = (await one(db, `select prosrc from pg_proc where proname = 'fdh8_replace_transaction_allocations'`)).prosrc;
check('replace holds the parent row lock (FOR UPDATE) -- concurrent replaces serialise', /from fdh_transactions\s+where id = p_transaction_id and user_id = v_uid\s+for update/i.test(lockSrc));
check('replace is SECURITY INVOKER (runs under the caller\'s RLS)', (await one(db, `select prosecdef d from pg_proc where proname = 'fdh8_replace_transaction_allocations'`)).d === false);

// B. The DB-level gate behind it.
const directAfter = await errorOf(db, `insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${SPLIT_APPROVED}', 1, 'expense', 50, 'AUD')`);
check('a direct allocation write onto an approved transaction is now refused by the trigger', directAfter !== null && /approved; reopen its statement/.test(directAfter), directAfter ?? 'accepted');
const viaSeam = await errorOf(db, `begin; select set_config('fhip.import_bridge_internal_write', 'true', true); insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${SPLIT_APPROVED}', 1, 'expense', 50, 'AUD'); rollback;`);
await db.exec('rollback').catch(() => {});
check('the 0207 import-bridge write seam (GUC) is still allowed through (WP-11 ledger Apply)', viaSeam === null, viaSeam ?? '');
await db.exec(`update fdh_transactions set approval_status = 'pending' where id = '${SPLIT_APPROVED}'`);
await db.exec(`insert into fdh_transaction_allocations (user_id, transaction_id, allocation_sequence, economic_transaction_type, amount, currency_code) values ('${A}', '${SPLIT_APPROVED}', 1, 'expense', 50, 'AUD')`);
await db.exec(`update fdh_transactions set approval_status = 'approved', approved_by = '${A}' where id = '${SPLIT_APPROVED}'`);
const cascade = await errorOf(db, `delete from fdh_transactions where id = '${SPLIT_APPROVED}'`);
check('deleting an APPROVED transaction still cascades its allocations (account deletion is not blocked)', cascade === null
  && (await one(db, `select count(*)::int n from fdh_transaction_allocations where transaction_id = '${SPLIT_APPROVED}'`)).n === 0, cascade ?? '');

// Privileges.
for (const sig of ['fdh8_replace_transaction_allocations(uuid, jsonb, boolean)', 'fdh7_bulk_approve_transactions(uuid[])']) {
  const p = await one(db, `select has_function_privilege('authenticated', '${sig}', 'execute') a, has_function_privilege('anon', '${sig}', 'execute') n`);
  check(`${sig.replace(/\(.*/, '')}: authenticated may execute, anon may not`, p.a === true && p.n === false, JSON.stringify(p));
}

// Re-apply: byte-identical no-op.
const fp1 = await schemaFingerprint(db);
const reErr = await errorOf(db, target);
const fp2 = await schemaFingerprint(db);
check('re-applying 0212 raises nothing', reErr === null, reErr ?? '');
check('re-applying 0212 changes no constraint, trigger, function body or grant', fp1 === fp2);
check('re-apply leaves exactly one allocation guard trigger', (await one(db, `select count(*)::int n from pg_trigger where tgname = 'trg_fdh8_guard_allocation_parent_not_approved'`)).n === 1);

const total = pass + fail;
console.log(`\n=== FDH 0212 PGlite verification: ${pass} PASS, ${fail} FAIL (${total} checks) ===`);
if (total < 40) { console.error('too few checks executed -- refusing to report a vacuous pass'); process.exit(2); }
process.exit(fail === 0 ? 0 : 1);
