/**
 * WP-07 acceptance -- GET /api/expenses/actuals (the Expenses tab's
 * "Actual (imported)" section; EXP-G1 / DC-17).
 *
 *  - the brief's Woolworths $200 Groceries approved fixture is visible AFTER
 *    Apply (approved) and absent BEFORE it (pending);
 *  - the route is tenant-scoped: another user's approved rows never appear;
 *  - 1,001 lines are all counted and paginate (no PostgREST 1000-row truncation);
 *  - a failed read is 'unavailable', never $0;
 *  - the wire contract the component reads is exactly what the route sends.
 *
 * NEGATIVE CONTROL: on the base branch (feature/canonical-upload-foundation,
 * f79374f) app/api/expenses/actuals/route.ts and lib/expenses/importedActuals.ts
 * do not exist, so every test in this file fails at import -- the Expenses tab
 * had no way to show an approved imported line at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, expenseItem, profile, statement, SUB, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';

const OTHER = '00000000-0000-0000-0000-0000000000u2';
const state: { tables: Record<string, Row[]>; failOn?: Set<string>; user: string } = { tables: {}, user: USER };

vi.mock('@/lib/services/appCapability', () => ({
  requireModuleCapability: async () => ({ user: { id: state.user }, blocked: null, decision: null }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(state.tables, { failOn: state.failOn }).client,
}));

import { GET } from '@/app/api/expenses/actuals/route';
import type { ImportedActualsDto, ImportedActualsOk } from '@/lib/expenses/importedActuals';

async function get(query = ''): Promise<ImportedActualsDto> {
  const res = await GET(new Request(`http://localhost/api/expenses/actuals${query}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ImportedActualsDto }).data;
}
const okOf = (d: ImportedActualsDto): ImportedActualsOk => {
  if (d.status !== 'ok') throw new Error(`unavailable: ${d.reason}`);
  return d;
};

// "Today" = 26 Sep 2026 in Sydney -> the default window is Jun-Aug 2026.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T02:00:00Z'));
  state.failOn = undefined;
  state.user = USER;
});
afterEach(() => vi.useRealTimers());

const woolworths = (approval: 'approved' | 'pending') => tables(
  profile(), taxonomy(),
  { fdh_financial_accounts: [account('bank')] },
  { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] },
  { fdh_transactions: [txn({ id: 'w', account: 'bank', statement: 's-aug', date: '2026-08-14', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Woolworths', approval })] },
  { expense_items: [expenseItem('plan-groc', 'Groceries', 800, 'monthly', { master_item_key: 'groceries' })] },
);

describe('Woolworths $200 Groceries on the Expenses tab', () => {
  it('after Apply (approved): one Actual line "Woolworths", $200, food, labelled "Imported from bank statement" with a statement link', async () => {
    state.tables = woolworths('approved');
    const d = okOf(await get());
    expect(d.lineCount).toBe(1);
    expect(d.lines[0]).toMatchObject({
      description: 'Woolworths', amount: 200, currency: 'AUD', amountReporting: 200, group: 'food', coverage: 'covered',
      sourceKind: 'bank_statement', sourceLabel: 'Imported from bank statement', categoryLabel: 'Groceries',
    });
    expect(d.lines[0].statementHref).toMatch(/review\?statement=s-aug&from=expenses$/);
    // Planned vs actual, never added: food planned 800, actual 200, combined uses actual.
    const food = d.groups.find((g) => g.group === 'food')!;
    expect(food).toMatchObject({ plannedMonthly: 800, actualMonthly: 200, varianceMonthly: -600, basis: 'actual' });
    expect(d.totals).toMatchObject({ plannedMonthly: 800, actualMonthly: 200, combinedMonthly: 200, actualTotalInWindow: 200 });
  });

  it('before Apply (still pending): absent -- zero lines, zero actual, counted as awaiting review', async () => {
    state.tables = woolworths('pending');
    const d = okOf(await get());
    expect(d.lineCount).toBe(0);
    expect(d.lines).toEqual([]);
    expect(d.totals.actualMonthly).toBe(0);
    expect(d.hasActual).toBe(false);
    expect(d.unknownPendingCount).toBe(1);
    expect(d.groups.find((g) => g.group === 'food')).toMatchObject({ plannedMonthly: 800, actualMonthly: null, basis: 'planned' });
  });

  it('nothing is written: the route makes no insert/upsert (imports are never copied into expense_items)', async () => {
    state.tables = woolworths('approved');
    const fake = makeFakeSupabase(state.tables);
    const { selectExpenses } = await import('@/lib/read-models/expenses');
    await selectExpenses(USER, { client: fake.client });
    expect(fake.upserts).toEqual([]);
  });
});

describe('tenant scoping', () => {
  it("another user's approved Woolworths line never appears; the caller sees only their own", async () => {
    const mine = woolworths('approved');
    const theirs: Row[] = [
      { ...account('bank-2'), user_id: OTHER },
      { ...statement('s-2', 'bank-2', '2026-08-01', '2026-08-31'), user_id: OTHER },
      { ...txn({ id: 'foreign', account: 'bank-2', statement: 's-2', date: '2026-08-15', amount: 999, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Coles (other household)' }), user_id: OTHER },
    ];
    state.tables = tables(mine, { fdh_financial_accounts: [theirs[0]], fdh_statement_uploads: [theirs[1]], fdh_transactions: [theirs[2]] }, { user_profiles: [{ user_id: OTHER, preferred_currency: 'AUD', country_of_residence: 'AU' }] });
    const d = okOf(await get());
    expect(d.lines.map((l) => l.description)).toEqual(['Woolworths']);
    expect(d.totals.actualTotalInWindow).toBe(200);

    state.user = OTHER;
    const cross = okOf(await get());
    expect(cross.lines.map((l) => l.description)).toEqual(['Coles (other household)']);
    expect(cross.lines.some((l) => l.description === 'Woolworths')).toBe(false);
  });

  it('a user with no rows at all gets 0 lines (not the other tenant\'s)', async () => {
    state.tables = woolworths('approved');
    state.user = OTHER;
    const d = okOf(await get());
    expect(d.lineCount).toBe(0);
    expect(d.totals.actualTotalInWindow).toBe(0);
  });
});

describe('1,001 lines paginate', () => {
  const big = () => {
    const rows: Row[] = [];
    for (let i = 0; i < 1001; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      rows.push(txn({ id: `t-${String(i).padStart(5, '0')}`, account: 'bank', statement: 's-aug', date: `2026-08-${day}`, amount: 10, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: `Line ${i}` }));
    }
    return tables(profile(), taxonomy(), { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] }, { fdh_transactions: rows });
  };

  it('all 1,001 are counted (totals over every line), served 100 per page: 11 pages, the last holding 1', async () => {
    state.tables = big();
    const p1 = okOf(await get('?page=1&pageSize=100'));
    expect(p1.lineCount).toBe(1001);
    expect(p1.pageCount).toBe(11);
    expect(p1.lines).toHaveLength(100);
    expect(p1.totals.actualTotalInWindow).toBe(10010);
    const p11 = okOf(await get('?page=11&pageSize=100'));
    expect(p11.lines).toHaveLength(1);
    const seen = new Set<string>();
    for (let page = 1; page <= 11; page += 1) for (const l of okOf(await get(`?page=${page}&pageSize=100`)).lines) seen.add(l.key);
    expect(seen.size).toBe(1001);
  });

  it('pageSize is capped at 500 and a page past the end clamps to the last page', async () => {
    state.tables = big();
    const d = okOf(await get('?page=99&pageSize=100000'));
    expect(d.pageSize).toBe(500);
    expect(d.pageCount).toBe(3);
    expect(d.page).toBe(3);
  });

  it('the group and month filters narrow the lines, not the totals', async () => {
    state.tables = big();
    const d = okOf(await get('?group=housing'));
    expect(d.lineCount).toBe(0);
    expect(d.totals.actualTotalInWindow).toBe(10010);
    expect(okOf(await get('?month=2026-08&pageSize=10')).lineCount).toBe(1001);
  });
});

describe('fail closed and the wire contract', () => {
  it('a failed read is status "unavailable" -- never a $0 actual', async () => {
    state.tables = woolworths('approved');
    state.failOn = new Set(['fdh_transactions']);
    const d = await get();
    expect(d).toEqual({ status: 'unavailable', reason: 'query_failed' });
  });

  it('the response carries every field the component reads (no snake/camel drift)', async () => {
    state.tables = woolworths('approved');
    const d = okOf(await get());
    expect(Object.keys(d).sort()).toEqual([
      'excludedDuplicates', 'groups', 'hasActual', 'hasPlanned', 'lineCount', 'lineGroups', 'lineMonths', 'lines', 'nonSpending', 'page', 'pageCount', 'pageSize',
      'partialLineCount', 'refundsNetted', 'refundsUnlinked', 'reportingCurrency', 'status', 'totals', 'unconverted', 'unknownPendingCount', 'window',
    ]);
    expect(Object.keys(d.lines[0]).sort()).toEqual([
      'accountName', 'amount', 'amountReporting', 'categoryLabel', 'coverage', 'currency', 'date', 'description', 'group', 'groupLabel', 'key', 'month', 'sourceKind', 'sourceLabel', 'statementHref',
    ]);
    // The non-spending buckets are always present and labelled for the tab.
    expect(d.nonSpending.map((b) => b.label)).toEqual(expect.arrayContaining([
      'Cash withdrawals — spending unknown', 'Transfers — not counted', 'Loan interest & fees — inside loan repayment',
    ]));
  });
});
