// Test-only: the REAL risk-free upload service functions (planRiskFreeUpload / commitRiskFreeUpload) running against a REAL Postgres
// (PGlite, in process) that holds the REAL migration 0260 (and any later migration the caller names), under the platform roles.
//
// Why a harness and not the in-memory fake: the 19-10-2026 production observation was "the date did not move", and a fake database cannot
// answer that, because the rule lives in the SQL function. Here the TypeScript service and the SQL function are both the real files; only
// the HTTP hop between them (PostgREST) is replaced by a thin adapter that runs the same call as the `authenticated` role with auth.uid()
// set, exactly what the function sees in production.
//
// Evidence label for anything built on this: PGLITE (an in-process Postgres with a platform shim), not DEV and not production.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const strip = (s: string): string => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');

export const U = {
  upload: 'aaaa0000-0000-0000-0000-0000000f0001',
  switchOnly: 'aaaa0000-0000-0000-0000-0000000f0002',
  noCapability: 'aaaa0000-0000-0000-0000-0000000f0003',
  plainUser: 'aaaa0000-0000-0000-0000-0000000f0004',
} as const;

/** Replays the platform shim, the two tables 0260 depends on (reduced to the columns it touches) and then the named migration files. */
export type MigrationSpec = string | { name: string; transform: (sql: string) => string };

/** The text of a migration file, optionally rewritten (a NEGATIVE CONTROL removes one rule and the assertion that guards it must go red). */
export function migrationText(spec: MigrationSpec): string {
  const name = typeof spec === 'string' ? spec : spec.name;
  const sql = readFileSync(path.join(ROOT, 'supabase', 'migrations', name), 'utf8');
  return typeof spec === 'string' ? sql : spec.transform(sql);
}

export async function createRiskFreeDb(migrationFiles: MigrationSpec[] = ['0260_nav2_risk_free_governed_dataset.sql']): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql'), 'utf8'));
  await db.exec(`
    create table if not exists admin_users (user_id uuid primary key references auth.users(id) on delete cascade, granted_at timestamptz default now());
    alter table admin_users enable row level security;
    drop policy if exists self_read_admin_users on admin_users;
    create policy self_read_admin_users on admin_users for select using (auth.uid() = user_id);
    create table if not exists ii_reference_job_control (
      job_key text primary key, enabled boolean not null default false, disabled_reason text,
      disabled_by_admin_id uuid, disabled_at timestamptz, last_success_at timestamptz, last_failure_at timestamptz,
      consecutive_failures integer not null default 0, updated_at timestamptz not null default now()
    );
  `);
  for (const f of migrationFiles) await db.exec(strip(migrationText(f)));
  for (const [k, id] of Object.entries(U)) await db.exec(`insert into auth.users(id,email) values ('${id}','rf-${k}@t.test') on conflict do nothing;`);
  await db.exec(`insert into admin_users (user_id) values ('${U.upload}'), ('${U.switchOnly}'), ('${U.noCapability}') on conflict do nothing;`);
  await db.exec(`update admin_users set can_upload_risk_free_data = true where user_id = '${U.upload}'; update admin_users set can_switch_risk_free_series = true where user_id = '${U.switchOnly}';`);
  return db;
}

/** Runs `fn` as a platform role with auth.uid() = uid (null = no identity), then restores the superuser session. */
export async function asRole<T>(db: PGlite, role: 'authenticated' | 'anon' | 'service_role', uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

type Err = { message: string; code?: string };
type Result = { data: unknown; error: Err | null };

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string): string => {
  if (!IDENT.test(s)) throw new Error(`harness: unsafe identifier ${s}`);
  return s;
};

class Query implements PromiseLike<Result> {
  private cols = '*';
  private wheres: string[] = [];
  private params: unknown[] = [];
  private orders: string[] = [];
  private lim: number | null = null;
  private off = 0;
  constructor(private readonly db: PGlite, private readonly uid: string | null, private readonly table: string) {}
  select(cols: string) {
    this.cols = cols.split(',').map((c) => ident(c.trim())).join(', ');
    return this;
  }
  private cmp(op: string, col: string, v: unknown) {
    this.params.push(v);
    this.wheres.push(`${ident(col)} ${op} $${this.params.length}`);
    return this;
  }
  eq(col: string, v: unknown) {
    return this.cmp('=', col, v);
  }
  gte(col: string, v: unknown) {
    return this.cmp('>=', col, v);
  }
  lte(col: string, v: unknown) {
    return this.cmp('<=', col, v);
  }
  order(col: string, o: { ascending?: boolean } = {}) {
    this.orders.push(`${ident(col)} ${o.ascending === false ? 'desc' : 'asc'}`);
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(from: number, to: number) {
    this.off = from;
    this.lim = to - from + 1;
    return this;
  }
  private async run(): Promise<Result> {
    const sql = `select ${this.cols} from public.${ident(this.table)}${this.wheres.length ? ` where ${this.wheres.join(' and ')}` : ''}${this.orders.length ? ` order by ${this.orders.join(', ')}` : ''}${this.lim !== null ? ` limit ${this.lim} offset ${this.off}` : ''}`;
    try {
      const r = await asRole(this.db, 'authenticated', this.uid, () => this.db.query<Record<string, unknown>>(sql, this.params));
      // PostgREST returns a date as yyyy-mm-dd and a numeric as a number, so the adapter does the same.
      return { data: r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]))), error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
    }
  }
  async maybeSingle(): Promise<Result> {
    const r = await this.run();
    if (r.error) return r;
    const rows = r.data as unknown[];
    return { data: rows[0] ?? null, error: null };
  }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(ok, bad);
  }
}

/** A Supabase-client lookalike over PGlite: `from().select()...` reads and `rpc()` calls, all as `authenticated` with auth.uid() = uid. */
export function pgliteClient(db: PGlite, uid: string | null): SupabaseClient {
  const client = {
    from: (table: string) => new Query(db, uid, table),
    rpc: async (name: string, args: Record<string, unknown>): Promise<Result> => {
      const keys = Object.keys(args).map(ident);
      const params = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const sql = `select to_jsonb(public.${ident(name)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) as v`;
      try {
        const r = await asRole(db, 'authenticated', uid, () => db.query<{ v: unknown }>(sql, params));
        return { data: r.rows[0]?.v ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
  };
  return client as unknown as SupabaseClient;
}

export async function one<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}
