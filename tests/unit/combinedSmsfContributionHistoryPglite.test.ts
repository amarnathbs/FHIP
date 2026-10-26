// COMBINED DEV BRANCH (WP-C entity finance + WP-D retirement, 21-10-2026): the SMSF contribution history reads WP-D's retirement_contributions
// (migration 0304) where destination_kind = 'smsf' and status = 'active'. EVIDENCE LABEL: PGLITE-VERIFIED on a replay of the REAL migration ledger,
// driven as the real `authenticated` role (row level security, auth.uid()) through a thin PostgREST-shaped adapter, once WITH 0304 and once WITHOUT it.
// Not DEV-verified.
import { describe, it, expect, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asUser, replayLedger, seedUser } from './support/entityLevelPgliteHarness';
import { listSmsfContributionDestinations, loadSmsfContributionHistory } from '@/lib/services/smsfContributionDestination';

type Row = Record<string, unknown>;

/** The few chain calls the SMSF contribution reader makes (select, eq, order), run as the given user against PGlite. */
function pgClient(db: PGlite, uid: string): SupabaseClient {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let cols = '*';
    let order = '';
    const chain: Record<string, unknown> = {
      select: (c: string) => { cols = c; return chain; },
      eq: (k: string, v: unknown) => { filters.push([k, v]); return chain; },
      order: (c: string, o?: { ascending?: boolean }) => { order = ` order by ${c} ${o?.ascending === false ? 'desc' : 'asc'}`; return chain; },
      then: (resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
        const where = filters.length ? ` where ${filters.map(([k], i) => `${k} = $${i + 1}`).join(' and ')}` : '';
        return asUser(db, uid, async () => (await db.query(`select ${cols} from ${table}${where}${order}`, filters.map(([, v]) => v))).rows as Row[])
          .then((data) => resolve({ data, error: null }), (e: Error) => resolve({ data: null, error: { message: e.message } }));
      },
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const USER = 'cccccccc-0000-0000-0000-000000000001';
const OTHER = 'cccccccc-0000-0000-0000-000000000002';

async function fundFor(db: PGlite, uid: string): Promise<{ fundId: string; raId: string }> {
  const rows = await asUser(db, uid, async () => (await db.query(`select * from smsf_create_fund('SMSF','PO SMSF',null,null,'self','AUD','AU','detailed')`)).rows as Row[]);
  return { fundId: rows[0].smsf_fund_id as string, raId: rows[0].retirement_account_id as string };
}

describe('WITH migration 0304: the SMSF history lists only active smsf ledger rows of this fund and household', () => {
  let db: PGlite;
  afterAll(async () => { await db?.close(); });

  it('lists the active smsf rows, never a removed, superseded or other-kind row, never another household', async () => {
    db = await replayLedger();
    await seedUser(db, USER, 'with0304@pg.test');
    await seedUser(db, OTHER, 'other0304@pg.test');
    const mine = await fundFor(db, USER);
    const theirs = await fundFor(db, OTHER);
    // an ordinary (non SMSF) retirement account of the same household, for the other-kind row
    const plain = (await asUser(db, USER, async () => (await db.query(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, owner) values ($1,'Industry fund','super',100,'AUD','self') returning id`, [USER])).rows[0] as Row)).id as string;

    const add = (uid: string, account: string, kind: string, status: string, type: string, amount: number, source = 'manual') =>
      asUser(db, uid, async () => db.query(
        `insert into retirement_contributions(user_id, retirement_account_id, destination_kind, contribution_type, amount, currency_code, frequency, source_type, status)
         values ($1,$2,$3,$4,$5,'AUD','monthly',$6,$7)`, [uid, account, kind, type, amount, source, status]));
    await add(USER, mine.raId, 'smsf', 'active', 'employer', 1_000, 'manual');
    await add(USER, mine.raId, 'smsf', 'removed', 'personal', 300);
    await add(USER, mine.raId, 'smsf', 'superseded', 'spouse', 200);
    await add(USER, plain, 'retirement_account', 'active', 'employer', 700);
    await add(OTHER, theirs.raId, 'smsf', 'active', 'employer', 5_000);

    const h = await loadSmsfContributionHistory(USER, mine.raId, pgClient(db, USER));
    expect(h.status).toBe('ok');
    expect(h.status === 'ok' && h.entries.map((e) => [e.contributionType, e.amount, e.source])).toEqual([['employer', 1_000, 'manual']]);
    // another household's fund account through MY session finds nothing (row level security), not an error and not their row
    const cross = await loadSmsfContributionHistory(USER, theirs.raId, pgClient(db, USER));
    expect(cross.status === 'ok' && cross.entries).toEqual([]);
  }, 400_000);

  it('the destinations name the fund and its own Retirement row, for this household only', async () => {
    const d = await listSmsfContributionDestinations(USER, pgClient(db, USER));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ fundName: 'PO SMSF', currency: 'AUD' });
  });
});

describe('WITHOUT migration 0304 (DEV before the PO applies it): the history is UNAVAILABLE, gracefully, and nothing else breaks', () => {
  let db: PGlite;
  afterAll(async () => { await db?.close(); });

  it('reads as unavailable with a reason, no exception, and the destinations still work', async () => {
    db = await replayLedger({ skip: (f) => f.startsWith('0304_') });
    await seedUser(db, USER, 'without0304@pg.test');
    const mine = await fundFor(db, USER);
    expect((await db.query(`select to_regclass('public.retirement_contributions') as t`)).rows[0]).toEqual({ t: null });
    const h = await loadSmsfContributionHistory(USER, mine.raId, pgClient(db, USER));
    expect(h.status).toBe('unavailable');
    expect(h.status === 'unavailable' && h.reason).toMatch(/retirement_contributions/);
    const d = await listSmsfContributionDestinations(USER, pgClient(db, USER));
    expect(d).toHaveLength(1);
  }, 400_000);
});
