// Migration 0263 (weekly refresh attempts + the monitoring summary) replayed in an in-process Postgres (PGlite) with the two things it depends
// on stubbed: auth.uid() and is_pc6_reference_data_admin(). Proves the SQL runs from empty, runs twice (idempotent), counts correctly,
// refuses a caller without the capability, and rejects an outcome outside the allowed set. Not DEV evidence.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SQL = readFileSync(path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations', '0263_nav2_risk_free_refresh_attempts.sql'), 'utf8');
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;
    create function public.is_pc6_reference_data_admin() returns boolean language sql stable as $f$ select coalesce(current_setting('test.admin', true), '') = 'yes' $f$;
  `);
  await db.exec(SQL);
  await db.exec(SQL); // idempotent: a second paste changes nothing and fails nothing
});
afterAll(async () => {
  await db.close();
});

const asAdmin = async () => db.exec(`select set_config('test.uid', '00000000-0000-0000-0000-000000000001', false); select set_config('test.admin', 'yes', false);`);
const summary = async () => ((await db.query<{ s: Record<string, unknown> }>('select nav2_refresh_attempt_summary() as s')).rows[0].s);

describe('0263: the attempts table and the summary', () => {
  it('an empty table: zero counts, no last attempt (never a fake value)', async () => {
    await asAdmin();
    expect(await summary()).toMatchObject({ runs_last_90_days: 0, robots_unavailable_continued_last_90_days: 0, blocked_by_source_last_90_days: 0, last_blocked_at: null, last_attempt_at: null });
  });

  it('counts robots_unavailable_continued and blocked_by_source separately, only within 90 days, and names the latest attempt', async () => {
    await db.exec(`
      insert into ii_risk_free_refresh_attempts (attempted_at, robots_outcome, source_status, pages_requested, robots_requests) values
        (now() - interval '100 days', 'robots_unavailable_continued', 'ok', 1, 1),
        (now() - interval '20 days', 'robots_unavailable_continued', 'ok', 1, 1),
        (now() - interval '13 days', 'robots_ok', 'ok', 3, 1),
        (now() - interval '6 days', 'robots_unavailable_continued', 'blocked_by_source', 1, 1);
    `);
    await asAdmin();
    expect(await summary()).toMatchObject({ runs_last_90_days: 3, robots_unavailable_continued_last_90_days: 2, blocked_by_source_last_90_days: 1, last_robots_outcome: 'robots_unavailable_continued', last_source_status: 'blocked_by_source' });
  });

  it('a caller without the capability, and an anonymous caller, are refused (42501)', async () => {
    await db.exec(`select set_config('test.admin', 'no', false);`);
    await expect(summary()).rejects.toMatchObject({ code: '42501' });
    await db.exec(`select set_config('test.uid', '', false); select set_config('test.admin', 'yes', false);`);
    await expect(summary()).rejects.toMatchObject({ code: '42501' });
  });

  it('an outcome outside the allowed set is rejected by the table itself', async () => {
    await expect(db.exec(`insert into ii_risk_free_refresh_attempts (robots_outcome, source_status) values ('whatever', 'ok')`)).rejects.toThrow();
    await expect(db.exec(`insert into ii_risk_free_refresh_attempts (robots_outcome, source_status) values ('robots_ok', 'fine')`)).rejects.toThrow();
  });

  it('the summary is callable by a session role and not by anon; the table is closed to sessions', async () => {
    const q = async (sql: string) => (await db.query<{ v: boolean }>(sql)).rows[0].v;
    expect(await q(`select has_function_privilege('authenticated', 'nav2_refresh_attempt_summary()', 'execute') as v`)).toBe(true);
    expect(await q(`select has_function_privilege('anon', 'nav2_refresh_attempt_summary()', 'execute') as v`)).toBe(false);
    expect(await q(`select has_table_privilege('authenticated', 'ii_risk_free_refresh_attempts', 'select') as v`)).toBe(false);
    expect(await q(`select has_table_privilege('anon', 'ii_risk_free_refresh_attempts', 'insert') as v`)).toBe(false);
  });
});
