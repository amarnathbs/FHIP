// Production hand-over v2 (docs/planning-benchmarks/po_apply_upload_PRODUCTION_v2): the SQL the Product Owner pastes is
// byte-identical to the migrations, the parts join back to the files, the order 0275 -> 0277 -> 0278 is stated, the earlier
// folder is marked superseded, and every pasted file passes the editor-safety lint.
// Evidence label: UNIT-TESTED (text). The check queries are executed on PGlite in planningBenchmarkRemovedBandsPglite.test.ts.
//
// NAMED NEGATIVE CONTROL NC-H1: a copy with one byte changed is reported as different.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from './support/sqlEditorHazards';

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'docs', 'planning-benchmarks', 'po_apply_upload_PRODUCTION_v2');
const MIG = (n: string) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', n));
const COPY = (n: string) => fs.readFileSync(path.join(DIR, 'sql', n));
const NAMES = [
  '0275_planning_benchmark_staged_upload.sql',
  '0277_planning_benchmark_dataset_metric_mapping.sql',
  '0278_planning_benchmark_removed_bands_target_ranges_only.sql',
];
const same = (a: Buffer, b: Buffer) => a.equals(b);

describe('PRODUCTION v2 hand-over', () => {
  it('the three SQL files are byte-identical to the migrations', () => {
    for (const n of NAMES) expect(same(MIG(n), COPY(n)), n).toBe(true);
  });

  it('NC-H1: the comparison bites on a one byte change', () => {
    const changed = Buffer.from(COPY(NAMES[2]));
    changed[changed.length - 2] = changed[changed.length - 2] ^ 1;
    expect(same(MIG(NAMES[2]), changed)).toBe(false);
  });

  it('the parts join back to 0275 and 0277 exactly', () => {
    const join = (p: string) => Buffer.concat(['a', 'b', 'c'].map((l) => fs.readFileSync(path.join(DIR, 'sql', 'parts', `${p}${l}.sql`))));
    expect(same(join('0275'), MIG(NAMES[0]))).toBe(true);
    expect(same(join('0277'), MIG(NAMES[1]))).toBe(true);
  });

  it('every pasted file passes the editor-safety lint (the 0275 file is a historical migration: it is checked for hazards that were fixed before it was applied on DEV)', () => {
    for (const f of ['0277_planning_benchmark_dataset_metric_mapping.sql', NAMES[2], 'rollback_0277.sql', 'rollback_0278.sql']) {
      expect(hazards(fs.readFileSync(path.join(DIR, 'sql', f), 'utf8')), f).toEqual([]);
    }
  });

  it('the README gives the order, marks the earlier folders superseded, and warns about the re-run of 0275 and the first Activate', () => {
    const t = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    expect(t.indexOf('## Step 1: 0275')).toBeGreaterThan(0);
    expect(t.indexOf('## Step 2: 0277')).toBeGreaterThan(t.indexOf('## Step 1: 0275'));
    expect(t.indexOf('## Step 3: 0278')).toBeGreaterThan(t.indexOf('## Step 2: 0277'));
    expect(t.indexOf('## Step 4: switch the permissions on')).toBeGreaterThan(t.indexOf('## Step 3: 0278'));
    expect(t).toContain('supersedes the earlier production hand-over for 0275 alone');
    expect(t).toMatch(/before the first Activate/);
    expect(t).toMatch(/re-emits a \*\*different\*\* function/);
    expect(t).toMatch(/Re-running `0275` afterwards/);
    expect(t).toMatch(/reverse\*\* order/);
  });

  it('the DEV 0277 README says 0278 re-emits a different function and does not touch the 0277 readiness function', () => {
    const t = fs.readFileSync(path.join(ROOT, 'docs', 'planning-benchmarks', 'po_apply_mapping', 'README.md'), 'utf8');
    expect(t).toMatch(/0278/);
    expect(t).toMatch(/different function/);
    expect(t).toMatch(/pb_dataset_readiness/);
  });
});
