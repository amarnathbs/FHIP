/**
 * The weekly RBI refresh pack (Product Owner decision 05-11-2026: automate the 91-day T-bill read) -- migration 0317 and docs/nav2/po_apply_weekly_refresh.
 *
 * Proven against the repository's OWN full migration chain in an in-process Postgres (PGlite; pg_cron and pg_net are the project's stubs from
 * scripts/db-rebuild-check/shim.sql, so a real scheduler clock and a real HTTP call are NOT proven here -- that is what the dry run in the pack is for).
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-W1  no production marker row -> the migration registers nothing (a DEV database or a replay never schedules calls to the production app);
 *   NC-W2  with the marker -> exactly the two jobs, with the exact cadence, route, vault secret name and a body that says dryRun false;
 *   NC-W3  running it twice leaves exactly two jobs (idempotent), never four;
 *   NC-W4  the pack's step 5 file is byte-equal to the migration, so what is pasted is what the repository holds;
 *   NC-W5  the editor-safety rules hold for the migration and every pack SQL file, and each rule really flags a bad snippet;
 *   NC-W6  every pack SQL file RUNS on the replayed schema (a wrong column or table name in a file nobody has run is the usual failure);
 *   NC-W7  switching on then off through the pack files respects the mandatory-reason constraint and restores the OFF state;
 *   NC-W8  the schedule never switches the job on by itself.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const PACK = path.join(ROOT, 'docs', 'nav2', 'po_apply_weekly_refresh');
const SHIM = path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
const MIGRATION = '0317_nav2_schedule_risk_free_weekly_refresh.sql';
const read = (p: string) => fs.readFileSync(p, 'utf8');
const pack = (f: string) => read(path.join(PACK, f));
const stripExtensions = (sql: string) => sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');

vi.setConfig({ testTimeout: 60_000 }); // the default 5 seconds is far too short for a full-chain replay

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(read(SHIM));
  const seed = read(path.join(ROOT, 'supabase', 'seed.sql'));
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f < '0317').sort();
  for (const f of files) {
    await db.exec(stripExtensions(read(path.join(MIG_DIR, f))));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  // Stand-ins for what the project's shim does not model, only so the pack's read-only files can be RUN here.
  await db.exec(`
    alter table cron.job add column if not exists active boolean not null default true;
    create schema if not exists vault;
    create table if not exists vault.secrets (name text);
    create or replace view vault.decrypted_secrets as select name, 'stand-in'::text as decrypted_secret from vault.secrets;
    create table if not exists net._http_response (id bigint, status_code int, timed_out boolean, error_msg text, content text, created timestamptz default now());
  `);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

const jobs = async () => (await db.query<{ jobname: string; schedule: string; command: string }>(`select jobname, schedule, command from cron.job where jobname like 'nav2-risk-free-refresh%' order by jobname`)).rows;

describe('the schedule migration', () => {
  it('NC-W1: without the production marker it registers nothing', async () => {
    await db.exec(stripExtensions(read(path.join(MIG_DIR, MIGRATION))));
    expect(await jobs()).toEqual([]);
  }, 60_000);

  it('NC-W2/W3: with the marker it registers exactly the two jobs; a second run leaves exactly two', async () => {
    await db.exec(`insert into platform_deployment_environment (environment) values ('production') on conflict (environment) do nothing;`);
    await db.exec(stripExtensions(read(path.join(MIG_DIR, MIGRATION))));
    await db.exec(stripExtensions(read(path.join(MIG_DIR, MIGRATION))));
    const rows = await jobs();
    expect(rows.map((r) => [r.jobname, r.schedule])).toEqual([
      ['nav2-risk-free-refresh-thu-fri', '30 3 * * 4,5'],
      ['nav2-risk-free-refresh-wed', '30 15 * * 3'],
    ]);
    for (const r of rows) {
      expect(r.command).toContain("url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/nav2-risk-free-refresh'");
      expect(r.command).toContain("where name = 'pc6_reference_ingest_cron_secret'");
      expect(r.command).toContain("body := jsonb_build_object('dryRun', false)");
      expect(r.command).toContain('timeout_milliseconds := 90000');
    }
  }, 60_000);

  it('NC-W8: the schedule never switches the job on by itself', async () => {
    const sw = await db.query<{ enabled: boolean }>(`select enabled from ii_reference_job_control where job_key = 'nav2_risk_free_weekly_refresh'`);
    expect(sw.rows).toEqual([{ enabled: false }]);
  });

  it('LOOK-ALIKE: the route it calls exists and is the weekly refresh route', () => {
    expect(fs.existsSync(path.join(ROOT, 'app', 'api', 'investment-intelligence', 'cron', 'nav2-risk-free-refresh', 'route.ts'))).toBe(true);
  });
});

describe('the pack', () => {
  it('NC-W4: the step 5 file is byte-equal to the migration', () => {
    expect(Buffer.compare(fs.readFileSync(path.join(PACK, '5_SCHEDULE_weekly_refresh.sql')), fs.readFileSync(path.join(MIG_DIR, MIGRATION)))).toBe(0);
  });

  it('NC-W6: every read-only pack file runs on the replayed schema and answers', async () => {
    await db.exec(`insert into vault.secrets (name) values ('pc6_reference_ingest_cron_secret')`);
    const pre = await db.query<{ check_name: string; ok: boolean }>(pack('1_READ_ONLY_prechecks.sql').replace(/;\s*$/, ''));
    // Every check is answerable. (The replay has the production marker from above and the schedule registered, so two of them differ from production-before.)
    expect(pre.rows.length).toBe(9);
    expect(pre.rows.filter((r) => ['switch row exists', 'attempt log table exists (0263)', 'refresh write function exists (0260)'].includes(r.check_name)).every((r) => r.ok)).toBe(true);
    const after = await db.query<{ what: string }>(pack('6_READ_ONLY_after.sql').replace(/;\s*$/, ''));
    expect(after.rows.map((r) => r.what)).toContain('switch');
    expect(after.rows.filter((r) => r.what === 'cron job')).toHaveLength(2);
    await db.query(pack('4_READ_ONLY_dry_run_response.sql').replace(/;\s*$/, ''));
    // The dry run request calls the (stubbed) http function with an empty body: it must not say dryRun false.
    expect(pack('3_DRY_RUN_request.sql')).toContain("body := '{}'::jsonb");
    expect(pack('3_DRY_RUN_request.sql')).not.toMatch(/dryRun/);
    await db.exec(pack('3_DRY_RUN_request.sql'));
  }, 60_000);

  it('NC-W7: switching on then off through the pack files respects the reason constraint and restores OFF', async () => {
    await db.exec(pack('2_SWITCH_ON.sql'));
    expect((await db.query<{ enabled: boolean; disabled_reason: string | null }>(`select enabled, disabled_reason from ii_reference_job_control where job_key = 'nav2_risk_free_weekly_refresh'`)).rows[0]).toEqual({ enabled: true, disabled_reason: null });
    await db.exec(pack('ROLLBACK_switch_off_and_unschedule.sql'));
    const off = (await db.query<{ enabled: boolean; disabled_reason: string | null }>(`select enabled, disabled_reason from ii_reference_job_control where job_key = 'nav2_risk_free_weekly_refresh'`)).rows[0];
    expect(off.enabled).toBe(false);
    expect(off.disabled_reason).toMatch(/switched off by the Product Owner/);
    expect(await jobs()).toEqual([]); // and the rollback removed both schedules
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Editor safety: the Supabase SQL editor pre-parser has misread a statement word followed by a name INSIDE a string or comment (confirmed for
// "into"). Same rule set as tests/unit/nav2/nav2MigrationPartsAndEditorSafety.test.ts, applied to this pack.
// ---------------------------------------------------------------------------------------------------------------------------------------
export function hazards(sql: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7f]/.test(sql)) out.push('non-ascii');
  if (sql.includes('$$')) out.push('bare dollar quote');
  if (sql.includes('%')) out.push('percent sign');
  if (sql.includes('"')) out.push('double quote');
  for (const line of sql.split('\n')) {
    const i = line.indexOf('--');
    if (i < 0) continue;
    const comment = line.slice(i);
    if (/[;"']/.test(comment)) out.push(`comment has ; or a quote: ${comment.slice(0, 60)}`);
    for (const m of comment.matchAll(/\b(into|from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) out.push(`comment has "${m[0]}"`);
  }
  return out;
}

describe('NC-W5: editor safety', () => {
  const files = ['1_READ_ONLY_prechecks.sql', '2_SWITCH_ON.sql', '3_DRY_RUN_request.sql', '4_READ_ONLY_dry_run_response.sql', '5_SCHEDULE_weekly_refresh.sql', '6_READ_ONLY_after.sql', 'ROLLBACK_switch_off_and_unschedule.sql'];
  it('the migration and every pack SQL file are clean', () => {
    expect(hazards(read(path.join(MIG_DIR, MIGRATION)))).toEqual([]);
    for (const f of files) expect(hazards(pack(f)), f).toEqual([]);
  });
  it('the rules really bite: each is shown to flag a bad snippet', () => {
    expect(hazards('select 1; -- café')).toContain('non-ascii');
    expect(hazards('do $$ begin end $$;')).toContain('bare dollar quote');
    expect(hazards("select 'a%'")).toContain('percent sign');
    expect(hazards('select "x"')).toContain('double quote');
    expect(hazards('select 1 -- it is; bad')).toEqual(expect.arrayContaining([expect.stringContaining('comment has ; or a quote')]));
    expect(hazards('select 1 -- rows into stage')).toEqual(expect.arrayContaining([expect.stringContaining('comment has "into stage"')]));
  });
});
