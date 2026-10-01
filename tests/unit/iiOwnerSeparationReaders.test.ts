/**
 * Investment Intelligence -- the READERS of account ownership after entity /
 * joint owners were introduced (2026-10-01).
 *
 * `ii_accounts.owner_member_id` keeps meaning "the sole household-member owner"
 * and is NULL for an entity-owned or jointly-owned account; the owner decision
 * lives in the active `ii_ownership_allocation` group. So every reader that used
 * to read "no owner_member_id" as "unresolved owner" had to learn the
 * difference, and the PO's entity-separation ruling (2026-09-21) -- a Trust /
 * HUF / Company's holdings must not flow into the PERSONAL totals -- had to be
 * enforced on the paths that feed personal Net Worth.
 *
 * This file proves, with negative controls:
 *   - the Investments read model never offers an entity-owned account's
 *     holdings to personal Net Worth (the "Imported, not yet in Net Worth"
 *     bucket) and never adds them to a total;
 *   - the effective-ownership loaders see an entity / joint owner as DECIDED;
 *   - the AU import-bridge readers do not misread null as "no owner", and do
 *     not overwrite an entity decision with a sole member.
 *
 * The publication-eligibility half (OWNER_IS_BUSINESS_ENTITY) is in
 * iiOwnerModel.test.ts; the upload-pipeline guards in documentProcessing.ts are
 * covered structurally at the bottom (the pipeline needs a real PDF to run).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { selectInvestments } from '@/lib/read-models/investments';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { profile, tables, USER } from './readModels/helpers/fixtures';
import { createInMemoryDb } from './support/inMemorySupabase';

const mockAdminFrom = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));

import { loadAccountOwnership, loadDecidedOwnershipAccountIds, loadEntityOwnedAccountIds } from '@/lib/services/investment-intelligence/accountOwnership';
import { confirmExistingAuStatementAccount, describeAuAccounts } from '@/lib/investment-import-bridge/auAccountResolution';

const snap = (id: string, acc: string, inst: string, date: string, value: number, extra: Row = {}): Row => ({
  id, user_id: USER, account_id: acc, instrument_id: inst, as_of_date: date, units: 10, value, currency_code: 'AUD', created_at: `${date}T00:00:00Z`, ...extra,
});
const inv = (id: string, value: number): Row => ({
  id, user_id: USER, investment_name: id, investment_type: 'shares', current_value: value, currency_code: 'AUD', owner: 'self',
  master_item_key: null, source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, is_active: true,
});
const alloc = (account: string, extra: Row = {}): Row => ({
  id: `a-${account}-${Math.random().toString(36).slice(2, 7)}`, user_id: USER, ii_account_id: account, ii_instrument_id: null, owner_member_id: null, owner_business_entity_id: 'trust-1',
  allocation_basis_points: 10000, status: 'active', ...extra,
});

const baseTables = (allocations: Row[]) =>
  tables(profile(), {
    investments: [inv('manual', 5000)],
    ii_holding_snapshots: [
      snap('s-personal', 'acc-personal', 'fund-a', '2026-08-31', 1000),
      snap('s-entity', 'acc-entity', 'fund-b', '2026-08-31', 7000),
    ],
    ii_fhip_publications: [],
    ii_ownership_allocation: allocations,
  });

describe('Investments read model: entity separation (PO ruling 2026-09-21)', () => {
  it('an entity-owned account\'s holdings are NOT offered to personal Net Worth; a personal account\'s still are; no total includes them', async () => {
    const { client } = makeFakeSupabase(baseTables([alloc('acc-entity')]));
    const res = await selectInvestments(USER, { client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.unpublished.holdings.map((h) => h.accountId)).toEqual(['acc-personal']);
    expect(res.unpublished).toMatchObject({ count: 1, total: 1000 });
    expect(res.entityHeldExcludedCount).toBe(1);
    expect(res.publishedTotal).toBe(5000); // manual row only: nothing from the entity account
    expect(res.householdPublishedTotal).toBe(5000);
  });

  it('NEGATIVE CONTROL [the exclusion is what does it]: with NO entity allocation the very same snapshot IS offered (count 2, total 8000)', async () => {
    const { client } = makeFakeSupabase(baseTables([]));
    const res = await selectInvestments(USER, { client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.unpublished).toMatchObject({ count: 2, total: 8000 });
    expect(res.entityHeldExcludedCount).toBe(0);
  });

  it('a joint split that includes an entity share is excluded too; a members-only joint split and a SUPERSEDED entity row are not', async () => {
    const { client } = makeFakeSupabase(
      baseTables([
        alloc('acc-entity', { owner_business_entity_id: 'trust-1', allocation_basis_points: 4000 }),
        alloc('acc-entity', { owner_business_entity_id: null, owner_member_id: 'm1', allocation_basis_points: 6000 }),
        alloc('acc-personal', { owner_business_entity_id: 'trust-1', status: 'superseded' }),
      ])
    );
    const res = await selectInvestments(USER, { client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.unpublished.holdings.map((h) => h.accountId)).toEqual(['acc-personal']);
    expect(res.entityHeldExcludedCount).toBe(1);
  });

  it('an unreadable ii_ownership_allocation (table not applied in this environment) degrades to "no entity-owned accounts" instead of taking Net Worth offline', async () => {
    const { client } = makeFakeSupabase(baseTables([alloc('acc-entity')]), { failOn: new Set(['ii_ownership_allocation']) });
    const res = await selectInvestments(USER, { client });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.publishedTotal).toBe(5000);
  });

  it('every OTHER read is still fail-closed (a snapshots error stays "unavailable")', async () => {
    const { client } = makeFakeSupabase(baseTables([]), { failOn: new Set(['ii_holding_snapshots']) });
    expect((await selectInvestments(USER, { client })).status).toBe('unavailable');
  });
});

describe('effective-ownership loaders', () => {
  const U = 'user-a';
  function setup(allocations: Row[], pointer: string | null = null) {
    const db = createInMemoryDb();
    db.reset({
      ii_accounts: [{ id: 'acc-1', user_id: U, owner_member_id: pointer }, { id: 'acc-2', user_id: U, owner_member_id: null }, { id: 'acc-x', user_id: 'user-b', owner_member_id: null }],
      ii_ownership_allocation: allocations,
    });
    mockAdminFrom.mockImplementation((t: string) => db.client.from(t));
    return db;
  }

  it('NEGATIVE CONTROL [null is not "unresolved"]: an entity-owned account has a null pointer but is DECIDED; an untouched null account is unassigned', async () => {
    const db = setup([alloc('acc-1', { user_id: U })]);
    const decided = await loadAccountOwnership(db.client as never, U, 'acc-1');
    expect(decided?.pointerMemberId).toBeNull();
    expect(decided?.ownership.kind).toBe('entity');
    expect(decided?.hasActiveAllocationGroup).toBe(true);
    const open = await loadAccountOwnership(db.client as never, U, 'acc-2');
    expect(open?.ownership.kind).toBe('unassigned');
    expect([...(await loadDecidedOwnershipAccountIds(db.client as never, U, ['acc-1', 'acc-2']))]).toEqual(['acc-1']);
  });

  it('NEGATIVE CONTROL [tenant scope]: another user\'s account is not loadable, and their allocations are not seen', async () => {
    const db = setup([alloc('acc-x', { user_id: 'user-b' })]);
    expect(await loadAccountOwnership(db.client as never, U, 'acc-x')).toBeNull();
    expect((await loadDecidedOwnershipAccountIds(db.client as never, U, ['acc-x'])).size).toBe(0);
    expect((await loadEntityOwnedAccountIds(db.client as never, U)).size).toBe(0);
  });

  it('loadEntityOwnedAccountIds counts active entity shares only', async () => {
    const db = setup([alloc('acc-1', { user_id: U }), alloc('acc-2', { user_id: U, owner_business_entity_id: null, owner_member_id: 'm1' }), alloc('acc-2', { user_id: U, status: 'superseded' })]);
    expect([...(await loadEntityOwnedAccountIds(db.client as never, U))]).toEqual(['acc-1']);
  });
});

describe('AU import-bridge readers (they used to test !owner_member_id)', () => {
  const U = 'user-a';
  function setup(allocations: Row[]) {
    const db = createInMemoryDb();
    db.reset({
      ii_accounts: [
        { id: 'au-entity', user_id: U, country_code: 'AU', status: 'active', owner_member_id: null, institution_name: 'Broker', account_number_masked: '***1' },
        { id: 'au-open', user_id: U, country_code: 'AU', status: 'active', owner_member_id: null, institution_name: 'Broker', account_number_masked: '***2' },
      ],
      ii_ownership_allocation: allocations,
      fdh_investment_statements: [{ id: 'st-1', user_id: U, canonical_account_id: null }],
    });
    mockAdminFrom.mockImplementation((t: string) => db.client.from(t));
    return db;
  }

  it('describeAuAccounts: an entity-owned account reports ownerRecorded=true; NEGATIVE CONTROL: an untouched account stays false', async () => {
    setup([alloc('au-entity', { user_id: U })]);
    const described = await describeAuAccounts(U, ['au-entity', 'au-open']);
    expect(described.find((a) => a.accountId === 'au-entity')?.ownerRecorded).toBe(true);
    expect(described.find((a) => a.accountId === 'au-open')?.ownerRecorded).toBe(false);
  });

  it('confirmExistingAuStatementAccount never "fills in" a sole member over an entity decision; NEGATIVE CONTROL: it still can on an undecided account', async () => {
    const db = setup([alloc('au-entity', { user_id: U })]);
    const r = await confirmExistingAuStatementAccount(U, 'st-1', 'au-entity', { memberId: 'm-1' });
    expect(r.error).toBeNull();
    expect(db.writes.filter((w) => w.table === 'ii_accounts')).toEqual([]);

    const db2 = setup([]);
    db2.tables.household_members = [{ id: 'm-1', user_id: U, full_name: 'X', relationship: 'self', is_active: true }];
    const r2 = await confirmExistingAuStatementAccount(U, 'st-1', 'au-open', { memberId: 'm-1' });
    expect(r2.error).toBeNull();
    expect(db2.writes.filter((w) => w.table === 'ii_accounts' && JSON.stringify(w.payload).includes('owner_member_id'))).not.toEqual([]);
  });
});

describe('documentProcessing / certification readers (structural: the pipeline needs a real statement to run)', () => {
  const read = (rel: string) => readFileSync(path.join(path.resolve(__dirname, '../..'), rel), 'utf8');

  it('the upload pipeline skips owner exceptions on an account whose owner is already decided as entity / joint, and does not count it as an unresolved owner', () => {
    const src = read('lib/services/investment-intelligence/documentProcessing.ts');
    expect(src).toContain('loadDecidedOwnershipAccountIds');
    // owner_unmatched / joint (no declared owner) loop, and the declared-owner loop
    expect(src.match(/if \(decidedOwnershipAccountIds\.has\(accountId\)\) continue;/g)?.length).toBe(2);
    expect(src).toContain('ownerUnresolved && !decidedOwnershipAccountIds.has(accountId)');
  });

  it('recertifyPosition and the AU certification read the EFFECTIVE ownership, not just the pointer', () => {
    expect(read('lib/services/investment-intelligence/documentProcessing.ts')).toContain("effectiveOwnership.ownership.kind === 'unassigned'");
    expect(read('lib/investment-import-bridge/certifyAuPosition.ts')).toContain("effectiveOwnership.ownership.kind === 'unassigned'");
  });

  it('publication reads the effective ownership and passes it to eligibility', () => {
    const src = read('lib/services/investment-intelligence/investmentPublicationService.ts');
    expect(src).toContain('loadAccountOwnership(supabase, userId, account.id)');
    expect(src.match(/ownership: eligibilityOwnership\(ctx\.ownership\)/g)?.length).toBe(3);
  });
});
