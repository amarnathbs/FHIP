// FDH-10 — RLS + same-tenant-referential-integrity + authoritative-write
// hardening certification against a freshly rebuilt database (PGlite/WASM),
// using REAL populated tenant data and genuine negative controls, following
// the exact standard established in scripts/fdh3_rls_certification.mjs.
//
// DISCLOSED BASELINE EXCLUSION: migrations 0094/0095 are skipped in this
// rebuild. Both are already-live-in-production authoritative-forgery
// hotfixes (see hard rule 6 of this dispatch) whose OWN migration files
// fail to replay cleanly against a from-scratch PGlite rebuild for a
// reason entirely unrelated to FDH-10 (a pre-existing "policy already
// exists" ordering issue reproduced and confirmed BEFORE any FDH-10 code
// was written — see the FDH-10 completion report). Excluding them here
// tests FDH-10's own schema against the same effective shape those two
// hotfixes represent (0092's schema, since 0093 is reserved by an unmerged
// sibling branch and 0094/0095 make no schema change FDH-10 depends on).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIG = path.join(REPO, 'supabase', 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(REPO, 'scripts', 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(REPO, 'supabase', 'seed.sql'), 'utf8');
const SKIP = new Set(['0094_ii_holding_snapshots_authoritative_forgery_hotfix.sql', '0095_goal_funding_sources_authoritative_forgery_hotfix.sql']);
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql') && !SKIP.has(f)).sort();
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete (${files.length} migrations, 0094/0095 excluded as disclosed)\n`);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid} — tests would be vacuous`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asServiceRole(fn) {
  await db.exec(`reset role;`);
  return fn();
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
async function expectError(fn, label) {
  try { await fn(); check(label, false, '(expected an error, none raised)'); }
  catch (e) { check(label, true, `(${String(e.message || e).slice(0, 90)})`); }
}

// --- Seed one liability per tenant, and one FX bank transaction per tenant --
let liabA, liabB, accA, txnA, txnB;
await asServiceRole(async () => {
  const l1 = await q(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner)
    values ('${A}', 'Tenant A Card', 'credit_card', 1200, 'AUD', 'self') returning id`);
  liabA = l1[0].id;
  const l2 = await q(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner)
    values ('${B}', 'Tenant B Card', 'credit_card', 900, 'AUD', 'self') returning id`);
  liabB = l2[0].id;

  const inst = await q(`select id from fdh_financial_institutions limit 1`);
  const instId = inst[0]?.id ?? null;
  const acc1 = await q(`insert into fdh_financial_accounts (user_id, institution_id, account_type, country_code, currency_code, display_name)
    values ('${A}', $1, 'credit_card', 'AU', 'AUD', 'A Card') returning id`, [instId]);
  accA = acc1[0].id;
  const accB1 = await q(`insert into fdh_financial_accounts (user_id, institution_id, account_type, country_code, currency_code, display_name)
    values ('${B}', $1, 'transaction', 'AU', 'AUD', 'B Transaction') returning id`, [instId]);
  const accBId = accB1[0].id;

  const t1 = await q(`insert into fdh_transactions (user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
    values ('${A}', '${accA}', '2026-08-10', 200, 'AUD', 'debit', 'transfer') returning id`);
  txnA = t1[0].id;
  const t2 = await q(`insert into fdh_transactions (user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
    values ('${B}', '${accBId}', '2026-08-10', 200, 'AUD', 'debit', 'transfer') returning id`);
  txnB = t2[0].id;
});
console.log(`seeded liabilities A=${liabA} B=${liabB}; bank txns A=${txnA} B=${txnB}\n`);

// === 1. TENANT ISOLATION on the two new FDH-10 tables ======================
console.log('=== TENANT ISOLATION: fdh_liability_statements / fdh_liability_statement_activities ===');
let stmtA, activityA;
await asTenant(A, async () => {
  const s = await q(`insert into fdh_liability_statements (user_id, liability_id, statement_type, facility_type, currency_code)
    values ('${A}', '${liabA}', 'credit_card', 'credit_card', 'AUD') returning id`);
  stmtA = s[0].id;
  const act = await q(`insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code)
    values ('${A}', '${stmtA}', 'PURCHASE', '2026-08-05', 200, 'AUD') returning id`);
  activityA = act[0].id;
  check('Tenant A can create its own liability statement + activity', Boolean(stmtA) && Boolean(activityA));
});
await asTenant(B, async () => {
  const leakStmt = await q(`select count(*)::int c from fdh_liability_statements where user_id = '${A}'`);
  check("Tenant B cannot read Tenant A's liability statement", leakStmt[0].c === 0, `(leaked ${leakStmt[0].c})`);
  const leakAct = await q(`select count(*)::int c from fdh_liability_statement_activities where user_id = '${A}'`);
  check("Tenant B cannot read Tenant A's statement activity", leakAct[0].c === 0, `(leaked ${leakAct[0].c})`);
});

// === 2. FORGED LIABILITY TARGET (spec section 91) ===========================
console.log('\n=== FORGED LIABILITY TARGET: Tenant A statement pointing at Tenant B\'s liability ===');
await asTenant(A, async () => {
  await expectError(
    () => q(`insert into fdh_liability_statements (user_id, liability_id, statement_type, facility_type, currency_code)
      values ('${A}', '${liabB}', 'credit_card', 'credit_card', 'AUD') returning id`),
    "cross-tenant liability_id on fdh_liability_statements is rejected at the DB boundary",
  );
});

// === 3. FORGED BANK MATCH (spec section 92) =================================
console.log('\n=== FORGED BANK MATCH: Tenant A activity linking to Tenant B\'s bank transaction ===');
await asTenant(A, async () => {
  await expectError(
    () => q(`insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code, linked_transaction_id, bank_match_status)
      values ('${A}', '${stmtA}', 'PAYMENT', '2026-08-10', 200, 'AUD', '${txnB}', 'matched') returning id`),
    "cross-tenant linked_transaction_id is rejected at the DB boundary",
  );
});
await asTenant(A, async () => {
  const ok = await q(`insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code, linked_transaction_id, bank_match_status)
    values ('${A}', '${stmtA}', 'PAYMENT', '2026-08-10', 200, 'AUD', '${txnA}', 'matched') returning id`);
  check('Same-tenant bank match link succeeds (positive control, proves the negative control above is real)', ok.length === 1);
});

// === 4. AUTHORITATIVE-FIELD FORGERY (spec section 89) =======================
console.log('\n=== AUTHORITATIVE-FIELD FORGERY: direct client UPDATE of system-derived fields ===');
await asTenant(A, async () => {
  await expectError(
    () => q(`update fdh_liability_statements set reconciliation_status = 'reconciled' where id = '${stmtA}'`),
    'direct UPDATE of reconciliation_status is refused by the authoritative-write trigger',
  );
  await expectError(
    () => q(`update fdh_liability_statement_activities set bank_match_status = 'matched' where id = '${activityA}'`),
    'direct UPDATE of bank_match_status is refused by the authoritative-write trigger',
  );
  await expectError(
    () => q(`update liabilities set source_type = 'liability_statement_import' where id = '${liabA}'`),
    'direct UPDATE of liabilities.source_type (provenance) is refused by the authoritative-write trigger',
  );
});
await asTenant(A, async () => {
  const ok = await q(`update liabilities set balance = 1300 where id = '${liabA}' returning id`);
  check('an ordinary user-editable liability field (balance) remains directly writable (spec section 129, manual edit unaffected)', ok.length === 1);
});

// === 5. THE ATOMIC LIABILITY APPLY RPC ======================================
console.log('\n=== ATOMIC APPLY RPC: fdh10_apply_liability_proposal ===');
let proposalId;
await asTenant(A, async () => {
  const p = await q(`insert into fhip_import_proposals (user_id, target_domain, source_kind, currency_code, recommended_apply_mode, status)
    values ('${A}', 'liability', 'credit_card_statement', 'AUD', 'update_existing', 'ready') returning id`);
  proposalId = p[0].id;
});
await asServiceRole(async () => {
  // target_entity_id/target_entity_updated_at are authoritative per the D.1
  // trigger widened in 0096 — set them the same way the real proposal-
  // generation code path does: via the internal-write GUC, exactly as
  // persistProposal()/supabaseStore.ts do in application code.
  // Combined into ONE exec (one implicit transaction) so the
  // transaction-local GUC set by the first statement is still visible to
  // the statements after it — exactly the single-transaction shape the
  // real fdh10_apply_liability_proposal() RPC itself runs under.
  await db.exec(`
    select set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set target_entity_id = '${liabA}', target_entity_updated_at = null where id = '${proposalId}';
    insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, reason_code)
      values ('${A}', '${proposalId}', 'balance', 'money', '1500.00', '1300.00', true, false, 'test');
  `);
});
await asTenant(A, async () => {
  const result = await q(`select fdh10_apply_liability_proposal('${proposalId}'::uuid, 'update_existing', null) as r`);
  const r = result[0].r;
  check('RPC apply succeeds and updates the liability balance', r.ok === true && r.outcome === 'applied', JSON.stringify(r));
  const live = await q(`select balance from liabilities where id = '${liabA}'`);
  check('liability balance genuinely updated to 1500.00', Number(live[0].balance) === 1500);

  const second = await q(`select fdh10_apply_liability_proposal('${proposalId}'::uuid, 'update_existing', null) as r`);
  check('DUPLICATE APPLY is refused (ALREADY_APPLIED), not a second mutation', second[0].r.ok === false && second[0].r.code === 'ALREADY_APPLIED', JSON.stringify(second[0].r));

  const appCount = await q(`select count(*)::int c from fhip_import_applications where proposal_id = '${proposalId}'`);
  check('exactly one application record exists', appCount[0].c === 1, `(saw ${appCount[0].c})`);
});

console.log('\n=== CROSS-TENANT APPLY: Tenant B cannot apply Tenant A\'s proposal ===');
let proposalA2;
await asTenant(A, async () => {
  const p = await q(`insert into fhip_import_proposals (user_id, target_domain, source_kind, currency_code, recommended_apply_mode, status)
    values ('${A}', 'liability', 'credit_card_statement', 'AUD', 'update_existing', 'ready') returning id`);
  proposalA2 = p[0].id;
});
await asServiceRole(async () => {
  await db.exec(`
    select set_config('fhip.import_bridge_internal_write', 'true', true);
    update fhip_import_proposals set target_entity_id = '${liabA}' where id = '${proposalA2}';
    insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, reason_code)
      values ('${A}', '${proposalA2}', 'balance', 'money', '1600.00', '1500.00', true, false, 'test');
  `);
});
await asTenant(B, async () => {
  const result = await q(`select fdh10_apply_liability_proposal('${proposalA2}'::uuid, 'update_existing', null) as r`);
  check("Tenant B's call against Tenant A's proposal returns PROPOSAL_NOT_FOUND, no data leak", result[0].r.ok === false && result[0].r.code === 'PROPOSAL_NOT_FOUND', JSON.stringify(result[0].r));
});
await asServiceRole(async () => {
  const live = await q(`select balance from liabilities where id = '${liabA}'`);
  check("Tenant A's liability balance is untouched by Tenant B's attempt", Number(live[0].balance) === 1500);
});

console.log('\n=== STALE PROPOSAL: liability edited after proposal generation is not silently overwritten ===');
await asTenant(A, async () => {
  await q(`update liabilities set balance = 1550 where id = '${liabA}'`); // user manually edits after proposal generated
  const result = await q(`select fdh10_apply_liability_proposal('${proposalA2}'::uuid, 'update_existing', null) as r`);
  check('stale apply is refused (STALE_PROPOSAL)', result[0].r.ok === false && result[0].r.code === 'STALE_PROPOSAL', JSON.stringify(result[0].r));
  const live = await q(`select balance from liabilities where id = '${liabA}'`);
  check('liability balance remains the manually-edited value, not silently overwritten', Number(live[0].balance) === 1550);
});

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) process.exit(1);
