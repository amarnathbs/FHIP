/**
 * FINANCIAL ORACLE -- a joint split between household members is published ONCE
 * and its value DIVIDED by the ownership split (PO decision 2026-10-01).
 *
 *   1,000,000 held 60/40  ->  600,000 / 400,000
 *   household total        ->  1,000,000   (never 2,000,000)
 *
 * The expected figures below are written out by hand, not computed by the code
 * under test. Every attribution must add back to the position's value EXACTLY.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { attributeByBasisPoints } from '@/lib/services/investment-intelligence/ownerAttribution';
import { selectInvestments } from '@/lib/read-models/investments';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { profile, tables, USER } from './readModels/helpers/fixtures';

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('attributeByBasisPoints (pure oracle)', () => {
  it('1,000,000 at 60/40 -> 600,000 / 400,000 and they add back to 1,000,000', () => {
    const r = attributeByBasisPoints(1_000_000, [{ key: 'asha', basisPoints: 6000 }, { key: 'ravi', basisPoints: 4000 }])!;
    expect(r.map((x) => x.amount)).toEqual([600_000, 400_000]);
    expect(sum(r.map((x) => x.amount))).toBe(1_000_000);
    expect(sum(r.map((x) => x.amount))).not.toBe(2_000_000);
  });

  it('50/50 of 1,000,001.01 and 70/30 of 250,000.50 (hand-computed)', () => {
    expect(attributeByBasisPoints(1_000_001.01, [{ key: 'a', basisPoints: 5000 }, { key: 'b', basisPoints: 5000 }])!.map((x) => x.amount)).toEqual([500_000.505, 500_000.505]);
    expect(attributeByBasisPoints(250_000.5, [{ key: 'a', basisPoints: 7000 }, { key: 'b', basisPoints: 3000 }])!.map((x) => x.amount)).toEqual([175_000.35, 75_000.15]);
  });

  it('three-way 33.33 / 33.33 / 33.34 of 100.00 -> 33.33 / 33.33 / 33.34 (hand-computed), exact total', () => {
    const r = attributeByBasisPoints(100, [{ key: 'a', basisPoints: 3333 }, { key: 'b', basisPoints: 3333 }, { key: 'c', basisPoints: 3334 }])!;
    expect(r.map((x) => x.amount)).toEqual([33.33, 33.33, 33.34]);
    expect(sum(r.map((x) => Math.round(x.amount * 100)))).toBe(10_000);
  });

  it('an indivisible amount never drifts: 0.0001 across two owners gives 0.0001 + 0 (largest remainder, earlier owner first)', () => {
    const r = attributeByBasisPoints(0.0001, [{ key: 'a', basisPoints: 5000 }, { key: 'b', basisPoints: 5000 }])!;
    expect(r.map((x) => x.amount)).toEqual([0.0001, 0]);
  });

  it('negative value keeps its sign and still adds back', () => {
    const r = attributeByBasisPoints(-1000, [{ key: 'a', basisPoints: 6000 }, { key: 'b', basisPoints: 4000 }])!;
    expect(r.map((x) => x.amount)).toEqual([-600, -400]);
  });

  it('NEGATIVE CONTROL [never fabricates]: a split that is not exactly 10000, has a zero / fractional share, or is empty returns null', () => {
    expect(attributeByBasisPoints(1000, [{ key: 'a', basisPoints: 6000 }, { key: 'b', basisPoints: 3999 }])).toBeNull();
    expect(attributeByBasisPoints(1000, [{ key: 'a', basisPoints: 6000 }, { key: 'b', basisPoints: 4001 }])).toBeNull();
    expect(attributeByBasisPoints(1000, [{ key: 'a', basisPoints: 10000 }, { key: 'b', basisPoints: 0 }])).toBeNull();
    expect(attributeByBasisPoints(1000, [{ key: 'a', basisPoints: 5000.5 }, { key: 'b', basisPoints: 4999.5 }])).toBeNull();
    expect(attributeByBasisPoints(1000, [])).toBeNull();
    expect(attributeByBasisPoints(Number.NaN, [{ key: 'a', basisPoints: 10000 }])).toBeNull();
  });
});

const inv = (id: string, value: number, extra: Row = {}): Row => ({
  id, user_id: USER, investment_name: id, investment_type: 'managed_fund', current_value: value, currency_code: 'AUD', owner: 'self',
  master_item_key: null, source_type: 'investment_intelligence_published', ii_canonical_account_id: null, ii_canonical_instrument_id: null, is_active: true, ...extra,
});
const alloc = (account: string, member: string | null, entity: string | null, bp: number, extra: Row = {}): Row => ({
  id: `a-${account}-${member ?? entity}-${bp}`, user_id: USER, ii_account_id: account, ii_instrument_id: null, owner_member_id: member, owner_business_entity_id: entity, allocation_basis_points: bp, status: 'active', ...extra,
});
const model = async (rowsInv: Row[], allocations: Row[]) => {
  const { client } = makeFakeSupabase(tables(profile(), { investments: rowsInv, ii_holding_snapshots: [], ii_fhip_publications: [], ii_ownership_allocation: allocations }));
  const res = await selectInvestments(USER, { client });
  if (res.status !== 'ok') throw new Error('unavailable');
  return res;
};

describe('Investments read model: a jointly-owned published position is counted ONCE and divided by the split', () => {
  const joint = inv('joint-fund', 1_000_000, { owner: 'joint', ii_canonical_account_id: 'acc-j', ii_canonical_instrument_id: 'fund-1' });

  it('ORACLE: 1,000,000 at 60/40 -> 600,000 / 400,000; household total 1,000,000; published total 1,000,000', async () => {
    const res = await model([joint], [alloc('acc-j', 'm-asha', null, 6000), alloc('acc-j', 'm-ravi', null, 4000)]);
    expect(res.lines).toHaveLength(1);
    const line = res.lines[0];
    expect(line.value.amountReporting).toBe(1_000_000);
    expect(line.ownerShares?.map((s) => [s.ownerMemberId, s.basisPoints, s.amountNative, s.amountReporting])).toEqual([
      ['m-asha', 6000, 600_000, 600_000],
      ['m-ravi', 4000, 400_000, 400_000],
    ]);
    expect(res.publishedTotal).toBe(1_000_000);
    expect(res.householdPublishedTotal).toBe(1_000_000);
    expect(sum(line.ownerShares!.map((s) => s.amountNative))).toBe(1_000_000);
    expect(res.publishedTotal).not.toBe(2_000_000);
  });

  it('the split follows the LIVE allocation: amending 60/40 to 70/30 re-divides the same single value with no republish', async () => {
    const res = await model([joint], [alloc('acc-j', 'm-asha', null, 7000), alloc('acc-j', 'm-ravi', null, 3000)]);
    expect(res.lines[0].ownerShares?.map((s) => s.amountNative)).toEqual([700_000, 300_000]);
    expect(res.publishedTotal).toBe(1_000_000);
  });

  it('NEGATIVE CONTROL [no allocation]: without a split the line has no ownerShares (the single-owner behaviour is unchanged)', async () => {
    const res = await model([joint], []);
    expect(res.lines[0].ownerShares).toBeUndefined();
    expect(res.publishedTotal).toBe(1_000_000);
  });

  it('NEGATIVE CONTROL [malformed split]: a group that does not total 10000 never divides the value', async () => {
    const res = await model([joint], [alloc('acc-j', 'm-asha', null, 6000), alloc('acc-j', 'm-ravi', null, 3000)]);
    expect(res.lines[0].ownerShares).toBeUndefined();
  });

  it('NEGATIVE CONTROL [entity shares are not household shares]: a member + entity group is not divided into household owners here', async () => {
    const res = await model([joint], [alloc('acc-j', 'm-asha', null, 6000), alloc('acc-j', null, 'e-trust', 4000)]);
    expect(res.lines[0].ownerShares).toBeUndefined();
  });

  it('NEGATIVE CONTROL [superseded / instrument-grain rows]: only the ACTIVE account-grain group divides the value', async () => {
    const res = await model(
      [joint],
      [
        alloc('acc-j', 'm-asha', null, 5000, { status: 'superseded' }),
        alloc('acc-j', 'm-ravi', null, 5000, { status: 'superseded' }),
        alloc('acc-j', 'm-asha', null, 6000),
        alloc('acc-j', 'm-ravi', null, 4000),
        alloc('acc-j', 'm-x', null, 10000, { ii_instrument_id: 'fund-1' }),
      ]
    );
    expect(res.lines[0].ownerShares?.map((s) => s.amountNative)).toEqual([600_000, 400_000]);
  });

  it('other lines are unaffected: a manual or sole-owner line has no ownerShares, and totals add exactly', async () => {
    const res = await model([joint, inv('manual', 250_000, { source_type: 'manual', owner: 'spouse' })], [alloc('acc-j', 'm-asha', null, 6000), alloc('acc-j', 'm-ravi', null, 4000)]);
    expect(res.lines.find((l) => l.id === 'manual')?.ownerShares).toBeUndefined();
    expect(res.publishedTotal).toBe(1_250_000);
  });
});

describe('publication writes ONE register row at the FULL value (structural: the write path needs a database)', () => {
  const src = readFileSync(path.join(path.resolve(__dirname, '../..'), 'lib/services/investment-intelligence/investmentPublicationService.ts'), 'utf8');
  it('current_value is the position value (never a share), the owner role comes from the effective ownership, and a members-only joint is published as "joint"', () => {
    expect(src).toContain('current_value: snapshot.value,');
    expect(src).toContain("if (ctx.ownership.kind === 'joint' && !ctx.ownership.hasEntity) return 'joint';");
    expect(src.match(/from\('investments'\)\.insert\(/g)?.length).toBe(1);
  });
});
