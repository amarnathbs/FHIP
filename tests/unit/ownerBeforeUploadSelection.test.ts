/**
 * Owner-before-upload (Phase 1): the client-safe wire format and the joint
 * percentage entry logic. Percent is what the user sees; basis points are what
 * is sent; the two must convert exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  OWNER_TOTAL_BASIS_POINTS,
  basisPointsToPercentText,
  equalShares,
  ownerSelectionSchema,
  ownerSelectionToMeta,
  ownerSelectionToQuery,
  percentToBasisPoints,
  readOwnerSelectionParam,
  type OwnerSelection,
} from '@/lib/ownership/ownerSelection';
import { evaluateJointDraft, withEqualSplit, type JointDraftRow } from '@/lib/ownership/jointDraft';
import { bankUploadParams } from '@/components/expenses/bankUploadParams';
import { PC5_TOTAL_BASIS_POINTS } from '@/lib/pc5/jointAllocation';

const M1 = 'a1111111-1111-4111-8111-111111111111';
const M2 = 'a2222222-2222-4222-8222-222222222222';
const E1 = 'e1111111-1111-4111-8111-111111111111';

describe('percent <-> basis points', () => {
  it('converts exactly, including the awkward thirds', () => {
    expect(percentToBasisPoints('50')).toBe(5000);
    expect(percentToBasisPoints('33.33')).toBe(3333);
    expect(percentToBasisPoints('33.34')).toBe(3334);
    expect(percentToBasisPoints('0.01')).toBe(1);
    expect(percentToBasisPoints('100')).toBe(10000);
    expect(basisPointsToPercentText(3334)).toBe('33.34');
    expect(basisPointsToPercentText(5000)).toBe('50');
  });
  it('refuses what it cannot represent rather than rounding it into a different share', () => {
    for (const bad of ['', 'abc', '-5', '33.345', '1e2', '5%', '1000']) expect(percentToBasisPoints(bad)).toBeNull();
  });
  it('the client total constant is the same number the server validator uses', () => {
    expect(OWNER_TOTAL_BASIS_POINTS).toBe(PC5_TOTAL_BASIS_POINTS);
  });
  it('equal shares always sum to exactly 10000, remainder to the last owner', () => {
    for (const n of [1, 2, 3, 4, 7]) expect(equalShares(n).reduce((a, b) => a + b, 0)).toBe(10000);
    expect(equalShares(3)).toEqual([3333, 3333, 3334]);
    expect(equalShares(0)).toEqual([]);
  });
});

describe('joint entry draft', () => {
  const rows = (...r: Array<[string, boolean, string]>): JointDraftRow[] => r.map(([key, checked, percentText]) => ({ key, checked, percentText }));

  it('converts percent to basis points summing to 10000', () => {
    const r = evaluateJointDraft(rows([`member:${M1}`, true, '60'], [`entity:${E1}`, true, '40']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.selection).toEqual({ kind: 'joint', allocations: [{ memberId: M1, basisPoints: 6000 }, { entityId: E1, basisPoints: 4000 }] });
      expect(r.totalBasisPoints).toBe(10000);
    }
  });
  it('NEGATIVE: not 100%, one owner, zero share, unreadable share -- each says why and yields no selection', () => {
    const notHundred = evaluateJointDraft(rows([`member:${M1}`, true, '60'], [`member:${M2}`, true, '39.99']));
    expect(notHundred.ok).toBe(false);
    expect(!notHundred.ok && notHundred.message).toMatch(/99\.99%.*exactly 100%/);
    expect(evaluateJointDraft(rows([`member:${M1}`, true, '100'], [`member:${M2}`, false, ''])).ok).toBe(false);
    const zero = evaluateJointDraft(rows([`member:${M1}`, true, '100'], [`member:${M2}`, true, '0']));
    expect(!zero.ok && zero.message).toMatch(/above 0%/);
    expect(evaluateJointDraft(rows([`member:${M1}`, true, '50'], [`member:${M2}`, true, 'half'])).ok).toBe(false);
  });
  it('an equal re-split of 3 owners is valid (3333 + 3333 + 3334)', () => {
    const split = withEqualSplit(rows([`member:${M1}`, true, ''], [`member:${M2}`, true, ''], [`entity:${E1}`, true, '']));
    expect(split.map((r) => r.percentText)).toEqual(['33.33', '33.33', '33.34']);
    expect(evaluateJointDraft(split).ok).toBe(true);
  });
});

describe('wire format', () => {
  it('every selection kind round-trips through the schema and the query / meta helpers', () => {
    const selections: OwnerSelection[] = [
      { kind: 'member', memberId: M1 },
      { kind: 'entity', entityId: E1 },
      { kind: 'smsf' },
      { kind: 'joint' },
      { kind: 'joint', allocations: [{ memberId: M1, basisPoints: 5000 }, { entityId: E1, basisPoints: 5000 }] },
    ];
    for (const s of selections) {
      const params = ownerSelectionToQuery(new URLSearchParams(), s);
      expect(ownerSelectionSchema.parse(readOwnerSelectionParam(params.get('owner')))).toEqual(s);
      expect(ownerSelectionToMeta(s)).toEqual({ owner: s });
    }
  });
  it('the selection carries no country and no names', () => {
    const json = JSON.stringify({ kind: 'member', memberId: M1 });
    expect(json).not.toMatch(/country|name/i);
    expect(ownerSelectionSchema.safeParse({ kind: 'member', memberId: M1, country: 'IN' }).success).toBe(false);
  });
  it('an absent or blank param reads back as undefined (owner_required), a garbled one as invalid', () => {
    expect(readOwnerSelectionParam(null)).toBeUndefined();
    expect(readOwnerSelectionParam('  ')).toBeUndefined();
    expect(ownerSelectionSchema.safeParse(readOwnerSelectionParam('{nope')).success).toBe(false);
  });
  it('the bank query carries the owner and the explicit confirm flag only when set', () => {
    const base = { country: 'AU' as const, currency: 'AUD' as const, owner: { kind: 'member', memberId: M1 } as OwnerSelection };
    const plain = bankUploadParams(base);
    expect(JSON.parse(plain.get('owner') as string)).toEqual({ kind: 'member', memberId: M1 });
    expect(plain.has('confirm_owner_change')).toBe(false);
    expect(plain.has('owner_role')).toBe(false);
    expect(bankUploadParams({ ...base, confirmOwnerChange: true }).get('confirm_owner_change')).toBe('1');
    expect(bankUploadParams({ country: 'AU', currency: 'AUD' }).has('owner')).toBe(false);
  });
});
