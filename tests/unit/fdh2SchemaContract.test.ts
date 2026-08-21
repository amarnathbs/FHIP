/**
 * FDH-2 — repeatable schema-verification test, mirroring
 * tests/unit/fdh1SchemaContract.test.ts's method exactly: parse the FDH-2
 * migration files from disk and assert structural facts, rather than trust
 * prose. Deliberately does NOT talk to a database — the real
 * against-a-database proof is scripts/db-rebuild-check/replay.mjs and
 * scripts/fdh2_certify_master_data.mjs (PGlite).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_ESSENTIAL_DISCRETIONARY,
  FDH_FIXED_VARIABLE,
  FDH_GLOBAL_RULE_TYPES,
  FDH_INSTITUTION_COVERAGE_STATUSES,
  FDH_INSTITUTION_TYPES,
  FDH_MCC_BROAD_GROUPS,
  FDH_MCC_MAPPING_CONFIDENCE,
  FDH_MCC_MAPPING_TYPES,
  FDH_RECURRING_TYPES,
} from '@/lib/financial-data-hub/constants/enums';
import {
  FDH2_MASTER_DATA_TABLES_ADDED,
  FDH_ADMIN_ONLY_TABLES,
} from '@/lib/financial-data-hub/constants/tables';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const SCHEMA_MIGRATIONS = [
  '0050_fdh2_taxonomy_mcc_foundation.sql',
  '0051_fdh2_institution_and_payment_rail_foundation.sql',
  '0052_fdh2_merchant_and_governance_foundation.sql',
];
const SEED_MIGRATIONS = [
  '0053_fdh2_taxonomy_and_mcc_seed.sql',
  '0054_fdh2_institution_and_payment_rail_seed.sql',
  '0055_fdh2_merchant_seed.sql',
  '0056_fdh2_classification_rule_seed.sql',
];
const ALL_FDH2_MIGRATIONS = [...SCHEMA_MIGRATIONS, ...SEED_MIGRATIONS];

function readMigration(file: string): string {
  return fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');
}

const SCHEMA_SQL_RAW = SCHEMA_MIGRATIONS.map(readMigration).join('\n');
const SCHEMA_SQL = SCHEMA_SQL_RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

function tableBody(table: string): string {
  const start = SCHEMA_SQL.indexOf(`create table ${table} (`);
  expect(start, `create table ${table} not found`).toBeGreaterThan(-1);
  const end = SCHEMA_SQL.indexOf('\n);', start);
  expect(end, `unterminated create table ${table}`).toBeGreaterThan(start);
  return SCHEMA_SQL.slice(start, end);
}

function checkValuesForConstraint(constraintName: string): string[] {
  const idx = SCHEMA_SQL.indexOf(`add constraint ${constraintName}`);
  expect(idx, `constraint ${constraintName} not found`).toBeGreaterThan(-1);
  const slice = SCHEMA_SQL.slice(idx, SCHEMA_SQL.indexOf(';', idx));
  const match = slice.match(/in \(([^)]*)\)/);
  expect(match, `no in (...) list on constraint ${constraintName}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function checkValuesForColumn(table: string, column: string): string[] {
  const body = tableBody(table);
  const columnIndex = body.indexOf(`\n  ${column} `);
  expect(columnIndex, `column ${table}.${column} not found`).toBeGreaterThan(-1);
  const match = body.slice(columnIndex).match(/in \(([^)]*)\)/);
  expect(match, `no check(... in (...)) on ${table}.${column}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Same idea as `checkValuesForColumn`, but for a column FDH-2 added to a
 * pre-existing FDH-1 table via `alter table ... add column`, rather than a
 * column inside a `create table` FDH-2 created itself. Scoped from the
 * `add column <column>` clause to the next `add column`/`add constraint`
 * boundary or statement end, so it can never accidentally read a different
 * column's check list.
 */
function checkValuesForAlteredColumn(column: string): string[] {
  const marker = `add column ${column} `;
  const start = SCHEMA_SQL.indexOf(marker);
  expect(start, `"${marker}" not found in any FDH-2 alter table statement`).toBeGreaterThan(-1);
  const nextBoundary = SCHEMA_SQL.slice(start + marker.length).search(/,\s*\n\s*add (column|constraint)|;/);
  expect(nextBoundary, `could not find the end of the ${column} column clause`).toBeGreaterThan(-1);
  const clause = SCHEMA_SQL.slice(start, start + marker.length + nextBoundary);
  const match = clause.match(/in \(([^)]*)\)/);
  expect(match, `no check(... in (...)) on altered column ${column}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('FDH-2 schema migrations exist and are additive only', () => {
  it('all seven FDH-2 migrations are present', () => {
    for (const file of ALL_FDH2_MIGRATIONS) {
      expect(fs.existsSync(path.join(MIGRATION_DIR, file)), file).toBe(true);
    }
  });

  it('the FDH-2 migration numbers start at 0050 or later and do not collide', () => {
    const numbers = ALL_FDH2_MIGRATIONS.map((f) => Number(f.slice(0, 4)));
    for (const n of numbers) expect(n).toBeGreaterThanOrEqual(50);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('creates only the declared FDH-2 master-data / admin-only tables (no unexpected new table)', () => {
    const created = [...SCHEMA_SQL.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]).sort();
    const expected = [...FDH2_MASTER_DATA_TABLES_ADDED, ...FDH_ADMIN_ONLY_TABLES].sort();
    expect(created).toEqual(expected);
  });

  it('every alter table in the schema migrations targets a pre-existing FDH table or an FDH-2 table it just created', () => {
    const alters = [...SCHEMA_SQL.matchAll(/alter table ([a-z_]+)/g)].map((m) => m[1]);
    for (const table of alters) {
      expect(table.startsWith('fdh_'), `alter on non-FDH table: ${table}`).toBe(true);
    }
  });

  it('never drops a table, column, policy or constraint', () => {
    expect(/\bdrop\s+(table|column)\b/i.test(SCHEMA_SQL)).toBe(false);
    // `drop constraint if exists` immediately followed by `add constraint` of
    // the SAME name is the one sanctioned additive-widening idiom (see
    // migration 0050/0051/0052 comments) — anything else is disallowed.
    const dropConstraints = [...SCHEMA_SQL_RAW.matchAll(/drop constraint if exists ([a-z0-9_]+);/g)].map((m) => m[1]);
    for (const name of dropConstraints) {
      expect(SCHEMA_SQL_RAW.includes(`add constraint ${name}`), `${name} dropped but never re-added under the same name`).toBe(true);
    }
    expect(/\bdrop\s+policy\b/i.test(SCHEMA_SQL)).toBe(false);
  });

  it('never mutates existing user-owned data (no update/delete against a pre-existing table)', () => {
    expect(/\bdelete\s+from\b/i.test(SCHEMA_SQL)).toBe(false);
    // The only 'update' verb permitted anywhere is none — FDH-2's schema
    // migrations perform zero UPDATE statements.
    expect(/\bupdate\s+/i.test(SCHEMA_SQL)).toBe(false);
  });

  it('touches none of the seven protected FHIP Input Data tables', () => {
    for (const table of [
      'income_sources', 'expense_items', 'assets', 'liabilities',
      'investments', 'retirement_accounts', 'insurance_policies',
    ]) {
      expect(new RegExp(`(insert into|update|delete from|alter table)\\s+${table}\\b`, 'i').test(SCHEMA_SQL)).toBe(false);
    }
  });

  it('creates no table restating a canonical Investment Intelligence entity', () => {
    for (const forbidden of ['holding', 'security_master', 'securities', 'valuation', 'portfolio', 'nav', 'folio', 'instrument']) {
      for (const table of FDH2_MASTER_DATA_TABLES_ADDED) {
        expect(table.includes(forbidden), `${table} matches forbidden investment pattern "${forbidden}"`).toBe(false);
      }
    }
  });
});

describe('FDH-2 row level security', () => {
  it('enables RLS on every new FDH-2 table without exception', () => {
    for (const table of [...FDH2_MASTER_DATA_TABLES_ADDED, ...FDH_ADMIN_ONLY_TABLES]) {
      expect(SCHEMA_SQL.includes(`alter table ${table} enable row level security`), `RLS not enabled on ${table}`).toBe(true);
    }
  });

  it('gives every new master-data table read-only RLS and no write policy at all', () => {
    for (const table of FDH2_MASTER_DATA_TABLES_ADDED) {
      expect(SCHEMA_SQL).toContain(`create policy "read ${table}" on ${table}`);
      const policies = [...SCHEMA_SQL.matchAll(new RegExp(`create policy "[^"]*" on ${table}[^;]*;`, 'g'))].map((m) => m[0]);
      expect(policies, `${table} should have exactly one read policy`).toHaveLength(1);
      expect(/for select/.test(policies[0])).toBe(true);
    }
  });

  it('gives fdh_global_learning_candidates NO policy at all (stricter than ordinary master data)', () => {
    expect(SCHEMA_SQL).toContain('alter table fdh_global_learning_candidates enable row level security');
    const policies = [...SCHEMA_SQL.matchAll(/create policy "[^"]*" on fdh_global_learning_candidates[^;]*;/g)];
    expect(policies, 'fdh_global_learning_candidates must carry zero policies').toHaveLength(0);
  });

  it('never grants a blanket `using (true)` read policy on the admin-only table', () => {
    expect(/fdh_global_learning_candidates[\s\S]{0,200}using \(true\)/.test(SCHEMA_SQL)).toBe(false);
  });
});

describe('FDH-2 widened vocabularies match the SQL check constraints', () => {
  it('fdh_financial_institutions.institution_type (widened) matches FDH_INSTITUTION_TYPES', () => {
    expect(checkValuesForConstraint('fdh_financial_institutions_institution_type_check').sort())
      .toEqual([...FDH_INSTITUTION_TYPES].sort());
  });

  it('fdh_institution_capabilities.capability_type matches FDH_INSTITUTION_TYPES', () => {
    expect(checkValuesForColumn('fdh_institution_capabilities', 'capability_type').sort())
      .toEqual([...FDH_INSTITUTION_TYPES].sort());
  });

  it('fdh_categories.essential_discretionary (widened) matches FDH_ESSENTIAL_DISCRETIONARY', () => {
    expect(checkValuesForConstraint('fdh_categories_essential_discretionary_check').sort())
      .toEqual([...FDH_ESSENTIAL_DISCRETIONARY].sort());
  });

  it('fdh_subcategories.essential_discretionary (widened) matches FDH_ESSENTIAL_DISCRETIONARY', () => {
    expect(checkValuesForConstraint('fdh_subcategories_essential_discretionary_check').sort())
      .toEqual([...FDH_ESSENTIAL_DISCRETIONARY].sort());
  });

  it('fdh_categories.fixed_variable matches FDH_FIXED_VARIABLE', () => {
    expect(checkValuesForAlteredColumn('fixed_variable').sort())
      .toEqual([...FDH_FIXED_VARIABLE].sort());
  });

  it('fdh_financial_institutions.coverage_status matches FDH_INSTITUTION_COVERAGE_STATUSES', () => {
    expect(checkValuesForAlteredColumn('coverage_status').sort())
      .toEqual([...FDH_INSTITUTION_COVERAGE_STATUSES].sort());
  });

  it('fdh_mcc_master.broad_group matches FDH_MCC_BROAD_GROUPS', () => {
    expect(checkValuesForColumn('fdh_mcc_master', 'broad_group').sort())
      .toEqual([...FDH_MCC_BROAD_GROUPS].sort());
  });

  it('fdh_mcc_category_map.mapping_confidence matches FDH_MCC_MAPPING_CONFIDENCE', () => {
    expect(checkValuesForColumn('fdh_mcc_category_map', 'mapping_confidence').sort())
      .toEqual([...FDH_MCC_MAPPING_CONFIDENCE].sort());
  });

  it('fdh_mcc_category_map.mapping_type matches FDH_MCC_MAPPING_TYPES', () => {
    expect(checkValuesForColumn('fdh_mcc_category_map', 'mapping_type').sort())
      .toEqual([...FDH_MCC_MAPPING_TYPES].sort());
  });

  it('fdh_merchants.recurring_type matches FDH_RECURRING_TYPES', () => {
    expect(checkValuesForAlteredColumn('recurring_type').sort())
      .toEqual([...FDH_RECURRING_TYPES].sort());
  });

  it('fdh_classification_rules.rule_type (widened) matches FDH_GLOBAL_RULE_TYPES', () => {
    expect(checkValuesForConstraint('fdh_classification_rules_rule_type_check').sort())
      .toEqual([...FDH_GLOBAL_RULE_TYPES].sort());
  });
});

describe('FDH-2 critical structural rules', () => {
  it('a payment rail never carries a category/subcategory column (mechanism, not category)', () => {
    const body = tableBody('fdh_payment_rail_master');
    expect(/category_id|subcategory_id|economic_transaction_type/.test(body)).toBe(false);
  });

  it('an MCC-category mapping never forces a false-precise ambiguous mapping', () => {
    const body = tableBody('fdh_mcc_category_map');
    expect(body).toContain('chk_fdh_mcc_map_ambiguous_no_subcategory');
    expect(body).toContain('chk_fdh_mcc_map_type_consistency');
  });

  it('the global-learning candidate PII gate is a real database constraint, not just documentation', () => {
    const body = tableBody('fdh_global_learning_candidates');
    expect(body).toContain('chk_fdh_glc_pii_gate');
    expect(body).toContain("status <> 'approved' or pii_screening_status = 'passed'");
  });

  it('no institution is seeded above master_only coverage', () => {
    for (const file of SEED_MIGRATIONS) {
      const sql = readMigration(file);
      if (!sql.includes('fdh_financial_institutions')) continue;
      const matches = [...sql.matchAll(/'(master_only|parser_planned|parser_in_development|parser_certified|connected_data_future|deprecated)'/g)].map((m) => m[1]);
      for (const status of matches) {
        expect(status, `institution seed used non-master_only coverage_status: ${status}`).toBe('master_only');
      }
    }
  });

  it('every seed migration uses ON CONFLICT ... DO NOTHING everywhere (idempotent by construction)', () => {
    for (const file of SEED_MIGRATIONS) {
      // Strip `--` line comments first — the generated file header itself
      // mentions "ON CONFLICT ... DO NOTHING" in prose, which must not be
      // double-counted as a real clause.
      const sql = readMigration(file).split('\n')
        .map((line) => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
        .join('\n');
      const inserts = (sql.match(/^insert into/gim) || []).length;
      const onConflicts = (sql.match(/on conflict/gi) || []).length;
      expect(onConflicts, `${file}: ${inserts} inserts but ${onConflicts} ON CONFLICT clauses`).toBe(inserts);
      expect(sql.toLowerCase().includes('do update'), `${file} uses DO UPDATE, not the required DO NOTHING idempotency idiom`).toBe(false);
    }
  });
});
