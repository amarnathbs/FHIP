/**
 * WP-15 routes: /api/expenses/planned-from-actuals and /api/assets/bank-balances.
 *
 *  - GET is a preview and writes NOTHING;
 *  - POST generate writes ONLY inert proposals (supersede earlier ready ones
 *    first, then proposal + fields) -- never expense_items / assets / any
 *    transaction; items that already match are not persisted;
 *  - POST apply is one RPC call; a stale / already-applied refusal is a 409;
 *  - a malformed body is a 422 and reaches no RPC.
 *
 * NEGATIVE CONTROL: on the base branch (f79374f) neither route exists, so
 * this file fails at import.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, expenseItem, profile, statement, SUB, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';

type Write = { table: string; op: 'insert' | 'update'; payload: unknown; filters: [string, unknown][] };
const state: { tables: Record<string, Row[]>; writes: Write[]; rpc: { fn: string; args: unknown }[]; rpcResult: unknown } = { tables: {}, writes: [], rpc: [], rpcResult: null };

/** Read-model fake for selects, recording fake for writes, stub for rpc. */
function client() {
  const reads = makeFakeSupabase(state.tables).client;
  let seq = 0;
  return {
    from(table: string) {
      const base = reads.from(table);
      return Object.assign(base, {
        insert(payload: unknown) {
          const w: Write = { table, op: 'insert', payload, filters: [] };
          state.writes.push(w);
          const id = `${table}-${++seq}`;
          const done = Promise.resolve({ data: null, error: null });
          return Object.assign(done, { select: () => ({ single: () => Promise.resolve({ data: { id }, error: null }) }) });
        },
        update(payload: unknown) {
          const w: Write = { table, op: 'update', payload, filters: [] };
          state.writes.push(w);
          const chain = { eq(col: string, val: unknown) { w.filters.push([col, val]); return chain; }, then: (f: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(f) };
          return chain;
        },
      });
    },
    rpc(fn: string, args: unknown) { state.rpc.push({ fn, args }); return Promise.resolve({ data: state.rpcResult, error: null }); },
  };
}

vi.mock('@/lib/services/appCapability', () => ({ requireModuleCapability: async () => ({ user: { id: USER }, blocked: null, decision: null }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client() }));

import * as expenseRoute from '@/app/api/expenses/planned-from-actuals/route';
import * as assetRoute from '@/app/api/assets/bank-balances/route';

const req = (url: string, body?: unknown) => new Request(`http://localhost${url}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T02:00:00Z'));
  state.writes = [];
  state.rpc = [];
  state.rpcResult = null;
  state.tables = tables(profile(), taxonomy(),
    { master_financial_items: [{ category: 'expense', item_key: 'groceries', item_label: 'Groceries' }, { category: 'expense', item_key: 'restaurants', item_label: 'Restaurants' }] },
    { fdh_financial_accounts: [account('bank', 'transaction', { display_name: 'Everyday' })] },
    { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] },
    { fdh_reconciliation_results: [{ user_id: USER, statement_upload_id: 's-aug', reported_closing_balance: 6000, currency_code: 'AUD', created_at: '2026-09-01T00:00:00Z' }] },
    { fdh_transactions: [
      txn({ account: 'bank', statement: 's-aug', date: '2026-08-10', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Woolworths' }),
      txn({ account: 'bank', statement: 's-aug', date: '2026-08-11', amount: 60, type: 'expense', category: CAT.food, subcategory: SUB.restaurants }),
    ] },
    { expense_items: [{ ...expenseItem('p-groc', 'Groceries', 800, 'monthly', { master_item_key: 'groceries' }), updated_at: null }, { ...expenseItem('p-rest', 'Restaurants', 60, 'monthly', { master_item_key: 'restaurants' }), updated_at: null }] },
    { assets: [] },
  );
});

describe('planned-from-actuals', () => {
  it('GET previews (groceries 800 -> 200 update; restaurants already 60 -> keep) and writes nothing', async () => {
    const res = await expenseRoute.GET(req('/api/expenses/planned-from-actuals'));
    const { data } = await res.json();
    expect(data.status).toBe('ok');
    expect(data.items.map((i: { masterItemKey: string; recommended: string; actualMonthly: number; proposalId: string | null }) => [i.masterItemKey, i.recommended, i.actualMonthly, i.proposalId])).toEqual([
      ['groceries', 'update_existing', 200, null], ['restaurants', 'keep_existing', 60, null],
    ]);
    expect(state.writes).toEqual([]);
    expect(state.rpc).toEqual([]);
  });

  it('POST generate: supersedes earlier ready expense proposals, then persists ONE proposal (groceries) with its window; the matching item is not persisted; nothing else is written', async () => {
    const res = await expenseRoute.POST(req('/api/expenses/planned-from-actuals', { action: 'generate' }));
    const { data } = await res.json();
    expect(state.writes.map((w) => `${w.op}:${w.table}`)).toEqual(['update:fhip_import_proposals', 'insert:fhip_import_proposals', 'insert:fhip_import_proposal_fields']);
    expect(state.writes[0]).toMatchObject({ payload: { status: 'superseded' }, filters: [['user_id', USER], ['target_domain', 'expense'], ['source_kind', 'bank_statement'], ['status', 'ready']] });
    expect(state.writes[1].payload).toMatchObject({ user_id: USER, target_domain: 'expense', source_kind: 'bank_statement', target_entity_id: 'p-groc', recommended_apply_mode: 'update_existing', source_window_from: '2026-06-01', source_window_to: '2026-08-31', status: 'ready' });
    expect((state.writes[2].payload as { field_name: string }[]).map((f) => f.field_name)).toEqual(['amount', 'frequency', 'currency_code']);
    expect(data.items.find((i: { masterItemKey: string }) => i.masterItemKey === 'groceries').proposalId).toBe('fhip_import_proposals-1');
    expect(data.items.find((i: { masterItemKey: string }) => i.masterItemKey === 'restaurants').proposalId).toBeNull();
  });

  it('POST apply: one RPC call; a stale batch is a 409 carrying the refusal', async () => {
    state.rpcResult = { ok: false, code: 'STALE_PROPOSAL', error: 'changed', proposal_id: '11111111-1111-4111-8111-111111111111', rolled_back: true };
    const res = await expenseRoute.POST(req('/api/expenses/planned-from-actuals', { action: 'apply', decisions: [{ proposalId: '11111111-1111-4111-8111-111111111111', decision: 'update_existing' }] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STALE_PROPOSAL', rolledBack: true });
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0].fn).toBe('fdh15_apply_expense_proposals');
  });

  it('a malformed body is 422 and reaches no RPC', async () => {
    const res = await expenseRoute.POST(req('/api/expenses/planned-from-actuals', { action: 'apply', decisions: [{ proposalId: 'not-a-uuid', decision: 'add_new' }] }));
    expect(res.status).toBe(422);
    expect(state.rpc).toEqual([]);
  });
});

describe('bank-balances', () => {
  it('GET previews the 6000 closing balance as an ADD, writing nothing', async () => {
    const res = await assetRoute.GET(req('/api/assets/bank-balances'));
    const { data } = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ accountName: 'Everyday', closingBalance: 6000, state: 'proposed', recommended: 'add_new', proposalId: null });
    expect(state.writes).toEqual([]);
  });

  it('POST generate persists the proposal for that one account, sourced from its statement', async () => {
    const res = await assetRoute.POST(req('/api/assets/bank-balances', { action: 'generate', accountId: '00000000-0000-4000-8000-000000000000' }));
    expect((await res.json()).data).toEqual({ status: 'unavailable', reason: 'account_not_found' });
    state.tables.fdh_financial_accounts[0].id = '00000000-0000-4000-8000-000000000000';
    state.tables.fdh_statement_uploads[0].financial_account_id = '00000000-0000-4000-8000-000000000000';
    for (const t of state.tables.fdh_transactions) t.financial_account_id = '00000000-0000-4000-8000-000000000000';
    const ok = await assetRoute.POST(req('/api/assets/bank-balances', { action: 'generate', accountId: '00000000-0000-4000-8000-000000000000' }));
    const { data } = await ok.json();
    expect(data.item.proposalId).toBe('fhip_import_proposals-1');
    expect(state.writes.map((w) => `${w.op}:${w.table}`)).toEqual(['update:fhip_import_proposals', 'insert:fhip_import_proposals', 'insert:fhip_import_proposal_fields']);
    expect(state.writes[1].payload).toMatchObject({ target_domain: 'asset', source_kind: 'bank_statement', source_statement_upload_id: 's-aug', recommended_apply_mode: 'add_new' });
  });

  it('POST apply: ALREADY_APPLIED is a 409 from fdh15_apply_asset_proposal', async () => {
    state.rpcResult = { ok: false, code: 'ALREADY_APPLIED', error: 'done' };
    const res = await assetRoute.POST(req('/api/assets/bank-balances', { action: 'apply', proposalId: '11111111-1111-4111-8111-111111111111', decision: 'add_new' }));
    expect(res.status).toBe(409);
    expect(state.rpc[0].fn).toBe('fdh15_apply_asset_proposal');
  });
});
