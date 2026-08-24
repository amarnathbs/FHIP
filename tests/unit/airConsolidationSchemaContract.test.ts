/**
 * Assets, Investments & Retirement Consolidation -- static structural
 * checks on migrations 0072-0074, mirroring fdh2SchemaContract.test.ts /
 * fdh3SchemaContract.test.ts's method (parse the migration from disk,
 * assert structural facts rather than trust prose). The real live-behaviour
 * proof is scripts/air_consolidation_certification.mjs (PGlite fresh
 * rebuild + populated-DEV-upgrade replay with real reconciliation
 * assertions) and scripts/air_consolidation_retirement_members_rls.mjs
 * (PGlite RLS, with a negative control).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const read = (file: string) => fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');

const SCHEMA_FILE = '0072_air_consolidation_schema_foundation.sql';
const DATA_FILE = '0073_air_consolidation_data_reclassification.sql';
const CATALOGUE_FILE = '0074_air_consolidation_catalogue_correction.sql';

describe('A/I/R consolidation migrations exist in numeric order', () => {
  it('0072, 0073, 0074 all exist', () => {
    for (const f of [SCHEMA_FILE, DATA_FILE, CATALOGUE_FILE]) {
      expect(fs.existsSync(path.join(MIGRATION_DIR, f)), f).toBe(true);
    }
  });

  it('no other migration in the repo also claims 0072/0073/0074', () => {
    const all = fs.readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql'));
    for (const n of ['0072', '0073', '0074']) {
      const matches = all.filter((f) => f.startsWith(n));
      expect(matches, `files starting with ${n}`).toEqual([expect.stringContaining(n)]);
    }
  });
});

describe('0072 schema foundation is purely additive', () => {
  const sql = read(SCHEMA_FILE);

  it('never drops or renames an existing column, table, or constraint', () => {
    expect(sql).not.toMatch(/drop column/i);
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/drop constraint/i);
    // Only the actual SQL keyword forms, not the word "rename" appearing in
    // prose comments (e.g. explaining why item_key is never renamed).
    expect(sql).not.toMatch(/\brename (column|to|constraint)\b/i);
  });

  it('never deletes or updates an existing user row', () => {
    expect(sql).not.toMatch(/delete from/i);
    // The only UPDATEs in this file, if any, must not target user data tables directly with unscoped WHERE.
    expect(sql).not.toMatch(/update\s+(assets|investments|retirement_accounts)\s/i);
  });

  it('adds all 7 canonical metadata columns to master_financial_items', () => {
    for (const col of [
      'is_current_value_source', 'is_future_flow_source', 'is_retirement_specific',
      'is_personal_use_default', 'superseded_by_category', 'superseded_by_item_key', 'governance_note',
    ]) {
      expect(sql, col).toMatch(new RegExp(`add column if not exists ${col}\\b`, 'i'));
    }
  });

  it('adds linked_liability_id to both assets and investments', () => {
    expect(sql).toMatch(/alter table assets[\s\S]*?add column if not exists linked_liability_id/i);
    expect(sql).toMatch(/alter table investments[\s\S]*?add column if not exists linked_liability_id/i);
  });

  it('creates retirement_members with RLS enabled and an owner-only policy', () => {
    expect(sql).toMatch(/create table if not exists retirement_members/i);
    expect(sql).toMatch(/alter table retirement_members enable row level security/i);
    expect(sql).toMatch(/create policy .* on retirement_members[\s\S]*?auth\.uid\(\) = user_id/i);
  });
});

describe('0073 data reclassification never deletes a row (spec s.4.3/57)', () => {
  const sql = read(DATA_FILE);

  it('contains no DELETE statement anywhere', () => {
    expect(sql).not.toMatch(/delete from/i);
  });

  it('every retired source row is deactivated (is_active = false), never dropped', () => {
    expect(sql).toMatch(/update assets set is_active = false/);
    expect(sql).toMatch(/update investments set is_active = false/);
  });

  it('collision branch never upserts onto an existing destination row -- inserts a new, unlinked, explained row instead', () => {
    // Every INSERT that follows a `collision then` branch must set master_item_key to null.
    expect(sql).toMatch(/if collision then[\s\S]{0,400}master_item_key, notes, created_at\s*\)\s*\n\s*values \([\s\S]{0,300}?, null,/);
    expect(sql).toMatch(/Possible duplicate/);
  });

  it('the contribution/current_balance defect fix zeroes current_balance and preserves the amount in a contribution field', () => {
    expect(sql).toMatch(/employer_contributions.*salary_sacrifice.*personal_concessional.*non_concessional.*spouse_contribution.*government_co_contribution/s);
    expect(sql).toMatch(/current_balance = 0/);
    expect(sql).toMatch(/employer_contribution = case when is_employer_side then coalesce\(employer_contribution, 0\) \+ r\.current_balance/);
    expect(sql).toMatch(/personal_contribution = case when not is_employer_side then coalesce\(personal_contribution, 0\) \+ r\.current_balance/);
  });

  it('wraps the whole migration in one transaction', () => {
    expect(sql.trim().startsWith('begin;') || /\nbegin;/.test(sql)).toBe(true);
    expect(sql.trim().endsWith('commit;')).toBe(true);
  });
});

describe('0074 catalogue correction never orphans a visible user row', () => {
  const sql = read(CATALOGUE_FILE);

  it('only ever touches master_financial_items, never a user data table', () => {
    expect(sql).not.toMatch(/update\s+(assets|investments|retirement_accounts)\s/i);
    expect(sql).not.toMatch(/delete from/i);
  });

  it('deactivates all 17 cross-module-duplicate Assets items', () => {
    const expected = [
      'shares', 'etfs', 'managed_funds', 'bonds', 'private_equity', 'cryptocurrency', 'gold', 'silver',
      'term_deposits', 'commercial_property', 'investment_property', 'business_ownership', 'partnership_interest',
      'smsf_balance', 'industry_super', 'retail_super', 'defined_benefit',
    ];
    for (const key of expected) {
      expect(sql, key).toMatch(new RegExp(`'${key}'`));
    }
    expect(sql).toMatch(/is_active = false/);
  });

  it('does NOT deactivate the 6 retirement contribution items (would orphan corrected rows)', () => {
    const contribBlock = sql.slice(sql.indexOf('2. Retirement contribution items'), sql.indexOf('3. Relabel'));
    expect(contribBlock).not.toMatch(/is_active = false/);
    expect(contribBlock).toMatch(/is_future_flow_source = true/);
  });

  it('relabels investment.property without changing its item_key', () => {
    expect(sql).toMatch(/item_label = 'Residential Investment Property'/);
    expect(sql).toMatch(/where category = 'investment' and item_key = 'property'/);
  });
});
