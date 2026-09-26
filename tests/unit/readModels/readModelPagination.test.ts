/**
 * No truncation at 1000 rows; 100-id chunks; fail closed (EXP-G8 / DC-18).
 * The fake client enforces PostgREST's 1000-row cap exactly as production
 * does, so an unpaged reader would visibly lose rows here.
 */
import { describe, expect, it } from 'vitest';

import { fetchAllByIds, fetchAllRows } from '@/lib/read-models/core/paginate';
import { selectExpenses } from '@/lib/read-models/expenses';
import { makeFakeSupabase } from './helpers/fakeSupabase';
import { account, CAT, profile, statement, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

describe('paging primitives', () => {
  it('fetchAllRows reads 2,500 rows in three pages', async () => {
    const { client, requests } = makeFakeSupabase({ t: Array.from({ length: 2500 }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}` })) });
    const rows = await fetchAllRows<{ id: string }>('t', (from, to) => client.from('t').select('id').order('id').range(from, to));
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    expect(requests.map((r) => [r.from, r.to])).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('negative control: the same read WITHOUT range() silently stops at 1000 (the PostgREST cap the fake enforces)', async () => {
    const { client } = makeFakeSupabase({ t: Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}` })) });
    const { data } = await client.from('t').select('id');
    expect((data as unknown[]).length).toBe(1000);
  });

  it('fetchAllByIds sends at most 100 ids per request', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const { client, requests } = makeFakeSupabase({ t: ids.map((id) => ({ id })) });
    const rows = await fetchAllByIds<{ id: string }>('t', ids, (chunk, from, to) => client.from('t').select('id').in('id', chunk).range(from, to));
    expect(rows).toHaveLength(250);
    expect(requests.map((r) => r.inSizes[0])).toEqual([100, 100, 50]);
  });

  it('an error on the 2nd page fails the whole read (never a partial list)', async () => {
    let calls = 0;
    await expect(fetchAllRows('t', async () => {
      calls += 1;
      return calls === 1 ? { data: Array.from({ length: 1000 }, () => ({})), error: null } : { data: null, error: { message: 'boom' } };
    })).rejects.toMatchObject({ reason: 'query_failed', source: 't' });
  });
});

describe('1,000 / 1,001-row statements through selectExpenses', () => {
  for (const n of [1000, 1001]) {
    it(`${n} approved $1 lines in a covered month are ALL counted ($${n})`, async () => {
      const { client, requests } = makeFakeSupabase(tables(profile(), taxonomy(),
        { fdh_financial_accounts: [account('bank')] },
        { fdh_statement_uploads: [statement('s', 'bank', '2026-08-01', '2026-08-31')] },
        { fdh_transactions: Array.from({ length: n }, (_, i) => txn({ id: `big-${String(i).padStart(5, '0')}`, account: 'bank', statement: 's', date: '2026-08-15', amount: 1, type: 'expense', category: CAT.food })) },
      ));
      const res = await selectExpenses(USER, { client, window: WINDOW });
      if (res.status !== 'ok') throw new Error('unavailable');
      expect(res.actual.lines).toHaveLength(n);
      expect(res.actual.monthly).toBe(n);
      // Every id-filtered follow-up query was chunked.
      expect(requests.flatMap((r) => r.inSizes).every((s) => s <= 100)).toBe(true);
    });
  }
});
