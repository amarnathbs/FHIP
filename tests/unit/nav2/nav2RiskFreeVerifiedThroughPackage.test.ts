// The hand-run package for migration 0294 (docs/nav2/po_apply_verified_through): every SQL file passes the editor-safety rules, the paste copy of the
// migration is byte-equal to the migration, the read-only files really are read only, and the README carries the steps the Product Owner needs.
//
// NAMED NEGATIVE CONTROLS: NC-P1 the editor-safety lint bites (a bad snippet is flagged); NC-P2 one changed byte breaks the copy equality;
// NC-P3 a write verb in a "read only" file would be caught by the scan.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from '../support/sqlEditorHazards';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'docs', 'nav2', 'po_apply_verified_through');
const SQL_DIR = path.join(DIR, 'sql');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0294_nav2_risk_free_confirm_verified_through.sql'), 'utf8');
const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
const read = (f: string) => fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
const code = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const WRITE_VERB = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i;

describe('package for migration 0294', () => {
  it('has every file the README names', () => {
    const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) expect(readme, f).toContain(f);
  });

  for (const f of files) {
    it(`NC-M4 style: ${f} has none of the editor hazards`, () => {
      expect(hazards(read(f))).toEqual([]);
    });
  }
  it('the migration itself passes the same rules', () => {
    expect(hazards(MIGRATION)).toEqual([]);
  });

  it('NC-P1: the lint bites (each rule flags a bad snippet)', () => {
    expect(hazards("-- a comment with a semicolon; here\nselect 1;").length).toBeGreaterThan(0);
    expect(hazards("-- reads from table now\nselect 1;").length).toBeGreaterThan(0);
    expect(hazards("select 'moved from the old date';").length).toBeGreaterThan(0);
    expect(hazards("select 100%;").length).toBeGreaterThan(0);
  });

  it('the paste copy of the migration is byte-equal to the migration', () => {
    expect(read('0294_apply.sql')).toBe(MIGRATION);
  });
  it('NC-P2: one changed byte breaks the equality', () => {
    expect(read('0294_apply.sql').replace('risk_free_today', 'risk_free_todaY')).not.toBe(MIGRATION);
  });

  it('the P and C files are read only; the B1 file writes only its own backup tables; the rollback only drops the two new functions', () => {
    for (const f of files.filter((x) => /^(P\d|B2|C0294)/.test(x))) expect(code(read(f)), f).not.toMatch(WRITE_VERB);
    const b1 = code(read('B1_backup_series_and_log.sql'));
    for (const stmt of b1.split(';').map((x) => x.trim()).filter(Boolean)) expect(stmt, stmt).toMatch(/nav2_backup_20261019_rf_/);
    expect(code(read('B3_drop_backups_after_release.sql')).match(/drop table if exists public\.(\w+)/g)?.length).toBe(2);
    const rollback = code(read('rollback_0294.sql'));
    expect(rollback.match(/drop function if exists public\.(\w+)/g)).toEqual(['drop function if exists public.confirm_risk_free_verified_through', 'drop function if exists public.risk_free_today']);
    expect(rollback).not.toMatch(/drop table|delete|truncate|update/i);
  });
  it('NC-P3: the write-verb scan is real (it flags an update in a read-only file)', () => {
    expect(code('-- read only\nupdate public.ii_risk_free_series set enabled = true;')).toMatch(WRITE_VERB);
  });

  it('the migration touches no table, no row and no constraint: functions only', () => {
    const c = code(MIGRATION);
    expect(c).not.toMatch(/\b(create table|alter table|drop table|drop function|truncate table|create index|create trigger|create policy)\b/i);
    expect(c).not.toMatch(/drop constraint|add constraint|check \(/i);
    expect((c.match(/create or replace function/g) ?? []).length).toBe(3);
  });

  it('the README gives the steps: DEV first, backup first, read-only first, the governed control (not a raw update), the December re-verification and the rollback', () => {
    const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    expect(readme.indexOf('## 3. DEV first')).toBeLessThan(readme.indexOf('## 4. Production'));
    expect(readme).toContain('B1_backup_series_and_log.sql');
    expect(readme).toContain('not a raw update');
    expect(readme).toContain('17-01-2027');
    expect(readme).toContain('## 7. December 2026 re-verification');
    expect(readme).toContain('## 6. Rollback');
    expect(readme).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/); // day-first in text
  });
});
