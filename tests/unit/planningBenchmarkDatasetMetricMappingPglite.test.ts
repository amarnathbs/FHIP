// Planning Benchmarks dataset to metric mapping (migration 0277) - real-Postgres (PGlite) proof of the DATABASE half.
//
// The whole migration ledger (0001 .. latest, including 0275 and 0277) is replayed into an ISOLATED in-memory Postgres. Every
// rule is exercised through the real SECURITY DEFINER functions as the real database roles with auth.uid() driven by
// request.jwt.claims. Nothing is reimplemented in the test.
//
// EVIDENCE LABEL: PGlite-verified. NOT DEV-verified and NOT production-verified (0277 is applied nowhere).
//
// NAMED NEGATIVE CONTROLS (NC-MAP*): each runs the SAME named assertion against a copy of the function with exactly one rule
// surgically removed, and the assertion MUST go red (an AssertionError carrying the control name).
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
const MIG_NAME = '0277_planning_benchmark_dataset_metric_mapping.sql';
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, MIG_NAME), 'utf8');
const ROLLBACK = fs.readFileSync(path.resolve(HERE, '..', '..', 'docs', 'planning-benchmarks', 'po_apply_mapping', 'rollback.sql'), 'utf8');

const UP = 'dddddddd-0000-0000-0000-00000000b001'; // upload only
const ACT = 'dddddddd-0000-0000-0000-00000000b002'; // activate only
const NOCAP = 'dddddddd-0000-0000-0000-00000000b004';
const PLAIN = 'dddddddd-0000-0000-0000-00000000b005';

const DS = 'PB MAP DATASET';
const DSR = 'PB MAP RANGE DATASET';
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
const q = async <T = Json>(sql: string, args: unknown[] = []): Promise<T[]> => (await db.query(sql, args)).rows as T[];

function extractFn(sql: string, name: string): string {
  const m = sql.match(new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$fn\\$;`));
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
const READINESS_FN = extractFn(MIGRATION, 'pb_dataset_readiness');
const TRIGGER_FN = extractFn(MIGRATION, 'pb_enforce_dataset_metric');
const SET_FN = extractFn(MIGRATION, 'set_planning_benchmark_dataset_metric');

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
  row_no: n, dataset_name: DS, dataset_version: '1.0', cohort_code: '', metric_code: M_CUR, statistic_type: 'median', value_numeric: 100, unit: 'currency', original_currency: 'AUD',
  base_date: '2020-06-30', effective_from: null, is_derived: false, derivation_method: '', confidence_score: null, value_text: 'prov', source_release: 'release',
  observation_period_start: '2019-07-01', observation_period_end: '2020-06-30', source_file: 'file.xlsx', source_locator: 'T1!B2', retrieval_date: '2026-10-01', ...over,
});
const trow = (n: number, over: Json = {}): Json => ({
  row_no: n, dataset_name: DSR, dataset_version: '1.0', metric_code: M_PCT, source_name: 'PB_TEST_SOURCE', country_code: 'AU', life_stage: '', household_type: 'single', band_label: 'low', band_tier: 1,
  lower_bound: 0, upper_bound: 10, direction: 'target_range', explanation: 'x', evidence_level: 'official_statistical', model_version: 'm-1', effective_from: null, source_release: 'release',
  observation_period_start: '2026-02-01', observation_period_end: null, source_file: 'f.pdf', source_locator: 'p3', retrieval_date: '2026-10-01', ...over,
});
const MARKER = { values: 'FHIP-PB-VALUES-1', target_ranges: 'FHIP-PB-RANGES-1' } as const;

async function stage(uid: string, kind: keyof typeof MARKER, rows: Json[]): Promise<Json> {
  const p = { kind, dataset_name: rows[0].dataset_name, dataset_version: '1.0', file_name: 'f.csv', file_sha256: sha(), file_bytes: 1000, template_version: MARKER[kind], rows };
  return as(uid, 'authenticated', async () => ((await db.query(`select public.stage_planning_benchmark_upload($1::jsonb) v`, [JSON.stringify(p)])).rows[0] as { v: Json }).v);
}
async function get(uid: string, id: string): Promise<Json> {
  return as(uid, 'authenticated', async () => ((await db.query(`select public.get_planning_benchmark_upload($1) v`, [id])).rows[0] as { v: Json }).v);
}
async function activate(uid: string, id: string): Promise<Json> {
  const b = (await get(uid, id)).batch as Json;
  const p = { expected_sha256: b.file_sha256, expected_digest: b.staging_digest, expected_counts: b.counts, self_activation_ack: false };
  return as(uid, 'authenticated', async () => ((await db.query(`select public.activate_planning_benchmark_upload($1, $2::jsonb) v`, [id, JSON.stringify(p)])).rows[0] as { v: Json }).v);
}
const dsId = async (name: string) => ((await q<{ id: string }>(`select id from benchmark_datasets where dataset_name = $1 and version = '1.0'`, [name]))[0]).id;
async function setMap(uid: string | null, ds: string, metric: string, v: boolean, r: boolean, reason = 'test reason', confirm = false, role: Role = 'authenticated'): Promise<Json> {
  return as(uid, role, async () => ((await db.query(`select public.set_planning_benchmark_dataset_metric($1, $2, $3, $4, $5, $6) v`, [ds, metric, v, r, reason, confirm])).rows[0] as { v: Json }).v);
}
async function removeMap(uid: string | null, ds: string, metric: string, reason = 'test reason', confirm = false, role: Role = 'authenticated'): Promise<Json> {
  return as(uid, role, async () => ((await db.query(`select public.remove_planning_benchmark_dataset_metric($1, $2, $3, $4) v`, [ds, metric, reason, confirm])).rows[0] as { v: Json }).v);
}
const mappedCodes = async (ds: string, kind: 'values' | 'ranges') =>
  (await q<{ c: string }>(`select m.metric_code c from benchmark_dataset_metrics x join benchmark_metric_definitions m on m.id = x.metric_definition_id where x.dataset_id = $1 and x.${kind === 'values' ? 'applies_to_values' : 'applies_to_target_ranges'} order by 1`, [ds])).map((r) => r.c);
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
  await db.exec(`insert into auth.users(id,email) values ('${UP}','up@pg.test'),('${ACT}','act@pg.test'),('${NOCAP}','nocap@pg.test'),('${PLAIN}','plain@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${UP}'),('${ACT}'),('${NOCAP}');`);
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
        from benchmark_datasets d join benchmark_metric_definitions m on m.metric_code in ('${M_CUR}', '${M_PCT}')
       where d.dataset_name in ('${DS}', '${DSR}');
  `);
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 0277 - shape and seed', () => {
  it('seeds the document pairs on top of the real ledger, creates RLS tables and grants API roles read only', async () => {
    const n = await countAll(`benchmark_dataset_metrics where evidence_note <> 'test mapping'`);
    expect(n).toBe(71);
    for (const t of ['benchmark_dataset_metrics', 'benchmark_dataset_metric_events']) {
      const rls = (await q<{ r: boolean }>(`select relrowsecurity r from pg_class where oid = 'public.${t}'::regclass`))[0];
      expect(rls.r, t).toBe(true);
      const grants = (await q<{ p: string }>(`select privilege_type p from information_schema.role_table_grants where table_name = $1 and grantee in ('anon','authenticated') order by 1`, [t])).map((g) => g.p);
      expect(grants, t).toEqual(t === 'benchmark_dataset_metrics' ? ['SELECT', 'SELECT'] : ['SELECT']);
    }
  });

  it('the mapping is readable like the other reference tables (anon and authenticated), the audit trail only by holders', async () => {
    expect((await as(null, 'anon', () => q<{ c: number }>(`select count(*)::int c from benchmark_dataset_metrics`)))[0].c).toBeGreaterThan(70);
    expect((await as(NOCAP, 'authenticated', () => q<{ c: number }>(`select count(*)::int c from benchmark_dataset_metrics`)))[0].c).toBeGreaterThan(70);
    await setMap(ACT, await dsId(DS), M_PCT2, true, false, 'audit visibility check');
    expect((await as(UP, 'authenticated', () => q<{ c: number }>(`select count(*)::int c from benchmark_dataset_metric_events`)))[0].c).toBeGreaterThan(0);
    expect((await as(NOCAP, 'authenticated', () => q<{ c: number }>(`select count(*)::int c from benchmark_dataset_metric_events`)))[0].c).toBe(0);
    await removeMap(ACT, await dsId(DS), M_PCT2, 'tidy up the audit visibility check');
  });

  it('API roles cannot write the mapping or the audit trail directly, and the audit trail is append-only', async () => {
    const ds = await dsId(DS);
    const metric = (await q<{ id: string }>(`select id from benchmark_metric_definitions where metric_code = '${M_PCT2}'`))[0].id;
    for (const who of [ACT, UP, NOCAP]) {
      await expect(as(who, 'authenticated', () => db.query(`insert into benchmark_dataset_metrics (dataset_id, metric_definition_id, applies_to_values) values ('${ds}', '${metric}', true)`))).rejects.toThrow(/permission denied/i);
      await expect(as(who, 'authenticated', () => db.query(`update benchmark_dataset_metrics set applies_to_values = true`))).rejects.toThrow(/permission denied/i);
      await expect(as(who, 'authenticated', () => db.query(`delete from benchmark_dataset_metrics`))).rejects.toThrow(/permission denied/i);
    }
    await expect(as(null, 'anon', () => db.query(`insert into benchmark_dataset_metrics (dataset_id, metric_definition_id, applies_to_values) values ('${ds}', '${metric}', true)`))).rejects.toThrow(/permission denied/i);
    await expect(as(ACT, 'authenticated', () => db.query(`insert into benchmark_dataset_metric_events (dataset_id, metric_definition_id, dataset_name, dataset_version, metric_code, action, reason, actor_user_id) values ('${ds}', '${metric}', 'x', '1', 'x', 'added', 'forged', '${ACT}')`))).rejects.toThrow(/permission denied/i);
    await expect(db.query(`update benchmark_dataset_metric_events set reason = 'tampered'`)).rejects.toThrow(/append-only/i);
    await expect(db.query(`delete from benchmark_dataset_metric_events`)).rejects.toThrow(/append-only/i);
  });

  it('a pair must name at least one kind of file, and is unique per dataset and metric', async () => {
    const ds = await dsId(DS);
    const metric = (await q<{ id: string }>(`select id from benchmark_metric_definitions where metric_code = '${M_CUR}'`))[0].id;
    await expect(db.query(`insert into benchmark_dataset_metrics (dataset_id, metric_definition_id) values ('${ds}', '${(await q<{ id: string }>(`select id from benchmark_metric_definitions where metric_code = '${M_PCT2}'`))[0].id}')`)).rejects.toThrow(/some_kind/);
    await expect(db.query(`insert into benchmark_dataset_metrics (dataset_id, metric_definition_id, applies_to_values) values ('${ds}', '${metric}', true)`)).rejects.toThrow(/one_pair|duplicate/i);
  });

  it('is idempotent and never undoes a change made on the screen: the seed runs only while the table is empty', async () => {
    const wealth = await dsId('AU household wealth distribution');
    const before = await countAll('benchmark_dataset_metrics');
    await removeMap(ACT, wealth, 'net_worth', 'check that a rerun does not re-add it', true);
    expect(await countAll('benchmark_dataset_metrics')).toBe(before - 1);
    await db.exec(MIGRATION);
    expect(await countAll('benchmark_dataset_metrics')).toBe(before - 1);
    expect(await mappedCodes(wealth, 'values')).toEqual([]);
    await setMap(ACT, wealth, 'net_worth', true, false, 'restore the seeded pair');
    expect(await mappedCodes(wealth, 'values')).toEqual(['net_worth']);
  });
});

describe('staging refuses a metric that is not mapped (where enforced) and accepts a legitimate pair', () => {
  it('a legitimate pair stages', async () => {
    const s = await stage(UP, 'values', [vrow(2)]);
    expect(s.status).toBe('staged');
    const r = await stage(UP, 'target_ranges', [trow(2)]);
    expect(r.status).toBe('staged');
  });

  it('NEW: a registered metric that is not mapped to the dataset is refused, naming the metrics that are allowed, and nothing is staged', async () => {
    const batches = await countAll('benchmark_upload_batches');
    const rows = await countAll('benchmark_upload_rows');
    await expectCode(stage(UP, 'values', [vrow(2, { metric_code: M_PCT2, unit: 'percentage', original_currency: '' })]), 'PB_E_MAPPING');
    await expectCode(stage(UP, 'values', [vrow(2, { metric_code: M_PCT, unit: 'percentage', original_currency: '', statistic_type: 'mean' }), vrow(3, { metric_code: M_PCT2, unit: 'percentage', original_currency: '' })]), `Metrics allowed for it: ${M_CUR}, ${M_PCT}`);
    expect(await countAll('benchmark_upload_batches')).toBe(batches);
    expect(await countAll('benchmark_upload_rows')).toBe(rows);
  });

  it('NEW: the kind of file matters: a metric mapped only for observed values is refused in a target ranges file, and the reverse', async () => {
    await expectCode(stage(UP, 'target_ranges', [trow(2, { dataset_name: DS })]), 'PB_E_MAPPING');
    await expectCode(stage(UP, 'values', [vrow(2, { dataset_name: DSR })]), 'PB_E_MAPPING');
    expect((await stage(UP, 'values', [vrow(2, { statistic_type: 'p90' })])).status).toBe('staged');
  });

  it('NEW: a dataset with no metric mapped yet refuses every row and says none is allowed yet', async () => {
    await db.exec(`insert into benchmark_datasets (benchmark_source_id, dataset_name, version, benchmark_class, source_period, geography_level, statistic_coverage, data_status)
      select id, 'PB MAP EMPTY DATASET', '1.0', 'observed_market', 'FY', 'country', 'median', 'draft' from benchmark_sources where source_name = 'PB_TEST_SOURCE'`);
    await expectCode(stage(UP, 'values', [vrow(2, { dataset_name: 'PB MAP EMPTY DATASET' })]), 'Metrics allowed for it: none yet');
  });

  it('a cohorts file is not affected (it carries no metric)', async () => {
    const crow = { row_no: 2, dataset_name: DS, dataset_version: '1.0', cohort_code: 'PB_MAP_COHORT', country_code: 'AU', region_code: '', urban_rural: '', age_band: 'AGE_25_34', income_band: '', household_type: '', life_stage: '', housing_tenure: '', employment_type: '', dependant_band: '', financial_dna_code: '', cross_border_flag: false, cohort_tier: 4, sample_size: null, cohort_description: 'Test cohort', source_release: 'r', source_file: 'f', source_locator: 'x' };
    const p = { kind: 'cohorts', dataset_name: DS, dataset_version: '1.0', file_name: 'c.csv', file_sha256: sha(), file_bytes: 10, template_version: 'FHIP-PB-COHORTS-1', rows: [crow] };
    const s = await as(UP, 'authenticated', async () => ((await db.query(`select public.stage_planning_benchmark_upload($1::jsonb) v`, [JSON.stringify(p)])).rows[0] as { v: Json }).v);
    expect(s.status).toBe('staged');
  });

  it('NC-MAP1: without the staging trigger the same wrong-metric assertion goes red', async () => {
    await db.exec('alter table benchmark_upload_rows disable trigger trg_benchmark_upload_rows_dataset_metric;');
    try {
      const s = await stage(UP, 'values', [vrow(2, { metric_code: M_PCT2, unit: 'percentage', original_currency: '', statistic_type: 'p80' })]);
      expect(s.status, 'NC-MAP1 named assertion: an unmapped metric must not stage').not.toBe('staged');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-MAP1 named assertion');
      return;
    } finally {
      await db.exec('alter table benchmark_upload_rows enable trigger trg_benchmark_upload_rows_dataset_metric;');
    }
    throw new Error('the control did not go red');
  });

  it('NC-MAP2: a trigger that always allows the row fails the same assertion', async () => {
    const mutated = TRIGGER_FN.replace('if v_ok then', 'if true then');
    expect(mutated).not.toBe(TRIGGER_FN);
    await db.exec(mutated);
    try {
      const s = await stage(UP, 'values', [vrow(2, { metric_code: M_PCT2, unit: 'percentage', original_currency: '', statistic_type: 'p25' })]);
      expect(s.status, 'NC-MAP2 named assertion: an unmapped metric must not stage').not.toBe('staged');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-MAP2 named assertion');
      return;
    } finally {
      await db.exec(TRIGGER_FN);
    }
    throw new Error('the control did not go red');
  });
});

describe('activation re-checks the mapping inside the activate transaction (defence in depth)', () => {
  it('a batch whose pair is removed after staging shows a blocker in the preview and Activate refuses it; re-adding the pair lets it through', async () => {
    const ds = await dsId(DS);
    const s = await stage(UP, 'values', [vrow(2, { statistic_type: 'p10', value_numeric: 7 })]);
    expect(((await get(ACT, s.batch_id as string)).blockers as string[]).join(' ')).not.toMatch(/Metric mapping/);
    const removed = await removeMap(ACT, ds, M_CUR, 'pair removed after staging', true);
    expect(removed).toMatchObject({ status: 'removed', staged_batches: expect.any(Number) });
    expect(Number(removed.staged_batches)).toBeGreaterThan(0);
    const view = await get(ACT, s.batch_id as string);
    expect((view.blockers as string[]).join(' ')).toMatch(/Metric mapping: 1 row\(s\) use a metric that is not mapped.*gross_household_income/);
    await expectCode(activate(ACT, s.batch_id as string), 'PB_E_NOT_READY');
    expect(await q(`select 1 from benchmark_values where dataset_id = '${ds}' and value_numeric = 7`)).toHaveLength(0);
    await setMap(ACT, ds, M_CUR, true, false, 'put the pair back');
    const ok = await activate(ACT, s.batch_id as string);
    expect(ok.status).toBe('activated');
    expect(await q(`select 1 from benchmark_values where dataset_id = '${ds}' and value_numeric = 7`)).toHaveLength(1);
  });

  it('NC-MAP3: without the readiness rule the same activation assertion goes red (the unmapped batch goes live)', async () => {
    const ds = await dsId(DS);
    const s = await stage(UP, 'values', [vrow(2, { statistic_type: 'p80', value_numeric: 8 })]);
    await removeMap(ACT, ds, M_CUR, 'control: remove the pair', true);
    const mutated = READINESS_FN.replace('if v_unmapped_n > 0 then', 'if false then');
    expect(mutated).not.toBe(READINESS_FN);
    await db.exec(mutated);
    try {
      const r = await activate(ACT, s.batch_id as string).then(() => 'activated', () => 'refused');
      expect(r, 'NC-MAP3 named assertion: an unmapped batch must not activate').toBe('refused');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-MAP3 named assertion');
      return;
    } finally {
      await db.exec(READINESS_FN);
      await db.exec(`delete from benchmark_values where dataset_id = '${ds}' and value_numeric = 8`);
      await setMap(ACT, ds, M_CUR, true, false, 'restore after the control');
    }
    throw new Error('the control did not go red');
  });
});

describe('maintaining the mapping: capability, audit, confirmation, live figures', () => {
  it('only the activate capability can add, change or remove: upload-only, no capability, plain user, anon and service role are refused', async () => {
    const ds = await dsId(DS);
    for (const who of [UP, NOCAP, PLAIN]) {
      await expectCode(setMap(who, ds, M_PCT2, true, false), 'PB_E_DENIED');
      await expectCode(removeMap(who, ds, M_CUR), 'PB_E_DENIED');
    }
    await expect(setMap(null, ds, M_PCT2, true, false, 'x reason', false, 'anon')).rejects.toThrow(/permission denied/i);
    await expect(setMap(null, ds, M_PCT2, true, false, 'x reason', false, 'service_role')).rejects.toThrow(/PB_E_DENIED|permission denied/i);
    expect(await mappedCodes(ds, 'values')).not.toContain(M_PCT2);
  });

  it('NC-MAP4: without the capability check an uploader could change the mapping (the named assertion goes red)', async () => {
    const ds = await dsId(DS);
    const mutated = SET_FN.replace('if v_uid is null or not public.is_planning_benchmark_activator() then', 'if v_uid is null then');
    expect(mutated).not.toBe(SET_FN);
    await db.exec(mutated);
    try {
      const r = await setMap(UP, ds, M_PCT2, true, false, 'control').then(() => 'allowed', () => 'denied');
      expect(r, 'NC-MAP4 named assertion: an upload-only caller must be denied').toBe('denied');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-MAP4 named assertion');
      return;
    } finally {
      await db.exec(SET_FN);
      await db.exec(`delete from benchmark_dataset_metrics where dataset_id = '${ds}' and metric_definition_id = (select id from benchmark_metric_definitions where metric_code = '${M_PCT2}')`);
    }
    throw new Error('the control did not go red');
  });

  it('adds, changes and removes a pair, with one append-only audit row each and the reason recorded', async () => {
    const ds = await dsId(DS);
    const before = await countAll('benchmark_dataset_metric_events');
    expect(await setMap(ACT, ds, M_PCT2, true, false, 'add for the test')).toMatchObject({ status: 'added' });
    expect(await setMap(ACT, ds, M_PCT2, true, false, 'same again')).toMatchObject({ status: 'unchanged' });
    expect(await setMap(ACT, ds, M_PCT2, true, true, 'both kinds')).toMatchObject({ status: 'changed' });
    expect(await mappedCodes(ds, 'ranges')).toContain(M_PCT2);
    // income_concentration has 4 live legacy bands that cite no source: they count as live figures of a ranges pair
    await expectCode(removeMap(ACT, ds, M_PCT2, 'remove again'), 'PB_E_LIVE');
    expect(await removeMap(ACT, ds, M_PCT2, 'remove again', true)).toMatchObject({ status: 'removed', live_figures: 4 });
    expect(await mappedCodes(ds, 'values')).not.toContain(M_PCT2);
    const ev = await q<{ action: string; reason: string; values_before: boolean | null; values_after: boolean | null }>(`select action, reason, values_before, values_after from benchmark_dataset_metric_events order by created_at, id offset ${before}`);
    expect(ev.map((e) => e.action)).toEqual(['added', 'changed', 'removed']);
    expect(ev.map((e) => e.reason)).toEqual(['add for the test', 'both kinds', 'remove again']);
    expect(await q(`select 1 from benchmark_dataset_metric_events where actor_user_id = '${ACT}' and dataset_name = '${DS}' and metric_code = '${M_PCT2}'`)).toHaveLength(5); // 2 from the visibility check plus these 3
  });

  it('refuses a missing reason, no kind of file, an unknown metric, an unknown dataset and a pair that does not exist', async () => {
    const ds = await dsId(DS);
    await expectCode(setMap(ACT, ds, M_PCT2, true, false, '  '), 'PB_E_INPUT');
    await expectCode(setMap(ACT, ds, M_PCT2, false, false, 'no kind'), 'PB_E_INPUT');
    await expectCode(setMap(ACT, ds, 'no_such_metric', true, false, 'unknown'), 'PB_E_NOT_FOUND');
    await expectCode(setMap(ACT, '00000000-0000-0000-0000-000000000000', M_PCT2, true, false, 'unknown'), 'PB_E_NOT_FOUND');
    await expectCode(removeMap(ACT, ds, M_PCT2, 'not mapped'), 'PB_E_NOT_FOUND');
    await expectCode(removeMap(ACT, ds, M_CUR, ''), 'PB_E_INPUT');
  });

  it('a pair with live figures cannot be removed or switched off without the explicit confirmation, and the live figures are never deleted', async () => {
    const wealth = await dsId('AU household wealth distribution');
    const liveBefore = (await q<{ c: number }>(`select count(*)::int c from benchmark_values where dataset_id = '${wealth}'`))[0].c;
    expect(liveBefore).toBeGreaterThan(0);
    await expectCode(removeMap(ACT, wealth, 'net_worth', 'live check'), 'PB_E_LIVE');
    await expectCode(setMap(ACT, wealth, 'net_worth', false, true, 'turn the values kind off'), 'PB_E_LIVE');
    expect(await mappedCodes(wealth, 'values')).toEqual(['net_worth']);
    const r = await removeMap(ACT, wealth, 'net_worth', 'confirmed removal', true);
    expect(r).toMatchObject({ status: 'removed' });
    expect(Number(r.live_figures)).toBe(liveBefore);
    expect((await q<{ c: number }>(`select count(*)::int c from benchmark_values where dataset_id = '${wealth}'`))[0].c).toBe(liveBefore);
    const ev = await q<{ live_figures: number; live_confirmed: boolean }>(`select live_figures, live_confirmed from benchmark_dataset_metric_events where dataset_name = 'AU household wealth distribution' and action = 'removed' order by created_at desc limit 1`);
    expect(ev[0]).toEqual({ live_figures: liveBefore, live_confirmed: true });
    await setMap(ACT, wealth, 'net_worth', true, false, 'restore the seeded pair');
  });

  it('NC-MAP5: a live-figure guard that is removed lets the unconfirmed removal through (the named assertion goes red)', async () => {
    const wealth = await dsId('AU household wealth distribution');
    const REMOVE_FN = extractFn(MIGRATION, 'remove_planning_benchmark_dataset_metric');
    const mutated = REMOVE_FN.replace('if v_live > 0 and not coalesce(p_confirm_live, false) then', 'if false then');
    expect(mutated).not.toBe(REMOVE_FN);
    await db.exec(mutated);
    try {
      const r = await removeMap(ACT, wealth, 'net_worth', 'control', false).then(() => 'removed', () => 'refused');
      expect(r, 'NC-MAP5 named assertion: unconfirmed removal of a live pair must be refused').toBe('refused');
    } catch (e) {
      expect((e as Error).name).toBe('AssertionError');
      expect((e as Error).message).toContain('NC-MAP5 named assertion');
      return;
    } finally {
      await db.exec(REMOVE_FN);
      if (!(await mappedCodes(wealth, 'values')).includes('net_worth')) await setMap(ACT, wealth, 'net_worth', true, false, 'restore after the control');
    }
    throw new Error('the control did not go red');
  });
});

describe('hand-over', () => {
  it('the check queries in the README run and return the values the README promises (before any test mapping change they were 71 seeded pairs)', async () => {
    const readme = fs.readFileSync(path.resolve(HERE, '..', '..', 'docs', 'planning-benchmarks', 'po_apply_mapping', 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const first = (await db.query(blocks[0])).rows[0] as Record<string, unknown>;
    expect(first).toMatchObject({ tables_ok: true, functions_ok: true, trigger_ok: true, no_api_write_ok: true });
    expect(Number(first.seeded_pairs)).toBeGreaterThanOrEqual(71);
    const per = (await db.query(blocks[1])).rows as Array<{ dataset_name: string; pairs: number }>;
    const byName = new Map(per.map((r) => [r.dataset_name, Number(r.pairs)]));
    expect(byName.get('FHIP Planning Benchmarks v1.0')).toBe(48);
    expect(byName.get('FHIP dependant-band household benchmark model')).toBe(11);
    expect(byName.has('India household consumption expenditure (rural/urban)')).toBe(false);
  });
});

describe('rollback', () => {
  it('the hand-over rollback restores the 0275 behaviour: the mapping objects are gone and an unmapped metric stages again', async () => {
    await db.exec(ROLLBACK);
    expect((await q<{ t: string | null }>(`select to_regclass('public.benchmark_dataset_metrics')::text t`))[0].t).toBeNull();
    expect((await q<{ c: number }>(`select count(*)::int c from pg_proc where proname in ('set_planning_benchmark_dataset_metric','remove_planning_benchmark_dataset_metric','pb_enforce_dataset_metric')`))[0].c).toBe(0);
    const s = await stage(UP, 'values', [vrow(2, { metric_code: M_PCT2, unit: 'percentage', original_currency: '', statistic_type: 'p75' })]);
    expect(s.status).toBe('staged');
    const view = await get(ACT, s.batch_id as string);
    expect(view.blockers as string[]).toEqual(expect.not.arrayContaining([expect.stringMatching(/Metric mapping/)]));
    // and the migration applies cleanly again afterwards
    await db.exec(MIGRATION);
    expect((await q<{ t: string | null }>(`select to_regclass('public.benchmark_dataset_metrics')::text t`))[0].t).not.toBeNull();
    expect(await countAll('benchmark_dataset_metrics')).toBe(71);
  });
});
