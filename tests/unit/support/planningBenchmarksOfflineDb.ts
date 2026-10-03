// Offline harness for the Planning Benchmarks first-load tests.
//
// It builds an ISOLATED, in-memory Postgres (PGlite) containing ONLY the six benchmark tables, created from
// the REAL DDL text of migration 0011, plus the registry rows that migrations 0012 and 0023 register
// (67 metric definitions, sources, the 12 datasets, the starter cohorts). It never reads or writes any
// DEV or production database. The values / target-range / cohort / source / dataset tables start EMPTY of
// figures exactly as the PO describes the DEV state (the 0012/0023 seed VALUES statements are deliberately
// not replayed).
//
// `fakeAdminClient` implements just enough of the Supabase query-builder surface (insert -> select ->
// single / thenable) for the real Admin route handlers to run unchanged against that database, so the
// import goes through the real route validation AND the real database CHECK / FK / NOT NULL constraints.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../../scripts/planning-benchmarks/firstLoadLib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const MIG = path.join(REPO_ROOT, 'supabase', 'migrations');

export const TEST_ADMIN_ID = '00000000-0000-0000-0000-00000000ad01';

export interface OfflineDb {
  db: PGlite;
  fakeAdminClient: () => unknown;
}

function read(name: string): string {
  return fs.readFileSync(path.join(MIG, name), 'utf8');
}

export async function buildOfflineBenchmarkDb(): Promise<OfflineDb> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create table countries (country_code char(2) primary key);
    insert into countries values ('AU'), ('IN');
    insert into auth.users (id, email) values ('${TEST_ADMIN_ID}', 'offline-admin@example.invalid');
  `);

  const m0011 = splitSqlStatements(read('0011_module8_financial_twin.sql')) as string[];
  const ddl = m0011.filter((s) => /^create table benchmark_(sources|datasets|metric_definitions|cohorts|values|target_ranges)\b/i.test(s) || /^create index idx_benchmark_/i.test(s));
  if (ddl.filter((s) => /^create table/i.test(s)).length !== 6) throw new Error('expected 6 benchmark tables in 0011');
  for (const s of ddl) await db.exec(s);

  const m0012 = splitSqlStatements(read('0012_module8_benchmark_seed.sql')) as string[];
  const m0023 = splitSqlStatements(read('0023_module8_dependant_band.sql')) as string[];
  // Registry ONLY: metric definitions, sources, datasets, cohorts (and the 0023 cohort tagging). No values, no target ranges.
  const registry = (s: string) => /^insert into benchmark_(metric_definitions|sources|datasets|cohorts)\b/i.test(s) || /^update benchmark_cohorts\b/i.test(s);
  for (const s of [...m0012, ...m0023].filter(registry)) await db.exec(s);

  const fakeAdminClient = () => ({
    from(table: string) {
      return {
        insert(body: Record<string, unknown> | Record<string, unknown>[]) {
          const rows = Array.isArray(body) ? body : [body];
          const run = async (single: boolean) => {
            try {
              const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
              const colList = cols.map((c) => `"${c}"`).join(', ');
              const sql = `insert into "${table}" (${colList}) select ${colList} from json_populate_recordset(null::"${table}", $1::json) returning *`;
              const res = await db.query(sql, [JSON.stringify(rows)]);
              return { data: single ? (res.rows[0] ?? null) : res.rows, error: null };
            } catch (e) {
              const err = e as { message?: string; code?: string };
              return { data: null, error: { message: err.message ?? String(e), code: err.code ?? '' } };
            }
          };
          return {
            select() {
              return {
                single: () => run(true),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run(false).then(res, rej),
              };
            },
          };
        },
      };
    },
  });

  return { db, fakeAdminClient };
}

/** natural key -> uuid maps, read from the offline database (what the PO's read-only export provides in real use). */
export async function readIdMaps(db: PGlite) {
  const metrics = await db.query<{ id: string; metric_code: string; unit: string }>('select id, metric_code, unit from benchmark_metric_definitions');
  const datasets = await db.query<{ id: string; dataset_name: string; version: string }>('select id, dataset_name, version from benchmark_datasets');
  const cohorts = await db.query<{ id: string; cohort_code: string; age_band: string | null }>('select id, cohort_code, age_band from benchmark_cohorts');
  const sources = await db.query<{ id: string; source_name: string }>('select id, source_name from benchmark_sources');
  return {
    metricByCode: Object.fromEntries(metrics.rows.map((r) => [r.metric_code, r.id])),
    metricUnitByCode: Object.fromEntries(metrics.rows.map((r) => [r.metric_code, r.unit])),
    datasetByKey: Object.fromEntries(datasets.rows.map((r) => [`${r.dataset_name}||${r.version}`, r.id])),
    cohortByCode: Object.fromEntries(cohorts.rows.map((r) => [r.cohort_code, r.id])),
    cohortAgeBandByCode: Object.fromEntries(cohorts.rows.map((r) => [r.cohort_code, r.age_band ?? ''])) as Record<string, string>,
    sourceByName: Object.fromEntries(sources.rows.map((r) => [r.source_name, r.id])),
  };
}
