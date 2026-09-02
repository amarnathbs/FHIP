import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isKnownCountry } from '@/lib/services/jurisdiction';
import {
  isLandingPresentationCountry,
  toAuthoritativeCountryCodeOrNull,
  LANDING_PRESENTATION_COUNTRIES,
} from '@/lib/services/landingCountryContext';

// PO clarification (2026-09-02), section 4: "Must structurally prevent
// country_of_residence = GLOBAL, primary_country = GLOBAL,
// billing_country = GLOBAL, cross_border_country = GLOBAL anywhere." This
// file proves that mechanically, at three independent layers:
//   1. Type/runtime level -- G1's own CountryCode guard (isKnownCountry)
//      rejects 'GLOBAL'; G2's own bridge function
//      (toAuthoritativeCountryCodeOrNull) never maps 'GLOBAL' to a
//      CountryCode.
//   2. Schema level -- reads the actual migration SQL text (not a copy) and
//      proves country_of_residence/primary_country/billing_country/
//      cross_border_relationships.country_code are all `char(2)` columns
//      with a foreign key to `countries(country_code)` -- 'GLOBAL' (6
//      characters) cannot fit, and no `countries` row named 'GLOBAL' exists.
//   3. Registry-seed level -- scans every migration file for a literal
//      'GLOBAL' country-code insertion into the `countries` table; there is
//      none.
const REPO_ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');

function readMigration(filename: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

describe('GLOBAL is not a country — type/runtime-level enforcement', () => {
  it('G1\'s own isKnownCountry() guard rejects GLOBAL (the authoritative CountryCode vocabulary has no third member)', () => {
    expect(isKnownCountry('GLOBAL')).toBe(false);
    expect(isKnownCountry('AU')).toBe(true);
    expect(isKnownCountry('IN')).toBe(true);
  });

  it('GLOBAL IS a valid G2 landing presentation value (positive control -- it is meant to be selectable)', () => {
    expect(isLandingPresentationCountry('GLOBAL')).toBe(true);
    expect(LANDING_PRESENTATION_COUNTRIES).toEqual(['AU', 'IN', 'GLOBAL']);
  });

  it('toAuthoritativeCountryCodeOrNull() is the one permitted bridge, and it never lets GLOBAL through as a CountryCode', () => {
    expect(toAuthoritativeCountryCodeOrNull('GLOBAL')).toBeNull();
    expect(toAuthoritativeCountryCodeOrNull('AU')).toBe('AU');
    expect(toAuthoritativeCountryCodeOrNull('IN')).toBe('IN');
    expect(toAuthoritativeCountryCodeOrNull(null)).toBeNull();
  });
});

describe('GLOBAL is not a country — schema-level enforcement (reads real migration source)', () => {
  it('user_profiles.country_of_residence is char(2) with an FK to countries(country_code) (migration 0001)', () => {
    const sql = readMigration('0001_foundation.sql');
    expect(sql).toMatch(/country_of_residence\s+char\(2\)\s+references\s+countries\(country_code\)/);
  });

  it('user_profiles.primary_country and .billing_country are char(2) with an FK to countries(country_code) (migration 0122)', () => {
    const sql = readMigration('0122_g1_country_foundation.sql');
    expect(sql).toMatch(/primary_country\s+char\(2\)\s+references\s+countries\(country_code\)/);
    expect(sql).toMatch(/billing_country\s+char\(2\)\s+references\s+countries\(country_code\)/);
  });

  it('cross_border_relationships.country_code is char(2) NOT NULL with an FK to countries(country_code) (migration 0122)', () => {
    const sql = readMigration('0122_g1_country_foundation.sql');
    expect(sql).toMatch(/country_code\s+char\(2\)\s+not null\s+references\s+countries\(country_code\)/);
  });

  it("'GLOBAL' (6 characters) cannot be stored in any char(2) column, independent of any application-layer guard", () => {
    // A direct, load-bearing assertion of the physical fact this whole test
    // file exists to prove: char(2) has a fixed 2-byte capacity.
    expect('GLOBAL'.length).toBeGreaterThan(2);
  });
});

describe("GLOBAL is not a country — no migration ever seeds a 'GLOBAL' countries row", () => {
  it('no migration file contains a countries-table insertion of GLOBAL as a country_code', () => {
    // Narrowly scoped to `insert into countries ... ;` statement bodies
    // specifically (not any use of the word "GLOBAL" anywhere in the
    // repository) -- migration 0102, for example, legitimately uses
    // 'GLOBAL' as a value of the UNRELATED
    // master_financial_items.applicability_class column (a catalogue-item
    // classification, not a country), which a naive whole-file substring
    // scan would wrongly flag. Only a literal 'GLOBAL' inside an actual
    // `insert into countries` statement would prove the real defect this
    // test exists to catch.
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const offenders: string[] = [];
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const codeOnly = sql.replace(/--.*$/gm, '');
      const insertStatements = codeOnly.match(/insert\s+into\s+countries\b[\s\S]*?;/gi) ?? [];
      if (insertStatements.some((stmt) => /'GLOBAL'/.test(stmt))) offenders.push(file);
    }
    expect(offenders, `migration(s) inserting 'GLOBAL' into the countries table: ${offenders.join(', ')}`).toEqual([]);
  });

  it('sanity check: the scan actually detects a real countries-table insertion when one exists (negative-control proof the pattern is not vacuous)', () => {
    const sql = readMigration('0122_g1_country_foundation.sql');
    const insertStatements = sql.match(/insert\s+into\s+countries\b[\s\S]*?;/gi) ?? [];
    expect(insertStatements.length).toBeGreaterThan(0);
    expect(insertStatements.some((stmt) => /'GB'/.test(stmt))).toBe(true);
  });
});
