// Planning Benchmarks production first-load: rehearsal on an isolated in-memory Postgres (PGlite).
//
// The whole migration ledger (0001 .. 0278, the same files production receives) plus supabase/seed.sql is replayed into
// PGlite. Then every shipped file goes through the REAL service code the Upload screen calls (stagePlanningBenchmarkUpload:
// read -> real validator with the real allowed lists -> the real SECURITY DEFINER stage RPC), is previewed with the real
// get RPC, and is activated by a SECOND, different person with the real activate RPC. Nothing is simulated except the
// HTTP layer. The result is what the screen would say for each file on a database in the migration-seeded state, which
// is the state production is expected to be in before the first load.
//
// EVIDENCE LABEL: PGlite-verified. Not DEV-verified, not production-verified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { activatePlanningBenchmarkUpload, getPlanningBenchmarkUpload, stagePlanningBenchmarkUpload, RpcFailure, type StageOutcome } from '../../lib/planning-benchmarks/uploadService';
import { loadAllowedValues } from '../../lib/planning-benchmarks/allowedValues';
import type { BuiltFile } from './buildProductionFirstLoad';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const SHIM = path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
const SEED = path.join(ROOT, 'supabase', 'seed.sql');

export const UPLOADER = 'eeeeeeee-0000-0000-0000-00000000f001';
export const ACTIVATOR = 'eeeeeeee-0000-0000-0000-00000000f002';
export const BOTH = 'eeeeeeee-0000-0000-0000-00000000f003';

type Json = Record<string, unknown>;

/** The migration files up to and including `upTo` (default: every file in the folder). */
export function migrationFiles(upTo?: string): string[] {
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  return upTo ? files.filter((f) => f <= upTo + '￿') : files;
}

export async function createReplicaDb(upTo = '0278'): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(SEED, 'utf8');
  for (const f of migrationFiles(upTo)) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec(`insert into auth.users(id,email) values ('${UPLOADER}','uploader@pg.test'),('${ACTIVATOR}','activator@pg.test'),('${BOTH}','both@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${UPLOADER}'),('${ACTIVATOR}'),('${BOTH}');`);
  await db.exec(`update admin_users set can_upload_planning_benchmarks = true where user_id in ('${UPLOADER}','${BOTH}');`);
  await db.exec(`update admin_users set can_activate_planning_benchmarks = true where user_id in ('${ACTIVATOR}','${BOTH}');`);
  return db;
}

/** A supabase-js shaped client (only what the upload service uses) that runs as one signed-in user inside PGlite. */
export function sessionClient(db: PGlite, uid: string) {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await db.exec('set role authenticated;');
    try {
      return await fn();
    } finally {
      await db.exec('reset role;');
      await db.query(`select set_config('request.jwt.claims', '', false)`);
    }
  };
  // PostgREST returns dates as 'YYYY-MM-DD' text; PGlite returns Date objects. Convert so the app code sees what it sees live.
  const plain = (rows: Json[]): Json[] => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])));
  const failure = (e: unknown) => ({ data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } });
  return {
    from(table: string) {
      return {
        select(cols: string) {
          return {
            limit: (n: number) =>
              run(async () => {
                try {
                  return { data: plain((await db.query(`select ${cols} from public.${table} limit ${Number(n)}`)).rows as Json[]), error: null };
                } catch (e) {
                  return failure(e);
                }
              }),
          };
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}${k === 'p' ? '::jsonb' : ''}`).join(', ')}) v`;
      const params = keys.map((k) => (k === 'p' ? JSON.stringify(args[k]) : args[k]));
      return run(async () => {
        try {
          return { data: ((await db.query(sql, params)).rows[0] as { v: unknown }).v, error: null };
        } catch (e) {
          return failure(e);
        }
      });
    },
  };
}

export type SessionClient = ReturnType<typeof sessionClient>;
const asClient = (c: SessionClient) => c as unknown as Parameters<typeof stagePlanningBenchmarkUpload>[0];

export const todayOf = async (db: PGlite): Promise<string> => ((await db.query(`select current_date::text d`)).rows[0] as { d: string }).d;

export interface StepResult {
  file: string;
  kind: string;
  outcome: StageOutcome['status'] | 'stage_error' | 'activate_error';
  stageIssues: Array<{ code: string; row: number | null; message: string }>;
  batchId: string | null;
  counts: Record<string, number> | null;
  preview: Json | null;
  activated: Json | null;
  error: string | null;
}

/** Stage, preview and (optionally) activate one shipped file as two different people. */
export async function runOneFile(db: PGlite, f: BuiltFile, bytes: Uint8Array, opts: { activate: boolean; uploader?: string; activator?: string; selfAck?: boolean } = { activate: true }): Promise<StepResult> {
  const uploader = sessionClient(db, opts.uploader ?? UPLOADER);
  const activator = sessionClient(db, opts.activator ?? ACTIVATOR);
  const todayIso = await todayOf(db);
  const res: StepResult = { file: f.fileName, kind: f.kind, outcome: 'staged', stageIssues: [], batchId: null, counts: null, preview: null, activated: null, error: null };
  let staged: StageOutcome;
  try {
    staged = await stagePlanningBenchmarkUpload(asClient(uploader), { fileName: f.fileName, bytes, kind: f.kind, todayIso });
  } catch (e) {
    res.outcome = 'stage_error';
    res.error = e instanceof RpcFailure ? e.error.message ?? 'rpc failure' : (e as Error).message;
    return res;
  }
  res.outcome = staged.status;
  if (staged.status === 'rejected') {
    res.stageIssues = staged.issues.filter((i) => i.severity === 'error').map((i) => ({ code: i.code, row: i.rowNumber, message: i.message }));
    return res;
  }
  if (staged.status === 'needs_sheet') return res;
  res.batchId = staged.batchId;
  res.counts = staged.counts;
  res.preview = await getPlanningBenchmarkUpload(asClient(activator), staged.batchId);
  if (opts.activate) {
    const batch = res.preview.batch as Json;
    try {
      res.activated = await activatePlanningBenchmarkUpload(asClient(activator), staged.batchId, {
        expectedSha256: String(batch.file_sha256),
        expectedDigest: String(batch.staging_digest),
        expectedCounts: batch.counts as Record<string, number>,
        selfActivationAck: opts.selfAck === true,
      });
    } catch (e) {
      res.outcome = 'activate_error';
      res.error = e instanceof RpcFailure ? e.error.message ?? 'rpc failure' : (e as Error).message;
    }
  }
  return res;
}

export async function allowedAs(db: PGlite, uid: string) {
  return loadAllowedValues(sessionClient(db, uid) as unknown as Parameters<typeof loadAllowedValues>[0], await todayOf(db));
}

export { readShippedFile as readShipped } from './productionFirstLoadValidate';

/** Counts a person would check before and after the load (the same figures the runbook's SQL returns). */
export async function stateSnapshot(db: PGlite): Promise<Json> {
  const one = async (sql: string) => (await db.query(sql)).rows as Json[];
  return {
    datasets: (await one(`select count(*)::int c from benchmark_datasets`))[0].c,
    mappingPairs: (await one(`select count(*)::int c from benchmark_dataset_metrics`))[0].c,
    liveValuesByDataset: Object.fromEntries((await one(`select d.dataset_name n, count(v.id)::int c from benchmark_datasets d left join benchmark_values v on v.dataset_id = d.id and (v.effective_to is null or v.effective_to > current_date) group by 1 order by 1`)).map((r) => [r.n, r.c])),
    allValues: (await one(`select count(*)::int c from benchmark_values`))[0].c,
    endDatedValues: (await one(`select count(*)::int c from benchmark_values where effective_to is not null`))[0].c,
    bands: (await one(`select count(*)::int c from benchmark_target_ranges`))[0].c,
    liveBands: (await one(`select count(*)::int c from benchmark_target_ranges where effective_to is null or effective_to > current_date`))[0].c,
    cohorts: (await one(`select count(*)::int c from benchmark_cohorts`))[0].c,
    batches: (await one(`select status s, count(*)::int c from benchmark_upload_batches group by 1 order by 1`)),
  };
}
