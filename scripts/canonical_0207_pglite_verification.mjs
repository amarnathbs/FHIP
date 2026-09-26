// Canonical-upload programme (WP-01) -- PGlite verification for migration
// 0207_canonical_upload_schema_foundation.sql.
//
// Case A: the real chain replayed up to 0206, a small synthetic tenant seeded,
//   anti-vacuity checks proving each gap exists BEFORE 0207, then 0207 applied
//   and every acceptance claim checked AFTER it, then 0207 applied a second
//   time (must be a byte-identical no-op).
// Case B: a live database whose event_type constraint was widened by a
//   sibling migration that 0207 does not know about -- 0207 must REFUSE to run
//   rather than silently revoke the sibling's value (the 0185/0186 trap).
//
// Every check prints PASS/FAIL with a name; the process exits non-zero on any
// FAIL. A green run with zero checks is impossible: the final line asserts the
// number of checks executed.
//
// Run: node scripts/canonical_0207_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0207_canonical_upload_schema_foundation.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

const NEW_ERROR_CODES = ['extraction_timeout'];
const NEW_EVENT_TYPES = [
  'liability_ledger_applied', 'liability_statement_rejected', 'payroll_bank_match_restamped',
  'payroll_event_superseded', 'bank_leg_reclassified_by_import', 'investment_positions_published',
  'post_approval_matcher_failed',
];

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
const constraintValues = async (db, table, name) => {
  const r = await one(db, `select pg_get_constraintdef(oid) d from pg_constraint where conrelid = $1::regclass and conname = $2`, [table, name]);
  if (!r) return null;
  return [...r.d.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
};
const constraintDef = async (db, table, name) => (await one(db, `select pg_get_constraintdef(oid) d from pg_constraint where conrelid = $1::regclass and conname = $2`, [table, name]))?.d ?? null;
const errorOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const asAuthenticated = async (db, uid, fn) => {
  await db.exec(`set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '${uid}'`);
  try { return await fn(); } finally { await db.exec('rollback').catch(() => {}); await db.exec(`reset request.jwt.claim.role; reset request.jwt.claim.sub`); }
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
const ACC_A = 'a0000000-0000-0000-0000-00000000000a';
const ACC_B = 'b0000000-0000-0000-0000-00000000000b';
const LIAB_A = 'a1000000-0000-0000-0000-00000000000a';
const LIAB_B = 'b1000000-0000-0000-0000-00000000000b';
const UP_A = 'a2000000-0000-0000-0000-00000000000a';
const TXN_A = 'a3000000-0000-0000-0000-00000000000a';
const TXN_A_OVERRIDE = 'a3000000-0000-0000-0000-00000000000b';
const TXN_B = 'b3000000-0000-0000-0000-00000000000b';
const STMT_A = 'a4000000-0000-0000-0000-00000000000a';
const ACT_A = 'a5000000-0000-0000-0000-00000000000a';

async function seed(db) {
  for (const [id, email] of [[A, 'a@t.test'], [B, 'b@t.test']]) {
    await db.exec(`insert into auth.users(id, email) values ('${id}', '${email}') on conflict do nothing`);
    await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  }
  await db.exec(`
    insert into liabilities (id, user_id, liability_name, debt_type, balance, currency_code) values
      ('${LIAB_A}', '${A}', 'Card A', 'credit_card', 1000, 'AUD'),
      ('${LIAB_B}', '${B}', 'Card B', 'credit_card', 2000, 'AUD');
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name) values
      ('${ACC_A}', '${A}', 'transaction', 'AU', 'AUD', 'Everyday A'),
      ('${ACC_B}', '${B}', 'transaction', 'AU', 'AUD', 'Everyday B');
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, document_type, country_code, currency_code, processing_status)
      values ('${UP_A}', '${A}', '${ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'queued');
    insert into fdh_transactions (id, user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, user_override) values
      ('${TXN_A}', '${A}', '${ACC_A}', '${UP_A}', '2026-08-03', 220, 'AUD', 'debit', 'expense', false),
      ('${TXN_A_OVERRIDE}', '${A}', '${ACC_A}', '${UP_A}', '2026-08-04', 50, 'AUD', 'debit', 'expense', true),
      ('${TXN_B}', '${B}', '${ACC_B}', null, '2026-08-03', 99, 'AUD', 'debit', 'expense', false);
    insert into fdh_liability_statements (id, user_id, statement_type, facility_type, currency_code)
      values ('${STMT_A}', '${A}', 'credit_card', 'credit_card', 'AUD');
    insert into fdh_liability_statement_activities (id, user_id, statement_id, activity_type, activity_date, amount, currency_code)
      values ('${ACT_A}', '${A}', '${STMT_A}', 'PURCHASE', '2026-08-02', 200, 'AUD');
  `);
}

const ALTERED_TABLES = [
  'fdh_financial_accounts', 'fdh_liability_statement_activities', 'fdh_liability_statements',
  'fdh_retirement_statements', 'fdh_investment_statements', 'fdh_payroll_events',
  'fhip_import_applications', 'fhip_import_proposals', 'fdh_statement_uploads', 'fdh_document_audit_events', 'fdh_transactions',
];
const relfilenodes = async (db) => Object.fromEntries((await db.query(`select relname, relfilenode from pg_class where relname = any($1)`, [ALTERED_TABLES])).rows.map((r) => [r.relname, r.relfilenode]));
const rowVersions = async (db) => (await db.query(`
  select 'txn:' || id::text k, xmin::text x from fdh_transactions
  union all select 'acc:' || id::text, xmin::text from fdh_financial_accounts
  union all select 'act:' || id::text, xmin::text from fdh_liability_statement_activities
  union all select 'stm:' || id::text, xmin::text from fdh_liability_statements
  union all select 'up:' || id::text, xmin::text from fdh_statement_uploads order by 1`)).rows;

// ============================================================================
console.log('Case A -- full chain to 0206, synthetic tenant, then 0207 (twice)');
{
  const db = await replayUpToTarget();
  await seed(db);

  // ---------------- BEFORE 0207: every gap is real ----------------
  const accColsBefore = await cols(db, 'fdh_financial_accounts');
  check('anti-vacuity: fdh_financial_accounts has no owner_role / liability_id before 0207',
    !accColsBefore.includes('owner_role') && !accColsBefore.includes('liability_id'));
  const actColsBefore = await cols(db, 'fdh_liability_statement_activities');
  check('anti-vacuity: activities have no ledger_transaction_id / gst_amount_raw before 0207',
    !actColsBefore.includes('ledger_transaction_id') && !actColsBefore.includes('gst_amount_raw'));
  const warnBefore = await Promise.all(['fdh_liability_statements', 'fdh_retirement_statements', 'fdh_investment_statements'].map((t) => cols(db, t)));
  check('anti-vacuity: no extraction_warnings on the three statement tables before 0207', warnBefore.every((c) => !c.includes('extraction_warnings')));
  check('anti-vacuity: no fdh_payroll_events.income_owner before 0207', !(await cols(db, 'fdh_payroll_events')).includes('income_owner'));
  check('anti-vacuity: no ledger_effects / summary before 0207',
    !(await cols(db, 'fhip_import_applications')).includes('ledger_effects') && !(await cols(db, 'fhip_import_proposals')).includes('summary'));

  const errBefore = await constraintValues(db, 'fdh_statement_uploads', 'fdh_statement_uploads_error_code_check');
  const evtBefore = await constraintValues(db, 'fdh_document_audit_events', 'fdh_document_audit_events_event_type_check');
  check('anti-vacuity: error_code predecessor is the 24-value 0179 list and lacks extraction_timeout',
    errBefore.length === 24 && !errBefore.includes('extraction_timeout'), `${errBefore.length} values`);
  check('anti-vacuity: event_type predecessor is the 109-value 0186 list and lacks all 7 new types',
    evtBefore.length === 109 && NEW_EVENT_TYPES.every((v) => !evtBefore.includes(v)), `${evtBefore.length} values`);
  const timeoutRefusedBefore = await errorOf(db, `update fdh_statement_uploads set error_code = 'extraction_timeout' where id = '${UP_A}'`);
  check("anti-vacuity: error_code 'extraction_timeout' is refused before 0207", timeoutRefusedBefore !== null, timeoutRefusedBefore ?? 'accepted');
  const auditRefusedBefore = await errorOf(db, `insert into fdh_document_audit_events (user_id, event_type, actor_type) values ('${A}', 'liability_ledger_applied', 'system')`);
  check("anti-vacuity: audit event 'liability_ledger_applied' is refused before 0207", auditRefusedBefore !== null, auditRefusedBefore ?? 'accepted');

  const gucInsert = (id) => `
    select set_config('fhip.import_bridge_internal_write', 'true', true);
    insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit)
      values ('${id}', '${A}', '${ACC_A}', '2026-08-09', 10, 'AUD', 'debit');`;
  const gucBefore = await asAuthenticated(db, A, () => errorOf(db, `begin; ${gucInsert('a6000000-0000-0000-0000-000000000001')} commit;`));
  await db.exec('rollback').catch(() => {});
  check('anti-vacuity: before 0207 an authenticated INSERT is refused EVEN WITH the GUC set (the seam does not exist yet)',
    gucBefore !== null && /engine-authoritative/.test(gucBefore), gucBefore ?? 'accepted');
  const fnBefore = await one(db, `select count(*)::int n from pg_proc where proname = 'fdh_internal_reclassify_corroborated_leg'`);
  check('anti-vacuity: the reclassify helper does not exist before 0207', fnBefore.n === 0);

  const nodesBefore = await relfilenodes(db);
  const versionsBefore = await rowVersions(db);

  // ---------------- APPLY 0207 ----------------
  const applyErr = await errorOf(db, target);
  check('0207 applies cleanly on top of the real 0206 chain', applyErr === null, applyErr ?? '');

  // ---------------- AFTER 0207 ----------------
  check('zero rows rewritten: no altered table got a new relfilenode (no table rewrite)',
    JSON.stringify(await relfilenodes(db)) === JSON.stringify(nodesBefore));
  check('zero rows rewritten: every pre-existing row keeps its xmin (no UPDATE ran)',
    JSON.stringify(await rowVersions(db)) === JSON.stringify(versionsBefore), `${versionsBefore.length} rows compared`);

  const accCols = await cols(db, 'fdh_financial_accounts');
  check('fdh_financial_accounts.owner_role and liability_id exist', accCols.includes('owner_role') && accCols.includes('liability_id'));
  const actCols = await cols(db, 'fdh_liability_statement_activities');
  check('activities.ledger_transaction_id and gst_amount_raw exist', actCols.includes('ledger_transaction_id') && actCols.includes('gst_amount_raw'));
  const warnAfter = await Promise.all(['fdh_liability_statements', 'fdh_retirement_statements', 'fdh_investment_statements'].map((t) => cols(db, t)));
  check('extraction_warnings exists on all three statement tables', warnAfter.every((c) => c.includes('extraction_warnings')));
  const stmtWarn = await one(db, `select extraction_warnings w from fdh_liability_statements where id = '${STMT_A}'`);
  check("existing statement rows read extraction_warnings = [] (constant default, no backfill UPDATE)", JSON.stringify(stmtWarn.w) === '[]');
  check('fdh_payroll_events.income_owner exists', (await cols(db, 'fdh_payroll_events')).includes('income_owner'));
  check('fhip_import_applications.ledger_effects and fhip_import_proposals.summary exist',
    (await cols(db, 'fhip_import_applications')).includes('ledger_effects') && (await cols(db, 'fhip_import_proposals')).includes('summary'));

  // Shared CHECKs: set equality against predecessor + new values.
  const errAfter = await constraintValues(db, 'fdh_statement_uploads', 'fdh_statement_uploads_error_code_check');
  const errExpected = [...errBefore, ...NEW_ERROR_CODES].sort();
  check('error_code CHECK == predecessor (live, pre-0207) + extraction_timeout, exactly',
    JSON.stringify([...errAfter].sort()) === JSON.stringify(errExpected), `${errBefore.length} -> ${errAfter.length}`);
  check('error_code CHECK revokes nothing', errBefore.every((v) => errAfter.includes(v)));
  const evtAfter = await constraintValues(db, 'fdh_document_audit_events', 'fdh_document_audit_events_event_type_check');
  const evtExpected = [...evtBefore, ...NEW_EVENT_TYPES].sort();
  check('event_type CHECK == predecessor (live, pre-0207) + the 7 new types, exactly',
    JSON.stringify([...evtAfter].sort()) === JSON.stringify(evtExpected), `${evtBefore.length} -> ${evtAfter.length}`);
  check('event_type CHECK revokes nothing', evtBefore.every((v) => evtAfter.includes(v)));
  const timeoutAfter = await errorOf(db, `update fdh_statement_uploads set error_code = 'extraction_timeout' where id = '${UP_A}'`);
  check("error_code 'extraction_timeout' is accepted after 0207", timeoutAfter === null, timeoutAfter ?? '');
  const auditAfter = await errorOf(db, `insert into fdh_document_audit_events (user_id, event_type, actor_type) values ('${A}', 'liability_ledger_applied', 'system')`);
  check("audit event 'liability_ledger_applied' is accepted after 0207", auditAfter === null, auditAfter ?? '');
  const bogusAudit = await errorOf(db, `insert into fdh_document_audit_events (user_id, event_type, actor_type) values ('${A}', 'not_a_real_event', 'system')`);
  check('an unknown audit event type is still refused (the CHECK still bites)', bogusAudit !== null);

  // r7_block_authenticated_insert: unchanged without the GUC, open only with it.
  const noGuc = await asAuthenticated(db, A, () => errorOf(db, `insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit) values ('a6000000-0000-0000-0000-000000000002', '${A}', '${ACC_A}', '2026-08-09', 10, 'AUD', 'debit')`));
  check('an authenticated INSERT into fdh_transactions WITHOUT the GUC is still refused', noGuc !== null && /engine-authoritative/.test(noGuc), noGuc ?? 'accepted');
  const noGucRecon = await asAuthenticated(db, A, () => errorOf(db, `insert into fdh_data_provenance (user_id) values ('${A}')`));
  check('the other r7-guarded tables are unchanged without the GUC (fdh_data_provenance refused)', noGucRecon !== null && /engine-authoritative/.test(noGucRecon), noGucRecon ?? 'accepted');
  const gucFalse = await asAuthenticated(db, A, () => errorOf(db, `begin; select set_config('fhip.import_bridge_internal_write', 'false', true); insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit) values ('a6000000-0000-0000-0000-000000000003', '${A}', '${ACC_A}', '2026-08-09', 10, 'AUD', 'debit'); commit;`));
  await db.exec('rollback').catch(() => {});
  check("GUC explicitly 'false' is still refused", gucFalse !== null && /engine-authoritative/.test(gucFalse), gucFalse ?? 'accepted');
  await db.exec(`
    create or replace function test_0207_definer_ledger_insert(p_id uuid) returns void as $$
    begin
      perform set_config('fhip.import_bridge_internal_write', 'true', true);
      insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit)
        values (p_id, '${A}', '${ACC_A}', '2026-08-09', 10, 'AUD', 'debit');
      perform set_config('fhip.import_bridge_internal_write', 'false', true);
    end; $$ language plpgsql security definer set search_path = public;`);
  const viaDefiner = await asAuthenticated(db, A, () => errorOf(db, `select test_0207_definer_ledger_insert('a6000000-0000-0000-0000-000000000004')`));
  const inserted = await one(db, `select count(*)::int n from fdh_transactions where id = 'a6000000-0000-0000-0000-000000000004'`);
  check('the SAME authenticated INSERT succeeds inside a SECURITY DEFINER function that sets the GUC', viaDefiner === null && inserted.n === 1, viaDefiner ?? '');
  const gucLeak = await one(db, `select coalesce(current_setting('fhip.import_bridge_internal_write', true), '') v`);
  check('the GUC does not leak out of the definer call', gucLeak.v !== 'true', `value after call: '${gucLeak.v}'`);

  // Reclassify helper: privileges.
  const sig = 'fdh_internal_reclassify_corroborated_leg(uuid, uuid, text, text, text, uuid)';
  const priv = await one(db, `select has_function_privilege('authenticated', '${sig}', 'execute') a, has_function_privilege('anon', '${sig}', 'execute') n, has_function_privilege('service_role', '${sig}', 'execute') s`);
  check("has_function_privilege('authenticated', helper, 'execute') = false", priv.a === false);
  check("has_function_privilege('anon', helper, 'execute') = false", priv.n === false);
  check("has_function_privilege('service_role', helper, 'execute') = true", priv.s === true);
  const pub = await one(db, `select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proname = 'fdh_internal_reclassify_corroborated_leg' and a.grantee = 0`);
  check('PUBLIC holds no EXECUTE on the helper', pub.n === 0);
  const asAuthRole = await errorOf(db, `set role authenticated; select ${sig.replace(/\(.*/, '')}('${A}', '${TXN_A}', 'transfer', 'x', 'payroll_event', null);`);
  await db.exec('reset role');
  check('calling the helper AS the authenticated role is refused (permission denied)', asAuthRole !== null && /permission denied/i.test(asAuthRole), asAuthRole ?? 'accepted');

  // Reclassify helper: behaviour. The r8 trigger must be live, or the pass below would prove nothing.
  const forged = await asAuthenticated(db, A, () => errorOf(db, `update fdh_transactions set economic_transaction_type = 'transfer' where id = '${TXN_A}'`));
  check('anti-vacuity: a direct authenticated type change with no correction row is refused by the 0068 trigger', forged !== null && /recorded correction/.test(forged), forged ?? 'accepted');
  await db.exec(`
    create or replace function test_0207_call_reclassify(p_user uuid, p_txn uuid, p_type text) returns text as $$
      select fdh_internal_reclassify_corroborated_leg(p_user, p_txn, p_type, 'unit test', 'liability_statement_activity', '${ACT_A}'::uuid);
    $$ language sql security definer set search_path = public;`);
  const res = await asAuthenticated(db, A, async () => { try { return (await one(db, `select test_0207_call_reclassify('${A}', '${TXN_A}', 'transfer') r`)).r; } catch (e) { return 'ERR ' + e.message; } });
  const after = await one(db, `select economic_transaction_type t, user_override o from fdh_transactions where id = '${TXN_A}'`);
  const corr = await one(db, `select count(*)::int n from fdh_transaction_corrections where transaction_id = '${TXN_A}' and field_name = 'economic_transaction_type' and corrected_value = '"transfer"'::jsonb and previous_value = '"expense"'::jsonb`);
  const aud = await one(db, `select count(*)::int n from fdh_document_audit_events where event_type = 'bank_leg_reclassified_by_import' and document_id = '${UP_A}' and metadata->>'transaction_id' = '${TXN_A}'`);
  check("helper called from an authenticated definer RPC: returns 'reclassified' and the leg is now 'transfer'", res === 'reclassified' && after.t === 'transfer', `result=${res}, type=${after.t}`);
  check('helper wrote the correction evidence row (previous expense -> transfer)', corr.n === 1);
  check("helper audited 'bank_leg_reclassified_by_import' against the leg's statement", aud.n === 1);
  check('helper did not mark the row as a user override', after.o === false);
  const again = await asAuthenticated(db, A, async () => (await one(db, `select test_0207_call_reclassify('${A}', '${TXN_A}', 'transfer') r`)).r);
  const corr2 = await one(db, `select count(*)::int n from fdh_transaction_corrections where transaction_id = '${TXN_A}'`);
  check("a repeat call is 'unchanged' and writes no second correction", again === 'unchanged' && corr2.n === 1, `result=${again}, corrections=${corr2.n}`);
  const overridden = await asAuthenticated(db, A, async () => (await one(db, `select test_0207_call_reclassify('${A}', '${TXN_A_OVERRIDE}', 'transfer') r`)).r);
  const ovType = await one(db, `select economic_transaction_type t from fdh_transactions where id = '${TXN_A_OVERRIDE}'`);
  check("a user_override row is skipped ('skipped_user_override') and keeps its type", overridden === 'skipped_user_override' && ovType.t === 'expense', `result=${overridden}, type=${ovType.t}`);
  const foreign = await asAuthenticated(db, A, () => errorOf(db, `select test_0207_call_reclassify('${B}', '${TXN_B}', 'transfer')`));
  check('a cross-tenant call (auth.uid() = A, p_user = B) is refused', foreign !== null && /RECLASSIFY_FOREIGN_USER/.test(foreign), foreign ?? 'accepted');
  const wrongOwner = await asAuthenticated(db, A, () => errorOf(db, `select test_0207_call_reclassify('${A}', '${TXN_B}', 'transfer')`));
  check("user A naming user B's transaction is NOT_FOUND", wrongOwner !== null && /RECLASSIFY_NOT_FOUND/.test(wrongOwner), wrongOwner ?? 'accepted');
  const badType = await errorOf(db, `select fdh_internal_reclassify_corroborated_leg('${A}', '${TXN_A}', 'unknown', 'x', 'payroll_event', null)`);
  check("reclassifying to 'unknown' is refused", badType !== null && /RECLASSIFY_INVALID_TYPE/.test(badType), badType ?? 'accepted');
  const badKind = await errorOf(db, `select fdh_internal_reclassify_corroborated_leg('${A}', '${TXN_A}', 'income', 'x', 'made_up', null)`);
  check('an unknown source kind is refused', badKind !== null && /RECLASSIFY_INVALID_SOURCE_KIND/.test(badKind), badKind ?? 'accepted');

  // Same-tenant and uniqueness guards.
  const crossLiab = await errorOf(db, `update fdh_financial_accounts set liability_id = '${LIAB_B}' where id = '${ACC_A}'`);
  check("a cross-tenant liability_id (A's account -> B's liability) is refused", crossLiab !== null && /cross-tenant/.test(crossLiab), crossLiab ?? 'accepted');
  const ownLiab = await errorOf(db, `update fdh_financial_accounts set liability_id = '${LIAB_A}', owner_role = 'joint' where id = '${ACC_A}'`);
  check("a same-tenant liability_id + owner_role 'joint' is accepted", ownLiab === null, ownLiab ?? '');
  const dupLiab = await errorOf(db, `insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name, liability_id) values ('${A}', 'credit_card', 'AU', 'AUD', 'Second', '${LIAB_A}')`);
  check('a second account for the same liability is refused (unique facility link)', dupLiab !== null && /duplicate key|unique/i.test(dupLiab), dupLiab ?? 'accepted');
  const badRole = await errorOf(db, `update fdh_financial_accounts set owner_role = 'company' where id = '${ACC_A}'`);
  check("owner_role outside (self, spouse, joint, smsf) is refused", badRole !== null && /owner_role/.test(badRole), badRole ?? 'accepted');
  const crossLedger = await errorOf(db, `update fdh_liability_statement_activities set ledger_transaction_id = '${TXN_B}' where id = '${ACT_A}'`);
  check("a cross-tenant ledger_transaction_id is refused", crossLedger !== null && /cross-tenant/.test(crossLedger), crossLedger ?? 'accepted');
  const ownLedger = await errorOf(db, `update fdh_liability_statement_activities set ledger_transaction_id = '${TXN_A}', gst_amount_raw = '18.00' where id = '${ACT_A}'`);
  check('a same-tenant ledger_transaction_id + gst_amount_raw is accepted', ownLedger === null, ownLedger ?? '');
  const badWarn = await errorOf(db, `update fdh_liability_statements set extraction_warnings = '{"a":1}'::jsonb where id = '${STMT_A}'`);
  check('extraction_warnings must be a JSON array', badWarn !== null && /extraction_warnings/.test(badWarn), badWarn ?? 'accepted');
  const badOwner = await errorOf(db, `insert into fdh_payroll_events (user_id, country_code, currency_code, pay_frequency, pay_frequency_source, income_owner) values ('${A}', 'AU', 'AUD', 'monthly', 'stated', 'joint')`);
  check("income_owner outside (self, spouse) is refused", badOwner !== null && /income_owner/.test(badOwner), badOwner ?? 'accepted');

  // Re-apply: byte-identical no-op.
  const fp1 = await schemaFingerprint(db);
  const reErr = await errorOf(db, target);
  const fp2 = await schemaFingerprint(db);
  check('re-applying 0207 raises nothing', reErr === null, reErr ?? '');
  check('re-applying 0207 changes no constraint, index, trigger, function body or column', fp1 === fp2);
  check('re-apply leaves exactly one error_code and one event_type CHECK',
    (await constraintDef(db, 'fdh_statement_uploads', 'fdh_statement_uploads_error_code_check')) !== null
    && (await one(db, `select count(*)::int n from pg_constraint where conrelid = 'fdh_document_audit_events'::regclass and contype = 'c'`)).n === 2);
}

// ============================================================================
console.log('Case B -- a sibling migration widened event_type first: 0207 must refuse, not revoke');
{
  const db = await replayUpToTarget();
  const live = await constraintValues(db, 'fdh_document_audit_events', 'fdh_document_audit_events_event_type_check');
  const widened = [...live, 'sibling_branch_only_event'].map((v) => `'${v}'`).join(', ');
  await db.exec(`
    alter table fdh_document_audit_events drop constraint fdh_document_audit_events_event_type_check;
    alter table fdh_document_audit_events add constraint fdh_document_audit_events_event_type_check check (event_type in (${widened}));`);
  const before = await constraintDef(db, 'fdh_document_audit_events', 'fdh_document_audit_events_event_type_check');
  check('setup: the sibling value is live before 0207', /sibling_branch_only_event/.test(before));
  const err = await errorOf(db, target);
  check('0207 raises instead of revoking the sibling value', err !== null && /would REVOKE fdh_document_audit_events\.event_type/.test(err) && /sibling_branch_only_event/.test(err), err ?? 'applied');
  check("the sibling's constraint is untouched after the refusal", (await constraintDef(db, 'fdh_document_audit_events', 'fdh_document_audit_events_event_type_check')) === before);
  // The file runs as one transaction (Supabase applies a migration in one;
  // PGlite's multi-statement exec is one implicit transaction), so the refusal
  // must also have rolled back sections A-E that ran before the guard.
  check('the refusal rolled the whole migration back (no owner_role column, error_code CHECK unchanged)',
    !(await cols(db, 'fdh_financial_accounts')).includes('owner_role')
    && !(await constraintValues(db, 'fdh_statement_uploads', 'fdh_statement_uploads_error_code_check')).includes('extraction_timeout'));
}

const total = pass + fail;
console.log(`\n=== canonical 0207 PGlite verification: ${pass} PASS, ${fail} FAIL (${total} checks) ===`);
if (total < 50) { console.error('too few checks executed -- refusing to report a vacuous pass'); process.exit(2); }
process.exit(fail === 0 ? 0 : 1);
