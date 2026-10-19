// STOP GATE 1 package: the manual backup step (production has no managed backups) and the pilot monitoring queries, executed in an in-process Postgres.
// Evidence level: PGLITE-VERIFIED.
//   NC-B1  B1 copies the three tables and the retention function text, leaves the live tables untouched, is safe to run twice (the second run keeps the FIRST copy),
//          and locks the copies away from the application roles; B2 reports equal counts and the captured function text; after a later change B2 shows the difference;
//   NC-B2  B3 removes exactly the four backup tables and nothing else;
//   NC-M1  M1 and M2 run, count what they say, and M1 reports a duplicate idempotency key when one exists (so a 0 means something).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hazards } from '../support/sqlEditorHazards';

const PACK = path.resolve(__dirname, '..', '..', '..', 'docs', 'nav2', 'po_apply_production', 'sql');
const sql = (rel: string) => readFileSync(path.join(PACK, rel), 'utf8');
const STUBS = `
  create role anon nologin; create role authenticated nologin;
  create table public.admin_users (user_id uuid primary key, role text);
  create table public.ii_reference_job_control (job_key text primary key, enabled boolean not null default false);
  create table public.ii_reference_corrections (id uuid primary key default gen_random_uuid());
  create function public.pc6_nav_row_is_candidate(p uuid) returns boolean language sql stable as $f$ select p is not null $f$;
  create table public.nav2_fund_analytics_reports (id uuid primary key default gen_random_uuid(), user_id uuid not null, scheme_count int not null, created_at timestamptz not null default now(), idempotency_key text);
  create table public.nav2_result_cache (id uuid primary key default gen_random_uuid(), invalidated_at timestamptz);
  create table public.nav2_correction_events (id bigint generated always as identity primary key, processed_at timestamptz);
  create table public.ii_risk_free_observations (id uuid primary key default gen_random_uuid(), kind text not null);
  insert into public.admin_users values ('00000000-0000-4000-8000-000000000001', 'admin'), ('00000000-0000-4000-8000-000000000002', 'analyst');
  insert into public.ii_reference_job_control values ('pc6_selective_historical_hydration', false), ('other_job', true);
  insert into public.ii_reference_corrections default values;
`;
const BACKUP_TABLES = ['admin_users', 'job_control', 'function_text', 'corrections_size'];
let db: PGlite;
beforeEach(async () => {
  db = new PGlite();
  await db.exec(STUBS);
}, 60_000);

describe('NC-B1: B1 and B2', () => {
  it('the files pass the editor-safety lint', () => {
    for (const f of ['backup/B1_backup_altered_tables.sql', 'backup/B2_backup_check.sql', 'backup/B3_drop_backups_after_release.sql', 'monitoring/M1_pilot_health.sql', 'monitoring/M2_reports_per_day.sql']) expect(hazards(sql(f)), f).toEqual([]);
  });
  it('B1 copies the tables and the function text, B2 agrees, a second run keeps the FIRST copy, and a later change is visible in B2', async () => {
    await db.exec(sql('backup/B1_backup_altered_tables.sql'));
    const r1 = (await db.query<Record<string, unknown>>(sql('backup/B2_backup_check.sql'))).rows[0];
    expect(r1).toMatchObject({ admin_rows_saved: 2, admin_rows_now: 2, switch_rows_saved: 2, switch_rows_now: 2, function_text_saved: true, corrections_rows_saved: 1 });
    await db.exec(`insert into public.ii_reference_job_control values ('nav2_fund_analytics', false); insert into public.admin_users values ('00000000-0000-4000-8000-000000000003', 'x');`);
    await db.exec(sql('backup/B1_backup_altered_tables.sql')); // run twice
    const r2 = (await db.query<Record<string, unknown>>(sql('backup/B2_backup_check.sql'))).rows[0];
    expect(r2).toMatchObject({ admin_rows_saved: 2, admin_rows_now: 3, switch_rows_saved: 2, switch_rows_now: 3 }); // the copy is the one taken first
    const def = (await db.query<{ definition: string }>('select definition from public.nav2_backup_20261016_function_text')).rows[0].definition;
    expect(def).toMatch(/pc6_nav_row_is_candidate/);
  });
  it('the copies cannot be read by the application roles (row level security, no grant)', async () => {
    await db.exec(sql('backup/B1_backup_altered_tables.sql'));
    expect((await db.query<{ locked: boolean }>(sql('backup/B2_backup_check.sql'))).rows[0]).toMatchObject({ backups_locked_to_service_role: true });
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname like 'nav2_backup_20261016%' and relkind = 'r'");
    expect(rls.rows).toHaveLength(4);
    for (const x of rls.rows) expect(x.relrowsecurity, x.relname).toBe(true);
    await db.exec('set role authenticated');
    await expect(db.query('select * from public.nav2_backup_20261016_admin_users')).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });
  it('NC-B1 control: B2 FAILS to report equal counts before B1 has run (the tables are absent)', async () => {
    await expect(db.query(sql('backup/B2_backup_check.sql'))).rejects.toThrow(/does not exist/);
  });
});

describe('NC-B2: B3', () => {
  it('removes exactly the four backup tables and leaves the live ones', async () => {
    await db.exec(sql('backup/B1_backup_altered_tables.sql'));
    await db.exec(sql('backup/B3_drop_backups_after_release.sql'));
    const left = await db.query<{ n: number }>("select count(*)::int as n from pg_class where relname like 'nav2_backup_20261016%'");
    expect(left.rows[0].n).toBe(0);
    for (const t of ['admin_users', 'ii_reference_job_control', 'ii_reference_corrections']) expect((await db.query(`select 1 from public.${t}`)).rows.length).toBeGreaterThan(0);
    await db.exec(sql('backup/B3_drop_backups_after_release.sql')); // safe twice
    expect(BACKUP_TABLES).toHaveLength(4);
  });
});

describe('NC-M1: M1 and M2', () => {
  it('count what they say; a duplicate idempotency key is reported (so 0 means something); the widest report is shown', async () => {
    const U1 = '00000000-0000-4000-8000-0000000000a1';
    const U2 = '00000000-0000-4000-8000-0000000000a2';
    await db.exec(`insert into public.nav2_fund_analytics_reports (user_id, scheme_count, idempotency_key) values ('${U1}', 4, 'key-aaaaaaaaaaaaaaaa'), ('${U1}', 10, 'key-bbbbbbbbbbbbbbbb'), ('${U2}', 3, null);
      insert into public.nav2_result_cache (invalidated_at) values (null), (now());
      insert into public.nav2_correction_events (processed_at) values (null), (now());
      insert into public.ii_risk_free_observations (kind) values ('value'), ('gap');
      insert into public.ii_reference_job_control values ('nav2_fund_analytics', true);`);
    const m1 = (await db.query<Record<string, unknown>>(sql('monitoring/M1_pilot_health.sql'))).rows[0];
    expect(m1).toMatchObject({ reports_total: 3, people_with_a_report: 2, widest_report: 10, reports_without_key: 1, duplicate_idempotency_keys: 0, live_cache_entries: 1, unprocessed_correction_events: 1, risk_free_value_rows: 1 });
    expect(String(m1.switches)).toContain('nav2_fund_analytics=true');
    // control: with the unique index absent a duplicate can exist, and M1 shows it
    await db.exec(`insert into public.nav2_fund_analytics_reports (user_id, scheme_count, idempotency_key) values ('${U1}', 4, 'key-aaaaaaaaaaaaaaaa');`);
    expect(((await db.query<Record<string, unknown>>(sql('monitoring/M1_pilot_health.sql'))).rows[0]).duplicate_idempotency_keys).toBe(1);
    const m2 = (await db.query<Record<string, unknown>>(sql('monitoring/M2_reports_per_day.sql'))).rows;
    expect(m2).toHaveLength(1);
    expect(m2[0]).toMatchObject({ reports: 4, people: 2, largest_report_in_funds: 10 });
  });
});
