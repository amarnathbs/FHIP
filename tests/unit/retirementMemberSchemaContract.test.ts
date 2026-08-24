/**
 * Retirement Member UI (Self/Spouse Target Retirement Age) -- static
 * structural checks on migration 0077, mirroring
 * airConsolidationSchemaContract.test.ts's method (parse the migration
 * from disk, assert structural facts rather than trust prose). The real
 * live-behaviour proof is scripts/rm_retirement_member_certification.mjs
 * (PGlite fresh rebuild, populated-DEV-upgrade backfill replay across
 * every spec case A-F, RLS re-test with a negative control).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const read = (file: string) => fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');

const RM_FILE = '0077_retirement_member_target_age.sql';

describe('Retirement Member UI migration exists and is numbered after the A/I/R consolidation', () => {
  it('0077 exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, RM_FILE))).toBe(true);
  });

  it('no other migration in the repo also claims 0077', () => {
    const all = fs.readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql'));
    const claimants = all.filter((f) => /^0077_/.test(f));
    expect(claimants).toEqual([RM_FILE]);
  });

  it('migrations 0072-0074 (immutable production history) are never touched by this file', () => {
    const sql = read(RM_FILE);
    expect(sql).not.toMatch(/0072_air_consolidation_schema_foundation/);
    expect(sql).not.toMatch(/0073_air_consolidation_data_reclassification/);
    expect(sql).not.toMatch(/0074_air_consolidation_catalogue_correction/);
    // Structural guarantee: no DROP/ALTER of the pre-existing retirement_members columns.
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/^\s*delete\s+from/im);
  });
});

describe('0077 is purely additive DDL', () => {
  const sql = read(RM_FILE);

  it('only adds columns, never drops or renames existing ones', () => {
    expect(sql).toMatch(/alter table retirement_members[\s\S]*?add column if not exists is_active/i);
    expect(sql).toMatch(/add column if not exists age_source/i);
    expect(sql).not.toMatch(/rename column/i);
  });

  it('age_source has a check constraint limited to the three documented provenance values', () => {
    expect(sql).toMatch(/check \(age_source in \('user_confirmed', 'suggested_default', 'needs_confirmation'\)\)/);
  });

  it('is_active defaults true (non-destructive spouse-removal support, spec s.11)', () => {
    expect(sql).toMatch(/add column if not exists is_active boolean not null default true/i);
  });
});

describe('0077 backfill never guesses a conflicting legacy age (spec s.23-24)', () => {
  const sql = read(RM_FILE);

  it('contains no AVG/mode/min/max aggregate applied to target_retirement_age', () => {
    expect(sql).not.toMatch(/avg\s*\(\s*.*target_retirement_age/i);
    expect(sql).not.toMatch(/mode\s*\(\s*\)\s*within\s+group.*target_retirement_age/i);
    expect(sql).not.toMatch(/max\s*\(\s*ra\.target_retirement_age/i);
    expect(sql).not.toMatch(/min\s*\(\s*ra\.target_retirement_age/i);
  });

  it('the conflict branch sets target_retirement_age to NULL and age_source to needs_confirmation', () => {
    expect(sql).toMatch(/distinct_count > 1/);
    expect(sql).toMatch(/'needs_confirmation'/);
  });

  it('the conflict branch preserves every distinct legacy value in notes rather than discarding them', () => {
    expect(sql).toMatch(/legacy_summary/);
    expect(sql).toMatch(/array_to_string\(distinct_ages/);
  });

  it('only owner IN (self, spouse) rows are considered for backfill (spec s.18 — joint/SMSF ownership is not a single member)', () => {
    expect(sql).toMatch(/ra\.owner in \('self', 'spouse'\)/);
  });

  it('never overwrites a pre-existing retirement_members row (idempotent / does not clobber new-UI data)', () => {
    expect(sql).toMatch(/if exists \(select 1 from retirement_members rm where rm\.user_id = grp\.user_id and rm\.member_type = grp\.member_type\) then\s*\n\s*continue;/);
  });
});

describe('0077 links retirement_accounts to their member without touching any value column', () => {
  const sql = read(RM_FILE);

  it('the account-linkage UPDATE only sets retirement_member_id, never current_balance/contribution fields', () => {
    const updateMatch = sql.match(/update retirement_accounts ra\s+set([\s\S]*?)from retirement_members/i);
    expect(updateMatch).not.toBeNull();
    const setClause = updateMatch![1];
    expect(setClause).toMatch(/retirement_member_id\s*=\s*rm\.id/);
    expect(setClause).not.toMatch(/current_balance/);
    expect(setClause).not.toMatch(/employer_contribution/);
    expect(setClause).not.toMatch(/personal_contribution/);
  });
});
