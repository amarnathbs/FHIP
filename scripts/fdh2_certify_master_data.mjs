// FDH-2 — master-data certification: clean rebuild + idempotent re-seed +
// data-quality validation, all against a real PostgreSQL (PGlite/WASM),
// never against production or shared DEV.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIG = path.join(REPO, 'supabase', 'migrations');
const SHIM = path.join(REPO, 'scripts', 'db-rebuild-check', 'shim.sql');
const SEED = path.join(REPO, 'supabase', 'seed.sql');

const FDH2_SEED_FILES = [
  '0053_fdh2_taxonomy_and_mcc_seed.sql',
  '0054_fdh2_institution_and_payment_rail_seed.sql',
  '0055_fdh2_merchant_seed.sql',
  '0056_fdh2_classification_rule_seed.sql',
];

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' ' + detail : ''}`); }
};

async function freshRebuild() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(SEED, 'utf8');
  for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}

const q = async (db, sql) => (await db.query(sql)).rows;
const count = async (db, table) => (await q(db, `select count(*)::int c from ${table}`))[0].c;

console.log('=== FDH-2 MASTER-DATA CERTIFICATION ===\n');

console.log('--- Clean rebuild #1 ---');
const db1 = await freshRebuild();
console.log('rebuild complete\n');

const TABLES = [
  'fdh_source_registry', 'fdh_economic_transaction_types', 'fdh_categories', 'fdh_subcategories',
  'fdh_mcc_master', 'fdh_mcc_category_map', 'fdh_financial_institutions', 'fdh_institution_capabilities',
  'fdh_institution_aliases', 'fdh_payment_rail_master', 'fdh_merchants', 'fdh_merchant_aliases',
  'fdh_classification_rules', 'fdh_global_learning_candidates',
];

console.log('--- Row counts (rebuild #1) ---');
const counts1 = {};
for (const t of TABLES) { counts1[t] = await count(db1, t); console.log(`  ${t}: ${counts1[t]}`); }

console.log('\n--- FDH-2-scoped row counts by country (sanity) ---');
console.log(`  categories with AU applicability: ${(await q(db1, `select count(*)::int c from fdh_categories where 'AU' = any(country_applicability)`))[0].c}`);
console.log(`  categories with IN applicability: ${(await q(db1, `select count(*)::int c from fdh_categories where 'IN' = any(country_applicability)`))[0].c}`);
console.log(`  merchants AU: ${(await q(db1, `select count(*)::int c from fdh_merchants where country_code='AU'`))[0].c}`);
console.log(`  merchants IN: ${(await q(db1, `select count(*)::int c from fdh_merchants where country_code='IN'`))[0].c}`);
console.log(`  institutions AU: ${(await q(db1, `select count(*)::int c from fdh_financial_institutions where country_code='AU'`))[0].c}`);
console.log(`  institutions IN: ${(await q(db1, `select count(*)::int c from fdh_financial_institutions where country_code='IN'`))[0].c}`);

console.log('\n=== IDEMPOTENCY: re-run the 4 FDH-2 seed migrations a second time ===');
for (const f of FDH2_SEED_FILES) {
  await db1.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
}
console.log('re-applied\n');
console.log('--- Row counts after second application (must be identical) ---');
for (const t of TABLES) {
  const c2 = await count(db1, t);
  check(`${t} row count unchanged after re-seed`, c2 === counts1[t], `(before=${counts1[t]} after=${c2})`);
}

console.log('\n=== STABLE-KEY CHECK: no duplicate stable keys anywhere ===');
check('no duplicate category_key', (await q(db1, `select category_key, count(*) c from fdh_categories group by category_key having count(*) > 1`)).length === 0);
check('no duplicate (category_id, subcategory_key)', (await q(db1, `select category_id, subcategory_key, count(*) c from fdh_subcategories group by category_id, subcategory_key having count(*) > 1`)).length === 0);
check('no duplicate mcc', (await q(db1, `select mcc, count(*) c from fdh_mcc_master group by mcc having count(*) > 1`)).length === 0);
check('no duplicate (country_code, institution_code)', (await q(db1, `select country_code, institution_code, count(*) c from fdh_financial_institutions group by country_code, institution_code having count(*) > 1`)).length === 0);
check('no duplicate (country_code, canonical_name) merchant', (await q(db1, `select country_code, canonical_name, count(*) c from fdh_merchants where country_code is not null group by country_code, canonical_name having count(*) > 1`)).length === 0);
check('no duplicate rule_key', (await q(db1, `select rule_key, count(*) c from fdh_classification_rules group by rule_key having count(*) > 1`)).length === 0);
check('no duplicate rail_key', (await q(db1, `select rail_key, count(*) c from fdh_payment_rail_master group by rail_key having count(*) > 1`)).length === 0);

console.log('\n=== ORPHAN / REFERENTIAL-INTEGRITY CHECKS (beyond FK enforcement) ===');
check('no MCC mapping references a non-existent category', (await q(db1, `select 1 from fdh_mcc_category_map m where m.category_id is not null and not exists (select 1 from fdh_categories c where c.id = m.category_id)`)).length === 0);
check('no subcategory-level MCC mapping without its parent category', (await q(db1, `select 1 from fdh_mcc_category_map where subcategory_id is not null and category_id is null`)).length === 0);
check('no ambiguous MCC mapping carries a subcategory', (await q(db1, `select 1 from fdh_mcc_category_map where ambiguity_flag = true and subcategory_id is not null`)).length === 0);
check('no ambiguous_unmapped MCC mapping carries a category', (await q(db1, `select 1 from fdh_mcc_category_map where mapping_type = 'ambiguous_unmapped' and category_id is not null`)).length === 0);
check('no merchant default_subcategory without default_category', (await q(db1, `select 1 from fdh_merchants where default_subcategory_id is not null and default_category_id is null`)).length === 0);
check('no merchant mcc_confidence without an mcc', (await q(db1, `select 1 from fdh_merchants where mcc_confidence is not null and mcc is null`)).length === 0);
check('every merchant.mcc (where set) exists in fdh_mcc_master', (await q(db1, `select 1 from fdh_merchants where mcc is not null and mcc not in (select mcc from fdh_mcc_master)`)).length === 0);
check('every category.source_key (where set) exists in fdh_source_registry', (await q(db1, `select 1 from fdh_categories where source_key is not null and source_key not in (select source_key from fdh_source_registry)`)).length === 0);
check('every institution.source_key (where set) exists in fdh_source_registry', (await q(db1, `select 1 from fdh_financial_institutions where source_key is not null and source_key not in (select source_key from fdh_source_registry)`)).length === 0);
check('every merchant.source_key (where set) exists in fdh_source_registry', (await q(db1, `select 1 from fdh_merchants where source_key is not null and source_key not in (select source_key from fdh_source_registry)`)).length === 0);
check('every mcc_master.source_key (where set) exists in fdh_source_registry', (await q(db1, `select 1 from fdh_mcc_master where source_key is not null and source_key not in (select source_key from fdh_source_registry)`)).length === 0);
check('every classification rule references a valid economic_transaction_type where present', (await q(db1, `select 1 from fdh_classification_rules where action_definition->>'economic_transaction_type' is not null and action_definition->>'economic_transaction_type' not in (select economic_type from fdh_economic_transaction_types)`)).length === 0);
check('every classify-action rule with a category_id resolves to a real category', (await q(db1, `select 1 from fdh_classification_rules where action_definition->>'action_kind' = 'classify' and action_definition ? 'category_id' and not exists (select 1 from fdh_categories c where c.id::text = action_definition->>'category_id')`)).length === 0);
check('every payment_rail_narrative rule references a real payment rail', (await q(db1, `select 1 from fdh_classification_rules where rule_type = 'payment_rail_narrative' and (match_definition->>'rail_key') not in (select rail_key from fdh_payment_rail_master)`)).length === 0);

console.log('\n=== FORMAT / DOMAIN CHECKS ===');
check('every MCC is exactly 4 digits', (await q(db1, `select 1 from fdh_mcc_master where mcc !~ '^[0-9]{4}$'`)).length === 0);
check('every fdh_categories.category_key is snake_case', (await q(db1, `select 1 from fdh_categories where category_key !~ '^[a-z0-9]+(_[a-z0-9]+)*$'`)).length === 0);
check('every institution has coverage_status = master_only (FDH-2 seeds only this status)', (await q(db1, `select 1 from fdh_financial_institutions where coverage_status <> 'master_only'`)).length === 0);
check('no institution masked_identifier-style full account number anywhere in aliases', (await q(db1, `select 1 from fdh_institution_aliases where alias ~ '[0-9]{7,}'`)).length === 0);
check('no merchant alias looks like a full account/phone number (7+ consecutive digits)', (await q(db1, `select 1 from fdh_merchant_aliases where alias_normalised ~ '[0-9]{7,}'`)).length === 0);

console.log('\n=== ALIAS COLLISION CHECKS (specification section 55-64: "make ambiguity explicit, never silently pick one") ===');
const merchantAliasCollisions = await q(db1, `
  select alias_normalised, country_code, count(distinct merchant_id) n
  from fdh_merchant_aliases group by alias_normalised, country_code having count(distinct merchant_id) > 1`);
check('no merchant alias (same country) maps to two different merchants', merchantAliasCollisions.length === 0, `(${merchantAliasCollisions.length} collisions${merchantAliasCollisions.length ? ': ' + JSON.stringify(merchantAliasCollisions) : ''})`);
const institutionAliasCollisions = await q(db1, `
  select alias_normalized, count(distinct institution_id) n
  from fdh_institution_aliases group by alias_normalized having count(distinct institution_id) > 1`);
check('no institution alias maps to two different institutions', institutionAliasCollisions.length === 0, `(${institutionAliasCollisions.length} collisions${institutionAliasCollisions.length ? ': ' + JSON.stringify(institutionAliasCollisions) : ''})`);

console.log('\n=== PII / PERSONAL-PAYEE GUARD (specification section 29-37) ===');
console.log('  NOTE: the personal-payee heuristic itself lives in');
console.log('  lib/financial-data-hub/domain/personalPayeeGuard.ts with its own');
console.log('  dedicated unit tests (tests/unit/fdh2Domain.test.ts) — it is a');
console.log('  guard for FUTURE candidate intake (fdh_global_learning_candidates), not a');
console.log('  filter re-applied to FHIP\'s own hand-curated, admin-authored merchant');
console.log('  library. This script instead asserts the STRUCTURAL guarantee: FDH-2');
console.log('  seeds zero rows into fdh_global_learning_candidates (candidate intake is a');
console.log('  documented contract only in this phase, never auto-populated).');
check('fdh_global_learning_candidates has zero seeded rows (no auto-promotion path exists)', (await count(db1, 'fdh_global_learning_candidates')) === 0);

console.log(`\n=== CERTIFICATION RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
