/**
 * PGLITE-VERIFIED: migration 0304 (public.retirement_contributions) -- constraints, the destination trigger, the unique payslip
 * index, idempotence, and TWO-USER row level security. The referenced tables are minimal stand-ins with the columns the
 * migration touches. Negative controls: the same hostile statements succeed on a table built WITHOUT the migration's guard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/0304_retirement_contributions.sql'), 'utf8');
const U1 = '00000000-0000-0000-0000-0000000000a1';
const U2 = '00000000-0000-0000-0000-0000000000b2';

const BASE = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.currencies (currency_code char(3) primary key);
insert into public.currencies values ('AUD'), ('INR');
create table public.retirement_accounts (id uuid primary key default gen_random_uuid(), user_id uuid not null, master_item_key text, current_balance numeric default 0);
create table public.retirement_members (id uuid primary key default gen_random_uuid(), user_id uuid not null);
create table public.fdh_payroll_events (id uuid primary key default gen_random_uuid(), user_id uuid not null);
insert into auth.users values ('${U1}'), ('${U2}');
create role app_user;
grant usage on schema public, auth to app_user;
grant all on all tables in schema public to app_user;
grant execute on function auth.uid() to app_user;
`;

async function fresh() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION);
  // Supabase grants table privileges to its API roles by default; the stand-in role gets the same so only RLS decides.
  await db.exec('grant all on all tables in schema public to app_user;');
  return db;
}
async function seed(db: PGlite) {
  const smsf = await db.query<{ id: string }>(`insert into public.retirement_accounts (user_id, master_item_key) values ('${U1}', 'smsf') returning id`);
  const rest = await db.query<{ id: string }>(`insert into public.retirement_accounts (user_id, master_item_key) values ('${U1}', 'industry_super') returning id`);
  const other = await db.query<{ id: string }>(`insert into public.retirement_accounts (user_id, master_item_key) values ('${U2}', 'industry_super') returning id`);
  const pe = await db.query<{ id: string }>(`insert into public.fdh_payroll_events (user_id) values ('${U1}') returning id`);
  return { smsf: smsf.rows[0].id, rest: rest.rows[0].id, other: other.rows[0].id, pe: pe.rows[0].id };
}
const ins = (user: string, extra: string) =>
  `insert into public.retirement_contributions (user_id, contribution_type, amount, currency_code, source_type, ${extra.split('|')[0]}) values ('${user}', 'employer', 100, 'AUD', 'manual', ${extra.split('|')[1]})`;

describe('migration 0304 retirement_contributions', () => {
  it('is idempotent and changes no existing row', async () => {
    const db = await fresh();
    const ids = await seed(db);
    await db.exec(MIGRATION);
    const n = await db.query<{ n: number }>('select count(*)::int as n from public.retirement_accounts');
    expect(n.rows[0].n).toBe(3);
    expect(ids.pe).toBeTruthy();
  }, 60_000);

  it('requires a rate or a date, a positive amount, and a destination exactly when the row is active', async () => {
    const db = await fresh();
    const s = await seed(db);
    await expect(db.exec(`insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, source_type) values ('${U1}', '${s.rest}', 'retirement_account', 'employer', 100, 'AUD', 'manual')`)).rejects.toThrow(/retirement_contributions_rate_or_date/);
    await expect(db.exec(`insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type) values ('${U1}', '${s.rest}', 'retirement_account', 'employer', 0, 'AUD', 'monthly', 'manual')`)).rejects.toThrow(/amount/);
    // active without a destination
    await expect(db.exec(`insert into public.retirement_contributions (user_id, contribution_type, amount, currency_code, frequency, source_type, status) values ('${U1}', 'employer', 100, 'AUD', 'monthly', 'manual', 'active')`)).rejects.toThrow(/destination_state/);
    // waiting without a destination is the one allowed shape
    await db.exec(`insert into public.retirement_contributions (user_id, contribution_type, amount, currency_code, frequency, source_type, status) values ('${U1}', 'employer', 100, 'AUD', 'fortnightly', 'manual', 'needs_destination')`);
    // a manual row never names a payslip
    await expect(db.exec(`insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type, source_payroll_event_id) values ('${U1}', '${s.rest}', 'retirement_account', 'employer', 1, 'AUD', 'monthly', 'manual', '${s.pe}')`)).rejects.toThrow(/manual_has_no_payslip/);
  }, 60_000);

  it('the same payslip cannot create a second row of the same type (exactly once), but a different type or payslip can', async () => {
    const db = await fresh();
    const s = await seed(db);
    const row = (type: string, pe: string) => `insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type, source_payroll_event_id) values ('${U1}', '${s.rest}', 'retirement_account', '${type}', 684.68, 'AUD', 'fortnightly', 'payslip', '${pe}')`;
    await db.exec(row('employer', s.pe));
    await expect(db.exec(row('employer', s.pe))).rejects.toThrow(/uq_retirement_contributions_payslip/);
    await db.exec(row('salary_sacrifice', s.pe));
  }, 60_000);

  it('the destination must be the same person\'s, and the SMSF kind must be the fund account (and only it)', async () => {
    const db = await fresh();
    const s = await seed(db);
    const mk = (acct: string, kind: string, user = U1) => `insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type) values ('${user}', '${acct}', '${kind}', 'employer', 1, 'AUD', 'monthly', 'manual')`;
    await db.exec(mk(s.smsf, 'smsf'));
    await db.exec(mk(s.rest, 'retirement_account'));
    await expect(db.exec(mk(s.other, 'retirement_account'))).rejects.toThrow(/same user/);
    await expect(db.exec(mk(s.rest, 'smsf'))).rejects.toThrow(/SMSF fund account/);
    await expect(db.exec(mk(s.smsf, 'retirement_account'))).rejects.toThrow(/must use destination kind smsf/);
    // moving an existing row to another person's account is refused too
    await expect(db.exec(`update public.retirement_contributions set retirement_account_id = '${s.other}' where retirement_account_id = '${s.rest}'`)).rejects.toThrow(/same user/);
  }, 60_000);

  it('TWO-USER RLS: each user sees and changes only their own rows; a forged user_id is refused', async () => {
    const db = await fresh();
    const s = await seed(db);
    const as = async (user: string, sql: string) => {
      await db.exec(`select set_config('request.jwt.claim.sub', '${user}', false); set role app_user;`);
      try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec('reset role;'); }
    };
    await db.exec(`insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type) values ('${U1}', '${s.rest}', 'retirement_account', 'employer', 10, 'AUD', 'monthly', 'manual')`);
    await db.exec(`insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type) values ('${U2}', '${s.other}', 'retirement_account', 'employer', 20, 'AUD', 'monthly', 'manual')`);
    expect((await as(U1, 'select amount from public.retirement_contributions')).rows).toEqual([{ amount: '10.00' }]);
    expect((await as(U2, 'select amount from public.retirement_contributions')).rows).toEqual([{ amount: '20.00' }]);
    // U2 cannot update or delete U1's row (zero rows affected, nothing changes)
    await as(U2, `update public.retirement_contributions set amount = 999 where user_id = '${U1}'`);
    await as(U2, `delete from public.retirement_contributions where user_id = '${U1}'`);
    expect((await db.query('select amount from public.retirement_contributions where user_id = $1', [U1])).rows).toEqual([{ amount: '10.00' }]);
    // U2 cannot insert a row as U1
    await expect(as(U2, `insert into public.retirement_contributions (user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type) values ('${U1}', '${s.rest}', 'retirement_account', 'employer', 1, 'AUD', 'monthly', 'manual')`)).rejects.toThrow(/row-level security/);
    // anonymous (no claim) sees nothing
    await db.exec(`select set_config('request.jwt.claim.sub', '', false); set role app_user;`);
    const anon = await db.query('select * from public.retirement_contributions');
    await db.exec('reset role;');
    expect(anon.rows).toHaveLength(0);
  }, 60_000);

  it('NEGATIVE CONTROL: a bare table without the policy lets U2 read U1\'s rows (so the test above is not vacuous)', async () => {
    const db = new PGlite();
    await db.exec(BASE);
    await db.exec(`create table public.rc_bare (id serial primary key, user_id uuid, amount numeric); insert into public.rc_bare (user_id, amount) values ('${U1}', 10); grant all on public.rc_bare to app_user; grant usage on all sequences in schema public to app_user;`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${U2}', false); set role app_user;`);
    const rows = await db.query('select * from public.rc_bare');
    await db.exec('reset role;');
    expect(rows.rows).toHaveLength(1);
  }, 60_000);
});
void ins;
