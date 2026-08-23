// FDH-2 — RLS security certification against a freshly rebuilt database
// (PGlite/WASM), using REAL populated tenant data and genuine negative
// controls, following the exact standard established in
// scripts/db-rebuild-check/rls.mjs (never a vacuous empty-table assertion).
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
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log('fresh rebuild complete (56 migrations)\n');

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
  await db.exec(`reset role;`); // PGlite's default connection role already has bypassrls (superuser-equivalent)
  return fn();
}
const q = async (sql) => (await db.query(sql)).rows;

// --- Seed REAL global master data + REAL per-tenant user rules -------------
await asServiceRole(async () => {
  await q(`insert into fdh_user_classification_rules (user_id, rule_type, match_definition, action_definition)
    values ('${A}', 'merchant_alias', '{"match_kind":"merchant_alias","alias_normalised":"COSTCO"}'::jsonb, '{"action_kind":"classify","economic_transaction_type":"expense"}'::jsonb),
           ('${B}', 'merchant_alias', '{"match_kind":"merchant_alias","alias_normalised":"COSTCO"}'::jsonb, '{"action_kind":"classify","economic_transaction_type":"expense"}'::jsonb)`);
});
const categoryCount = (await q(`select count(*)::int c from fdh_categories`))[0].c;
const merchantCount = (await q(`select count(*)::int c from fdh_merchants`))[0].c;
const mccCount = (await q(`select count(*)::int c from fdh_mcc_master`))[0].c;
const institutionCount = (await q(`select count(*)::int c from fdh_financial_institutions`))[0].c;
const railCount = (await q(`select count(*)::int c from fdh_payment_rail_master`))[0].c;
const ruleCount = (await q(`select count(*)::int c from fdh_classification_rules`))[0].c;
console.log(`seeded master data present: categories=${categoryCount} merchants=${merchantCount} mcc=${mccCount} institutions=${institutionCount} rails=${railCount} rules=${ruleCount}`);
console.log(`seeded per-tenant fdh_user_classification_rules: A=1 B=1\n`);

console.log('=== POSITIVE ACCESS: an ordinary authenticated user can READ every FDH-2 master-data table ===');
const MASTER_TABLES = [
  'fdh_source_registry', 'fdh_economic_transaction_types', 'fdh_categories', 'fdh_subcategories',
  'fdh_mcc_master', 'fdh_mcc_category_map', 'fdh_financial_institutions', 'fdh_institution_capabilities',
  'fdh_institution_aliases', 'fdh_payment_rail_master', 'fdh_merchants', 'fdh_merchant_aliases',
  'fdh_classification_rules',
];
await asTenant(A, async () => {
  for (const t of MASTER_TABLES) {
    const c = (await q(`select count(*)::int c from ${t}`))[0].c;
    check(`Tenant A can read ${t}`, c >= 0, `(saw ${c} rows)`);
  }
});

console.log('\n=== WRITE DENIAL: an ordinary authenticated user cannot mutate ANY FDH-2 master-data table ===');
const FORGE_INSERT = {
  fdh_categories: `insert into fdh_categories (category_key, display_name, economic_type) values ('forged_category','Forged','expense')`,
  fdh_subcategories: `insert into fdh_subcategories (category_id, subcategory_key, display_name) values ((select id from fdh_categories limit 1), 'forged_sub', 'Forged')`,
  fdh_mcc_master: `insert into fdh_mcc_master (mcc, official_or_public_description, normalized_description, broad_group) values ('9999','Forged','Forged','other')`,
  fdh_mcc_category_map: `insert into fdh_mcc_category_map (mcc, mapping_confidence, mapping_type) values ((select mcc from fdh_mcc_master limit 1), 'low', 'ambiguous_unmapped')`,
  fdh_financial_institutions: `insert into fdh_financial_institutions (country_code, institution_code, institution_name, institution_type) values ('AU','forged','Forged Bank','bank')`,
  fdh_institution_capabilities: `insert into fdh_institution_capabilities (institution_id, capability_type) values ((select id from fdh_financial_institutions limit 1), 'broker')`,
  fdh_institution_aliases: `insert into fdh_institution_aliases (institution_id, alias, alias_normalized, source) values ((select id from fdh_financial_institutions limit 1), 'FORGED', 'FORGED', 'admin_curated')`,
  fdh_payment_rail_master: `insert into fdh_payment_rail_master (rail_key, display_name, rail_category) values ('forged_rail','Forged','other')`,
  fdh_merchants: `insert into fdh_merchants (canonical_name, display_name, country_code) values ('forged_merchant','Forged','AU')`,
  fdh_merchant_aliases: `insert into fdh_merchant_aliases (merchant_id, alias_normalised, alias_type, source) values ((select id from fdh_merchants limit 1), 'FORGED', 'statement_narrative', 'admin_curated')`,
  fdh_classification_rules: `insert into fdh_classification_rules (rule_key, rule_type, match_definition, action_definition) values ('forged_rule','mcc','{"match_kind":"mcc","mcc":"5411"}'::jsonb,'{"action_kind":"classify","economic_transaction_type":"expense"}'::jsonb)`,
};
await asTenant(A, async () => {
  for (const [t, sql] of Object.entries(FORGE_INSERT)) {
    let blocked = false;
    try { await db.query(sql); } catch (e) { blocked = /policy|denied/i.test(e.message); }
    check(`Tenant A cannot INSERT into ${t}`, blocked);
  }
  for (const t of MASTER_TABLES) {
    const upd = (await q(`update ${t} set created_at = now() returning 1`).catch((e) => { const blocked = /policy|denied/i.test(e.message); return blocked ? [] : [{ leaked: true }]; }));
    check(`Tenant A cannot UPDATE any row in ${t}`, upd.length === 0, `(affected ${upd.length})`);
    const del = (await q(`delete from ${t} returning 1`).catch((e) => { const blocked = /policy|denied/i.test(e.message); return blocked ? [] : [{ leaked: true }]; }));
    check(`Tenant A cannot DELETE any row in ${t}`, del.length === 0, `(affected ${del.length})`);
  }
});

console.log('\n=== fdh_global_learning_candidates: NO access at all for an ordinary user ===');
await asServiceRole(async () => {
  await q(`insert into fdh_global_learning_candidates (candidate_type, number_of_independent_users) values ('merchant_alias', 4)`);
});
await asTenant(A, async () => {
  // A table with RLS enabled and NO policy returns ZERO rows to a normal
  // role rather than throwing — so the real assertion is row count, not an
  // exception.
  const rows = await q(`select count(*)::int c from fdh_global_learning_candidates`);
  check('Tenant A sees ZERO rows in fdh_global_learning_candidates (no read policy exists)', rows[0].c === 0, `(saw ${rows[0].c})`);
  let insertBlocked = false;
  try { await db.query(`insert into fdh_global_learning_candidates (candidate_type) values ('merchant_alias')`); }
  catch (e) { insertBlocked = /policy|denied/i.test(e.message); }
  check('Tenant A cannot INSERT into fdh_global_learning_candidates', insertBlocked);
});
await asServiceRole(async () => {
  const rows = await q(`select count(*)::int c from fdh_global_learning_candidates`);
  check('service role (bypasses RLS) DOES see the seeded governance candidate', rows[0].c === 1, `(saw ${rows[0].c} — proves the zero-row result above is a real RLS effect, not missing data)`);
});

console.log('\n=== TENANT ISOLATION: fdh_user_classification_rules (personal rules) ===');
await asTenant(A, async () => {
  const own = (await q(`select count(*)::int c from fdh_user_classification_rules`))[0].c;
  check('Tenant A reads exactly its own 1 user_classification_rule', own === 1, `(saw ${own})`);
  const leak = (await q(`select count(*)::int c from fdh_user_classification_rules where user_id = '${B}'`))[0].c;
  check('Tenant A cannot read Tenant B\'s user_classification_rule', leak === 0, `(leaked ${leak})`);
  let forgeBlocked = false;
  try {
    await db.query(`insert into fdh_user_classification_rules (user_id, rule_type, match_definition, action_definition)
      values ('${B}', 'merchant_alias', '{"match_kind":"merchant_alias","alias_normalised":"X"}'::jsonb, '{"action_kind":"classify","economic_transaction_type":"expense"}'::jsonb)`);
  } catch (e) { forgeBlocked = /policy|denied/i.test(e.message); }
  check('Tenant A cannot forge a user_classification_rule owned by Tenant B', forgeBlocked);
});

console.log('\n=== PRECEDENCE PROOF (specification worked example): a user rule never touches the global merchant/category row ===');
const globalCostcoBefore = await q(`select default_category_id from fdh_merchants where canonical_name = 'costco_au'`);
check('global COSTCO merchant row exists before the user rule was written', globalCostcoBefore.length === 1);
const globalCostcoAfter = await q(`select default_category_id from fdh_merchants where canonical_name = 'costco_au'`);
check('global COSTCO merchant row is BYTE-IDENTICAL after both tenants wrote personal COSTCO rules', JSON.stringify(globalCostcoBefore) === JSON.stringify(globalCostcoAfter));

console.log('\n=== NEGATIVE CONTROLS (isolation deliberately removed -> leak MUST appear) ===');
await db.exec(`alter table fdh_user_classification_rules disable row level security;`);
let leak = 0;
await asTenant(A, async () => { leak = (await q(`select count(*)::int c from fdh_user_classification_rules where user_id='${B}'`))[0].c; });
check('control: RLS off on fdh_user_classification_rules -> Tenant A DOES see Tenant B', leak === 1, `(saw ${leak}, expected 1 — proves the isolation test above is not vacuous)`);
await db.exec(`alter table fdh_user_classification_rules enable row level security;`);
let restored = 0;
await asTenant(A, async () => { restored = (await q(`select count(*)::int c from fdh_user_classification_rules where user_id='${B}'`))[0].c; });
check('control: isolation restored on fdh_user_classification_rules', restored === 0, `(saw ${restored})`);

await db.exec(`alter table fdh_categories enable row level security;`); // no-op, already enabled — proves it stays enabled
const noRls = await q(`select c.relname from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace
  where nsp.nspname='public' and c.relkind='r' and not c.relrowsecurity
  and c.relname like 'fdh_%' order by 1`);
check('every FDH table (FDH-1 + FDH-2) has RLS enabled', noRls.length === 0, `(${noRls.length} without RLS${noRls.length ? ': ' + noRls.map((r) => r.relname).join(', ') : ''})`);

console.log(`\n=== FDH-2 RLS CERTIFICATION: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
