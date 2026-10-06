// Planning Benchmarks staged upload (migration 0270) - real-Postgres (PGlite) proof of the DATABASE half.
//
// The whole migration ledger (0001 .. latest, including 0270) is replayed into an ISOLATED in-memory Postgres.
// Every rule is then exercised through the real SECURITY DEFINER functions as the real database roles with
// auth.uid() driven by request.jwt.claims. Nothing is reimplemented in the test.
//
// EVIDENCE LABEL: PGlite-verified. NOT DEV-verified and NOT production-verified (0270 is applied nowhere).
//
// NAMED NEGATIVE CONTROLS (NC-DB*). A green test proves nothing if it cannot go red. Each control runs the SAME
// assertion against a copy of the function with exactly one rule surgically removed, and the assertion MUST
// fail (the mutation is verified to have changed the SQL, the failure must be an AssertionError raised by the
// NAMED assertion, and the real function is restored afterwards).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
const MIG_NAME = '0270_planning_benchmark_staged_upload.sql';
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, MIG_NAME), 'utf8');

const UP = 'cccccccc-0000-0000-0000-00000000a001'; // can_upload only
const ACT = 'cccccccc-0000-0000-0000-00000000a002'; // can_activate only
const BOTH = 'cccccccc-0000-0000-0000-00000000a003'; // both
const NOCAP = 'cccccccc-0000-0000-0000-00000000a004'; // admin row, no capability
const PLAIN = 'cccccccc-0000-0000-0000-00000000a005'; // ordinary user
const UP2 = 'cccccccc-0000-0000-0000-00000000a006'; // second uploader

const DS = 'PB TEST DATASET';
const M_CUR = 'gross_household_income';
const M_PCT = 'income_growth_12m';
const M_PCT2 = 'income_concentration';

let db: PGlite;
type Json = Record<string, unknown>;

type Role = 'authenticated' | 'anon' | 'service_role';
async function as<T>(uid: string | null, role: Role, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

const sha = () => crypto.randomBytes(32).toString('hex');
const today = async () => ((await db.query(`select current_date::text d`)).rows[0] as { d: string }).d;

function extractFn(sql: string, name: string): string {
  const re = new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$fn\\$;`);
  const m = sql.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
const ACTIVATE_FN = extractFn(MIGRATION, 'activate_planning_benchmark_upload');

async function expectCode(p: Promise<unknown>, code: string) {
  let message = '';
  try {
    await p;
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, `expected rejection containing ${code}`).toContain(code);
}

// ---------------------------------------------------------------- row builders ---
const vrow = (n: number, over: Json = {}): Json => ({
  row_no: n,
  dataset_name: DS,
  dataset_version: '1.0',
  cohort_code: '',
  metric_code: M_CUR,
  statistic_type: 'median',
  value_numeric: 100,
  unit: 'currency',
  original_currency: 'AUD',
  base_date: '2020-06-30',
  effective_from: null,
  is_derived: false,
  derivation_method: '',
  confidence_score: null,
  value_text: 'prov text',
  source_release: 'release',
  observation_period_start: '2019-07-01',
  observation_period_end: '2020-06-30',
  source_file: 'file.xlsx',
  source_locator: 'T1!B2',
  retrieval_date: '2026-10-01',
  ...over,
});
const trow = (n: number, over: Json = {}): Json => ({
  row_no: n,
  dataset_name: 'PB RANGE DATASET',
  dataset_version: '1.0',
  metric_code: M_PCT,
  source_name: 'PB_TEST_SOURCE',
  country_code: 'AU',
  life_stage: '',
  household_type: 'single',
  band_label: 'low',
  band_tier: 1,
  lower_bound: 0,
  upper_bound: 10,
  direction: 'target_range',
  explanation: 'x',
  evidence_level: 'official_statistical',
  model_version: 'm-1',
  effective_from: null,
  source_release: 'release',
  observation_period_start: '2026-02-01',
  observation_period_end: null,
  source_file: 'f.pdf',
  source_locator: 'p3',
  retrieval_date: '2026-10-01',
  ...over,
});
const crow = (n: number, over: Json = {}): Json => ({
  row_no: n,
  dataset_name: DS,
  dataset_version: '1.0',
  cohort_code: 'PB_COHORT_A',
  country_code: 'AU',
  region_code: '',
  urban_rural: '',
  age_band: 'AGE_25_34',
  income_band: '',
  household_type: '',
  life_stage: '',
  housing_tenure: '',
  employment_type: '',
  dependant_band: '',
  financial_dna_code: '',
  cross_border_flag: false,
  cohort_tier: 4,
  sample_size: null,
  cohort_description: 'Test cohort',
  source_release: 'release',
  source_file: 'f.xlsx',
  source_locator: 'r9',
  ...over,
});

const MARKER = { values: 'FHIP-PB-VALUES-1', target_ranges: 'FHIP-PB-RANGES-1', cohorts: 'FHIP-PB-COHORTS-1' } as const;

async function stage(uid: string, kind: keyof typeof MARKER, rows: Json[], over: Json = {}): Promise<Json> {
  const p = { kind, dataset_name: (rows[0]?.dataset_name as string) ?? DS, dataset_version: '1.0', file_name: 'f.csv', file_sha256: sha(), file_bytes: 1000, template_version: MARKER[kind], rows, ...over };
  return as(uid, 'authenticated', async () => ((await db.query(`select public.stage_planning_benchmark_upload($1::jsonb) v`, [JSON.stringify(p)])).rows[0] as { v: Json }).v);
}
async function get(uid: string, id: string): Promise<Json> {
  return as(uid, 'authenticated', async () => ((await db.query(`select public.get_planning_benchmark_upload($1) v`, [id])).rows[0] as { v: Json }).v);
}
async function activate(uid: string, id: string, ack = false, over: Json = {}): Promise<Json> {
  const view = await get(uid, id);
  const b = view.batch as Json;
  const p = { expected_sha256: b.file_sha256, expected_digest: b.staging_digest, expected_counts: b.counts, self_activation_ack: ack, ...over };
  return as(uid, 'authenticated', async () => ((await db.query(`select public.activate_planning_benchmark_upload($1, $2::jsonb) v`, [id, JSON.stringify(p)])).rows[0] as { v: Json }).v);
}
async function discard(uid: string, id: string, reason = 'wrong file'): Promise<Json> {
  return as(uid, 'authenticated', async () => ((await db.query(`select public.discard_planning_benchmark_upload($1, $2) v`, [id, reason])).rows[0] as { v: Json }).v);
}

const q = async <T = Json>(sql: string, args: unknown[] = []): Promise<T[]> => (await db.query(sql, args)).rows as T[];
const dsId = async (name: string) => ((await q<{ id: string }>(`select id from benchmark_datasets where dataset_name = $1 and version = '1.0'`, [name]))[0]).id;
const metricId = async (code: string) => ((await q<{ id: string }>(`select id from benchmark_metric_definitions where metric_code = $1`, [code]))[0]).id;
const liveValues = async (ds: string) =>
  q<{ metric_code: string; statistic_type: string; value_numeric: string; version: number; effective_to: string | null }>(
    `select m.metric_code, v.statistic_type, v.value_numeric::text, v.version, v.effective_to::text from benchmark_values v join benchmark_metric_definitions m on m.id = v.metric_definition_id
      where v.dataset_id = $1 and (v.effective_to is null or v.effective_to > current_date) order by m.metric_code, v.statistic_type`,
    [await dsId(ds)]
  );
const countAll = async (t: string) => ((await q<{ c: number }>(`select count(*)::int c from ${t}`))[0]).c;

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
  await db.exec(`insert into auth.users(id,email) values ('${UP}','up@pg.test'),('${ACT}','act@pg.test'),('${BOTH}','both@pg.test'),('${NOCAP}','nocap@pg.test'),('${PLAIN}','plain@pg.test'),('${UP2}','up2@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${UP}'),('${ACT}'),('${BOTH}'),('${NOCAP}'),('${UP2}');`);
  await db.exec(`update admin_users set can_upload_planning_benchmarks = true where user_id in ('${UP}','${BOTH}','${UP2}');`);
  await db.exec(`update admin_users set can_activate_planning_benchmarks = true where user_id in ('${ACT}','${BOTH}');`);
  await db.exec(`
    insert into benchmark_sources (source_name, source_type, publisher, source_title, citation_text, publication_date, status)
      values ('PB_TEST_SOURCE','official','Pub','Title','Cite',date '2026-01-01','approved'),
             ('PB_DRAFT_SOURCE','official','Pub','Title','Cite',date '2026-01-01','draft'),
             ('PB_REVIEW_SOURCE','official','Pub','Title','Cite',date '2026-01-01','under_review'),
             ('PB_OTHER_SOURCE','official','Pub','Title','Cite',date '2026-01-01','approved');
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, '${DS}', '1.0', 'observed_market', 'FY', 'country', 'median', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE';
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, 'PB TEST DATASET 2', '1.0', 'observed_market', 'FY', 'country', 'median', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE';
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, 'PB RANGE DATASET', '1.0', 'fhip_planning', 'FY', 'country', 'bands', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE';
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, 'PB DRAFT SRC DATASET', '1.0', 'fhip_planning', 'FY', 'country', 'bands', 'draft' from benchmark_sources where source_name = 'PB_DRAFT_SOURCE';
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, 'PB REVIEW SRC DATASET', '1.0', 'fhip_planning', 'FY', 'country', 'bands', 'draft' from benchmark_sources where source_name = 'PB_REVIEW_SOURCE';
    insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, 'PB SUSPENDED DATASET', '1.0', 'fhip_planning', 'FY', 'country', 'bands', 'suspended' from benchmark_sources where source_name = 'PB_TEST_SOURCE';
  `);
}, 600_000);

afterAll(async () => {
  await db?.close();
});

// ------------------------------------------------------------------------------------------------ shape ---
describe('migration 0270 - shape', () => {
  it('adds the two capability columns defaulting to false and grants them to nobody', async () => {
    const cols = await q<{ column_name: string; column_default: string }>(
      `select column_name, column_default from information_schema.columns where table_name = 'admin_users' and column_name in ('can_upload_planning_benchmarks','can_activate_planning_benchmarks') order by 1`
    );
    expect(cols.map((c) => c.column_name)).toEqual(['can_activate_planning_benchmarks', 'can_upload_planning_benchmarks']);
    for (const c of cols) expect(c.column_default).toBe('false');
    const granted = await q<{ c: number }>(`select count(*)::int c from admin_users where user_id not in ('${UP}','${ACT}','${BOTH}','${UP2}') and (can_upload_planning_benchmarks or can_activate_planning_benchmarks)`);
    expect(granted[0].c).toBe(0);
  });

  it('has RLS on all three tables and no write privilege for anon or authenticated', async () => {
    for (const t of ['benchmark_upload_batches', 'benchmark_upload_rows', 'benchmark_upload_events']) {
      const rls = (await q<{ r: boolean }>(`select relrowsecurity r from pg_class where oid = 'public.${t}'::regclass`))[0];
      expect(rls.r, t).toBe(true);
      const grants = (await q<{ p: string }>(`select privilege_type p from information_schema.role_table_grants where table_name = $1 and grantee in ('anon','authenticated') order by 1`, [t])).map((g) => g.p);
      expect(grants, t).toEqual(['SELECT']);
    }
  });

  it('is idempotent: the whole migration can be applied a second time without error', async () => {
    await db.exec(MIGRATION);
    const fns = await q<{ c: number }>(`select count(*)::int c from pg_proc where proname in ('stage_planning_benchmark_upload','get_planning_benchmark_upload','activate_planning_benchmark_upload','discard_planning_benchmark_upload')`);
    expect(fns[0].c).toBe(4);
  });
});

// ------------------------------------------------------------------- authorisation (Standard s2/s4, DB layer) ---
describe('authorisation - the capability is enforced in the DATABASE (database-bypass tests)', () => {
  const rows = () => [vrow(2)];

  it('an ordinary user, an admin WITHOUT either capability, anon and service_role cannot stage, get, activate or discard', async () => {
    for (const who of [PLAIN, NOCAP]) {
      await expectCode(stage(who, 'values', rows()), 'PB_E_DENIED');
      await expectCode(get(who, '00000000-0000-0000-0000-000000000000'), 'PB_E_DENIED');
      await expectCode(as(who, 'authenticated', () => db.query(`select public.activate_planning_benchmark_upload('00000000-0000-0000-0000-000000000000', '{}'::jsonb)`)), 'PB_E_DENIED');
      await expectCode(discard(who, '00000000-0000-0000-0000-000000000000'), 'PB_E_DENIED');
    }
    await expect(as(null, 'anon', () => db.query(`select public.stage_planning_benchmark_upload('{}'::jsonb)`))).rejects.toThrow(/permission denied/i);
    await expect(as(null, 'anon', () => db.query(`select public.get_planning_benchmark_upload('00000000-0000-0000-0000-000000000000')`))).rejects.toThrow(/permission denied/i);
    // service_role may hold EXECUTE through platform default privileges, but auth.uid() is null for it, so the function itself refuses.
    await expect(as(null, 'service_role', () => db.query(`select public.stage_planning_benchmark_upload('{}'::jsonb)`))).rejects.toThrow(/PB_E_DENIED|permission denied/i);
  });

  it('upload and activate are separate capabilities: an uploader cannot activate, an activator cannot stage', async () => {
    await expectCode(stage(ACT, 'values', rows()), 'PB_E_DENIED');
    const s = await stage(UP, 'values', [vrow(2, { metric_code: M_CUR, statistic_type: 'p10' })]);
    expect(s.status).toBe('staged');
    await expectCode(as(UP, 'authenticated', () => db.query(`select public.activate_planning_benchmark_upload($1, '{}'::jsonb)`, [s.batch_id])), 'PB_E_DENIED');
  });

  it('a holder may read previews but a plain admin sees nothing in the tables (RLS) and cannot write them directly', async () => {
    const s = await stage(UP, 'values', [vrow(2, { statistic_type: 'p20' })]);
    const seen = await as(UP, 'authenticated', () => q<{ c: number }>(`select count(*)::int c from benchmark_upload_batches where id = '${s.batch_id}'`));
    expect(seen[0].c).toBe(1);
    const hidden = await as(NOCAP, 'authenticated', () => q<{ c: number }>(`select count(*)::int c from benchmark_upload_batches`));
    expect(hidden[0].c).toBe(0);
    await expect(as(UP, 'authenticated', () => db.query(`insert into benchmark_upload_batches (kind, dataset_id, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version, row_count, staging_digest, staged_by) values ('values', '${'00000000-0000-0000-0000-000000000000'}', 'x','1.0','f',repeat('a',64),1,'t',1,'d','${UP}')`))).rejects.toThrow(/permission denied/i);
    await expect(as(UP, 'authenticated', () => db.query(`update benchmark_upload_batches set status = 'activated'`))).rejects.toThrow(/permission denied/i);
  });

  it('the internal helper functions are not executable by API roles', async () => {
    for (const fn of [`public.pb_classify_rows('00000000-0000-0000-0000-000000000000')`, `public.pb_batch_digest('00000000-0000-0000-0000-000000000000')`, `public.pb_store_classification('00000000-0000-0000-0000-000000000000')`]) {
      await expect(as(BOTH, 'authenticated', () => db.query(`select * from ${fn}`))).rejects.toThrow(/permission denied/i);
    }
  });
});

// -------------------------------------------------------------------------------------------- staging ---
describe('staging', () => {
  it('stages a first load, classifies every row as new and changes NOTHING live', async () => {
    const before = await countAll('benchmark_values');
    const s = await stage(UP, 'values', [vrow(2), vrow(3, { statistic_type: 'mean', value_numeric: 120 })]);
    expect(s.status).toBe('staged');
    expect(s.counts).toMatchObject({ new: 2, changed: 0, unchanged: 0, conflict: 0, removed: 0 });
    expect(await countAll('benchmark_values')).toBe(before);
    const ds = (await q<{ data_status: string }>(`select data_status from benchmark_datasets where dataset_name = '${DS}'`))[0];
    expect(ds.data_status).toBe('draft');
  });

  it('rejects each broken row rule with an explicit coded error and stages nothing', async () => {
    const batches = await countAll('benchmark_upload_batches');
    await expectCode(stage(UP, 'values', [vrow(2, { metric_code: 'no_such_metric' })]), 'PB_E_ROWS');
    await expectCode(stage(UP, 'values', [vrow(2, { unit: 'percentage', original_currency: '' })]), 'unit that differs');
    await expectCode(stage(UP, 'values', [vrow(2, { cohort_code: 'NO_SUCH_COHORT' })]), 'cohort that does not exist');
    await expectCode(stage(UP, 'values', [vrow(2, { statistic_type: 'bogus' })]), 'value rule');
    await expectCode(stage(UP, 'values', [vrow(2, { value_numeric: 1.23456 })]), 'value rule');
    await expectCode(stage(UP, 'values', [vrow(2, { effective_from: '2999-01-01' })]), 'value rule');
    await expectCode(stage(UP, 'values', [vrow(2, { unit: 'currency', original_currency: '' })]), 'value rule');
    await expectCode(stage(UP, 'values', [vrow(2), vrow(3)]), 'repeats');
    await expectCode(stage(UP, 'values', [vrow(2, { dataset_name: 'Other' })], { dataset_name: DS }), 'different dataset');
    await expectCode(stage(UP, 'values', [vrow(2)], { dataset_name: 'No such dataset' }), 'PB_E_DATASET');
    await expectCode(stage(UP, 'values', [vrow(2)], { template_version: 'FHIP-PB-VALUES-0' }), 'template version');
    await expectCode(stage(UP, 'values', [vrow(2)], { file_sha256: 'abc' }), 'file hash');
    await expectCode(stage(UP, 'values', [vrow(2)], { dataset_name: 'PB SUSPENDED DATASET', rows: [vrow(2, { dataset_name: 'PB SUSPENDED DATASET' })] }), 'suspended');
    expect(await countAll('benchmark_upload_batches')).toBe(batches);
  });

  it('staging the same file twice returns the one staged batch (idempotent)', async () => {
    const h = sha();
    const a = await stage(UP, 'values', [vrow(2, { metric_code: M_PCT, unit: 'percentage', original_currency: '', value_numeric: 5 })], { file_sha256: h });
    const b = await stage(UP2, 'values', [vrow(2, { metric_code: M_PCT, unit: 'percentage', original_currency: '', value_numeric: 5 })], { file_sha256: h });
    expect(a.status).toBe('staged');
    expect(b.status).toBe('already_staged');
    expect(b.batch_id).toBe(a.batch_id);
  });

  it('the preview shows the diff, the readiness result and the blockers', async () => {
    const s = await stage(UP, 'values', [vrow(2, { metric_code: M_PCT2, unit: 'percentage', original_currency: '', value_numeric: 7 })]);
    const v = await get(UP, s.batch_id as string);
    expect((v.rows as Json[])[0]).toMatchObject({ metric_code: M_PCT2, classification: 'new', new_value: '7', live_value: null });
    expect(v.blockers).toEqual([]);
    expect(v.readiness_errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- activate ---
describe('activate - first load, supersede, idempotency', () => {
  let firstBatch = '';
  let firstSha = '';

  it('a first load becomes live in one step, activates the dataset and writes the audit rows', async () => {
    firstSha = sha();
    const s = await stage(UP, 'values', [vrow(2), vrow(3, { statistic_type: 'mean', value_numeric: 120 }), vrow(4, { metric_code: M_PCT, unit: 'percentage', original_currency: '', value_numeric: 5.5, is_derived: true, derivation_method: 'calc' })], { file_sha256: firstSha });
    firstBatch = s.batch_id as string;
    const runsBefore = await countAll('benchmark_update_runs');
    const r = await activate(ACT, firstBatch);
    expect(r.status).toBe('activated');
    expect(r.result).toMatchObject({ rows_inserted: 3, rows_end_dated: 0, dataset_status: 'active' });
    const live = await liveValues(DS);
    expect(live.map((x) => `${x.metric_code}/${x.statistic_type}/${x.value_numeric}/${x.version}`)).toEqual([`${M_CUR}/mean/120.0000/1`, `${M_CUR}/median/100.0000/1`, `${M_PCT}/median/5.5000/1`]);
    const ds = (await q<{ data_status: string; review_due_at: string | null; approved_by: string }>(`select data_status, review_due_at::text, approved_by from benchmark_datasets where dataset_name = '${DS}'`))[0];
    expect(ds.data_status).toBe('active');
    expect(ds.approved_by).toBe(ACT);
    expect(ds.review_due_at).not.toBeNull();
    expect(await countAll('benchmark_update_runs')).toBe(runsBefore + 1);
    const run = (await q<Json>(`select event_type, approval_status, rows_imported, audit_user::text from benchmark_update_runs order by created_at desc limit 1`))[0];
    expect(run).toMatchObject({ event_type: 'DATASET_IMPORT', approval_status: 'approved', rows_imported: 3, audit_user: ACT });
    const ev = await q<{ event_type: string }>(`select event_type from benchmark_upload_events where batch_id = $1 order by created_at`, [firstBatch]);
    expect(ev.map((e) => e.event_type)).toEqual(['staged', 'activated']);
    const batch = (await q<Json>(`select status, activated_by::text, self_activated from benchmark_upload_batches where id = $1`, [firstBatch]))[0];
    expect(batch).toMatchObject({ status: 'activated', activated_by: ACT, self_activated: false });
  });

  it('activating twice writes nothing the second time, and the same file cannot be staged again', async () => {
    const before = await countAll('benchmark_values');
    const again = await activate(ACT, firstBatch);
    expect(again.status).toBe('already_activated');
    expect(await countAll('benchmark_values')).toBe(before);
    await expectCode(stage(UP, 'values', [vrow(2), vrow(3, { statistic_type: 'mean', value_numeric: 120 })], { file_sha256: firstSha }), 'PB_E_DUPLICATE');
  });

  it('supersede: a changed figure is end-dated and replaced, an identical one is left alone, a new one is added, and no key ever has two live rows', async () => {
    const s = await stage(UP, 'values', [
      vrow(2, { value_numeric: 111 }), // changed (100 -> 111)
      vrow(3, { statistic_type: 'mean', value_numeric: 120 }), // unchanged
      vrow(4, { statistic_type: 'p10', value_numeric: 50 }), // new
    ]);
    expect(s.counts).toMatchObject({ new: 1, changed: 1, unchanged: 1, conflict: 0 });
    const r = await activate(ACT, s.batch_id as string);
    expect(r.result).toMatchObject({ rows_inserted: 2, rows_end_dated: 1 });
    const live = await liveValues(DS);
    expect(live.map((x) => `${x.metric_code}/${x.statistic_type}/${x.value_numeric}/v${x.version}`)).toEqual([
      `${M_CUR}/mean/120.0000/v1`,
      `${M_CUR}/median/111.0000/v2`,
      `${M_CUR}/p10/50.0000/v1`,
      `${M_PCT}/median/5.5000/v1`,
    ]);
    // history is kept, not deleted
    const old = await q<{ v: string; effective_to: string }>(`select value_numeric::text v, effective_to::text from benchmark_values where dataset_id = $1 and statistic_type = 'median' and value_numeric = 100`, [await dsId(DS)]);
    expect(old).toHaveLength(1);
    expect(old[0].effective_to).toBe(await today());
    // the Twin read rule (no end date, or an end date after today) returns exactly one row per key
    const dup = await q<{ c: number }>(
      `select count(*)::int c from (select metric_definition_id, cohort_id, statistic_type from benchmark_values where dataset_id = $1 and (effective_to is null or effective_to > current_date) group by 1,2,3 having count(*) > 1) x`,
      [await dsId(DS)]
    );
    expect(dup[0].c).toBe(0);
  });

  it('NC-DB4: without the end-dating step the same assertion fails (two live rows for one key)', async () => {
    const mutated = ACTIVATE_FN.replace('update public.benchmark_values v set effective_to = current_date', 'update public.benchmark_values v set effective_to = effective_to');
    expect(mutated).not.toBe(ACTIVATE_FN);
    await db.exec(mutated);
    try {
      const s = await stage(UP, 'values', [vrow(2, { value_numeric: 222 })]);
      await activate(ACT, s.batch_id as string);
      const dup = await q<{ c: number }>(
        `select count(*)::int c from (select metric_definition_id, cohort_id, statistic_type from benchmark_values where dataset_id = $1 and (effective_to is null or effective_to > current_date) group by 1,2,3 having count(*) > 1) x`,
        [await dsId(DS)]
      );
      // the named assertion: no key has two live rows. It must be RED against the mutated function.
      expect(dup[0].c, 'NC-DB4 named assertion: no key has two live rows').toBe(0);
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-DB4 named assertion');
      return;
    } finally {
      await db.exec(ACTIVATE_FN);
      // repair the live data the broken run left behind so later tests start clean
      await db.exec(`update benchmark_values set effective_to = current_date where dataset_id = (select id from benchmark_datasets where dataset_name = '${DS}') and metric_definition_id = (select id from benchmark_metric_definitions where metric_code = '${M_CUR}') and statistic_type = 'median' and value_numeric = 111`);
    }
    throw new Error('the control did not go red: the mutated function still produced one live row per key');
  });
});

describe('activate - binding, staleness, self-activation, readiness, conflicts, atomicity', () => {
  it('refuses an activation that is not bound to the previewed file, digest or counts', async () => {
    const s = await stage(UP, 'values', [vrow(2, { statistic_type: 'p25', value_numeric: 1 })]);
    await expectCode(activate(ACT, s.batch_id as string, false, { expected_digest: 'f'.repeat(64) }), 'PB_E_BINDING');
    await expectCode(activate(ACT, s.batch_id as string, false, { expected_sha256: 'e'.repeat(64) }), 'PB_E_BINDING');
    await expectCode(activate(ACT, s.batch_id as string, false, { expected_counts: { new: 99, changed: 0, unchanged: 0, conflict: 0, removed: 0 } }), 'PB_E_BINDING');
    expect((await get(ACT, s.batch_id as string)).batch).toMatchObject({ status: 'staged' });
  });

  it('refuses a stale batch: live data moved after staging', async () => {
    const a = await stage(UP, 'values', [vrow(2, { statistic_type: 'p75', value_numeric: 10 })]);
    const b = await stage(UP, 'values', [vrow(2, { statistic_type: 'p75', value_numeric: 11 })]);
    await activate(ACT, b.batch_id as string);
    const view = await get(ACT, a.batch_id as string);
    // p75 was new when A was staged, but is now live: the preview itself tells the reviewer
    expect((view.blockers as string[]).join(' ')).toContain('Live data changed');
    await expectCode(activate(ACT, a.batch_id as string), 'PB_E_STALE');
  });

  it('NC-DB3: without the digest recheck the stale batch would activate (the named assertion goes red)', async () => {
    const a = await stage(UP, 'values', [vrow(2, { statistic_type: 'p80', value_numeric: 10 })]);
    const b = await stage(UP, 'values', [vrow(2, { statistic_type: 'p80', value_numeric: 11 })]);
    await activate(ACT, b.batch_id as string);
    const mutated = ACTIVATE_FN.replace('if v_digest <> b.staging_digest then', 'if false then');
    expect(mutated).not.toBe(ACTIVATE_FN);
    await db.exec(mutated);
    try {
      await expectCode(activate(ACT, a.batch_id as string), 'PB_E_STALE');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('expected rejection containing PB_E_STALE');
      return;
    } finally {
      await db.exec(ACTIVATE_FN);
    }
    throw new Error('the control did not go red');
  });

  it('separation of duties: the staging admin needs the explicit acknowledgement to activate their own upload, and it is recorded', async () => {
    const s = await stage(BOTH, 'values', [vrow(2, { statistic_type: 'p90', value_numeric: 9 })]);
    await expectCode(activate(BOTH, s.batch_id as string, false), 'PB_E_SELF');
    const r = await activate(BOTH, s.batch_id as string, true);
    expect(r.status).toBe('activated');
    const batch = (await q<Json>(`select self_activated from benchmark_upload_batches where id = $1`, [s.batch_id]))[0];
    expect(batch.self_activated).toBe(true);
  });

  it('NC-DB2: without the self-activation check the same assertion fails', async () => {
    const mutated = ACTIVATE_FN.replace('if b.staged_by = v_uid and coalesce((p ->> \'self_activation_ack\')::boolean, false) is not true then', 'if false then');
    expect(mutated).not.toBe(ACTIVATE_FN);
    await db.exec(mutated);
    try {
      const s = await stage(BOTH, 'values', [vrow(2, { statistic_type: 'target_min', value_numeric: 9 })]);
      await expectCode(activate(BOTH, s.batch_id as string, false), 'PB_E_SELF');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('expected rejection containing PB_E_SELF');
      return;
    } finally {
      await db.exec(ACTIVATE_FN);
    }
    throw new Error('the control did not go red');
  });

  it('NC-DB1: without the capability predicate an uploader could activate (the named assertion goes red)', async () => {
    const s = await stage(UP, 'values', [vrow(2, { statistic_type: 'target_max', value_numeric: 9 })]);
    const mutated = ACTIVATE_FN.replace('if v_uid is null or not public.is_planning_benchmark_activator() then', 'if v_uid is null then');
    expect(mutated).not.toBe(ACTIVATE_FN);
    await db.exec(mutated);
    try {
      await expectCode(as(UP, 'authenticated', () => db.query(`select public.activate_planning_benchmark_upload($1, '{}'::jsonb)`, [s.batch_id])), 'PB_E_DENIED');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('expected rejection containing PB_E_DENIED');
      return;
    } finally {
      await db.exec(ACTIVATE_FN);
    }
    throw new Error('the control did not go red');
  });

  it('readiness: a draft or under-review source blocks activation, a suspended dataset cannot be staged, and the preview says why', async () => {
    for (const [dataset, source] of [['PB DRAFT SRC DATASET', 'PB_DRAFT_SOURCE'], ['PB REVIEW SRC DATASET', 'PB_REVIEW_SOURCE']]) {
      const s = await stage(UP, 'target_ranges', [trow(2, { dataset_name: dataset, source_name: source })], { dataset_name: dataset });
      expect(s.status).toBe('staged');
      const v = await get(UP, s.batch_id as string);
      expect((v.blockers as string[]).join(' ')).toContain('Source status is');
      await expectCode(activate(ACT, s.batch_id as string), 'PB_E_NOT_READY');
    }
  });

  it('a dataset missing its period, geography or coverage cannot activate', async () => {
    await db.exec(`update benchmark_datasets set geography_level = null where dataset_name = 'PB TEST DATASET 2'`);
    const s = await stage(UP, 'values', [vrow(2, { dataset_name: 'PB TEST DATASET 2', metric_code: 'net_household_income' })], { dataset_name: 'PB TEST DATASET 2' });
    await expectCode(activate(ACT, s.batch_id as string), 'geography level is missing');
    await db.exec(`update benchmark_datasets set geography_level = 'country' where dataset_name = 'PB TEST DATASET 2'`);
    expect((await activate(ACT, s.batch_id as string)).status).toBe('activated');
  });

  it('conflict: a live figure for the same key held by a DIFFERENT dataset name blocks the batch', async () => {
    // PB TEST DATASET 2 now holds a live net_household_income/median. Another dataset name staging the same key conflicts.
    await db.exec(`insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status) select id, 'PB CONFLICT DATASET', '1.0', 'observed_market', 'FY', 'country', 'median', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE'`);
    const s = await stage(UP, 'values', [vrow(2, { dataset_name: 'PB CONFLICT DATASET', metric_code: 'net_household_income' })], { dataset_name: 'PB CONFLICT DATASET' });
    expect(s.counts).toMatchObject({ conflict: 1 });
    await expectCode(activate(ACT, s.batch_id as string), 'PB_E_CONFLICT');
  });

  it('a new VERSION of the same dataset supersedes the old version, and the old dataset is marked superseded once it has no live value', async () => {
    await db.exec(`insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status) select id, 'PB TEST DATASET 2', '2.0', 'observed_market', 'FY', 'country', 'median', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE'`);
    const rows = [vrow(2, { dataset_name: 'PB TEST DATASET 2', dataset_version: '2.0', metric_code: 'net_household_income', value_numeric: 300 })];
    const s = await stage(UP, 'values', rows, { dataset_name: 'PB TEST DATASET 2', dataset_version: '2.0' });
    expect(s.counts).toMatchObject({ changed: 1, conflict: 0 });
    const r = await activate(ACT, s.batch_id as string);
    expect(r.result).toMatchObject({ rows_inserted: 1, rows_end_dated: 1 });
    const status = await q<{ version: string; data_status: string }>(`select version, data_status from benchmark_datasets where dataset_name = 'PB TEST DATASET 2' order by version`);
    expect(status).toEqual([{ version: '1.0', data_status: 'superseded' }, { version: '2.0', data_status: 'active' }]);
    const run = (await q<Json>(`select previous_version, new_version from benchmark_update_runs order by created_at desc limit 1`))[0];
    expect(run).toMatchObject({ previous_version: '1.0', new_version: '2.0' });
  });

  it('ATOMIC: a failure part-way through the apply leaves nothing changed (no end-dated row, batch still staged)', async () => {
    const s = await stage(UP, 'values', [vrow(2, { statistic_type: 'p10', value_numeric: 77 }), vrow(3, { statistic_type: 'p20', value_numeric: 78 })]);
    // Tamper as the superuser AFTER staging so the insert half of the apply violates a database CHECK.
    await db.exec(`update benchmark_upload_rows set payload = jsonb_set(payload, '{statistic_type}', to_jsonb('bogus'::text)) where batch_id = '${s.batch_id}' and row_no = 3`);
    const liveBefore = JSON.stringify(await liveValues(DS));
    const ended = (await q<{ c: number }>(`select count(*)::int c from benchmark_values where effective_to is not null`))[0].c;
    // digest includes the payload, so the tampered batch is refused as stale/bound: rebind the stored digest to isolate the apply step.
    await db.exec(`update benchmark_upload_batches set staging_digest = public.pb_batch_digest('${s.batch_id}') where id = '${s.batch_id}'`);
    await expect(activate(ACT, s.batch_id as string)).rejects.toThrow(/check constraint|violates/i);
    expect(JSON.stringify(await liveValues(DS))).toBe(liveBefore);
    expect((await q<{ c: number }>(`select count(*)::int c from benchmark_values where effective_to is not null`))[0].c).toBe(ended);
    expect((await q<{ status: string }>(`select status from benchmark_upload_batches where id = '${s.batch_id}'`))[0].status).toBe('staged');
    expect((await q<{ c: number }>(`select count(*)::int c from benchmark_upload_events where batch_id = '${s.batch_id}' and event_type = 'activated'`))[0].c).toBe(0);
  });

  it('an expired staged upload cannot be activated', async () => {
    const s = await stage(UP, 'values', [vrow(2, { statistic_type: 'rate', value_numeric: 3 })]);
    await db.exec(`update benchmark_upload_batches set expires_at = now() - interval '1 day' where id = '${s.batch_id}'`);
    await expectCode(activate(ACT, s.batch_id as string), 'PB_E_EXPIRED');
    expect(((await get(ACT, s.batch_id as string)).blockers as string[]).join(' ')).toContain('expired');
  });
});

// --------------------------------------------------------------------------------- target ranges + cohorts ---
describe('target ranges (group replacement) and cohorts', () => {
  const bands = (extra: Json[] = []) => [trow(2, { band_label: 'low', band_tier: 1, lower_bound: null, upper_bound: 10 }), trow(3, { band_label: 'mid', band_tier: 2, lower_bound: 10, upper_bound: 20 }), trow(4, { band_label: 'high', band_tier: 3, lower_bound: 20, upper_bound: null }), ...extra];

  it('a first load of bands is live after Activate, citing the dataset source', async () => {
    const s = await stage(UP, 'target_ranges', bands());
    expect(s.counts).toMatchObject({ new: 3, removed: 0 });
    const r = await activate(ACT, s.batch_id as string);
    expect(r.result).toMatchObject({ rows_inserted: 3 });
    const live = await q<Json>(`select band_tier, benchmark_source_id is not null s from benchmark_target_ranges where metric_definition_id = $1 and household_type = 'single' and effective_to is null order by band_tier`, [await metricId(M_PCT)]);
    expect(live).toHaveLength(3);
    expect(live.every((x) => x.s === true)).toBe(true);
  });

  it('replacing the set: a changed tier is end-dated, an identical tier left alone, an unrestated tier removed (and shown in the preview)', async () => {
    const s = await stage(UP, 'target_ranges', [trow(2, { band_label: 'low', band_tier: 1, lower_bound: null, upper_bound: 10 }), trow(3, { band_label: 'mid', band_tier: 2, lower_bound: 10, upper_bound: 25 })]);
    expect(s.counts).toMatchObject({ unchanged: 1, changed: 1, new: 0, removed: 1 });
    const v = await get(UP, s.batch_id as string);
    expect(v.removed as Json[]).toEqual([expect.objectContaining({ band_label: 'high', band_tier: 3 })]);
    const r = await activate(ACT, s.batch_id as string);
    expect(r.result).toMatchObject({ rows_inserted: 1, rows_end_dated: 2, bands_removed: 1 });
    const live = await q<Json>(`select band_tier, upper_bound::text u from benchmark_target_ranges where metric_definition_id = $1 and household_type = 'single' and (effective_to is null or effective_to > current_date) order by band_tier`, [await metricId(M_PCT)]);
    expect(live).toEqual([{ band_tier: 1, u: '10.0000' }, { band_tier: 2, u: '25.0000' }]);
  });

  it('refuses bands that cite a source other than the dataset source, and live bands cited by another source are a conflict', async () => {
    await expectCode(stage(UP, 'target_ranges', [trow(2, { source_name: 'PB_OTHER_SOURCE' })]), 'not the one source of the dataset');
    await db.exec(`insert into benchmark_target_ranges (metric_definition_id, benchmark_source_id, country_code, household_type, band_label, band_tier, lower_bound, upper_bound) select (select id from benchmark_metric_definitions where metric_code = '${M_PCT2}'), id, 'AU', 'single', 'x', 1, 0, 5 from benchmark_sources where source_name = 'PB_OTHER_SOURCE'`);
    const s = await stage(UP, 'target_ranges', [trow(2, { metric_code: M_PCT2 })]);
    expect(s.counts).toMatchObject({ conflict: 1 });
    await expectCode(activate(ACT, s.batch_id as string), 'PB_E_CONFLICT');
  });

  it('a seed band with no source is replaced by an upload that names the dataset source', async () => {
    await db.exec(`insert into benchmark_target_ranges (metric_definition_id, country_code, household_type, band_label, band_tier, lower_bound, upper_bound) values ((select id from benchmark_metric_definitions where metric_code = 'passive_income_ratio'), 'AU', 'single', 'seed', 1, 0, 5)`);
    const s = await stage(UP, 'target_ranges', [trow(2, { metric_code: 'passive_income_ratio', band_label: 'low', upper_bound: 6 })]);
    expect(s.counts).toMatchObject({ changed: 1, conflict: 0 });
    await activate(ACT, s.batch_id as string);
    const live = await q<Json>(`select band_label, upper_bound::text u from benchmark_target_ranges where metric_definition_id = (select id from benchmark_metric_definitions where metric_code = 'passive_income_ratio') and household_type = 'single' and (effective_to is null or effective_to > current_date)`);
    expect(live).toEqual([{ band_label: 'low', u: '6.0000' }]);
  });

  it('cohorts: new are inserted, identical are skipped, a differing existing cohort is a conflict', async () => {
    const s = await stage(UP, 'cohorts', [crow(2), crow(3, { cohort_code: 'PB_COHORT_B', cohort_tier: 3 })]);
    expect(s.counts).toMatchObject({ new: 2 });
    await activate(ACT, s.batch_id as string);
    expect(await countAll(`benchmark_cohorts where cohort_code in ('PB_COHORT_A','PB_COHORT_B')`)).toBe(2);
    const again = await stage(UP, 'cohorts', [crow(2), crow(3, { cohort_code: 'PB_COHORT_B', cohort_tier: 3 }), crow(4, { cohort_code: 'PB_COHORT_C' })]);
    expect(again.counts).toMatchObject({ unchanged: 2, new: 1 });
    const changed = await stage(UP, 'cohorts', [crow(2, { cohort_description: 'Different words' })]);
    expect(changed.counts).toMatchObject({ conflict: 1 });
    await expectCode(activate(ACT, changed.batch_id as string), 'PB_E_CONFLICT');
  });

  it('a cohort created by an upload can be referenced by a later values upload', async () => {
    const s = await stage(UP, 'values', [vrow(2, { cohort_code: 'PB_COHORT_A', metric_code: M_PCT, unit: 'percentage', original_currency: '', value_numeric: 12 })]);
    expect(s.counts).toMatchObject({ new: 1 });
  });
});

// ----------------------------------------------------------------------------------------------- discard ---
describe('discard and append-only audit', () => {
  it('an uploader may discard only their own batch, an activator any, and an activated batch cannot be discarded', async () => {
    const mine = await stage(UP, 'values', [vrow(2, { statistic_type: 'share', value_numeric: 1 })]);
    await expectCode(discard(UP2, mine.batch_id as string), 'only an upload you staged');
    expect((await discard(UP, mine.batch_id as string, 'wrong file')).status).toBe('discarded');
    expect((await discard(UP, mine.batch_id as string)).status).toBe('already_discarded');
    await expectCode(activate(ACT, mine.batch_id as string), 'PB_E_STATE');
    const theirs = await stage(UP2, 'values', [vrow(2, { statistic_type: 'threshold', value_numeric: 1 })]);
    expect((await discard(ACT, theirs.batch_id as string)).status).toBe('discarded');
    const live = await stage(UP, 'values', [vrow(2, { statistic_type: 'threshold', value_numeric: 2 })]);
    await activate(ACT, live.batch_id as string);
    await expectCode(discard(ACT, live.batch_id as string), 'PB_E_STATE');
    const row = (await q<Json>(`select discarded_by::text, discard_reason from benchmark_upload_batches where id = $1`, [mine.batch_id]))[0];
    expect(row).toMatchObject({ discarded_by: UP, discard_reason: 'wrong file' });
  });

  it('events are append-only and batches are never deleted, even for the owner role', async () => {
    await expect(db.exec(`update benchmark_upload_events set event_type = 'staged'`)).rejects.toThrow(/append-only/i);
    await expect(db.exec(`delete from benchmark_upload_events`)).rejects.toThrow(/append-only/i);
    await expect(db.exec(`delete from benchmark_upload_batches`)).rejects.toThrow(/never deleted/i);
  });
});
