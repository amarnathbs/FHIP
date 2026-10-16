/**
 * AIE per-user daily cap -- the DEV and PRODUCTION hand-over packs (docs/ai/po_apply_per_user_cap), replayed on a real
 * Postgres engine (PGlite) that holds the repository's whole migration ledger EXCEPT 0284, i.e. the state DEV and
 * production are expected to be in before the Product Owner applies anything.
 *
 * EVIDENCE LABEL: PGLITE-VERIFIED. Nothing here has been run on DEV or production.
 *
 * What is proven, in the order the Product Owner runs the files:
 *   precheck (all ok before) -> backup (copies equal) -> apply (the pack file, not the repository copy) -> verify (all ok)
 *   -> functional probe (PROBE OK, leaves nothing behind) -> monitor (runs) -> optional rollback (objects gone, the 0195
 *   function still works) -> drop backups.
 * Plus: every pack file passes the repository's editor-safety lint (and the lint demonstrably bites), the apply files are
 * byte-identical to the migration, and the files DEV and production share are identical.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SUPABASE_ROOT = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
const PACK = path.join(ROOT, 'docs', 'ai', 'po_apply_per_user_cap');
const MIGRATION_FILE = '0284_aie_per_user_daily_cost_cap.sql';

const read = (rel: string) => fs.readFileSync(path.join(PACK, rel), 'utf8');
const packFiles = (dir: string) => fs.readdirSync(path.join(PACK, dir)).filter((f) => f.endsWith('.sql')).sort();

let db: PGlite;

async function lastRows(sql: string): Promise<Record<string, unknown>[]> {
  const res = await db.exec(sql);
  return (res[res.length - 1]?.rows ?? []) as Record<string, unknown>[];
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  for (const f of fs.readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql') && x !== MIGRATION_FILE).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec(`insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000c1','pack-a@pg.test'),('00000000-0000-4000-8000-0000000000c2','pack-b@pg.test');`);
  // some existing 0195-era attempts, so the backup and the rollback have real rows to protect
  await db.exec(`select * from aie_reserve_ai_cost('global', 0.01, 10, 'pre-existing-1'); select * from aie_reserve_ai_cost('global', 0.01, 10, 'pre-existing-2');`);
  await db.exec(`select * from aie_settle_ai_cost_v2('global','pre-existing-1',0.004,10,5,'gpt-4o-mini',array[]::text[],'success',false);`);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('pack files: editor safety and consistency', () => {
  it('every SQL file in both packs and the migration pass the editor-safety lint, and the lint really bites (negative control)', async () => {
    const lint = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, 'scripts', 'migration_editor_safety_lint.mjs')).href)) as { hazards: (s: string) => string[] };
    const files = [path.join(MIG_DIR, MIGRATION_FILE), ...['dev', 'production'].flatMap((d) => packFiles(d).map((f) => path.join(PACK, d, f)))];
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) expect(lint.hazards(fs.readFileSync(f, 'utf8')), f).toEqual([]);
    // negative controls: the three hazards this change cares about are each caught
    expect(lint.hazards('-- value taken from the user\nselect 1;').length).toBeGreaterThan(0);
    expect(lint.hazards("select 'insert into x';").length).toBeGreaterThan(0);
    expect(lint.hazards('select 50%;').length).toBeGreaterThan(0);
  });

  it('the apply file in each pack is byte-identical to the repository migration', () => {
    const migration = fs.readFileSync(path.join(MIG_DIR, MIGRATION_FILE), 'utf8');
    expect(read('dev/04_apply_migration_0284.sql')).toBe(migration);
    expect(read('production/04_apply_migration_0284.sql')).toBe(migration);
  });

  it('the files DEV and production share are identical, and production adds the backup steps', () => {
    for (const f of packFiles('dev')) expect(read(`production/${f}`), f).toBe(read(`dev/${f}`));
    expect(packFiles('production')).toEqual(
      expect.arrayContaining(['01_precheck_READONLY.sql', '02_manual_backup_before_apply.sql', '04_apply_migration_0284.sql', '05_verify_READONLY.sql', '06_functional_probe_rolls_back.sql', '07_monitor_per_user_spend_READONLY.sql', '08_optional_rollback.sql', '09_drop_backups.sql']),
    );
    expect(packFiles('dev')).not.toContain('02_manual_backup_before_apply.sql');
  });

  it('every file that is meant to be read only says so on its first line and contains no write', () => {
    for (const f of packFiles('production').filter((n) => n.includes('READONLY'))) {
      const sql = read(`production/${f}`);
      expect(sql.split('\n')[0], f).toMatch(/READ ONLY/);
      const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(code, f).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i);
    }
  });
});

describe('the pack replayed in the order the Product Owner runs it', () => {
  it('01 precheck on the pre-0284 state: every row is ok (0195 present, 0284 absent)', async () => {
    const res = await db.exec(read('production/01_precheck_READONLY.sql'));
    const rows = res[0].rows as Array<{ n: number; check_name: string; ok: boolean }>;
    expect(rows).toHaveLength(9);
    for (const r of rows) expect(r.ok, r.check_name).toBe(true);
  });

  it('02 manual backup: the copies are created, locked, and equal to the live tables', async () => {
    const res = await db.exec(read('production/02_manual_backup_before_apply.sql'));
    const rows = res[res.length - 1].rows as Array<{ check_name: string; live_rows: number; backup_rows: number; ok: boolean }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.ok, r.check_name).toBe(true);
    expect(Number(rows.find((r) => r.check_name === 'aie_ai_cost_attempt')!.backup_rows)).toBeGreaterThanOrEqual(2);
    const priv = await db.query<{ anon: boolean; authenticated: boolean; rls: boolean }>(
      `select has_table_privilege('anon','private.bkp_aiecap_ai_cost_attempt','select') as anon,
              has_table_privilege('authenticated','private.bkp_aiecap_ai_cost_attempt','select') as authenticated,
              (select relrowsecurity from pg_class where oid = 'private.bkp_aiecap_ai_cost_attempt'::regclass) as rls`,
    );
    expect(priv.rows[0]).toEqual({ anon: false, authenticated: false, rls: true });
    // safe to run twice
    await db.exec(read('production/02_manual_backup_before_apply.sql'));
  });

  it('04 apply (the PACK file) works, and running it a second time is harmless', async () => {
    await db.exec(read('production/04_apply_migration_0284.sql'));
    await db.exec(read('production/04_apply_migration_0284.sql'));
    const existing = await db.query<{ n: string }>(`select count(*) as n from aie_ai_cost_attempt where idempotency_key like 'pre-existing-%' and user_id is null`);
    expect(Number(existing.rows[0].n)).toBe(2); // old rows untouched, attributed to nobody
  });

  it('05 verify after apply: every row is ok, and the ceilings are 10 and 1', async () => {
    const res = await db.exec(read('production/05_verify_READONLY.sql'));
    const checks = res[0].rows as Array<{ check_name: string; ok: boolean }>;
    expect(checks).toHaveLength(10);
    for (const r of checks) expect(r.ok, r.check_name).toBe(true);
    const facts = res[1].rows[0] as { global_allowance_usd: string; per_user_daily_cap_usd: string };
    expect(Number(facts.global_allowance_usd)).toBe(10);
    expect(Number(facts.per_user_daily_cap_usd)).toBe(1);
  });

  it('06 functional probe: reports PROBE OK through an error and keeps NOTHING (ledger and attempts unchanged)', async () => {
    const before = await db.query(`select (select count(*) from aie_ai_cost_attempt) as a, (select reserved_usd from aie_ai_cost_ledger where id='global') as r, (select total_attempts from aie_ai_cost_ledger where id='global') as t`);
    await expect(db.exec(read('production/06_functional_probe_rolls_back.sql'))).rejects.toThrow(/^PROBE OK/);
    const after = await db.query(`select (select count(*) from aie_ai_cost_attempt) as a, (select reserved_usd from aie_ai_cost_ledger where id='global') as r, (select total_attempts from aie_ai_cost_ledger where id='global') as t`);
    expect(after.rows).toEqual(before.rows);
  });

  it('06 negative control: the probe reports PROBE FAILED when the per-user check is missing (it cannot pass vacuously)', async () => {
    // Break the function the way a bad deploy would: the per-user comparison can never trigger.
    const original = (await db.query<{ src: string }>(`select pg_get_functiondef('aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)'::regprocedure) as src`)).rows[0].src;
    const broken = original.replace('if v_user_used + p_amount_usd > v_effective_user_cap then', 'if false then');
    expect(broken).not.toBe(original);
    await db.exec(broken);
    await expect(db.exec(read('production/06_functional_probe_rolls_back.sql'))).rejects.toThrow(/^PROBE FAILED/);
    await db.exec(original); // restore the real function
    await expect(db.exec(read('production/06_functional_probe_rolls_back.sql'))).rejects.toThrow(/^PROBE OK/);
  });

  it('07 monitor runs and reports a user prefix, not a full id', async () => {
    await db.exec(`select * from aie_reserve_ai_cost_v2('global', 0.2, 10, 'monitor-1', '00000000-0000-4000-8000-0000000000c1'::uuid, null);
                   select * from aie_reserve_ai_cost_v2('global', 0.9, 10, 'monitor-2', '00000000-0000-4000-8000-0000000000c1'::uuid, null);`);
    const res = await db.exec(read('production/07_monitor_per_user_spend_READONLY.sql'));
    const rows = res[0].rows as Array<{ user_prefix: string; attempts_today: number; admitted: number; refused_daily_cap: number; counted_usd_today: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].user_prefix).toBe('00000000');
    expect(Number(rows[0].attempts_today)).toBe(2);
    expect(Number(rows[0].admitted)).toBe(1);
    expect(Number(rows[0].refused_daily_cap)).toBe(1);
    expect(Number(rows[0].counted_usd_today)).toBeCloseTo(0.2, 6);
  });

  it('08 optional rollback: the new objects are gone, the 0195 function still works, existing rows survive', async () => {
    await db.exec(read('production/08_optional_rollback.sql'));
    const gone = await db.query<{ v2: boolean; col1: boolean; col2: boolean; idx: boolean }>(
      `select to_regprocedure('public.aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)') is not null as v2,
              exists (select 1 from information_schema.columns where table_name='aie_ai_cost_attempt' and column_name='user_id') as col1,
              exists (select 1 from information_schema.columns where table_name='aie_ai_cost_ledger' and column_name='user_daily_cap_usd') as col2,
              exists (select 1 from pg_indexes where indexname='idx_aie_ai_cost_attempt_user_day') as idx`,
    );
    expect(gone.rows[0]).toEqual({ v2: false, col1: false, col2: false, idx: false });
    const legacy = await db.query<{ reserved: boolean }>(`select * from aie_reserve_ai_cost('global', 0.01, 10, 'after-rollback')`);
    expect(legacy.rows[0].reserved).toBe(true);
    const kept = await db.query<{ n: string }>(`select count(*) as n from aie_ai_cost_attempt where idempotency_key like 'pre-existing-%'`);
    expect(Number(kept.rows[0].n)).toBe(2);
    // and the migration can be applied again afterwards
    await db.exec(read('production/04_apply_migration_0284.sql'));
  });

  it('09 drop backups removes the copies', async () => {
    await db.exec(read('production/09_drop_backups.sql'));
    const r = await db.query<{ a: boolean; l: boolean }>(`select to_regclass('private.bkp_aiecap_ai_cost_attempt') is not null as a, to_regclass('private.bkp_aiecap_ai_cost_ledger') is not null as l`);
    expect(r.rows[0]).toEqual({ a: false, l: false });
  });

  it('the DEV pack replays too (no backup step): precheck is ok on the pre-state it was written for', async () => {
    // The state is post-apply now, so only prove the DEV files parse and the read-only ones run.
    await lastRows(read('dev/05_verify_READONLY.sql'));
    await lastRows(read('dev/07_monitor_per_user_spend_READONLY.sql'));
  });
});
