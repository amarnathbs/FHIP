// Planning Benchmarks migration 0278 - the preview of an observed values upload must not claim that bands are removed
// (finding D1 of the DEV walkthrough of 07/10/2026). Real-Postgres (PGlite) proof: the whole ledger (0001 .. 0278) is
// replayed into an isolated in-memory Postgres and the real SECURITY DEFINER functions are called as the real roles.
//
// EVIDENCE LABEL: PGlite-verified. NOT DEV-verified (0278 is applied nowhere).
//
// FAILING-FIRST: NC-B1 runs the D1 assertion against the 0275 version of pb_removed_band_ids and it goes red there.
// NAMED NEGATIVE CONTROLS:
//   NC-B1  with the 0275 function restored a values batch over live bands reports removed bands (the false statement);
//   NC-B2  with the kind condition removed from 0278 the same assertion fails;
//   NC-B3  a values batch staged under the 0275 function is refused after 0278 (nothing goes live on a wrong preview).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hazards } from './support/sqlEditorHazards';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
const MIG_NAME = '0278_planning_benchmark_removed_bands_target_ranges_only.sql';
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, MIG_NAME), 'utf8');
const MIG_0275 = fs.readFileSync(path.join(MIG_DIR, '0275_planning_benchmark_staged_upload.sql'), 'utf8');
function extractFn(sql: string, name: string): string {
  const m = sql.match(new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$fn\\$;`));
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
const OLD_FN = extractFn(MIG_0275, 'pb_removed_band_ids');
const NEW_FN = extractFn(MIGRATION, 'pb_removed_band_ids');

const UP = 'dddddddd-0000-0000-0000-00000000c001';
const ACT = 'dddddddd-0000-0000-0000-00000000c002';
const DS = 'PB BAND VALUES DATASET';
const DSR = 'PB BAND RANGE DATASET';
const M = 'income_growth_12m';
const M2 = 'income_concentration';

let db: PGlite;
type Json = Record<string, unknown>;
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated;');
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const sha = () => crypto.randomBytes(32).toString('hex');
const q = async <T = Json>(sql: string, args: unknown[] = []): Promise<T[]> => (await db.query(sql, args)).rows as T[];
async function expectCode(p: Promise<unknown>, code: string) {
  let message = '';
  try {
    await p;
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, `expected rejection containing ${code}`).toContain(code);
}
const vrow = (n: number, over: Json = {}): Json => ({
  row_no: n, dataset_name: DS, dataset_version: '1.0', cohort_code: '', metric_code: M, statistic_type: 'median', value_numeric: 5, unit: 'percentage', original_currency: '',
  base_date: '2020-06-30', effective_from: null, is_derived: false, derivation_method: '', confidence_score: null, value_text: 'prov', source_release: 'release',
  observation_period_start: '2019-07-01', observation_period_end: '2020-06-30', source_file: 'file.xlsx', source_locator: 'T1!B2', retrieval_date: '2026-10-01', ...over,
});
const trow = (n: number, over: Json = {}): Json => ({
  row_no: n, dataset_name: DSR, dataset_version: '1.0', metric_code: M, source_name: 'PB_TEST_SOURCE', country_code: 'AU', life_stage: '', household_type: 'single', band_label: 'low', band_tier: 1,
  lower_bound: 0, upper_bound: 10, direction: 'target_range', explanation: 'x', evidence_level: 'official_statistical', model_version: 'm-1', effective_from: null, source_release: 'release',
  observation_period_start: '2026-02-01', observation_period_end: null, source_file: 'f.pdf', source_locator: 'p3', retrieval_date: '2026-10-01', ...over,
});
const MARKER = { values: 'FHIP-PB-VALUES-1', target_ranges: 'FHIP-PB-RANGES-1' } as const;
async function stage(kind: keyof typeof MARKER, rows: Json[]): Promise<Json> {
  const p = { kind, dataset_name: rows[0].dataset_name, dataset_version: '1.0', file_name: 'f.csv', file_sha256: sha(), file_bytes: 1000, template_version: MARKER[kind], rows };
  return as(UP, async () => ((await db.query(`select public.stage_planning_benchmark_upload($1::jsonb) v`, [JSON.stringify(p)])).rows[0] as { v: Json }).v);
}
const get = (id: string): Promise<Json> => as(ACT, async () => ((await db.query(`select public.get_planning_benchmark_upload($1) v`, [id])).rows[0] as { v: Json }).v);
function bind(b: Json) {
  return { expected_sha256: b.file_sha256, expected_digest: b.staging_digest, expected_counts: b.counts, self_activation_ack: false };
}
async function activate(id: string): Promise<Json> {
  const p = bind((await get(id)).batch as Json);
  return as(ACT, async () => ((await db.query(`select public.activate_planning_benchmark_upload($1, $2::jsonb) v`, [id, JSON.stringify(p)])).rows[0] as { v: Json }).v);
}
const mid = async (code: string) => ((await q<{ id: string }>(`select id from benchmark_metric_definitions where metric_code = $1`, [code]))[0]).id;
const liveBands = async (code: string) =>
  await q<{ id: string; band_tier: number; band_label: string }>(`select id, band_tier, band_label from benchmark_target_ranges where metric_definition_id = $1 and (effective_to is null or effective_to > current_date) order by band_tier, id`, [await mid(code)]);
const endedToday = async (code: string) =>
  (await q<{ id: string }>(`select id from benchmark_target_ranges where metric_definition_id = $1 and effective_to = current_date order by id`, [await mid(code)])).map((r) => r.id);
const removedIds = async (batch: string) => ((await q<{ r: string[] }>(`select public.pb_removed_band_ids('${batch}') r`))[0]).r;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  expect(files).toContain(MIG_NAME);
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec(`insert into auth.users(id,email) values ('${UP}','up@pg.test'),('${ACT}','act@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${UP}'),('${ACT}');`);
  await db.exec(`update admin_users set can_upload_planning_benchmarks = true where user_id = '${UP}';`);
  await db.exec(`update admin_users set can_activate_planning_benchmarks = true, can_upload_planning_benchmarks = true where user_id = '${ACT}';`);
  await db.exec(`
    insert into benchmark_sources (source_name, source_type, publisher, source_title, citation_text, publication_date, status)
      values ('PB_TEST_SOURCE','official','Pub','Title','Cite',date '2026-01-01','approved');
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, '${DS}', '1.0', 'observed_market', 'FY', 'country', 'median', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE';
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, '${DSR}', '1.0', 'fhip_planning', 'FY', 'country', 'bands', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE';
    insert into benchmark_dataset_metrics (dataset_id, metric_definition_id, applies_to_values, applies_to_target_ranges, evidence_note)
      select d.id, m.id, d.dataset_name = '${DS}', d.dataset_name = '${DSR}', 'test mapping'
        from benchmark_datasets d join benchmark_metric_definitions m on m.metric_code in ('${M}', '${M2}')
       where d.dataset_name in ('${DS}', '${DSR}');
  `);
  // Live bands for metric M: three tiers of one group (AU, single) and one legacy band with no country, life stage or household type,
  // the shape that made the false preview on DEV (4 bands removed by a values upload).
  const first = await stage('target_ranges', [
    trow(2, { band_label: 'low', band_tier: 1, lower_bound: null, upper_bound: 10 }),
    trow(3, { band_label: 'mid', band_tier: 2, lower_bound: 10, upper_bound: 20 }),
    trow(4, { band_label: 'high', band_tier: 3, lower_bound: 20, upper_bound: null }),
  ]);
  await activate(first.batch_id as string);
  await db.exec(`insert into benchmark_target_ranges (metric_definition_id, band_label, band_tier, lower_bound, upper_bound) values ('${await mid(M)}', 'legacy', 1, 0, 5)`);
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('D1: a values batch over live bands reports no removed bands', () => {
  it('NEW: the staged counts, the preview list, the digest input and the activation result all say 0, and no band is touched', async () => {
    const before = await liveBands(M);
    expect(before.length).toBe(4);
    const s = await stage('values', [vrow(2)]);
    expect(s.status).toBe('staged');
    expect(s.counts).toMatchObject({ new: 1, removed: 0 });
    expect(await removedIds(s.batch_id as string)).toEqual([]);
    const v = await get(s.batch_id as string);
    expect(v.removed).toEqual([]);
    const r = await activate(s.batch_id as string);
    expect(r.result).toMatchObject({ rows_inserted: 1, bands_removed: 0 });
    expect(await liveBands(M)).toEqual(before);
    expect(await endedToday(M)).toEqual([]);
  });

  it('a values batch for another metric with no live bands is also 0 (control)', async () => {
    const s = await stage('values', [vrow(2, { metric_code: M2, statistic_type: 'mean' })]);
    expect(s.counts).toMatchObject({ removed: 0 });
  });
});

describe('a target ranges batch still reports exactly the tiers it would remove, and activation retires exactly those', () => {
  it('a missing tier is reported in the counts and the preview, and the ids retired are the ids previewed', async () => {
    const live = await liveBands(M);
    const s = await stage('target_ranges', [trow(2, { band_label: 'low', band_tier: 1, lower_bound: null, upper_bound: 10 }), trow(3, { band_label: 'mid', band_tier: 2, lower_bound: 10, upper_bound: 25 })]);
    // the group is AU single: tier 3 is not restated. The legacy band has other attributes so it is a different group.
    expect(s.counts).toMatchObject({ unchanged: 1, changed: 1, new: 0, removed: 1 });
    const previewed = await removedIds(s.batch_id as string);
    const high = live.find((b) => b.band_label === 'high')!;
    expect(previewed).toEqual([high.id]);
    const v = await get(s.batch_id as string);
    expect(v.removed as Json[]).toEqual([expect.objectContaining({ band_label: 'high', band_tier: 3 })]);
    const r = await activate(s.batch_id as string);
    expect(r.result).toMatchObject({ bands_removed: 1, rows_end_dated: 2 });
    const ended = await endedToday(M);
    // end-dated = the changed tier 2 plus exactly the previewed removed band
    expect(ended).toContain(high.id);
    expect(ended).toHaveLength(2);
    const after = await liveBands(M);
    expect(after.map((b) => b.id)).not.toContain(high.id);
    expect(after.some((b) => b.band_label === 'legacy')).toBe(true);
  });

  it('a first load of a new group reports 0 removed, and a cohorts batch never reports any', async () => {
    const s = await stage('target_ranges', [trow(2, { metric_code: M2, band_label: 'low', band_tier: 1 })]);
    expect(s.counts).toMatchObject({ new: 1, removed: 0 });
    const c = { row_no: 2, dataset_name: DS, dataset_version: '1.0', cohort_code: 'PB_BAND_COHORT', country_code: 'AU', region_code: '', urban_rural: '', age_band: 'AGE_25_34', income_band: '', household_type: '', life_stage: '', housing_tenure: '', employment_type: '', dependant_band: '', financial_dna_code: '', cross_border_flag: false, cohort_tier: 4, sample_size: null, cohort_description: 'Test cohort', source_release: 'r', source_file: 'f', source_locator: 'x' };
    const p = { kind: 'cohorts', dataset_name: DS, dataset_version: '1.0', file_name: 'c.csv', file_sha256: sha(), file_bytes: 10, template_version: 'FHIP-PB-COHORTS-1', rows: [c] };
    const cs = await as(UP, async () => ((await db.query(`select public.stage_planning_benchmark_upload($1::jsonb) v`, [JSON.stringify(p)])).rows[0] as { v: Json }).v);
    expect(cs.counts).toMatchObject({ removed: 0 });
  });
});

describe('negative controls (each must go red against a broken function)', () => {
  it('NC-B1: with the 0275 function the values batch reports removed bands, so the D1 assertion fails (the failing-first proof)', async () => {
    await db.exec(OLD_FN);
    try {
      const s = await stage('values', [vrow(2, { statistic_type: 'p25' })]);
      expect(s.counts, 'NC-B1 named assertion: a values batch must report 0 removed bands').toMatchObject({ removed: 0 });
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-B1 named assertion');
      return;
    } finally {
      await db.exec(NEW_FN);
    }
    throw new Error('the control did not go red');
  });

  it('NC-B2: with the kind condition removed from the new function the same assertion fails', async () => {
    const mutated = NEW_FN.replace("where exists (select 1 from public.benchmark_upload_batches ub where ub.id = p_batch and ub.kind = 'target_ranges')\n     and ", 'where ');
    expect(mutated).not.toBe(NEW_FN);
    await db.exec(mutated);
    try {
      const s = await stage('values', [vrow(2, { statistic_type: 'p80' })]);
      expect(s.counts, 'NC-B2 named assertion: a values batch must report 0 removed bands').toMatchObject({ removed: 0 });
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-B2 named assertion');
      return;
    } finally {
      await db.exec(NEW_FN);
    }
    throw new Error('the control did not go red');
  });

  it('NC-B3: a values batch staged under the 0275 function (false count, false digest) is refused after 0278 and never activated', async () => {
    await db.exec(OLD_FN);
    let id = '';
    try {
      const s = await stage('values', [vrow(2, { statistic_type: 'p10', value_numeric: 35 })]);
      expect(Number((s.counts as Json).removed)).toBeGreaterThan(0);
      id = s.batch_id as string;
    } finally {
      await db.exec(NEW_FN);
    }
    const count35 = async () => (await q<{ c: number }>(`select count(*)::int c from benchmark_values where value_numeric = 35`))[0].c;
    const before = await count35();
    // the activation is bound to the digest stored at staging, which contained the false list, so it is refused as stale
    const p = bind((await get(id)).batch as Json);
    await expectCode(as(ACT, () => db.query(`select public.activate_planning_benchmark_upload($1, $2::jsonb)`, [id, JSON.stringify(p)])), 'PB_E_STALE');
    expect(await count35()).toBe(before);
    expect((await q<{ status: string }>(`select status from benchmark_upload_batches where id = '${id}'`))[0].status).toBe('staged');
    // staging the same file again gives a correct batch that activates
    const again = await stage('values', [vrow(2, { statistic_type: 'p10', value_numeric: 35 })]);
    expect(again.counts).toMatchObject({ removed: 0 });
    expect((await activate(again.batch_id as string)).status).toBe('activated');
  });
});

describe('migration shape', () => {
  it('re-emits only pb_removed_band_ids: idempotent, no EXECUTE for API roles, the 0277 readiness function untouched, editor safe', async () => {
    const def = async () => (await q<{ d: string }>(`select pg_get_functiondef('public.pb_dataset_readiness(uuid, uuid)'::regprocedure) d`))[0].d;
    const defBefore = await def();
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
    const defAfter = await def();
    expect(defAfter).toBe(defBefore);
    expect(defAfter).toMatch(/benchmark_dataset_metrics/); // still the 0277 version
    const code = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/pb_dataset_readiness|drop |alter table|create table|create trigger/i);
    expect((code.match(/create or replace function/g) ?? []).length).toBe(1);
    expect(hazards(MIGRATION)).toEqual([]);
    for (const role of ['anon', 'authenticated']) {
      expect((await q<{ ok: boolean }>(`select has_function_privilege('${role}', 'public.pb_removed_band_ids(uuid)', 'execute') ok`))[0].ok, role).toBe(false);
    }
  });
});

const V2_README = () => fs.readFileSync(path.resolve(HERE, '..', '..', 'docs', 'planning-benchmarks', 'po_apply_upload_PRODUCTION_v2', 'README.md'), 'utf8');
const sqlBlocks = () => [...V2_README().matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('the check queries of the PRODUCTION v2 README run on the replayed ledger and return what the README promises', () => {
  it('step 1, step 2, per-dataset, step 3 and the readiness check', async () => {
    const blocks = sqlBlocks().filter((b) => b.trimStart().startsWith('select'));
    expect(blocks).toHaveLength(5);
    const rows: Array<Array<Record<string, unknown>>> = [];
    for (const b of blocks) rows.push((await db.query(b)).rows as Array<Record<string, unknown>>);
    expect(rows[0][0]).toEqual({ tables_ok: true, columns_ok: true, functions_ok: true });
    expect(rows[1][0]).toEqual({ tables_ok: true, functions_ok: true, trigger_ok: true, no_api_write_ok: true });
    expect(rows[2].length).toBeGreaterThanOrEqual(11);
    expect(rows[3][0]).toEqual({ kind_rule_ok: true, anon_blocked: true, authenticated_blocked: true });
    expect(rows[4][0]).toEqual({ readiness_still_has_mapping_rule: true });
  });

  it('NC-B4: the step 3 check goes red against the 0275 function (it detects an unapplied 0278)', async () => {
    const check = sqlBlocks().find((b) => b.includes('kind_rule_ok'))!;
    await db.exec(OLD_FN);
    try {
      expect(((await db.query(check)).rows[0] as Json).kind_rule_ok).toBe(false);
    } finally {
      await db.exec(NEW_FN);
    }
    expect(((await db.query(check)).rows[0] as Json).kind_rule_ok).toBe(true);
  });
});
