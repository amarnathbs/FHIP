// Migration 0277 (Planning Benchmarks dataset to metric mapping): hand-run safety, parts, and the proof that the rows the
// migration seeds EQUAL the reviewable table in docs/planning-benchmarks/DATASET_METRIC_MAPPING.md.
// Evidence label: UNIT-TESTED (text checks). The behaviour of the SQL is proven on PGlite
// (planningBenchmarkDatasetMetricMappingPglite.test.ts).
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  the seed equals the document row for row (a changed, added or dropped row in either breaks it);
//   NC-S2  the comparison itself bites: a mutated copy of the document is reported as different;
//   NC-M1  the three parts joined are byte-equal to the migration;
//   NC-M2  the editor-safety lint flags a bad snippet and covers the rollback file too.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from './support/sqlEditorHazards';
import { METRIC_CATALOGUE } from '@/lib/engines/twin/metricCatalogue';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0277_planning_benchmark_dataset_metric_mapping.sql'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'planning-benchmarks', 'DATASET_METRIC_MAPPING.md'), 'utf8');
const PARTS = path.join(ROOT, 'docs', 'planning-benchmarks', 'po_apply_mapping', 'parts');
const part = (l: string) => fs.readFileSync(path.join(PARTS, `0277${l}.sql`), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'docs', 'planning-benchmarks', 'po_apply_mapping', 'rollback.sql'), 'utf8');

interface Pair {
  dataset: string;
  version: string;
  metric: string;
  values: boolean;
  ranges: boolean;
  evidence: string;
}
const key = (p: Pair) => `${p.dataset}|${p.version}|${p.metric}`;

function seedRows(sql: string): Pair[] {
  const block = /from \(values\n([\s\S]*?)\n\s*\) as s\(/.exec(sql);
  if (!block) throw new Error('seed block not found');
  const rows: Pair[] = [];
  for (const line of block[1].split('\n')) {
    const m = /^\s*\('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', (true|false), (true|false), '((?:[^']|'')*)'\),?$/.exec(line);
    if (!m) throw new Error(`unparsable seed line: ${line}`);
    const un = (s: string) => s.replace(/''/g, "'");
    rows.push({ dataset: un(m[1]), version: un(m[2]), metric: un(m[3]), values: m[4] === 'true', ranges: m[5] === 'true', evidence: un(m[6]) });
  }
  return rows;
}

function docRows(md: string): Array<Pair & { unit: string }> {
  const rows: Array<Pair & { unit: string }> = [];
  let inTable = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('| dataset | version | metric_code | unit | kind | evidence |')) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (line.startsWith('|---')) continue;
    if (!line.startsWith('|')) break;
    const c = line.slice(1, -1).split(' | ').map((x) => x.trim());
    if (c.length !== 6) throw new Error(`bad doc row: ${line}`);
    const kind = c[4];
    if (!['values', 'target ranges', 'values and target ranges'].includes(kind)) throw new Error(`bad kind: ${kind}`);
    rows.push({ dataset: c[0], version: c[1], metric: c[2], unit: c[3], values: kind !== 'target ranges', ranges: kind !== 'values', evidence: c[5] });
  }
  return rows;
}

function differences(a: Pair[], b: Pair[]): string[] {
  const out: string[] = [];
  const mb = new Map(b.map((p) => [key(p), p]));
  const ma = new Map(a.map((p) => [key(p), p]));
  if (ma.size !== a.length) out.push('duplicate pair in the first list');
  if (mb.size !== b.length) out.push('duplicate pair in the second list');
  for (const p of a) {
    const q = mb.get(key(p));
    if (!q) out.push(`only in the first list: ${key(p)}`);
    else if (q.values !== p.values || q.ranges !== p.ranges) out.push(`kind differs: ${key(p)}`);
    else if (q.evidence !== p.evidence) out.push(`evidence differs: ${key(p)}`);
  }
  for (const q of b) if (!ma.has(key(q))) out.push(`only in the second list: ${key(q)}`);
  return out;
}

describe('the migration seed equals the reviewable document', () => {
  const seed = seedRows(MIGRATION);
  const doc = docRows(DOC);

  it('NC-S1: every row, kind and evidence text is identical, and the count is the one the document states', () => {
    expect(doc.length).toBe(seed.length);
    expect(differences(seed, doc)).toEqual([]);
    expect(DOC).toContain(`The seeded mapping (${seed.length} pairs`);
  });

  it('NC-S2: the comparison bites on a dropped, an added, a re-kinded and a re-worded row', () => {
    expect(differences(seed, doc.slice(1))).not.toEqual([]);
    expect(differences(seed, [...doc, { ...doc[0], metric: 'invented_metric' }])).not.toEqual([]);
    expect(differences(seed, doc.map((p, i) => (i === 3 ? { ...p, ranges: !p.ranges } : p)))).not.toEqual([]);
    expect(differences(seed, doc.map((p, i) => (i === 5 ? { ...p, evidence: p.evidence + ' x' } : p)))).not.toEqual([]);
    expect(differences(seed, doc.map((p, i) => (i === 7 ? { ...p, dataset: 'Other' } : p)))).not.toEqual([]);
  });

  it('every pair has at least one kind, an evidence text, and no pair repeats', () => {
    for (const p of seed) {
      expect(p.values || p.ranges, key(p)).toBe(true);
      expect(p.evidence.length, key(p)).toBeGreaterThan(10);
    }
    expect(new Set(seed.map(key)).size).toBe(seed.length);
  });

  it('the unit column is the unit the metric is defined in (checked against the repo metric catalogue)', () => {
    const unit = new Map(METRIC_CATALOGUE.map((m) => [m.code, m.unit]));
    for (const p of doc) {
      expect(unit.has(p.metric), `${p.metric} is a registered metric`).toBe(true);
      expect(p.unit, p.metric).toBe(unit.get(p.metric));
    }
  });

  it('no dataset is mapped for a kind its first-load evidence does not support (spot checks of the Product Owner decisions)', () => {
    const has = (d: string, m: string) => seed.find((p) => p.dataset === d && p.metric === m);
    // India household assets: the register refused liquid_asset_share, so it is NOT seeded (listed as needs PO input)
    expect(has('India household assets and debt (rural/urban)', 'liquid_asset_share')).toBeUndefined();
    expect(has('India household assets and debt (rural/urban)', 'total_assets')?.values).toBe(true);
    // the consumption dataset has no metric that can hold its figure: nothing seeded
    expect(seed.some((p) => p.dataset.startsWith('India household consumption'))).toBe(false);
    // planning bands: the two planning-band datasets are target ranges only
    for (const p of seed.filter((x) => x.dataset === 'FHIP Planning Benchmarks v1.0' || x.dataset === 'AU ASFA retirement standard')) expect(p.ranges && !p.values, key(p)).toBe(true);
    expect(seed.filter((p) => p.dataset === 'FHIP Planning Benchmarks v1.0')).toHaveLength(48);
    // net worth is mapped to the two datasets that hold it and to no other
    expect(seed.filter((p) => p.metric === 'net_worth').map((p) => p.dataset).sort()).toEqual(['AU household wealth distribution', 'AU net worth and income by age band']);
  });

  it('the document lists the needs-PO-input items and the metrics that are mapped to no dataset', () => {
    const mapped = new Set(seed.map((p) => p.metric));
    const unmapped = METRIC_CATALOGUE.map((m) => m.code).filter((c) => !mapped.has(c));
    expect(unmapped.length).toBeGreaterThan(0);
    for (const c of unmapped) expect(DOC, c).toContain('`' + c + '`');
    expect(DOC).toMatch(/Needs Product Owner input/);
    expect(DOC).toContain('liquid_asset_share');
  });
});

describe('migration 0277 hand-run safety', () => {
  it('NC-M1: parts a, b, c joined are byte-equal to the migration file', () => {
    expect([part('a'), part('b'), part('c')].join('')).toBe(MIGRATION);
  });

  it('every part starts on its banner or the file header and ends on a complete statement (pasteable alone)', () => {
    expect(part('a').startsWith('-- 0277')).toBe(true);
    expect(part('b').startsWith('-- PART B starts here')).toBe(true);
    expect(part('c').startsWith('-- PART C starts here')).toBe(true);
    for (const l of ['a', 'b', 'c']) {
      const code = part(l).split(/\r?\n/).filter((x) => x.trim() && !x.trim().startsWith('--'));
      expect(code[code.length - 1].trimEnd().endsWith(';')).toBe(true);
    }
  });

  it('the migration, each part and the rollback pass the editor-safety lint', () => {
    expect(hazards(MIGRATION)).toEqual([]);
    for (const l of ['a', 'b', 'c']) expect(hazards(part(l))).toEqual([]);
    expect(hazards(ROLLBACK)).toEqual([]);
  });

  it('NC-M2: the lint bites on bad snippets', () => {
    expect(hazards('-- rows from public')).not.toEqual([]);
    expect(hazards("select 'insert into foo'")).not.toEqual([]);
    expect(hazards('select 1 -- a; b')).not.toEqual([]);
    expect(hazards('select 10 % 3')).not.toEqual([]);
  });

  it('nothing existing is dropped or recreated: no drop constraint, no drop of an existing table, no widened shared check', () => {
    const code = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/drop\s+constraint/i);
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toMatch(/alter\s+table\s+(public\.)?(benchmark_update_runs|admin_users|benchmark_values|benchmark_target_ranges|benchmark_datasets|benchmark_upload_batches|benchmark_upload_rows)/i);
  });

  it('contract: tables, RLS, the two maintenance functions and the trigger exist; API roles get no write grant; EXECUTE is revoked from public and anon; no new capability column', () => {
    for (const t of ['benchmark_dataset_metrics', 'benchmark_dataset_metric_events']) {
      expect(MIGRATION).toMatch(new RegExp(`create table if not exists ${t}`));
      expect(MIGRATION).toMatch(new RegExp(`alter table ${t} enable row level security`));
    }
    for (const f of ['set_planning_benchmark_dataset_metric', 'remove_planning_benchmark_dataset_metric', 'pb_enforce_dataset_metric']) expect(MIGRATION).toContain(f);
    expect(MIGRATION).toMatch(/revoke all on function set_planning_benchmark_dataset_metric[\s\S]*from public, anon/i);
    expect(MIGRATION).toMatch(/security definer set search_path = ''/i);
    expect(MIGRATION).not.toMatch(/grant (all|insert|update|delete)[^;]*benchmark_dataset_metric[^;]*to (anon|authenticated)/i);
    expect(MIGRATION).not.toMatch(/add column[^;]*can_/i);
    expect(MIGRATION.match(/is_planning_benchmark_activator\(\)/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
