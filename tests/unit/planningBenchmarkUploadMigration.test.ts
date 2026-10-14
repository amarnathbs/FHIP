// Migration 0275 (Planning Benchmarks staged upload, F5): the hand-run parts must be exact slices of the migration, each
// must be pasteable alone, and the SQL must avoid the constructs that broke a paste into the Supabase SQL editor before.
// Evidence label: UNIT-TESTED (text checks). The behaviour of the SQL is proven separately on PGlite
// (planningBenchmarkUploadPglite.test.ts).
//
// NAMED NEGATIVE CONTROLS
//   NC-M1  the three parts joined are byte-equal to the migration (a changed byte in either breaks it);
//   NC-M2  every hazard rule flags a deliberately bad snippet (the lint bites);
//   NC-M3  the migration never drops a constraint or a table that already exists (no drop-and-recreate of a shared CHECK).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from './support/sqlEditorHazards';

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).find((f) => f.startsWith('0275_planning_benchmark_staged_upload'))!;
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', FILE), 'utf8');
const PARTS_DIR = path.join(ROOT, 'docs', 'planning-benchmarks', 'po_apply_upload', 'parts');
const part = (l: string) => fs.readFileSync(path.join(PARTS_DIR, `0275${l}.sql`), 'utf8');

describe('migration 0275 hand-run safety', () => {
  it('NC-M1: parts a, b, c joined are byte-equal to the migration file', () => {
    expect([part('a'), part('b'), part('c')].join('')).toBe(MIGRATION);
  });

  it('every part starts on a banner or the file header and ends on a complete statement (pasteable alone)', () => {
    expect(part('a').startsWith('-- 0275')).toBe(true);
    expect(part('b').startsWith('-- PART B starts here')).toBe(true);
    expect(part('c').startsWith('-- PART C starts here')).toBe(true);
    // the last NON-COMMENT line of each part ends a statement (a trailing banner comment before the next part is harmless)
    for (const l of ['a', 'b', 'c']) {
      const code = part(l).split(/\r?\n/).filter((x) => x.trim() && !x.trim().startsWith('--'));
      expect(code[code.length - 1].trimEnd().endsWith(';')).toBe(true);
    }
  });

  it('the migration and each part pass the editor-safety lint', () => {
    expect(hazards(MIGRATION)).toEqual([]);
    for (const l of ['a', 'b', 'c']) expect(hazards(part(l))).toEqual([]);
  });

  it('NC-M2: the lint bites on bad snippets', () => {
    expect(hazards('-- rows from public')).not.toEqual([]);
    expect(hazards("select 'insert into foo'")).not.toEqual([]);
    expect(hazards('select 1 -- a; b')).not.toEqual([]);
    expect(hazards('select 10 % 3')).not.toEqual([]);
    expect(hazards('select $$x$$')).not.toEqual([]);
    expect(hazards('select é')).not.toEqual([]);
  });

  it('NC-M3: nothing existing is dropped or recreated (no drop constraint, no drop table on an existing table, no widened check list)', () => {
    const code = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/drop\s+constraint/i);
    expect(code).not.toMatch(/drop\s+table\s+(if\s+exists\s+)?(public\.)?(benchmark_values|benchmark_target_ranges|benchmark_datasets|benchmark_cohorts|benchmark_sources|benchmark_update_runs|admin_users)\b/i);
    expect(code).not.toMatch(/alter\s+table\s+(public\.)?benchmark_update_runs/i);
  });

  it('contract: the three tables, the two capability columns, the predicates and the four RPCs exist, with EXECUTE revoked from public and anon', () => {
    for (const t of ['benchmark_upload_batches', 'benchmark_upload_rows', 'benchmark_upload_events']) expect(MIGRATION).toMatch(new RegExp(`create table if not exists ${t}`));
    for (const c of ['can_upload_planning_benchmarks', 'can_activate_planning_benchmarks']) expect(MIGRATION).toContain(c);
    for (const f of ['stage_planning_benchmark_upload', 'get_planning_benchmark_upload', 'activate_planning_benchmark_upload', 'discard_planning_benchmark_upload', 'is_planning_benchmark_uploader', 'is_planning_benchmark_activator']) {
      expect(MIGRATION).toContain(f);
    }
    expect(MIGRATION).toMatch(/revoke all on function[\s\S]*from public, anon/i);
    expect(MIGRATION).toMatch(/security definer set search_path = ''/i);
    expect(MIGRATION).not.toMatch(/grant (all|insert|update|delete)[^;]*benchmark_upload_(batches|rows|events)[^;]*to (anon|authenticated)/i);
  });
});
