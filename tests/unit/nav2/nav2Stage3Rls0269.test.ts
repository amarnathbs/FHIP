// Migration 0269, replayed in an in-process Postgres (PGlite) with the few things they depend on stubbed. NOT DEV evidence: the
// timing of the monitoring function and the effect of the policy can only be shown on DEV once the SQL is applied (hand-over).
//
//   NC-P1  0269: BEFORE it, a user whose Premium has lapsed can still read their stored report from the table (the defect, reproduced);
//          AFTER it, only a user who is Premium today can, only their own rows, and never anon; the end date is inclusive.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIG = (name: string) => readFileSync(path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations', name), 'utf8');
const U = { premium: '00000000-0000-0000-0000-000000000001', free: '00000000-0000-0000-0000-000000000002', lapsed: '00000000-0000-0000-0000-000000000003', future: '00000000-0000-0000-0000-000000000004', openEnded: '00000000-0000-0000-0000-000000000005', endsToday: '00000000-0000-0000-0000-000000000006' };
const ROLES = `create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;`;

describe('0269: stored reports are readable only while the owner is Premium (NC-P1)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(ROLES);
    await db.exec(`
      create table user_entitlements (user_id uuid primary key, plan_tier text not null, effective_from date, effective_to date);
      create table nav2_fund_analytics_reports (id serial primary key, user_id uuid not null, report_json jsonb not null);
      alter table nav2_fund_analytics_reports enable row level security;
      -- the policy exactly as migration 0261 created it
      create policy own_read_nav2_fund_analytics_reports on nav2_fund_analytics_reports for select using (auth.uid() = user_id);
      grant select on nav2_fund_analytics_reports to authenticated;
      grant usage on schema auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
      insert into user_entitlements values
        ('${U.premium}', 'premium', current_date - 5, current_date + 5),
        ('${U.free}', 'free', null, null),
        ('${U.lapsed}', 'premium', current_date - 30, current_date - 1),
        ('${U.future}', 'premium', current_date + 1, null),
        ('${U.openEnded}', 'premium', null, null),
        ('${U.endsToday}', 'premium', current_date - 10, current_date);
      insert into nav2_fund_analytics_reports (user_id, report_json) select u, jsonb_build_object('owner', u) from unnest(array['${Object.values(U).join("','")}']::uuid[]) u;
    `);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });
  const rowsSeenBy = async (uid: string | null): Promise<string[]> => {
    await db.exec(`select set_config('test.uid', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
    try {
      return (await db.query<{ user_id: string }>('select user_id from nav2_fund_analytics_reports order by user_id')).rows.map((r) => r.user_id);
    } finally {
      await db.exec('reset role');
    }
  };

  it('BEFORE 0269 (the 0261 policy): a lapsed user and a not-yet-started user still read their own report (the defect, reproduced)', async () => {
    expect(await rowsSeenBy(U.lapsed)).toEqual([U.lapsed]);
    expect(await rowsSeenBy(U.free)).toEqual([U.free]);
  });

  it('AFTER 0269 (run twice: idempotent): only a user who is Premium today reads, only their own row; the end date is inclusive; anon is refused', async () => {
    await db.exec(MIG('0269_nav2_reports_premium_only_read.sql'));
    await db.exec(MIG('0269_nav2_reports_premium_only_read.sql'));
    expect(await rowsSeenBy(U.premium)).toEqual([U.premium]);
    expect(await rowsSeenBy(U.openEnded)).toEqual([U.openEnded]);
    expect(await rowsSeenBy(U.endsToday)).toEqual([U.endsToday]); // inclusive end date
    expect(await rowsSeenBy(U.free)).toEqual([]);
    expect(await rowsSeenBy(U.lapsed)).toEqual([]);
    expect(await rowsSeenBy(U.future)).toEqual([]);
    await expect(rowsSeenBy(null)).rejects.toThrow(/permission denied/); // anon has no grant at all
  });

  it('the helper function is callable by a signed-in session and not by anon; the table still has no write grant', async () => {
    const q = async (sql: string) => (await db.query<{ v: boolean }>(sql)).rows[0].v;
    expect(await q(`select has_function_privilege('authenticated', 'nav2_viewer_has_premium()', 'execute') as v`)).toBe(true);
    expect(await q(`select has_function_privilege('anon', 'nav2_viewer_has_premium()', 'execute') as v`)).toBe(false);
    expect(await q(`select has_table_privilege('authenticated', 'nav2_fund_analytics_reports', 'update') as v`)).toBe(false);
  });
});

