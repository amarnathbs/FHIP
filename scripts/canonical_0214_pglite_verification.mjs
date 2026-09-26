// Canonical-upload programme (WP-15) -- PGlite verification for migration
// 0214_canonical_wp15_input_population_proposals.sql.
//
// Case A: the real chain replayed up to 0214 (exclusive), a synthetic two-
//   tenant household seeded, anti-vacuity checks proving each gap exists
//   BEFORE 0214 (an expense/asset proposal with a target cannot even be
//   stored; no apply function; no bank_statement_import provenance), then
//   0214 applied and every acceptance claim exercised through the real RPCs
//   as the authenticated role, then 0214 re-applied (must be a no-op).
// Case B: sibling-safety. (1) A sibling widened assets.source_type first:
//   0214 must keep the sibling's value (widen by union). (2) A sibling added a
//   target_domain branch to a shared guard function: 0214 must REFUSE to
//   apply rather than silently delete it.
//
// Every check prints PASS/FAIL; exit code is non-zero on any FAIL, and the
// run asserts a minimum number of checks so a vacuous green is impossible.
//
// Run: node scripts/canonical_0214_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0214_canonical_wp15_input_population_proposals.sql';
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
const checkValues = async (db, table) => {
  const r = await one(db, `select pg_get_constraintdef(c.oid) d from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = $1::regclass and c.contype = 'c' and a.attname = 'source_type'`, [table]);
  return r ? [...r.d.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]) : null;
};
const schemaFingerprint = async (db) => {
  const c = (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows;
  const i = (await db.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`)).rows;
  const t = (await db.query(`select tgname, tgrelid::regclass::text r, tgattr::text a from pg_trigger where not tgisinternal order by 1,2`)).rows;
  const f = (await db.query(`select proname, md5(prosrc) h from pg_proc where pronamespace = 'public'::regnamespace order by 1,2`)).rows;
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
const rpc = async (db, sql) => {
  try { return (await one(db, sql)).r; } catch (e) { return { ok: false, code: 'SQL_ERROR', error: e.message }; }
};

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ACC_A = 'a0000000-0000-0000-0000-00000000000a';
const ACC_A_CARD = 'a0000000-0000-0000-0000-0000000000cc';
const ACC_B = 'b0000000-0000-0000-0000-00000000000b';
const UP_A1 = 'a2000000-0000-0000-0000-000000000001'; // July statement, closing 5000
const UP_A2 = 'a2000000-0000-0000-0000-000000000002'; // August statement, closing 6000 (approved later in the run)
const UP_B = 'b2000000-0000-0000-0000-00000000000b';
const UP_CARD = 'a2000000-0000-0000-0000-0000000000cc'; // approved card statement (never a cash asset)
const EXP_GROC_A = 'a7000000-0000-0000-0000-000000000001';
const EXP_B = 'b7000000-0000-0000-0000-000000000001';
const ASSET_B = 'b8000000-0000-0000-0000-000000000001';

async function seed(db) {
  for (const [id, email] of [[A, 'a@t.test'], [B, 'b@t.test']]) {
    await db.exec(`insert into auth.users(id, email) values ('${id}', '${email}') on conflict do nothing`);
    await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  }
  await db.exec(`
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name) values
      ('${ACC_A}', '${A}', 'transaction', 'AU', 'AUD', 'Everyday A'),
      ('${ACC_A_CARD}', '${A}', 'credit_card', 'AU', 'AUD', 'Card A'),
      ('${ACC_B}', '${B}', 'transaction', 'AU', 'AUD', 'Everyday B');
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, document_type, country_code, currency_code, processing_status, statement_period_start, statement_period_end) values
      ('${UP_A1}', '${A}', '${ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'approved', '2026-07-01', '2026-07-31'),
      ('${UP_A2}', '${A}', '${ACC_A}', 'csv', 'bank_statement', 'AU', 'AUD', 'approved', '2026-08-01', '2026-08-31'),
      ('${UP_CARD}', '${A}', '${ACC_A_CARD}', 'csv', 'bank_statement', 'AU', 'AUD', 'approved', '2026-07-01', '2026-07-31'),
      ('${UP_B}', '${B}', '${ACC_B}', 'csv', 'bank_statement', 'AU', 'AUD', 'approved', '2026-07-01', '2026-07-31');
    insert into fdh_reconciliation_results (user_id, statement_upload_id, reported_closing_balance, currency_code) values
      ('${A}', '${UP_A1}', 5000, 'AUD'), ('${A}', '${UP_CARD}', 300, 'AUD'), ('${B}', '${UP_B}', 777, 'AUD');
    insert into expense_items (id, user_id, expense_name, expense_category, amount, frequency, currency_code, master_item_key) values
      ('${EXP_GROC_A}', '${A}', 'Groceries', 'food', 800, 'monthly', 'AUD', 'groceries'),
      ('${EXP_B}', '${B}', 'Groceries', 'food', 900, 'monthly', 'AUD', 'groceries');
    insert into assets (id, user_id, asset_name, asset_class, current_value, currency_code) values
      ('${ASSET_B}', '${B}', 'Savings B', 'cash', 100, 'AUD');
  `);
}

/** Inserts a proposal + fields AS USER uid through RLS; returns the proposal id. */
async function makeProposal(db, uid, p) {
  return asUser(db, uid, async () => {
    const id = (await one(db, `insert into fhip_import_proposals (user_id, target_domain, source_kind, currency_code, target_entity_id, recommended_apply_mode, source_statement_upload_id, source_window_from, source_window_to, status)
      values ($1, $2, 'bank_statement', 'AUD', $3, $4, $5, $6, $7, 'ready') returning id`,
      [uid, p.domain, p.target ?? null, p.mode, p.statement ?? null, p.windowFrom ?? null, p.windowTo ?? null])).id;
    for (const f of p.fields) {
      await db.query(`insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, reason_code) values ($1, $2, $3, $4, $5, $6, 'test')`,
        [uid, id, f[0], f[1], f[2], f[3] ?? null]);
    }
    return id;
  });
}
const applyExpense = (db, uid, decisions) => asUser(db, uid, () => rpc(db, `select fdh15_apply_expense_proposals('${JSON.stringify(decisions)}'::jsonb) r`));
const applyAsset = (db, uid, id, decision = 'add_new') => asUser(db, uid, () => rpc(db, `select fdh15_apply_asset_proposal('${id}', '${decision}', null) r`));
const status = async (db, id) => (await one(db, `select status from fhip_import_proposals where id = $1`, [id])).status;

// ============================================================================
console.log('Case A -- full chain, synthetic household, then 0214 (twice)');
{
  const db = await replayUpToTarget();
  await seed(db);

  // ---------------- BEFORE 0214: every gap is real ----------------
  check('anti-vacuity: expense_items has no source_type / last_imported_at before 0214',
    !(await cols(db, 'expense_items')).includes('source_type') && !(await cols(db, 'expense_items')).includes('last_imported_at'));
  check('anti-vacuity: assets has no source_financial_account_id before 0214', !(await cols(db, 'assets')).includes('source_financial_account_id'));
  const assetValsBefore = await checkValues(db, 'assets');
  check("anti-vacuity: assets.source_type CHECK lacks 'bank_statement_import' before 0214",
    Array.isArray(assetValsBefore) && !assetValsBefore.includes('bank_statement_import'), JSON.stringify(assetValsBefore));
  const expTargetBefore = await errorOf(db, `insert into fhip_import_proposals (user_id, target_domain, source_kind, target_entity_id, recommended_apply_mode) values ('${A}', 'expense', 'bank_statement', '${EXP_GROC_A}', 'update_existing')`);
  check('anti-vacuity: an expense proposal with a target cannot be stored before 0214 ("no implemented target guard")',
    expTargetBefore !== null && /no implemented target guard/.test(expTargetBefore), expTargetBefore ?? 'accepted');
  const fnsBefore = await one(db, `select count(*)::int n from pg_proc where proname in ('fdh15_apply_expense_proposals', 'fdh15_apply_asset_proposal')`);
  check('anti-vacuity: neither apply function exists before 0214', fnsBefore.n === 0);
  const ownerBodyBefore = (await one(db, `select prosrc from pg_proc where proname = 'fdh9_assert_proposal_owner'`)).prosrc;

  // ---------------- APPLY 0214 ----------------
  const applyErr = await errorOf(db, target);
  check('0214 applies cleanly on top of the real chain', applyErr === null, applyErr ?? '');

  // ---------------- Schema ----------------
  const expVals = await checkValues(db, 'expense_items');
  check("expense_items.source_type CHECK = {manual, bank_statement_average}", JSON.stringify([...expVals].sort()) === JSON.stringify(['bank_statement_average', 'manual']), JSON.stringify(expVals));
  const assetVals = await checkValues(db, 'assets');
  check('assets.source_type CHECK is a strict superset of the predecessor + bank_statement_import',
    assetValsBefore.every((v) => assetVals.includes(v)) && assetVals.includes('bank_statement_import') && assetVals.length === assetValsBefore.length + 1, JSON.stringify(assetVals));
  const existingRow = await one(db, `select source_type from expense_items where id = '${EXP_GROC_A}'`);
  check("existing expense rows read source_type = 'manual' (constant default)", existingRow.source_type === 'manual');
  const ownerBodyAfter = (await one(db, `select prosrc from pg_proc where proname = 'fdh9_assert_proposal_owner'`)).prosrc;
  for (const d of ['income', 'liability', 'retirement']) {
    check(`fdh9_assert_proposal_owner keeps its '${d}' branch`, ownerBodyBefore.includes(`target_domain = '${d}'`) && ownerBodyAfter.includes(`target_domain = '${d}'`));
  }
  const priv = await one(db, `select has_function_privilege('authenticated', 'fdh15_apply_one_expense_proposal(uuid, uuid, text, text[])', 'execute') inner_fn,
    has_function_privilege('authenticated', 'fdh15_apply_expense_proposals(jsonb)', 'execute') batch_fn,
    has_function_privilege('authenticated', 'fdh15_apply_asset_proposal(uuid, text, text[])', 'execute') asset_fn`);
  check('the per-proposal helper is NOT executable by authenticated; the two entry points are', priv.inner_fn === false && priv.batch_fn === true && priv.asset_fn === true, JSON.stringify(priv));

  // ---------------- Provenance cannot be forged ----------------
  const forgeExpUpd = await asUser(db, A, () => errorOf(db, `update expense_items set source_type = 'bank_statement_average' where id = '${EXP_GROC_A}'`));
  check('authenticated UPDATE of expense_items.source_type is refused', forgeExpUpd !== null && /provenance/.test(forgeExpUpd), forgeExpUpd ?? 'accepted');
  const forgeExpIns = await asUser(db, A, () => errorOf(db, `insert into expense_items (user_id, expense_name, expense_category, amount, frequency, currency_code, source_type) values ('${A}', 'X', 'other', 1, 'monthly', 'AUD', 'bank_statement_average')`));
  check('authenticated INSERT with source_type bank_statement_average is refused', forgeExpIns !== null && /provenance/.test(forgeExpIns), forgeExpIns ?? 'accepted');
  const ordinaryEdit = await asUser(db, A, () => errorOf(db, `update expense_items set notes = 'still editable' where id = '${EXP_GROC_A}'`));
  check('an ordinary user edit of an expense row is still allowed', ordinaryEdit === null, ordinaryEdit ?? '');
  const forgeAsset = await asUser(db, A, () => errorOf(db, `insert into assets (user_id, asset_name, asset_class, current_value, currency_code, source_financial_account_id) values ('${A}', 'X', 'cash', 1, 'AUD', '${ACC_A}')`));
  check('authenticated INSERT of an asset linked to a bank account is refused', forgeAsset !== null && /provenance/.test(forgeAsset), forgeAsset ?? 'accepted');
  const crossLink = await errorOf(db, `begin; select set_config('fhip.import_bridge_internal_write', 'true', true); update assets set source_financial_account_id = '${ACC_A}' where id = '${ASSET_B}'; commit;`);
  await db.exec('rollback').catch(() => {});
  check("even the internal path cannot link B's asset to A's bank account (same-tenant trigger)", crossLink !== null && /cross-tenant/.test(crossLink), crossLink ?? 'accepted');

  // ---------------- Cross-tenant proposals ----------------
  const crossTarget = await errorOf(db, `insert into fhip_import_proposals (user_id, target_domain, source_kind, target_entity_id, recommended_apply_mode) values ('${A}', 'expense', 'bank_statement', '${EXP_B}', 'update_existing')`);
  check("a proposal of A's targeting B's expense row is refused", crossTarget !== null && /cross-tenant/.test(crossTarget), crossTarget ?? 'accepted');
  const crossAssetTarget = await errorOf(db, `insert into fhip_import_proposals (user_id, target_domain, source_kind, target_entity_id, recommended_apply_mode) values ('${A}', 'asset', 'bank_statement', '${ASSET_B}', 'update_existing')`);
  check("a proposal of A's targeting B's asset is refused", crossAssetTarget !== null && /cross-tenant/.test(crossAssetTarget), crossAssetTarget ?? 'accepted');
  const crossSource = await errorOf(db, `insert into fhip_import_proposals (user_id, target_domain, source_kind, source_statement_upload_id, recommended_apply_mode) values ('${A}', 'asset', 'bank_statement', '${UP_B}', 'add_new')`);
  check("a proposal of A's sourced from B's statement is refused", crossSource !== null && /cross-tenant/.test(crossSource), crossSource ?? 'accepted');

  // ---------------- (a) Planned expenses from actual averages ----------------
  // Groceries: planned 800 monthly -> actual average 650. Restaurants: new, 120.
  const W = { windowFrom: '2026-06-01', windowTo: '2026-08-31' };
  const pGroc = await makeProposal(db, A, { domain: 'expense', target: EXP_GROC_A, mode: 'update_existing', ...W,
    fields: [['amount', 'money', '650.00', '800.00'], ['frequency', 'enum', 'monthly', 'monthly'], ['currency_code', 'enum', 'AUD', 'AUD']] });
  const pRest = await makeProposal(db, A, { domain: 'expense', mode: 'add_new', ...W,
    fields: [['expense_name', 'text', 'Restaurants'], ['master_item_key', 'text', 'restaurants'], ['expense_category', 'enum', 'food'], ['amount', 'money', '120.00'], ['frequency', 'enum', 'monthly'], ['currency_code', 'enum', 'AUD'], ['is_essential', 'bool', 'false']] });
  const snapshot = async () => (await db.query(`select master_item_key, amount::text, frequency, source_type, is_active from expense_items where user_id = '${A}' order by master_item_key`)).rows;

  // Batch atomicity: B cannot touch A's proposals.
  const foreign = await applyExpense(db, B, [{ proposal_id: pGroc, decision: 'update_existing' }]);
  check("user B applying A's proposal is PROPOSAL_NOT_FOUND and changes nothing", foreign.ok === false && foreign.code === 'PROPOSAL_NOT_FOUND' && (await status(db, pGroc)) === 'ready', JSON.stringify(foreign));

  // Batch rollback: a stale second decision rolls back the first.
  const pStale = await makeProposal(db, A, { domain: 'expense', target: EXP_GROC_A, mode: 'update_existing', ...W,
    fields: [['amount', 'money', '640.00', '799.00']] });
  const before1 = await snapshot();
  const rolled = await applyExpense(db, A, [{ proposal_id: pRest, decision: 'add_new' }, { proposal_id: pStale, decision: 'update_existing' }]);
  check('a batch whose 2nd decision is stale is refused as STALE_PROPOSAL with rolled_back=true', rolled.ok === false && rolled.code === 'STALE_PROPOSAL' && rolled.rolled_back === true, JSON.stringify(rolled));
  check('...and the 1st decision (add Restaurants) was rolled back: no row, proposal still ready',
    JSON.stringify(await snapshot()) === JSON.stringify(before1) && (await status(db, pRest)) === 'ready');
  const leak = await one(db, `select coalesce(current_setting('fhip.import_bridge_internal_write', true), '') v`);
  check('the internal-write flag does not leak after a rolled-back batch', leak.v !== 'true');

  // The real apply.
  const ok1 = await applyExpense(db, A, [{ proposal_id: pGroc, decision: 'update_existing' }, { proposal_id: pRest, decision: 'add_new' }]);
  check('the batch applies: 2 results', ok1.ok === true && ok1.results?.length === 2, JSON.stringify(ok1));
  const rows1 = await snapshot();
  const groc = rows1.find((r) => r.master_item_key === 'groceries');
  const rest = rows1.find((r) => r.master_item_key === 'restaurants');
  check('Groceries planned 800 -> 650 monthly, provenance bank_statement_average', groc?.amount === '650.00' && groc?.frequency === 'monthly' && groc?.source_type === 'bank_statement_average', JSON.stringify(groc));
  check('Restaurants added once at 120 monthly, provenance bank_statement_average', rest?.amount === '120.00' && rest?.source_type === 'bank_statement_average' && rest?.is_active === true, JSON.stringify(rest));
  const apps = await one(db, `select count(*)::int n from fhip_import_applications where proposal_id in ('${pGroc}', '${pRest}') and target_domain = 'expense'`);
  check('two application audit rows recorded', apps.n === 2);
  const txCount = await one(db, `select count(*)::int n from fdh_transactions`);
  check('no transaction was created or copied by the apply', txCount.n === 0);

  // Idempotent: repeat Apply.
  const again = await applyExpense(db, A, [{ proposal_id: pGroc, decision: 'update_existing' }]);
  check('repeat Apply is ALREADY_APPLIED and changes nothing', again.ok === false && again.code === 'ALREADY_APPLIED' && JSON.stringify(await snapshot()) === JSON.stringify(rows1), JSON.stringify(again));
  const dupBatch = await applyExpense(db, A, [{ proposal_id: pRest, decision: 'add_new' }, { proposal_id: pRest, decision: 'add_new' }]);
  check('the same proposal twice in one batch is refused', dupBatch.ok === false && dupBatch.code === 'INVALID_APPLY_MODE', JSON.stringify(dupBatch));

  // Stale add: a row for the item now exists.
  const pAddDup = await makeProposal(db, A, { domain: 'expense', mode: 'add_new', ...W,
    fields: [['expense_name', 'text', 'Groceries'], ['master_item_key', 'text', 'groceries'], ['amount', 'money', '600.00'], ['frequency', 'enum', 'monthly'], ['currency_code', 'enum', 'AUD']] });
  const staleAdd = await applyExpense(db, A, [{ proposal_id: pAddDup, decision: 'add_new' }]);
  check('adding an item that now exists is STALE_PROPOSAL (never a duplicate row)', staleAdd.ok === false && staleAdd.code === 'STALE_PROPOSAL', JSON.stringify(staleAdd));

  // Stale update: the user edited after generation.
  const pUpd = await makeProposal(db, A, { domain: 'expense', target: EXP_GROC_A, mode: 'update_existing', ...W, fields: [['amount', 'money', '700.00', '650.00']] });
  await asUser(db, A, () => db.exec(`update expense_items set amount = 655 where id = '${EXP_GROC_A}'`));
  const staleUpd = await applyExpense(db, A, [{ proposal_id: pUpd, decision: 'update_existing' }]);
  const afterStale = await one(db, `select amount::text a from expense_items where id = '${EXP_GROC_A}'`);
  check("an edit after generation makes the update STALE_PROPOSAL and keeps the user's 655", staleUpd.ok === false && staleUpd.code === 'STALE_PROPOSAL' && afterStale.a === '655.00', JSON.stringify(staleUpd));

  // Forbidden field.
  const pForge = await makeProposal(db, A, { domain: 'expense', target: EXP_GROC_A, mode: 'update_existing', ...W, fields: [['owner', 'enum', 'smsf', 'self']] });
  const forged = await applyExpense(db, A, [{ proposal_id: pForge, decision: 'update_existing' }]);
  check('a proposal field outside the allow-list (owner) is FORBIDDEN_FIELD', forged.ok === false && forged.code === 'FORBIDDEN_FIELD', JSON.stringify(forged));

  // Keep existing.
  const pKeep = await makeProposal(db, A, { domain: 'expense', target: EXP_GROC_A, mode: 'keep_existing', ...W, fields: [['amount', 'money', '655.00', '655.00']] });
  const kept = await applyExpense(db, A, [{ proposal_id: pKeep, decision: 'keep_existing' }]);
  check('keep_existing dismisses the proposal and writes nothing', kept.ok === true && (await status(db, pKeep)) === 'dismissed' && (await one(db, `select amount::text a from expense_items where id = '${EXP_GROC_A}'`)).a === '655.00', JSON.stringify(kept));

  // A user cannot mark their own proposal applied directly.
  const pDirect = await makeProposal(db, A, { domain: 'expense', target: EXP_GROC_A, mode: 'update_existing', ...W, fields: [['amount', 'money', '1.00', '655.00']] });
  const direct = await asUser(db, A, () => errorOf(db, `update fhip_import_proposals set status = 'applied', applied_at = now() where id = '${pDirect}'`));
  check('an authenticated direct status=applied is refused', direct !== null, direct ?? 'accepted');
  const srcForge = await asUser(db, A, () => errorOf(db, `update fhip_import_proposals set source_window_from = '2020-01-01' where id = '${pDirect}'`));
  check('an authenticated rewrite of a proposal source window is refused (authoritative)', srcForge !== null && /authoritative/.test(srcForge), srcForge ?? 'accepted');

  // ---------------- (b) Bank balance -> cash asset ----------------
  const assetFields = (value, name = 'Everyday A') => [['asset_name', 'text', name], ['asset_class', 'enum', 'cash'], ['current_value', 'money', value], ['currency_code', 'enum', 'AUD'], ['valuation_date', 'text', '2026-07-31'], ['owner', 'enum', 'joint']];
  const pForgedValue = await makeProposal(db, A, { domain: 'asset', mode: 'add_new', statement: UP_A1, fields: assetFields('9999.00') });
  const forgedValue = await applyAsset(db, A, pForgedValue);
  check('a balance that does not match the approved statement (9999 vs 5000) is refused', forgedValue.ok === false && forgedValue.code === 'FORBIDDEN_FIELD', JSON.stringify(forgedValue));
  const pAsset = await makeProposal(db, A, { domain: 'asset', mode: 'add_new', statement: UP_A1, fields: assetFields('5000.00') });
  const added = await applyAsset(db, A, pAsset);
  const assetRows = (await db.query(`select id, current_value::text v, asset_class, owner, source_type, source_financial_account_id a, valuation_date::text d from assets where user_id = '${A}' and is_active`)).rows;
  check('the closing balance becomes exactly one cash asset of 5000, linked to the account, owner joint (D-10)',
    added.ok === true && assetRows.length === 1 && assetRows[0].v === '5000.00' && assetRows[0].asset_class === 'cash' && assetRows[0].source_type === 'bank_statement_import' && assetRows[0].a === ACC_A && assetRows[0].owner === 'joint' && assetRows[0].d === '2026-07-31',
    JSON.stringify({ added, assetRows }));
  const againAsset = await applyAsset(db, A, pAsset);
  check('repeat Apply is ALREADY_APPLIED; still one asset', againAsset.ok === false && againAsset.code === 'ALREADY_APPLIED' && (await one(db, `select count(*)::int n from assets where user_id = '${A}' and is_active`)).n === 1, JSON.stringify(againAsset));
  const pSecondAdd = await makeProposal(db, A, { domain: 'asset', mode: 'add_new', statement: UP_A1, fields: assetFields('5000.00', 'Everyday A again') });
  const secondAdd = await applyAsset(db, A, pSecondAdd);
  check('a second add for the same account is STALE_PROPOSAL; still one asset (no double count)', secondAdd.ok === false && secondAdd.code === 'STALE_PROPOSAL' && (await one(db, `select count(*)::int n from assets where user_id = '${A}' and is_active`)).n === 1, JSON.stringify(secondAdd));
  const dupIndex = await errorOf(db, `begin; select set_config('fhip.import_bridge_internal_write', 'true', true); insert into assets (user_id, asset_name, asset_class, current_value, currency_code, source_financial_account_id) values ('${A}', 'dup', 'cash', 1, 'AUD', '${ACC_A}'); commit;`);
  await db.exec('rollback').catch(() => {});
  check('the unique index refuses a second active asset for one account even on the internal path', dupIndex !== null && /duplicate key|unique/i.test(dupIndex), dupIndex ?? 'accepted');
  const pCardStmt = await makeProposal(db, A, { domain: 'asset', mode: 'add_new', statement: UP_CARD, fields: assetFields('300.00') });
  const cardRes = await applyAsset(db, A, pCardStmt);
  check('a card-facility statement balance is never a cash asset (PROPOSAL_NOT_ACTIONABLE: ordinary bank account only)', cardRes.ok === false && cardRes.code === 'PROPOSAL_NOT_ACTIONABLE' && /ordinary bank account/.test(cardRes.error), JSON.stringify(cardRes));
  // The August statement's closing balance arrives (its reconciliation row).
  await db.exec(`insert into fdh_reconciliation_results (user_id, statement_upload_id, reported_closing_balance, currency_code) values ('${A}', '${UP_A2}', 6000, 'AUD')`);

  // Newer statement: the July proposal is now stale; an August update applies.
  const pOld = await makeProposal(db, A, { domain: 'asset', target: assetRows[0].id, mode: 'update_existing', statement: UP_A1, fields: [['current_value', 'money', '5000.00', '5000.00']] });
  const oldRes = await applyAsset(db, A, pOld, 'update_existing');
  check('a proposal from an older statement is STALE once a newer one is approved', oldRes.ok === false && oldRes.code === 'STALE_PROPOSAL', JSON.stringify(oldRes));
  const pNew = await makeProposal(db, A, { domain: 'asset', target: assetRows[0].id, mode: 'update_existing', statement: UP_A2,
    fields: [['current_value', 'money', '6000.00', '5000.00'], ['valuation_date', 'text', '2026-08-31', '2026-07-31']] });
  const newRes = await applyAsset(db, A, pNew, 'update_existing');
  const updated = await one(db, `select current_value::text v, valuation_date::text d, count(*) over ()::int n from assets where user_id = '${A}' and is_active`);
  check('the August statement updates the SAME asset to 6000 (never a second one)', newRes.ok === true && updated.v === '6000.00' && updated.d === '2026-08-31' && updated.n === 1, JSON.stringify({ newRes, updated }));
  const staleAsset = await makeProposal(db, A, { domain: 'asset', target: assetRows[0].id, mode: 'update_existing', statement: UP_A2, fields: [['current_value', 'money', '6000.00', '1.00']] });
  const staleAssetRes = await applyAsset(db, A, staleAsset, 'update_existing');
  check('an asset proposal whose snapshot no longer matches is STALE_PROPOSAL', staleAssetRes.ok === false && staleAssetRes.code === 'STALE_PROPOSAL', JSON.stringify(staleAssetRes));
  const bOnA = await applyAsset(db, B, pNew, 'update_existing');
  check("user B cannot apply A's asset proposal", bOnA.ok === false && bOnA.code === 'PROPOSAL_NOT_FOUND', JSON.stringify(bOnA));
  const userEditAsset = await asUser(db, A, () => errorOf(db, `update assets set current_value = 6100, notes = 'topped up' where id = '${assetRows[0].id}'`));
  check('the user can still edit the imported asset value directly (manual edit stays allowed)', userEditAsset === null, userEditAsset ?? '');
  const userUnlink = await asUser(db, A, () => errorOf(db, `update assets set source_financial_account_id = null where id = '${assetRows[0].id}'`));
  check('...but cannot unlink / relink its bank account directly', userUnlink !== null && /provenance/.test(userUnlink), userUnlink ?? 'accepted');

  // ---------------- Re-apply 0214: no-op ----------------
  const fp1 = await schemaFingerprint(db);
  const reErr = await errorOf(db, target);
  const fp2 = await schemaFingerprint(db);
  check('re-applying 0214 raises nothing', reErr === null, reErr ?? '');
  check('re-applying 0214 changes no constraint, index, trigger, function body or column', fp1 === fp2);
  check('re-apply leaves exactly one source_type CHECK on assets and on expense_items',
    (await one(db, `select count(*)::int n from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) where c.conrelid = 'assets'::regclass and c.contype = 'c' and a.attname = 'source_type'`)).n === 1
    && (await one(db, `select count(*)::int n from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) where c.conrelid = 'expense_items'::regclass and c.contype = 'c' and a.attname = 'source_type'`)).n === 1);
}

// ============================================================================
console.log('Case B -- sibling safety');
{
  const db = await replayUpToTarget();
  // (1) A sibling widened assets.source_type first.
  const live = await checkValues(db, 'assets');
  const conname = (await one(db, `select c.conname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) where c.conrelid = 'assets'::regclass and c.contype = 'c' and a.attname = 'source_type'`)).conname;
  await db.exec('begin');
  await db.exec(`alter table assets drop constraint ${conname}; alter table assets add constraint ${conname} check (source_type in (${[...live, 'sibling_only_value'].map((v) => `'${v}'`).join(', ')}));`);
  const e1 = await errorOf(db, target);
  const widened = await checkValues(db, 'assets');
  check('with a sibling value already live, 0214 applies', e1 === null, e1 ?? '');
  check("...and the sibling's value survives (widen by union, nothing revoked)", widened.includes('sibling_only_value') && widened.includes('bank_statement_import') && live.every((v) => widened.includes(v)), JSON.stringify(widened));
  await db.exec('rollback');

  // (2) A sibling added a target_domain branch to a shared guard function.
  await db.exec('begin');
  const body = (await one(db, `select pg_get_functiondef(oid) d from pg_proc where proname = 'fdh9_assert_application_owner'`)).d;
  const siblingBody = body.replace(`elsif new.target_domain = 'retirement' then`, `elsif new.target_domain = 'investment' then\n    null;\n  elsif new.target_domain = 'retirement' then`);
  check('setup: the sibling body really differs', siblingBody !== body);
  await db.exec(siblingBody);
  const e2 = await errorOf(db, target);
  check("0214 REFUSES to apply rather than delete a sibling's 'investment' branch", e2 !== null && /revocation guard/.test(e2) && /investment/.test(e2), e2 ?? 'applied');
  await db.exec('rollback');

  // (3) A sibling added a source column to the proposal owner trigger's column list.
  await db.exec('begin');
  await db.exec(`alter table fhip_import_proposals add column sibling_source_id uuid;
    drop trigger trg_fhip_import_proposals_owner on fhip_import_proposals;
    create trigger trg_fhip_import_proposals_owner before insert or update of user_id, sibling_source_id, target_entity_id on fhip_import_proposals for each row execute function fdh9_assert_proposal_owner();`);
  const e3 = await errorOf(db, target);
  check("0214 REFUSES to drop a sibling's trigger column", e3 !== null && /revocation guard/.test(e3) && /sibling_source_id/.test(e3), e3 ?? 'applied');
  await db.exec('rollback');
  check('after the refusals the database is unchanged (no 0214 objects)', (await one(db, `select count(*)::int n from pg_proc where proname like 'fdh15_%'`)).n === 0);
}

const total = pass + fail;
console.log(`\n=== canonical 0214 PGlite verification: ${pass} PASS, ${fail} FAIL (${total} checks) ===`);
if (total < 50) { console.error(`expected at least 50 checks, ran ${total}`); process.exit(2); }
process.exit(fail === 0 ? 0 : 1);
