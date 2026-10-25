// DOCUMENT2 (4) WP-I, PO-D24-02: migration 0298 on a real Postgres (PGlite) replay of the REAL migration ledger, driven as the real
// `authenticated` role with row level security. It proves the invariant holds for a writer that never touches the application routes: a
// direct UPDATE or UPSERT of the declaration with the person's own session. EVIDENCE LABEL: PGLITE-VERIFIED (an isolated in-memory replay).
// NOT DEV-verified and NOT production-verified: the PO applies 0298 on DEV first.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, expectSqlError, replayLedger, seedUser } from './support/entityLevelPgliteHarness';
import { hazards } from './support/sqlEditorHazards';

const MIGRATION = path.resolve(__dirname, '..', '..', 'supabase', 'migrations', '0298_retirement_no_savings_declaration_guard.sql');
const CODE = 'RETIREMENT_DECLARATION_CONFLICT';

let db: PGlite;
let n = 0;
type Row = Record<string, unknown>;
const uid = () => `dddddddd-0000-0000-0000-${String(++n).padStart(12, '0')}`;
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];

async function newUser(label: string): Promise<string> {
  const id = uid();
  await seedUser(db, id, `${label}${n}@pg.test`, 'AU');
  return id;
}
async function addAccount(u: string, name: string, active = true): Promise<string> {
  return asUser(db, u, async () => {
    const r = await db.query(
      `insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, is_active) values ($1,$2,'super',100000,'AUD',$3) returning id`,
      [u, name, active],
    );
    return (r.rows[0] as Row).id as string;
  });
}
async function addFund(u: string): Promise<{ fundId: string; raId: string }> {
  const rows = await asUser(db, u, async () => (await db.query(`select * from smsf_create_fund('SMSF','Test SMSF',null,null,'self','AUD','AU','detailed')`)).rows as Row[]);
  return { fundId: rows[0].smsf_fund_id as string, raId: rows[0].retirement_account_id as string };
}
const declareProfile = (u: string, value: boolean) =>
  asUser(db, u, async () => db.query(`update user_profiles set not_applicable_retirement=$2 where user_id=$1`, [u, value]));
const declareSection = (u: string) =>
  asUser(db, u, async () => db.query(`insert into user_financial_section_status(user_id, section, status) values ($1,'retirement','not_applicable') on conflict (user_id, section) do update set status='not_applicable'`, [u]));
const flag = async (u: string) => (await q(`select not_applicable_retirement f from user_profiles where user_id=$1`, [u]))[0].f as boolean;
const section = async (u: string) => q(`select status from user_financial_section_status where user_id=$1 and section='retirement'`, [u]);

beforeAll(async () => {
  db = await replayLedger();
}, 400_000);
afterAll(async () => {
  await db?.close();
});

describe('migration 0298: file hygiene', () => {
  it('is editor safe and additive (no table, no policy, no data change)', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(hazards(sql)).toEqual([]);
    const code = sql.toLowerCase().replace(/--.*$/gm, '');
    expect(code).not.toMatch(/create\s+table|drop\s+table|truncate|delete\s+from|insert\s+into|\bupdate\s+public\./);
  });
  it('re-running it changes nothing (idempotent)', async () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    const t = await q(`select count(*)::int c from pg_trigger where tgname in ('trg_guard_retirement_declaration_profile','trg_guard_retirement_declaration_section')`);
    expect(t[0].c).toBe(2);
  });
});

describe('profile store: user_profiles.not_applicable_retirement (a direct update, no application route)', () => {
  it('is refused while an active retirement account exists, and the row keeps its value', async () => {
    const u = await newUser('a');
    await addAccount(u, 'Rest super');
    await addAccount(u, 'Hostplus');
    await expectSqlError(declareProfile(u, true), CODE);
    expect(await flag(u)).toBe(false);
  });

  it('SMSF-only is refused (the fund and its mirror row count once)', async () => {
    const u = await newUser('b');
    await addFund(u);
    await expectSqlError(declareProfile(u, true), CODE);
    expect(await flag(u)).toBe(false);
  });

  it('inactive accounts and an inactive SMSF do not block it', async () => {
    const u = await newUser('c');
    await addAccount(u, 'Old fund', false);
    const { fundId } = await addFund(u);
    await q(`update smsf_funds set is_active=false where id=$1`, [fundId]);
    await declareProfile(u, true);
    expect(await flag(u)).toBe(true);
  });

  it('deactivating the last account makes the declaration possible again', async () => {
    const u = await newUser('d');
    const id = await addAccount(u, 'Rest super');
    await expectSqlError(declareProfile(u, true), CODE);
    await q(`update retirement_accounts set is_active=false where id=$1`, [id]);
    await declareProfile(u, true);
    expect(await flag(u)).toBe(true);
  });

  it('clearing is never refused, and a legacy contradiction does not block unrelated edits of the same row', async () => {
    const u = await newUser('e');
    await declareProfile(u, true); // true while nothing is held
    await addAccount(u, 'Rest super'); // the contradiction now exists (account added after the declaration)
    await asUser(db, u, async () => db.query(`update user_profiles set full_name='Renamed' where user_id=$1`, [u]));
    await asUser(db, u, async () => db.query(`update user_profiles set not_applicable_retirement=true where user_id=$1`, [u])); // already true: not a transition
    expect(await flag(u)).toBe(true);
    await declareProfile(u, false);
    expect(await flag(u)).toBe(false);
  });

  it('TWO-USER ISOLATION: another person\'s accounts neither block this person nor are visible to the guard', async () => {
    const a = await newUser('f');
    const b = await newUser('g');
    await addAccount(b, 'B super');
    await addFund(b);
    await declareProfile(a, true);
    expect(await flag(a)).toBe(true);
    await expectSqlError(declareProfile(b, true), CODE);
    expect(await flag(b)).toBe(false);
  });
});

describe('section store: user_financial_section_status (retirement, not_applicable)', () => {
  it('is refused while an account exists (insert and the update branch of an upsert), and no row is left', async () => {
    const u = await newUser('h');
    await addAccount(u, 'Rest super');
    await expectSqlError(declareSection(u), CODE);
    expect(await section(u)).toHaveLength(0);
    await asUser(db, u, async () => db.query(`insert into user_financial_section_status(user_id, section, status) values ($1,'retirement','reviewed_zero')`, [u]));
    await expectSqlError(declareSection(u), CODE);
    expect((await section(u))[0].status).toBe('reviewed_zero');
  });

  it('SMSF-only is refused; another section is unaffected by retirement holdings; inactive items allow it', async () => {
    const u = await newUser('i');
    const { fundId } = await addFund(u);
    await expectSqlError(declareSection(u), CODE);
    await asUser(db, u, async () => db.query(`insert into user_financial_section_status(user_id, section, status) values ($1,'insurance','not_applicable')`, [u]));
    await q(`update smsf_funds set is_active=false where id=$1`, [fundId]);
    await declareSection(u);
    expect((await section(u))[0].status).toBe('not_applicable');
  });

  it('TWO-USER ISOLATION on the section store', async () => {
    const a = await newUser('j');
    const b = await newUser('k');
    await addAccount(b, 'B super');
    await declareSection(a);
    expect((await section(a))[0].status).toBe('not_applicable');
    await expectSqlError(declareSection(b), CODE);
  });
});

describe('NEGATIVE CONTROL: without the 0298 triggers the same direct writes succeed', () => {
  it('drops the two triggers, proves the contradiction is then writable, and restores them', async () => {
    const u = await newUser('l');
    await addAccount(u, 'Rest super');
    await q(`drop trigger trg_guard_retirement_declaration_profile on user_profiles`);
    await q(`drop trigger trg_guard_retirement_declaration_section on user_financial_section_status`);
    await declareProfile(u, true);
    await declareSection(u);
    expect(await flag(u)).toBe(true); // the contradiction exists: the guard was the only thing preventing it
    expect((await section(u))[0].status).toBe('not_applicable');
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    const v = await newUser('m');
    await addAccount(v, 'Rest super');
    await expectSqlError(declareProfile(v, true), CODE); // and the restored guard refuses again
  });
});
