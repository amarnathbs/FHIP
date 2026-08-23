// FDH-2 — deterministic seed-migration generator.
//
// Reads the version-controlled data modules under data/financial-data-hub/
// (the canonical, human-reviewable source of truth) and emits idempotent SQL
// migration files under supabase/migrations/. Re-running this script
// produces byte-identical output for unchanged input data — the generator
// itself performs no randomness and no wall-clock-dependent formatting.
//
// Every INSERT uses `ON CONFLICT (<stable key>) DO NOTHING`, so re-applying
// a generated migration (or the whole chain, twice) never creates a
// duplicate row and never touches an existing row — this is the FDH-2
// "master seed run twice -> same row count, no duplicates" requirement.
//
// Usage: node scripts/fdh2_generate_master_data_migration.mjs [--write]
// Without --write, prints a dry-run summary only (used by the data-quality
// validator). With --write, writes the four migration files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceRegistry } from '../data/financial-data-hub/sourceRegistry.mjs';
import { economicTypes } from '../data/financial-data-hub/economicTypes.mjs';
import { categories } from '../data/financial-data-hub/categories.mjs';
import { subcategories } from '../data/financial-data-hub/subcategories.mjs';
import { mccList } from '../data/financial-data-hub/mcc.mjs';
import { mccCategoryMap } from '../data/financial-data-hub/mccCategoryMap.mjs';
import { institutionsAu } from '../data/financial-data-hub/institutionsAu.mjs';
import { institutionsIn } from '../data/financial-data-hub/institutionsIn.mjs';
import { paymentRails } from '../data/financial-data-hub/paymentRails.mjs';
import { merchantsAu } from '../data/financial-data-hub/merchantsAu.mjs';
import { merchantsIn } from '../data/financial-data-hub/merchantsIn.mjs';
import { classificationRules } from '../data/financial-data-hub/classificationRules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO, 'supabase', 'migrations');

// ---- SQL literal helpers ---------------------------------------------------
function sqlNull() { return 'null'; }
function sqlBool(b) { return b ? 'true' : 'false'; }
function sqlNum(n) { return String(n); }
/** Dollar-quoted string literal — avoids manual apostrophe escaping. */
function sqlStr(s) {
  if (s === null || s === undefined) return sqlNull();
  return `$lit$${s}$lit$`;
}
function sqlOpt(v, fn) { return v === null || v === undefined ? sqlNull() : fn(v); }
function sqlArrayChar2(arr) {
  return `array[${arr.map((c) => `'${c}'`).join(',')}]::char(2)[]`;
}
function sqlJson(obj) {
  return `$json$${JSON.stringify(obj)}$json$::jsonb`;
}
/** A category_id subquery by stable category_key. Null-safe. */
function catIdExpr(categoryKey) {
  if (!categoryKey) return 'null';
  return `(select id from fdh_categories where category_key = '${categoryKey}')`;
}
/** A subcategory_id subquery by (category_key, subcategory_key). Null-safe. */
function subcatIdExpr(categoryKey, subcategoryKey) {
  if (!categoryKey || !subcategoryKey) return 'null';
  return `(select id from fdh_subcategories where category_id = ${catIdExpr(categoryKey)} and subcategory_key = '${subcategoryKey}')`;
}
function institutionIdExpr(countryCode, institutionCode) {
  return `(select id from fdh_financial_institutions where country_code = '${countryCode}' and institution_code = '${institutionCode}')`;
}
function merchantIdExpr(countryCode, canonicalName) {
  return `(select id from fdh_merchants where country_code = '${countryCode}' and canonical_name = '${canonicalName}')`;
}

const HEADER = (title, body) => `-- =============================================================================
-- Financial Data Hub (FDH) — FDH-2 ${title}
-- =============================================================================
-- GENERATED FILE. Produced deterministically by
-- scripts/fdh2_generate_master_data_migration.mjs from the version-controlled
-- source data under data/financial-data-hub/. Do not hand-edit this file —
-- edit the source data module and regenerate. Every INSERT is
-- \`ON CONFLICT ... DO NOTHING\`, so re-applying this migration (or the full
-- chain) twice produces the same row count with zero duplicates.
${body}
-- =============================================================================
`;

// ---- 0053: taxonomy + MCC seed ---------------------------------------------
function build0053() {
  const lines = [];

  lines.push('-- --- fdh_source_registry ------------------------------------------------');
  lines.push('insert into fdh_source_registry (source_key, source_name, source_category, source_reference_note, accessed_at, notes) values');
  lines.push(sourceRegistry.map((s) => `  (${sqlStr(s.source_key)}, ${sqlStr(s.source_name)}, ${sqlStr(s.source_category)}, ${sqlOpt(s.source_reference_note, sqlStr)}, ${sqlOpt(s.accessed_at, sqlStr)}, ${sqlOpt(s.notes, sqlStr)})`).join(',\n') + '\non conflict (source_key) do nothing;\n');

  lines.push('-- --- fdh_economic_transaction_types --------------------------------------');
  lines.push('insert into fdh_economic_transaction_types (economic_type, display_name, description) values');
  lines.push(economicTypes.map((e) => `  (${sqlStr(e.economic_type)}, ${sqlStr(e.display_name)}, ${sqlStr(e.description)})`).join(',\n') + '\non conflict (economic_type) do nothing;\n');

  lines.push('-- --- fdh_categories -------------------------------------------------------');
  lines.push('insert into fdh_categories (category_key, display_name, description, economic_type, country_applicability, essential_discretionary, fixed_variable, tax_reporting_flag, retirement_relevance, investment_relevance, debt_relevance, fhip_mapping_key, display_order, icon_key, source_key) values');
  lines.push(categories.map((c) => `  (${sqlStr(c.category_key)}, ${sqlStr(c.display_name)}, ${sqlOpt(c.description, sqlStr)}, ${sqlStr(c.economic_type)}, ${sqlArrayChar2(c.country_applicability)}, ${sqlOpt(c.essential_discretionary, sqlStr)}, ${sqlOpt(c.fixed_variable, sqlStr)}, ${sqlBool(c.tax_reporting_flag)}, ${sqlBool(c.retirement_relevance)}, ${sqlBool(c.investment_relevance)}, ${sqlBool(c.debt_relevance)}, ${sqlOpt(c.fhip_mapping_key, sqlStr)}, ${sqlNum(c.display_order)}, ${sqlOpt(c.icon_key, sqlStr)}, ${sqlOpt(c.source_key, sqlStr)})`).join(',\n') + '\non conflict (category_key) do nothing;\n');

  lines.push('-- --- fdh_subcategories ------------------------------------------------------');
  lines.push('insert into fdh_subcategories (category_id, subcategory_key, display_name, description, country_applicability, essential_discretionary, fixed_variable, fhip_mapping_key, display_order, source_key) values');
  lines.push(subcategories.map((s) => `  (${catIdExpr(s.category_key)}, ${sqlStr(s.subcategory_key)}, ${sqlStr(s.display_name)}, ${sqlOpt(s.description, sqlStr)}, ${sqlArrayChar2(s.country_applicability)}, ${sqlOpt(s.essential_discretionary, sqlStr)}, ${sqlOpt(s.fixed_variable, sqlStr)}, ${sqlOpt(s.fhip_mapping_key, sqlStr)}, ${sqlNum(s.display_order)}, ${sqlOpt(s.source_key, sqlStr)})`).join(',\n') + '\non conflict (category_id, subcategory_key) do nothing;\n');

  lines.push('-- --- fdh_mcc_master ---------------------------------------------------------');
  lines.push('insert into fdh_mcc_master (mcc, official_or_public_description, normalized_description, broad_group, active, source_key, source_version, country_relevance, notes) values');
  lines.push(mccList.map((c) => `  (${sqlStr(c.mcc)}, ${sqlStr(c.official_or_public_description)}, ${sqlStr(c.normalized_description)}, ${sqlStr(c.broad_group)}, ${sqlBool(c.active)}, ${sqlOpt(c.source_key, sqlStr)}, ${sqlOpt(c.source_version, sqlStr)}, ${sqlArrayChar2(c.country_relevance)}, ${sqlOpt(c.notes, sqlStr)})`).join(',\n') + '\non conflict (mcc) do nothing;\n');

  lines.push('-- --- fdh_mcc_category_map ----------------------------------------------------');
  lines.push('insert into fdh_mcc_category_map (mcc, country_code, category_id, subcategory_id, mapping_confidence, mapping_type, ambiguity_flag, requires_additional_context, notes) values');
  lines.push(mccCategoryMap.map((m) => `  (${sqlStr(m.mcc)}, ${sqlOpt(m.country_code, sqlStr)}, ${catIdExpr(m.category_key)}, ${subcatIdExpr(m.category_key, m.subcategory_key)}, ${sqlStr(m.mapping_confidence)}, ${sqlStr(m.mapping_type)}, ${sqlBool(m.ambiguity_flag)}, ${sqlBool(m.requires_additional_context)}, ${sqlOpt(m.notes, sqlStr)})`).join(',\n') + `\non conflict (mcc, (coalesce(country_code, '**'))) do nothing;\n`);

  return HEADER('Migration D (0053): taxonomy + MCC master-data seed', lines.join('\n'));
}

// ---- 0054: institution + payment rail seed ---------------------------------
function build0054() {
  const lines = [];
  for (const [countryCode, list] of [['AU', institutionsAu], ['IN', institutionsIn]]) {
    lines.push(`-- --- fdh_financial_institutions (${countryCode}) --------------------------------------`);
    lines.push('insert into fdh_financial_institutions (country_code, institution_code, institution_name, institution_type, legal_name, parent_group, website_domain, coverage_status, source_key, source_checked_at) values');
    lines.push(list.map((i) => `  ('${countryCode}', ${sqlStr(i.institution_code)}, ${sqlStr(i.institution_name)}, ${sqlStr(i.institution_type)}, ${sqlOpt(i.legal_name, sqlStr)}, ${sqlOpt(i.parent_group, sqlStr)}, ${sqlOpt(i.website_domain, sqlStr)}, ${sqlStr(i.coverage_status)}, ${sqlOpt(i.source_key, sqlStr)}, ${sqlOpt(i.source_checked_at, sqlStr)})`).join(',\n') + '\non conflict (country_code, institution_code) do nothing;\n');
  }

  lines.push('-- --- fdh_institution_capabilities ---------------------------------------------');
  const capRows = [];
  for (const [countryCode, list] of [['AU', institutionsAu], ['IN', institutionsIn]]) {
    for (const i of list) {
      for (const cap of i.capabilities ?? []) {
        capRows.push(`  (${institutionIdExpr(countryCode, i.institution_code)}, ${sqlStr(cap)})`);
      }
    }
  }
  if (capRows.length) {
    lines.push('insert into fdh_institution_capabilities (institution_id, capability_type) values');
    lines.push(capRows.join(',\n') + '\non conflict (institution_id, capability_type) do nothing;\n');
  }

  lines.push('-- --- fdh_institution_aliases -------------------------------------------------');
  const aliasRows = [];
  for (const [countryCode, list] of [['AU', institutionsAu], ['IN', institutionsIn]]) {
    for (const i of list) {
      for (const alias of i.aliases ?? []) {
        const norm = alias.trim().toUpperCase();
        aliasRows.push(`  (${institutionIdExpr(countryCode, i.institution_code)}, ${sqlStr(alias)}, ${sqlStr(norm)}, 'admin_curated', 0.95, true)`);
      }
    }
  }
  lines.push('insert into fdh_institution_aliases (institution_id, alias, alias_normalized, source, confidence, verified) values');
  lines.push(aliasRows.join(',\n') + '\non conflict (institution_id, alias_normalized) do nothing;\n');

  lines.push('-- --- fdh_payment_rail_master --------------------------------------------------');
  lines.push('insert into fdh_payment_rail_master (rail_key, display_name, country_code, rail_category, description, active) values');
  lines.push(paymentRails.map((r) => `  (${sqlStr(r.rail_key)}, ${sqlStr(r.display_name)}, ${sqlOpt(r.country_code, sqlStr)}, ${sqlStr(r.rail_category)}, ${sqlOpt(r.description, sqlStr)}, ${sqlBool(r.active)})`).join(',\n') + '\non conflict (rail_key) do nothing;\n');

  return HEADER('Migration E (0054): institution + payment-rail master-data seed', lines.join('\n'));
}

// ---- 0055: merchant seed ----------------------------------------------------
function build0055() {
  const lines = [];
  for (const [countryCode, list] of [['AU', merchantsAu], ['IN', merchantsIn]]) {
    lines.push(`-- --- fdh_merchants (${countryCode}) -----------------------------------------------------`);
    lines.push('insert into fdh_merchants (canonical_name, display_name, country_code, merchant_type, default_category_id, default_subcategory_id, mcc, mcc_confidence, essential_discretionary, subscription_possible, verification_status, active, website_domain, parent_company_name, recurring_possible, typical_frequency, fixed_amount_expected, variable_amount_possible, recurring_type, is_payment_processor, source_key, source_checked_at) values');
    lines.push(list.map((m) => `  (${sqlStr(m.canonical_name)}, ${sqlStr(m.display_name)}, '${countryCode}', ${sqlStr(m.merchant_type)}, ${catIdExpr(m.category_key)}, ${subcatIdExpr(m.category_key, m.subcategory_key)}, ${sqlOpt(m.mcc, sqlStr)}, ${sqlOpt(m.mcc_confidence, sqlStr)}, ${sqlOpt(m.essential_discretionary, sqlStr)}, ${sqlBool(m.subscription_possible)}, 'approved', ${sqlBool(m.active ?? true)}, ${sqlOpt(m.website_domain, sqlStr)}, ${sqlOpt(m.parent_company_name, sqlStr)}, ${sqlBool(m.recurring_possible)}, ${sqlOpt(m.typical_frequency, sqlStr)}, ${sqlBool(m.fixed_amount_expected)}, ${sqlBool(m.variable_amount_possible)}, ${sqlOpt(m.recurring_type, sqlStr)}, ${sqlBool(m.is_payment_processor)}, ${sqlOpt(m.source_key, sqlStr)}, ${sqlOpt(m.source_checked_at, sqlStr)})`).join(',\n') + `\non conflict (country_code, canonical_name) where country_code is not null do nothing;\n`);
  }

  lines.push('-- --- fdh_merchant_aliases ------------------------------------------------------');
  const aliasRows = [];
  for (const [countryCode, list] of [['AU', merchantsAu], ['IN', merchantsIn]]) {
    for (const mm of list) {
      for (const alias of mm.aliases ?? []) {
        const norm = alias.trim().toUpperCase();
        aliasRows.push(`  (${merchantIdExpr(countryCode, mm.canonical_name)}, '${countryCode}', ${sqlStr(norm)}, 'statement_narrative', 'admin_curated', 0.9, true)`);
      }
    }
  }
  lines.push('insert into fdh_merchant_aliases (merchant_id, country_code, alias_normalised, alias_type, source, confidence, verified) values');
  lines.push(aliasRows.join(',\n') + `\non conflict (merchant_id, alias_normalised, (coalesce(country_code, '**'))) do nothing;\n`);

  return HEADER('Migration F (0055): merchant + merchant-alias master-data seed', lines.join('\n'));
}

// ---- 0056: classification rule seed -----------------------------------------
function actionDefExpr(action) {
  if (action.action_kind !== 'classify') return sqlJson(action);
  // A 'classify' action needs REAL category/subcategory UUIDs, which only
  // exist once this migration runs after 0053 — built via jsonb_build_object
  // with scalar subqueries rather than a literal.
  const parts = [`'action_kind', 'classify'`];
  if (action.economic_transaction_type) parts.push(`'economic_transaction_type', '${action.economic_transaction_type}'`);
  if (action.category_key) parts.push(`'category_id', (${catIdExpr(action.category_key)})::text`);
  if (action.category_key && action.subcategory_key) parts.push(`'subcategory_id', (${subcatIdExpr(action.category_key, action.subcategory_key)})::text`);
  return `jsonb_build_object(${parts.join(', ')})`;
}

function build0056() {
  const lines = [];
  lines.push('-- --- fdh_classification_rules ---------------------------------------------------');
  lines.push('insert into fdh_classification_rules (rule_key, rule_type, country_applicability, match_definition, action_definition, priority, status, active, version) values');
  lines.push(classificationRules.map((r) => `  (${sqlStr(r.rule_key)}, ${sqlStr(r.rule_type)}, ${sqlArrayChar2(r.country_applicability)}, ${sqlJson(r.match_definition)}, ${actionDefExpr(r.action_definition)}, ${sqlNum(r.priority)}, 'approved', true, 1)`).join(',\n') + '\non conflict (rule_key) do nothing;\n');
  return HEADER('Migration G (0056): classification rule seed library', lines.join('\n'));
}

const FILES = {
  '0053_fdh2_taxonomy_and_mcc_seed.sql': build0053,
  '0054_fdh2_institution_and_payment_rail_seed.sql': build0054,
  '0055_fdh2_merchant_seed.sql': build0055,
  '0056_fdh2_classification_rule_seed.sql': build0056,
};

const shouldWrite = process.argv.includes('--write');
let totalBytes = 0;
for (const [filename, builder] of Object.entries(FILES)) {
  const sql = builder();
  totalBytes += sql.length;
  if (shouldWrite) {
    fs.writeFileSync(path.join(OUT_DIR, filename), sql, { encoding: 'utf8' });
    console.log(`wrote ${filename} (${sql.length} bytes)`);
  } else {
    console.log(`[dry-run] would write ${filename} (${sql.length} bytes)`);
  }
}
console.log(`\ntotal ${totalBytes} bytes across ${Object.keys(FILES).length} files`);
console.log(`counts: sourceRegistry=${sourceRegistry.length} economicTypes=${economicTypes.length} categories=${categories.length} subcategories=${subcategories.length} mcc=${mccList.length} mccMap=${mccCategoryMap.length} institutionsAu=${institutionsAu.length} institutionsIn=${institutionsIn.length} paymentRails=${paymentRails.length} merchantsAu=${merchantsAu.length} merchantsIn=${merchantsIn.length} classificationRules=${classificationRules.length}`);
