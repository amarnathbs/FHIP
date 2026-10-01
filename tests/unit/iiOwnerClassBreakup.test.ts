/**
 * Owner classes (2026-10-01, PO decision): "show everything, but in a SEPARATE
 * breakup per owner class; a consolidated view only as an explicit macro summary;
 * entity-owned data is never silently summed into personal totals."
 *
 * Proves:
 *  - the classification (personal per member / joint / entity / shared-with-entity /
 *    unallocated), including agreement with the India MF report's owner keys;
 *  - the breakup + macro line: classes partition the accounts, the macro line is
 *    exactly their sum, and entity-involved accounts are NEVER inside a personal row;
 *  - joint attribution divides each position by basis points and adds back exactly;
 *  - the scoped read-only client runs the CERTIFIED loaders unchanged on a class's
 *    rows only (sum of class inputs == consolidated input), and refuses writes.
 *
 * Expected figures are written by hand.
 */
import { describe, expect, it } from 'vitest';

import {
  CONSOLIDATED_LABEL,
  buildOwnerBreakup,
  classifyOwnership,
  loadOwnerBreakup,
  loadOwnerClassContext,
  personalScopeAccountIds,
  scopeClientToAccounts,
  type OwnerLabels,
} from '@/lib/services/investment-intelligence/ownerClass';
import { deriveAccountOwnership, type AccountOwnership } from '@/lib/services/investment-intelligence/ownerModel';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { USER } from './readModels/helpers/fixtures';

const labels: OwnerLabels = {
  member: (id) => ({ 'm-asha': { name: 'Asha Rao', relationship: 'self' }, 'm-ravi': { name: 'Ravi Rao', relationship: 'spouse' } } as Record<string, { name: string; relationship: string }>)[id],
  entity: (id) => ({ 'e-trust': { name: 'Rao Family Trust', entityType: 'family_trust' }, 'e-huf': { name: 'Rao HUF', entityType: 'huf' } } as Record<string, { name: string; entityType: string }>)[id],
};
const own = (shares: { m?: string; e?: string; bp: number }[], pointer: string | null = null): AccountOwnership =>
  deriveAccountOwnership(pointer, shares.map((s) => ({ owner_member_id: s.m ?? null, owner_business_entity_id: s.e ?? null, allocation_basis_points: s.bp, ii_instrument_id: null, status: 'active' })));

describe('classifyOwnership', () => {
  it('sole member -> personal member:<id>; sole entity -> entity:<id>; members-only split -> joint; split with an entity -> entity_shared; none -> unallocated', () => {
    expect(classifyOwnership(own([], 'm-asha'), labels)).toMatchObject({ key: 'member:m-asha', kind: 'personal', label: 'Asha Rao', detail: 'You' });
    expect(classifyOwnership(own([{ e: 'e-trust', bp: 10000 }]), labels)).toMatchObject({ key: 'entity:e-trust', kind: 'entity', label: 'Rao Family Trust', detail: 'Family trust' });
    expect(classifyOwnership(own([{ e: 'e-huf', bp: 10000 }]), labels)).toMatchObject({ key: 'entity:e-huf', detail: 'Hindu Undivided Family (HUF)' });
    expect(classifyOwnership(own([{ m: 'm-asha', bp: 6000 }, { m: 'm-ravi', bp: 4000 }]), labels).key).toBe('joint');
    expect(classifyOwnership(own([{ m: 'm-asha', bp: 6000 }, { e: 'e-trust', bp: 4000 }]), labels).key).toBe('entity_shared');
    expect(classifyOwnership(own([]), labels).key).toBe('unallocated');
  });

  it('AGREES WITH THE INDIA MF REPORT: an incomplete split (not 10000) and an unknown owner id are both Unallocated, never silently personal', () => {
    expect(classifyOwnership(own([{ m: 'm-asha', bp: 6000 }, { m: 'm-ravi', bp: 3000 }], 'm-asha'), labels).key).toBe('unallocated');
    expect(classifyOwnership(own([], 'm-ghost'), labels).key).toBe('unallocated');
    expect(classifyOwnership(own([{ e: 'e-ghost', bp: 10000 }]), labels).key).toBe('unallocated');
  });
});

describe('buildOwnerBreakup: separate tables per owner class + an explicit macro line', () => {
  // value in AUD unless stated
  const accounts = [
    { id: 'a-asha', ownership: own([], 'm-asha') },
    { id: 'a-ravi', ownership: own([], 'm-ravi') },
    { id: 'a-joint', ownership: own([{ m: 'm-asha', bp: 6000 }, { m: 'm-ravi', bp: 4000 }]) },
    { id: 'a-trust', ownership: own([{ e: 'e-trust', bp: 10000 }]) },
    { id: 'a-shared', ownership: own([{ m: 'm-asha', bp: 6000 }, { e: 'e-trust', bp: 4000 }]) },
    { id: 'a-none', ownership: own([]) },
    { id: 'a-empty', ownership: own([], 'm-asha') }, // an account with no position yet
  ];
  const positions = [
    { accountId: 'a-asha', currencyCode: 'AUD', value: 100_000 },
    { accountId: 'a-ravi', currencyCode: 'AUD', value: 200_000 },
    { accountId: 'a-joint', currencyCode: 'AUD', value: 1_000_000 },
    { accountId: 'a-trust', currencyCode: 'AUD', value: 500_000 },
    { accountId: 'a-shared', currencyCode: 'AUD', value: 200_000 },
    { accountId: 'a-none', currencyCode: 'AUD', value: 50_000 },
    { accountId: 'a-asha', currencyCode: 'INR', value: 7_000_000 },
  ];
  const b = buildOwnerBreakup(accounts, positions, labels);
  const row = (key: string) => b.classes.find((c) => c.info.key === key)!;
  const aud = (r: { valueByCurrency: { currencyCode: string; totalValue: number }[] }) => r.valueByCurrency.find((v) => v.currencyCode === 'AUD')?.totalValue;

  it('one row per owner class, in a stable order: personal members, joint, entities, shared-with-entity, unallocated', () => {
    expect(b.classes.map((c) => c.info.key)).toEqual(['member:m-asha', 'member:m-ravi', 'joint', 'entity:e-trust', 'entity_shared', 'unallocated']);
  });

  it('each class has its OWN totals (hand-computed)', () => {
    expect(aud(row('member:m-asha'))).toBe(100_000);
    expect(row('member:m-asha').valueByCurrency.find((v) => v.currencyCode === 'INR')?.totalValue).toBe(7_000_000);
    expect(row('member:m-asha').accountCount).toBe(2); // a-asha + a-empty
    expect(row('member:m-asha').positionCount).toBe(2);
    expect(aud(row('member:m-ravi'))).toBe(200_000);
    expect(aud(row('joint'))).toBe(1_000_000);
    expect(aud(row('entity:e-trust'))).toBe(500_000);
    expect(aud(row('entity_shared'))).toBe(200_000);
    expect(aud(row('unallocated'))).toBe(50_000);
  });

  it('NEGATIVE CONTROL [never silently summed]: no personal row contains the trust or the shared-with-trust account', () => {
    const personalAud = b.classes.filter((c) => c.info.kind === 'personal').reduce((s, c) => s + (aud(c) ?? 0), 0);
    expect(personalAud).toBe(300_000); // 100,000 + 200,000 only
    expect(personalAud).not.toBe(300_000 + 500_000);
    expect(personalAud).not.toBe(300_000 + 200_000);
  });

  it('joint and entity-shared classes show each owner\'s attributed part, dividing by basis points and adding back exactly', () => {
    expect(row('joint').ownerAttribution?.map((o) => [o.ownerLabel, aud(o)])).toEqual([['Asha Rao', 600_000], ['Ravi Rao', 400_000]]);
    expect(row('entity_shared').ownerAttribution?.map((o) => [o.ownerLabel, aud(o)])).toEqual([['Asha Rao', 120_000], ['Rao Family Trust', 80_000]]);
    expect(row('member:m-asha').ownerAttribution).toBeNull();
    expect(row('entity:e-trust').ownerAttribution).toBeNull();
  });

  it('the macro line is explicit, labelled, and EXACTLY the sum of the classes (each position once, never 2x)', () => {
    expect(b.consolidated.label).toBe(CONSOLIDATED_LABEL);
    expect(b.consolidated.note).toMatch(/macro summary/);
    expect(aud(b.consolidated)).toBe(100_000 + 200_000 + 1_000_000 + 500_000 + 200_000 + 50_000); // 2,050,000
    expect(b.consolidated.valueByCurrency.find((v) => v.currencyCode === 'INR')?.totalValue).toBe(7_000_000);
    expect(b.consolidated.positionCount).toBe(positions.length);
    for (const cur of ['AUD', 'INR']) {
      const sumClasses = b.classes.reduce((s, c) => s + (c.valueByCurrency.find((v) => v.currencyCode === cur)?.totalValue ?? 0), 0);
      expect(sumClasses).toBe(b.consolidated.valueByCurrency.find((v) => v.currencyCode === cur)?.totalValue);
    }
    expect(aud(b.consolidated)).not.toBe(2_050_000 + 1_000_000); // joint not double counted
  });

  it('a position whose account is unknown falls to Unallocated, never dropped', () => {
    const x = buildOwnerBreakup(accounts, [...positions, { accountId: 'a-missing', currencyCode: 'AUD', value: 1 }], labels);
    expect(x.classes.find((c) => c.info.key === 'unallocated')?.valueByCurrency[0].totalValue).toBe(50_001);
  });
});

describe('scopeClientToAccounts: the certified loaders run unchanged on one class\'s rows', () => {
  const T = (id: string, account: string, amount: number): Row => ({ id, user_id: USER, account_id: account, instrument_id: 'fund-1', transaction_type: 'purchase', transaction_date: '2024-01-01', gross_amount: amount, currency_code: 'INR', status: 'active', units: amount / 10 });
  const S = (id: string, account: string, value: number): Row => ({ id, user_id: USER, account_id: account, instrument_id: 'fund-1', as_of_date: '2024-06-30', units: value / 20, value, currency_code: 'INR', quality_status: 'ok' });
  const base = (): Record<string, Row[]> => ({
    ii_portfolio_truth_status: [
      { id: 't1', user_id: USER, account_id: 'a-asha', instrument_id: 'fund-1', history_completeness: 'complete_from_inception', status: 'certified', unit_variance_within_tolerance: true },
      { id: 't2', user_id: USER, account_id: 'a-trust', instrument_id: 'fund-1', history_completeness: 'complete_from_inception', status: 'certified', unit_variance_within_tolerance: true },
    ],
    ii_transactions: [T('x1', 'a-asha', 1000), T('x2', 'a-trust', 5000)],
    ii_holding_snapshots: [S('s1', 'a-asha', 1100), S('s2', 'a-trust', 5600)],
    ii_instruments: [{ id: 'fund-1', instrument_name: 'Fund One', base_currency: 'INR', country_of_domicile: 'IN' }],
    ii_prices_nav: [],
    ii_instrument_benchmarks: [],
    ii_benchmark_series: [],
    ii_risk_free_rates: [],
    ii_accounts: [{ id: 'a-asha', user_id: USER }, { id: 'a-trust', user_id: USER }],
    ii_ownership_allocation: [],
  });
  const flows = async (client: ReturnType<typeof makeFakeSupabase>['client'] | unknown) => {
    const res = await loadAnalyticsDataset(client as never, USER, { asOfDate: new Date('2024-07-31') });
    // contributions only (the terminal valuation flow is dated at the as-of date, the purchases on 2024-01-01)
    return res.dataset?.schemes.flatMap((s) => s.cashFlows.filter((c) => c.date.getTime() < new Date('2024-02-01').getTime()).map((c) => Math.abs(c.amount))).reduce((a, b) => a + b, 0) ?? 0;
  };

  it('the SUM of the per-class cash-flow inputs equals the consolidated input (no row lost, none duplicated); each class sees only its own', async () => {
    const { client } = makeFakeSupabase(base());
    const all = await flows(client);
    const asha = await flows(scopeClientToAccounts(client, ['a-asha']));
    const trust = await flows(scopeClientToAccounts(client, ['a-trust']));
    expect(asha).toBe(1000);
    expect(trust).toBe(5000);
    expect(all).toBe(6000);
    expect(asha + trust).toBe(all);
  });

  it('NEGATIVE CONTROL [scope is what narrows]: the unscoped client sees both accounts; an empty scope sees none', async () => {
    const { client } = makeFakeSupabase(base());
    expect(await flows(client)).toBe(6000);
    const none = await loadAnalyticsDataset(scopeClientToAccounts(client, []) as never, USER, { asOfDate: new Date('2024-07-31') });
    expect(none.empty).toBe(true);
  });

  it('tables without an account column pass through; account-scoped tables are narrowed', async () => {
    const { client } = makeFakeSupabase(base());
    const scoped = scopeClientToAccounts(client, ['a-asha']);
    const inst = await (scoped.from('ii_instruments') as { select: (c: string) => PromiseLike<{ data: unknown[] }> }).select('id');
    expect(inst.data).toHaveLength(1);
    const tx = await (scoped.from('ii_transactions') as { select: (c: string) => PromiseLike<{ data: unknown[] }> }).select('id');
    expect(tx.data).toHaveLength(1);
  });

  it('NEGATIVE CONTROL [read-only]: a scoped client refuses every write, so a per-class run can never overwrite consolidated results', () => {
    const { client } = makeFakeSupabase(base());
    const scoped = scopeClientToAccounts(client, ['a-asha']);
    for (const w of ['insert', 'update', 'upsert', 'delete']) {
      expect(() => (scoped.from('ii_transactions') as Record<string, () => unknown>)[w]()).toThrow(/read-only/);
    }
  });
});

describe('loaders (DB-shaped fake)', () => {
  const tbl = (): Record<string, Row[]> => ({
    ii_accounts: [
      { id: 'a-asha', user_id: USER, owner_member_id: 'm-asha' },
      { id: 'a-trust', user_id: USER, owner_member_id: null },
      { id: 'a-joint', user_id: USER, owner_member_id: null },
      { id: 'a-other', user_id: 'someone-else', owner_member_id: 'm-x' },
    ],
    ii_ownership_allocation: [
      { id: 'o1', user_id: USER, ii_account_id: 'a-trust', owner_member_id: null, owner_business_entity_id: 'e-trust', allocation_basis_points: 10000, ii_instrument_id: null, status: 'active' },
      { id: 'o2', user_id: USER, ii_account_id: 'a-joint', owner_member_id: 'm-asha', owner_business_entity_id: null, allocation_basis_points: 6000, ii_instrument_id: null, status: 'active' },
      { id: 'o3', user_id: USER, ii_account_id: 'a-joint', owner_member_id: 'm-ravi', owner_business_entity_id: null, allocation_basis_points: 4000, ii_instrument_id: null, status: 'active' },
    ],
    household_members: [
      { id: 'm-asha', user_id: USER, full_name: 'Asha Rao', relationship: 'self' },
      { id: 'm-ravi', user_id: USER, full_name: 'Ravi Rao', relationship: 'spouse' },
    ],
    business_entities: [{ id: 'e-trust', user_id: USER, name: 'Rao Family Trust', entity_type: 'family_trust' }],
    ii_holding_snapshots: [
      { id: 'h1', user_id: USER, account_id: 'a-asha', instrument_id: 'f1', as_of_date: '2024-06-30', value: 100, currency_code: 'INR' },
      { id: 'h0', user_id: USER, account_id: 'a-asha', instrument_id: 'f1', as_of_date: '2024-05-31', value: 90, currency_code: 'INR' },
      { id: 'h2', user_id: USER, account_id: 'a-trust', instrument_id: 'f1', as_of_date: '2024-06-30', value: 500, currency_code: 'INR' },
      { id: 'h3', user_id: USER, account_id: 'a-joint', instrument_id: 'f1', as_of_date: '2024-06-30', value: 1000, currency_code: 'INR' },
      { id: 'h4', user_id: 'someone-else', account_id: 'a-other', instrument_id: 'f1', as_of_date: '2024-06-30', value: 999999, currency_code: 'INR' },
    ],
  });

  it('classes come from this user\'s accounts only; the personal scope excludes the entity account', async () => {
    const { client } = makeFakeSupabase(tbl());
    const ctx = await loadOwnerClassContext(client as never, USER);
    expect(ctx.classes.map((c) => c.key)).toEqual(['member:m-asha', 'joint', 'entity:e-trust']);
    expect(personalScopeAccountIds(ctx).sort()).toEqual(['a-asha', 'a-joint']);
    expect(ctx.accountIdsByClass.get('entity:e-trust')).toEqual(['a-trust']);
  });

  it('loadOwnerBreakup uses the LATEST snapshot per position, never another tenant\'s, and its macro line equals the sum of classes', async () => {
    const { client } = makeFakeSupabase(tbl());
    const b = await loadOwnerBreakup(client as never, USER);
    expect(b.classes.find((c) => c.info.key === 'member:m-asha')?.valueByCurrency[0].totalValue).toBe(100);
    expect(b.classes.find((c) => c.info.key === 'joint')?.ownerAttribution?.map((o) => o.valueByCurrency[0].totalValue)).toEqual([600, 400]);
    expect(b.consolidated.valueByCurrency[0].totalValue).toBe(1600);
  });

  it('degrades when ii_ownership_allocation is unreadable: everything is personal / unallocated, nothing crashes', async () => {
    const { client } = makeFakeSupabase(tbl(), { failOn: new Set(['ii_ownership_allocation']) });
    const ctx = await loadOwnerClassContext(client as never, USER);
    expect(ctx.classes.map((c) => c.key)).toEqual(['member:m-asha', 'unallocated']);
  });
});
