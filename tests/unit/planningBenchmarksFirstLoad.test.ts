// Planning Benchmarks - first-load import files, validated OFFLINE.
//
// EVIDENCE LABEL: code-complete, verified on an isolated in-memory PGlite replica of the benchmark tables.
// Not DEV-verified and not production-verified. No database other than that in-memory replica is touched and
// there is no network access.
//
// What "the app's own validators" means here (see docs/planning-benchmarks/IMPORT_SCHEMA_AND_PARAMETER_MAP_2026-10-03.md):
//   - the REAL Admin route handlers (app/api/admin/benchmarks/{sources,datasets,cohorts,values,target-ranges}/route.ts)
//     run unchanged, with only requireAdmin()/adminClient() substituted;
//   - their inserts hit the REAL DDL of migration 0011 (CHECK / FK / NOT NULL / unique), replayed from the migration text;
//   - the app-level rules the routes do not enforce but the live Twin depends on are checked by firstLoadChecks.mjs.
//
// NEGATIVE CONTROLS. Each rule is run twice: on the real files (must pass) and on a deliberately broken copy (the
// named check MUST return failures). A green check that cannot go red proves nothing.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildOfflineBenchmarkDb, readIdMaps, REPO_ROOT, type OfflineDb } from './support/planningBenchmarksOfflineDb';
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore plain .mjs helpers
import { readCsvFile, parseCsv, toCsv, VALUES_HEADER, COHORT_HEADER, TARGET_RANGE_HEADER, SOURCE_HEADER, dayFirst, isRealIsoDate, REGISTER_HEADER, splitSqlStatements, parseValuesTuples } from '../../scripts/planning-benchmarks/firstLoadLib.mjs';
// @ts-ignore
import { loadImportSet, buildPayload, listImportFiles, DATASET_HEADER } from '../../scripts/planning-benchmarks/firstLoadPayload.mjs';
// @ts-ignore
import { checkUnits, checkProvenance, checkObservationPeriods, checkTraceability, checkNoDuplicateKeys, checkDtiNotBackfilled, checkBandsPreserved, checkValuesComplete, checkDerivedRecompute, checkValueCohortBands, checkTargetRanges, normaliseBand, DATASETS, DATASET_NO_BY_NAME } from '../../scripts/planning-benchmarks/firstLoadChecks.mjs';

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/services/adminAuth', async (orig) => {
  const o = await orig<typeof import('@/lib/services/adminAuth')>();
  return {
    ...o,
    requireAdmin: async () => ({ user: { id: '00000000-0000-0000-0000-00000000ad01' }, forbidden: null }),
    adminClient: () => holder.client,
  };
});

import { POST as sourcesPOST } from '@/app/api/admin/benchmarks/sources/route';
import { POST as datasetsPOST } from '@/app/api/admin/benchmarks/datasets/route';
import { POST as cohortsPOST } from '@/app/api/admin/benchmarks/cohorts/route';
import { POST as valuesPOST } from '@/app/api/admin/benchmarks/values/route';
import { POST as targetRangesPOST } from '@/app/api/admin/benchmarks/target-ranges/route';

const DIR = path.join(REPO_ROOT, 'docs', 'planning-benchmarks', 'first_load');
const EXTRACTS = path.join(DIR, 'extracts');

type Rec = Record<string, string>;
interface Row {
  file: string;
  record: Rec;
}

function loadRegister(): Rec[] {
  return readCsvFile(path.join(DIR, 'PROVENANCE_REGISTER.csv')).records as Rec[];
}
function loadExtracts(): Map<string, Rec> {
  const m = new Map<string, Rec>();
  for (const n of fs.readdirSync(EXTRACTS).filter((f) => /\.observations\.csv(\.gz)?$/.test(f))) {
    const buf = fs.readFileSync(path.join(EXTRACTS, n));
    const text = (n.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
    for (const r of parseCsv(text).records as Rec[]) {
      if (m.has(r.obs_id)) throw new Error(`duplicate obs_id ${r.obs_id}`);
      m.set(r.obs_id, r);
    }
  }
  return m;
}

let off: OfflineDb;
let ids: Awaited<ReturnType<typeof readIdMaps>>;
const set = loadImportSet(DIR) as {
  files: { drafts: string[]; values: string[]; cohorts: string[]; targetRanges: string[]; sources: string[]; datasets: string[] };
  sources: Row[];
  datasets: Row[];
  cohorts: Row[];
  values: Row[];
  targetRanges: Row[];
};
const register = loadRegister();
const extracts = loadExtracts();

beforeAll(async () => {
  off = await buildOfflineBenchmarkDb();
  holder.client = off.fakeAdminClient();
  ids = await readIdMaps(off.db);
}, 180000);

function post(handler: (req: Request) => Promise<Response>, body: unknown) {
  return handler(new Request('http://offline.test/api', { method: 'POST', body: JSON.stringify(body) }));
}

describe('offline replica is a faithful, EMPTY-of-figures registry', () => {
  it('has the 12 registered datasets, 67 metric definitions and no values or target ranges', async () => {
    expect((await off.db.query('select count(*)::int c from benchmark_datasets')).rows[0]).toEqual({ c: 12 });
    expect((await off.db.query('select count(*)::int c from benchmark_metric_definitions')).rows[0]).toEqual({ c: 67 });
    expect((await off.db.query('select count(*)::int c from benchmark_values')).rows[0]).toEqual({ c: 0 });
    expect((await off.db.query('select count(*)::int c from benchmark_target_ranges')).rows[0]).toEqual({ c: 0 });
    for (const name of Object.values(DATASETS)) expect(ids.datasetByKey[`${name}||1.0`], name).toBeTruthy();
  });
});

describe('column contracts', () => {
  it('every import CSV header equals the documented contract exactly', () => {
    const f = set.files;
    for (const n of f.values) expect(readCsvFile(path.join(DIR, n)).header, n).toEqual(VALUES_HEADER);
    for (const n of f.cohorts) expect(readCsvFile(path.join(DIR, n)).header, n).toEqual(COHORT_HEADER);
    for (const n of f.targetRanges) expect(readCsvFile(path.join(DIR, n)).header, n).toEqual(TARGET_RANGE_HEADER);
    for (const n of f.sources) expect(readCsvFile(path.join(DIR, n)).header, n).toEqual(SOURCE_HEADER);
    for (const n of f.datasets) expect(readCsvFile(path.join(DIR, n)).header, n).toEqual(DATASET_HEADER);
  });
  it('the register CSV has the documented columns and real ISO dates', () => {
    expect(readCsvFile(path.join(DIR, 'PROVENANCE_REGISTER.csv')).header).toEqual(REGISTER_HEADER);
    for (const r of register) {
      expect(isRealIsoDate(r.obs_period_start), `${r.release_name} start`).toBe(true);
      if (r.obs_period_end) expect(isRealIsoDate(r.obs_period_end), `${r.release_name} end`).toBe(true);
      expect(isRealIsoDate(r.retrieval_date)).toBe(true);
      expect(Number(r.bytes)).toBeGreaterThan(0);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.licence_statement.length).toBeGreaterThan(10);
    }
  });
});

describe('every importable file passes the REAL import path (real route handlers + real DDL)', () => {
  it('sources, datasets, cohorts, values and target ranges all insert, with matching row counts', async () => {
    for (const { record } of set.sources) {
      const res = await post(sourcesPOST, Object.fromEntries(Object.entries(record).filter(([k, v]) => !k.startsWith('x_') && v !== '')));
      expect(res.status, `source ${record.source_name} ${await res.clone().text()}`).toBe(200);
    }
    const idsAfterSources = await readIdMaps(off.db);
    for (const { record } of set.datasets) {
      const body: Record<string, unknown> = { benchmark_source_id: idsAfterSources.sourceByName[record.source_name] };
      for (const [k, v] of Object.entries(record)) if (k !== 'source_name' && v !== '') body[k] = v === 'true' ? true : v === 'false' ? false : v;
      const res = await post(datasetsPOST, body);
      expect(res.status, `dataset ${record.dataset_name} ${await res.clone().text()}`).toBe(200);
    }
    const idsAfterDatasets = await readIdMaps(off.db);
    // The payload builder + the console runner are exercised end to end below; here we build the same bodies directly.
    const payload = buildPayload(set, idsAfterDatasets.metricByCode);
    for (const c of payload.cohorts) {
      const res = await post(cohortsPOST, { ...c.body, dataset_id: idsAfterDatasets.datasetByKey[c.datasetKey] });
      expect(res.status, `cohort ${c.body.cohort_code} ${await res.clone().text()}`).toBe(200);
    }
    const idsAfterCohorts = await readIdMaps(off.db);
    const valueBodies = payload.values.map((v: { datasetKey: string; cohortCode: string; metricCode: string; body: Record<string, unknown> }) => ({
      ...v.body,
      dataset_id: idsAfterCohorts.datasetByKey[v.datasetKey],
      metric_definition_id: payload.metricIds[v.metricCode],
      ...(v.cohortCode ? { cohort_id: idsAfterCohorts.cohortByCode[v.cohortCode] } : {}),
    }));
    if (valueBodies.length) {
      const res = await post(valuesPOST, { rows: valueBodies });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()).data.imported).toBe(valueBodies.length);
    }
    for (const t of payload.targetRanges) {
      const body = { ...t.body, metric_definition_id: payload.metricIds[t.metricCode], ...(t.sourceName ? { benchmark_source_id: idsAfterCohorts.sourceByName[t.sourceName] } : {}) };
      const res = await post(targetRangesPOST, body);
      expect(res.status, `target range ${t.metricCode} ${t.body.band_label} ${await res.clone().text()}`).toBe(200);
    }
    const c = (t: string) => off.db.query(`select count(*)::int c from ${t}`).then((r) => (r.rows[0] as { c: number }).c);
    expect(await c('benchmark_values')).toBe(set.values.length);
    expect(await c('benchmark_target_ranges')).toBe(set.targetRanges.length);
  }, 180000);
});

describe('app-level rules the routes do not enforce but the live Twin depends on', () => {
  it('units match each metric definition, currency amounts carry the dataset country currency', () => {
    expect(checkUnits(set.values, ids.metricUnitByCode)).toEqual([]);
  });
  it('NEGATIVE CONTROL: a currency figure labelled as a percentage fails checkUnits', () => {
    const broken = structuredClone(set.values.find((r) => r.record.unit === 'currency'));
    if (!broken) return; // no currency rows in this load: nothing to break
    broken.record.unit = 'percentage';
    const fails = checkUnits([broken], ids.metricUnitByCode);
    expect(fails.length).toBeGreaterThan(0);
    expect(fails[0]).toMatch(/unit "percentage"/);
  });

  it('every value row carries provenance (release, period, file, locator, retrieval date) and valid ISO dates', () => {
    expect(checkProvenance(set.values)).toEqual([]);
  });
  it('NEGATIVE CONTROL: a row with its retrieval date removed fails checkProvenance', () => {
    const broken = structuredClone(set.values[0]);
    broken.record.x_retrieval_date = '';
    expect(checkProvenance([broken]).join(' ')).toMatch(/x_retrieval_date/);
  });

  it('every observation period claimed exists in the provenance register (no interpolated period)', () => {
    expect(checkObservationPeriods(set.values, register)).toEqual([]);
  });
  it('NEGATIVE CONTROL (interpolated year): a row inserted for a survey year that was never downloaded fails the register check', () => {
    const base = structuredClone(set.values.find((r) => r.record.x_obs_period_start));
    if (!base) throw new Error('no value rows');
    // pick a plausible-looking but absent period: shift the real period by one year
    const shift = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
    base.record.x_obs_period_start = shift(base.record.x_obs_period_start);
    base.record.x_obs_period_end = shift(base.record.x_obs_period_end);
    base.record.x_release = base.record.x_release.replace(/\d{4}-\d{2}/, 'INTERPOLATED');
    const fails = checkObservationPeriods([base], register);
    expect(fails.length).toBe(1);
    expect(fails[0]).toMatch(/not in the provenance register/);
  });

  it('every value traces to a published observation; non-derived values equal the published figure exactly', () => {
    expect(checkTraceability(set.values, extracts)).toEqual([]);
  });
  it('NEGATIVE CONTROL: altering a published figure by 1 fails checkTraceability', () => {
    const src = set.values.find((r) => String(r.record.is_derived).toLowerCase() !== 'true');
    if (!src) return;
    const broken = structuredClone(src);
    broken.record.value_numeric = String(Number(broken.record.value_numeric) + 1);
    expect(checkTraceability([broken], extracts).join(' ')).toMatch(/differs from published/);
  });

  it('exactly one row per (metric, cohort, statistic) across all files (the Twin keeps one)', () => {
    expect(checkNoDuplicateKeys(set.values)).toEqual([]);
  });
  it('NEGATIVE CONTROL: loading the same figure twice (e.g. two releases) fails checkNoDuplicateKeys', () => {
    const dup = structuredClone(set.values[0]);
    dup.record.x_obs_id = 'DUP-1';
    expect(checkNoDuplicateKeys([set.values[0], dup]).join(' ')).toMatch(/duplicates key/);
  });

  it('cohort age bands are the source bands (shape-normalised only), never recoded', () => {
    expect(checkBandsPreserved(set.cohorts, extracts)).toEqual([]);
  });
  it('NEGATIVE CONTROL: relabelling the ABS band 15-24 as the app band 18-24 fails checkBandsPreserved', () => {
    const c = set.cohorts.find((r) => r.record.age_band && normaliseBand((extracts.get(r.record.x_obs_id.split('+')[0]) || { dim_age_band: '' }).dim_age_band || '') === r.record.age_band);
    if (!c) return;
    const broken = structuredClone(c);
    broken.record.age_band = 'AGE_18_24_RELABELLED';
    expect(checkBandsPreserved([broken], extracts).length).toBeGreaterThan(0);
    expect(normaliseBand('15-24')).toBe('AGE_15_24');
    expect(normaliseBand('75 and over')).toBe('AGE_75_PLUS');
    expect(normaliseBand('65+')).toBe('AGE_65_PLUS');
  });

  it('unit multipliers are pure conversions: NEGATIVE CONTROL - a $-thousand figure imported without its x1000 fails', () => {
    const src = set.values.find((r) => r.record.x_unit_multiplier === '1000');
    if (!src) throw new Error('no x1000 row to break');
    expect(checkTraceability([src], extracts)).toEqual([]);
    const broken = structuredClone(src);
    broken.record.value_numeric = String(Number(broken.record.value_numeric) / 1000);
    expect(checkTraceability([broken], extracts).join(' ')).toMatch(/differs from published/);
    const odd = structuredClone(src);
    odd.record.x_unit_multiplier = '52';
    expect(checkTraceability([odd], extracts).join(' ')).toMatch(/pure unit conversion/);
  });

  it('every derived value is exactly reproducible from the published observations it cites', () => {
    expect(checkDerivedRecompute(set.values, extracts)).toEqual([]);
    expect(set.values.filter((r) => r.record.is_derived === 'true').length).toBeGreaterThan(0);
  });
  it('NEGATIVE CONTROL: a derived value nudged away from its inputs fails checkDerivedRecompute', () => {
    const src = set.values.find((r) => r.record.is_derived === 'true' && r.record.metric_code === 'property_concentration');
    if (!src) throw new Error('no property_concentration row');
    const broken = structuredClone(src);
    broken.record.value_numeric = String(Number(broken.record.value_numeric) + 0.5);
    expect(checkDerivedRecompute([broken], extracts).join(' ')).toMatch(/!= recomputed/);
  });

  it('a value row only uses a cohort whose age band is the band the source published', () => {
    const bands: Record<string, string> = { ...ids.cohortAgeBandByCode };
    for (const c of set.cohorts) bands[c.record.cohort_code] = c.record.age_band;
    expect(checkValueCohortBands(set.values, bands, extracts)).toEqual([]);
  });
  it('NEGATIVE CONTROL: pointing the ABS 15-24 figure at the app 18-24 cohort fails checkValueCohortBands', () => {
    const src = set.values.find((r) => r.record.cohort_code === 'AU_AGE_15_24');
    if (!src) throw new Error('no 15-24 row');
    const broken = structuredClone(src);
    broken.record.cohort_code = 'AU_AGE_18_24';
    const msg = checkValueCohortBands([broken], ids.cohortAgeBandByCode, extracts).join(' ');
    expect(msg).toMatch(/AGE_18_24/);
    expect(msg).toMatch(/published band is "15-24"/);
  });

  it('target ranges carry provenance, a registered period, and exactly one published bound', () => {
    expect(set.targetRanges.length).toBeGreaterThan(0);
    expect(checkTargetRanges(set.targetRanges, extracts, register)).toEqual([]);
  });
  it('NEGATIVE CONTROL: an ASFA band edited away from the published lump sum fails checkTargetRanges', () => {
    const src = set.targetRanges.find((r) => r.record.band_label === 'comfortable');
    if (!src) throw new Error('no comfortable band');
    const broken = structuredClone(src);
    broken.record.lower_bound = String(Number(broken.record.lower_bound) + 5000);
    expect(checkTargetRanges([broken], extracts, register).join(' ')).toMatch(/exactly one bound must equal the published figure/);
    const wrongPeriod = structuredClone(src);
    wrongPeriod.record.x_obs_period_start = '2025-02-01';
    expect(checkTargetRanges([wrongPeriod], extracts, register).join(' ')).toMatch(/not in the provenance register/);
  });

  it('the DTI threshold is effective from 01/02/2026 and is not backfilled before that date', () => {
    const dti = set.values.filter((r) => r.record.dataset_name === DATASETS[5]);
    expect(dti.length).toBeGreaterThan(0);
    expect(checkDtiNotBackfilled(set.values)).toEqual([]);
    for (const r of dti) expect(dayFirst(r.record.effective_from)).toBe('01/02/2026');
  });
  it('NEGATIVE CONTROL (DTI backfill): a copy of the DTI row dated before 01/02/2026 fails checkDtiNotBackfilled', () => {
    const src = set.values.find((r) => r.record.dataset_name === DATASETS[5]);
    if (!src) throw new Error('no DTI row');
    for (const early of ['2025-01-01', '2020-07-01', '2026-01-31']) {
      const broken = structuredClone(src);
      broken.record.effective_from = early;
      expect(checkDtiNotBackfilled([broken]).join(' '), early).toMatch(/before 2026-02-01/);
    }
  });

  it('no NEEDS_MANUAL_CHECK observation is imported', () => {
    for (const r of set.values) expect(extracts.get(String(r.record.x_obs_id).split('+')[0])?.status, r.record.x_obs_id).toBe('OK');
  });
});

describe('draft files can never be imported', () => {
  it('the dependant-band worksheet and the FHIP v1.0 draft are excluded by file discovery', () => {
    const f = listImportFiles(DIR);
    expect(f.drafts.some((n: string) => /^01_.*DRAFT_WORKSHEET/.test(n))).toBe(true);
    expect(f.drafts.some((n: string) => /^11_.*DRAFT_FOR_PO_APPROVAL/.test(n))).toBe(true);
    for (const n of [...f.values, ...f.cohorts, ...f.targetRanges]) expect(n).not.toMatch(/DRAFT/i);
  });
  it('NEGATIVE CONTROL: the dependant-band worksheet pushed through the real values route is refused (no value, no approval)', async () => {
    const ws = readCsvFile(path.join(DIR, '01_fhip_dependant_band_model.DRAFT_WORKSHEET.csv')).records as Rec[];
    expect(ws.length).toBe(198);
    expect(ws.every((r) => r.value_numeric === '')).toBe(true);
    expect(ws.every((r) => /NEEDS PO APPROVAL/.test(r.approval_status))).toBe(true);
    // The real values route would ACCEPT a null value (it only requires dataset/metric/statistic), so the guards are:
    // (1) drafts are never discovered as import files, (2) checkValuesComplete refuses a blank figure, (3) the
    // worksheet's dataset has no row in the import set.
    const asRows = ws.map((r) => ({ file: 'worksheet', record: r }));
    const fails = checkValuesComplete(asRows);
    expect(fails.length).toBe(198);
    expect(fails[0]).toMatch(/no numeric value_numeric/);
    expect(checkValuesComplete(set.values)).toEqual([]);
    expect(set.values.some((r) => r.record.dataset_name === ws[0].dataset_name)).toBe(false);
  });
  it('the FHIP v1.0 draft equals the repo seed it was transcribed from (196 bands, 48 metrics)', () => {
    const draft = readCsvFile(path.join(DIR, '11_fhip_planning_benchmarks_v1.DRAFT_FOR_PO_APPROVAL.target_ranges.csv')).records as Rec[];
    expect(draft.length).toBe(196);
    expect(new Set(draft.map((r) => r.metric_code)).size).toBe(48);
    const mig = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', '0012_module8_benchmark_seed.sql'), 'utf8');
    const seedTuples = (splitSqlStatements(mig) as string[])
      .filter((s) => /^insert into benchmark_target_ranges/i.test(s) && !/ASFA_STANDARD_2026/.test(s))
      .flatMap((s) => parseValuesTuples(s) as unknown[][]);
    expect(seedTuples.length).toBe(draft.length);
    for (const r of draft) {
      expect(r.x_release).toMatch(/FHIP Planning Benchmarks v1\.0/);
      expect(Number(r.band_tier)).toBeGreaterThanOrEqual(1);
      expect(Number(r.band_tier)).toBeLessThanOrEqual(4);
    }
  });
});

describe('builder and console runner (end to end against the real route handlers on the replica)', () => {
  it('buildPayload strips every x_ provenance column and resolves nothing it cannot find', async () => {
    const payload = buildPayload(set, ids.metricByCode);
    const all = JSON.stringify(payload);
    expect(all).not.toMatch(/"x_/);
    expect(() => buildPayload({ ...set, values: [{ file: 'f', record: { ...set.values[0].record, metric_code: 'no_such_metric' } }] }, ids.metricByCode)).toThrow(/no_such_metric/);
  });

  it('the runner dry-run writes nothing; the real run writes exactly the payload; a second run is refused (no duplicate load)', async () => {
    const fresh = await buildOfflineBenchmarkDb();
    holder.client = fresh.fakeAdminClient();
    const freshIds = await readIdMaps(fresh.db);
    const payload = buildPayload(set, freshIds.metricByCode);

    const route: Record<string, (req: Request) => Promise<Response>> = {
      '/sources': sourcesPOST,
      '/datasets': datasetsPOST,
      '/cohorts': cohortsPOST,
      '/values': valuesPOST,
      '/target-ranges': targetRangesPOST,
    };
    // GET side is a test fake over the same replica (the runner only needs id + natural key fields back).
    const fakeFetch = async (url: string, init: { method: string; body?: string }) => {
      const u = new URL(url, 'http://offline.test');
      const p = u.pathname.replace('/api/admin/benchmarks', '');
      if (init.method === 'POST') return route[p](new Request(u.toString(), { method: 'POST', body: init.body }));
      let rows: unknown[] = [];
      if (p === '/sources') rows = (await fresh.db.query('select * from benchmark_sources')).rows;
      else if (p === '/datasets') rows = (await fresh.db.query('select * from benchmark_datasets')).rows;
      else if (p === '/cohorts') rows = (await fresh.db.query('select * from benchmark_cohorts')).rows;
      else if (p === '/values') rows = (await fresh.db.query('select * from benchmark_values where dataset_id = $1', [u.searchParams.get('dataset_id')])).rows;
      else if (p === '/target-ranges')
        rows = (await fresh.db.query('select t.* from benchmark_target_ranges t join benchmark_metric_definitions m on m.id = t.metric_definition_id where m.metric_code = $1', [u.searchParams.get('metric_code')])).rows;
      return Response.json({ data: rows });
    };

    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'planning-benchmarks', 'import_via_admin_api.console.js'), 'utf8');
    const g: { pbRunImport?: (p: unknown, o: unknown) => Promise<{ ok: boolean; dryRun: boolean; problems?: string[]; created: Record<string, string[]> }> } = {};
    new Function('globalThis', src)(g);
    const downloads: string[] = [];
    const opts = { fetch: fakeFetch, log: () => {}, download: (n: string) => downloads.push(n) };

    const dry = await g.pbRunImport!(payload, { ...opts, dryRun: true });
    expect(dry.ok).toBe(true);
    expect((await fresh.db.query('select count(*)::int c from benchmark_values')).rows[0]).toEqual({ c: 0 });

    const real = await g.pbRunImport!(payload, { ...opts, dryRun: false });
    expect(real.problems ?? []).toEqual([]);
    expect(real.ok).toBe(true);
    expect(real.created.values.length).toBe(payload.values.length);
    expect(real.created.targetRanges.length).toBe(payload.targetRanges.length);
    expect((await fresh.db.query('select count(*)::int c from benchmark_values')).rows[0]).toEqual({ c: payload.values.length });
    expect(downloads.some((n) => /rollback/.test(n))).toBe(true);

    if (payload.values.length) {
      const again = await g.pbRunImport!(payload, { ...opts, dryRun: false });
      expect(again.ok).toBe(false);
      expect((again.problems ?? []).join(' ')).toMatch(/already has/);
      expect((await fresh.db.query('select count(*)::int c from benchmark_values')).rows[0]).toEqual({ c: payload.values.length });
    }
    holder.client = off.fakeAdminClient();
  }, 240000);
});

describe('documented counts match the files', () => {
  it('45 values, 4 target ranges, 1 cohort, no sources/datasets files; the register CSV has rows for every imported dataset', () => {
    expect(set.values.length).toBe(45);
    expect(set.targetRanges.length).toBe(4);
    expect(set.cohorts.length).toBe(1);
    expect(set.sources.length + set.datasets.length).toBe(0);
    const imported = new Set(set.values.map((r) => DATASET_NO_BY_NAME[r.record.dataset_name]));
    imported.add(12);
    for (const no of imported) expect(register.some((r) => Number(r.dataset_no) === no), `dataset ${no}`).toBe(true);
    expect([...imported].sort((a, b) => Number(a) - Number(b))).toEqual([2, 3, 4, 5, 6, 7, 9, 10, 12]);
  });
});

describe('helpers', () => {
  it('CSV round trip keeps quotes, commas and newlines', () => {
    const header = ['a', 'b'];
    const recs = [{ a: 'x,y', b: 'he said "hi"\nbye' }];
    expect(parseCsv(toCsv(header, recs)).records).toEqual(recs);
  });
  it('day-first formatting of ISO dates', () => {
    expect(dayFirst('2026-02-01')).toBe('01/02/2026');
    expect(isRealIsoDate('2026-02-30')).toBe(false);
  });
  it('every dataset has a number and a name', () => {
    expect(Object.keys(DATASETS).length).toBe(12);
    expect(DATASET_NO_BY_NAME['AU ASFA retirement standard']).toBe(12);
  });
});
