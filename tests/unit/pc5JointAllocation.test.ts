/**
 * PC5 (M4) — K.6: joint ownership allocation.
 *
 * The invariant under test is blunt: the shares of one allocation group
 * must total EXACTLY 100%, and the module must refuse rather than adjust
 * anything that does not. Most of these tests assert a refusal, because
 * every "helpful" behaviour a validator could have here — dropping a zero,
 * scaling a near-miss to fit, de-duplicating an owner — would silently
 * store an allocation the user did not submit.
 */
import { describe, it, expect } from 'vitest';
import {
  PC5_TOTAL_BASIS_POINTS,
  allocationOwnerKey,
  defaultEqualAllocation,
  formatBasisPoints,
  ownerRoleForAllocation,
  validateAllocation,
} from '@/lib/pc5/jointAllocation';
import { OWNER_VALUES } from '@/lib/constants';

describe('PC5 K.6 — defaultEqualAllocation', () => {
  it('two owners get exactly 50/50, which is K.6\'s named default', () => {
    const result = defaultEqualAllocation([{ ownerMemberId: 'm1' }, { ownerMemberId: 'm2' }]);
    expect(result.map((r) => r.basisPoints)).toEqual([5000, 5000]);
  });

  it('three owners total exactly 100% — the case percent-with-two-decimals cannot express', () => {
    const result = defaultEqualAllocation([{ ownerMemberId: 'm1' }, { ownerMemberId: 'm2' }, { ownerMemberId: 'm3' }]);
    expect(result.map((r) => r.basisPoints)).toEqual([3333, 3333, 3334]);
    expect(result.reduce((s, r) => s + r.basisPoints, 0)).toBe(PC5_TOTAL_BASIS_POINTS);
  });

  it('seven owners still total exactly 100%', () => {
    const owners = Array.from({ length: 7 }, (_, i) => ({ ownerMemberId: `m${i}` }));
    const result = defaultEqualAllocation(owners);
    expect(result.reduce((s, r) => s + r.basisPoints, 0)).toBe(PC5_TOTAL_BASIS_POINTS);
  });

  it('a single owner gets 100%', () => {
    expect(defaultEqualAllocation([{ ownerMemberId: 'm1' }])).toEqual([{ ownerMemberId: 'm1', basisPoints: 10000 }]);
  });

  it('returns [] rather than throwing for an empty owner list', () => {
    expect(defaultEqualAllocation([])).toEqual([]);
  });

  it('the remainder goes to the LAST owner, deterministically', () => {
    const result = defaultEqualAllocation([{ ownerMemberId: 'a' }, { ownerMemberId: 'b' }, { ownerMemberId: 'c' }]);
    expect(result[result.length - 1].basisPoints).toBe(3334);
  });

  it('preserves business-entity owners as well as members', () => {
    const result = defaultEqualAllocation([{ ownerMemberId: 'm1' }, { ownerBusinessEntityId: 'e1' }]);
    expect(result).toEqual([
      { ownerMemberId: 'm1', basisPoints: 5000 },
      { ownerBusinessEntityId: 'e1', basisPoints: 5000 },
    ]);
  });
});

describe('PC5 K.6 — validateAllocation accepts only an exact 100%', () => {
  it('accepts a valid two-way split', () => {
    const result = validateAllocation([
      { ownerMemberId: 'm1', basisPoints: 7000 },
      { ownerMemberId: 'm2', basisPoints: 3000 },
    ]);
    expect(result.ok).toBe(true);
  });

  it('REFUSES 99.99% rather than scaling it to fit — the stored split must be the submitted one', () => {
    const result = validateAllocation([
      { ownerMemberId: 'm1', basisPoints: 3333 },
      { ownerMemberId: 'm2', basisPoints: 3333 },
      { ownerMemberId: 'm3', basisPoints: 3333 },
    ]);
    expect(result).toEqual({ ok: false, reason: 'total_not_100_percent', total: 9999 });
  });

  it('REFUSES 100.01%', () => {
    const result = validateAllocation([
      { ownerMemberId: 'm1', basisPoints: 5001 },
      { ownerMemberId: 'm2', basisPoints: 5000 },
    ]);
    expect(result).toMatchObject({ ok: false, reason: 'total_not_100_percent', total: 10001 });
  });

  it('REFUSES a zero share rather than dropping it — "owns 0%" and "is not an owner" are different assertions', () => {
    const result = validateAllocation([
      { ownerMemberId: 'm1', basisPoints: 10000 },
      { ownerMemberId: 'm2', basisPoints: 0 },
    ]);
    expect(result).toMatchObject({ ok: false, reason: 'out_of_range_basis_points', index: 1 });
  });

  it('REFUSES a negative share', () => {
    expect(
      validateAllocation([
        { ownerMemberId: 'm1', basisPoints: 12000 },
        { ownerMemberId: 'm2', basisPoints: -2000 },
      ]),
    ).toMatchObject({ ok: false, reason: 'out_of_range_basis_points' });
  });

  it('REFUSES a fractional basis point — the unit is an integer by construction', () => {
    expect(
      validateAllocation([
        { ownerMemberId: 'm1', basisPoints: 5000.5 },
        { ownerMemberId: 'm2', basisPoints: 4999.5 },
      ]),
    ).toMatchObject({ ok: false, reason: 'non_integer_basis_points', index: 0 });
  });

  it('REFUSES the same owner twice, matching the database\'s own unique index on (group, owner)', () => {
    expect(
      validateAllocation([
        { ownerMemberId: 'm1', basisPoints: 5000 },
        { ownerMemberId: 'm1', basisPoints: 5000 },
      ]),
    ).toMatchObject({ ok: false, reason: 'duplicate_owner', ownerKey: 'm1' });
  });

  it('REFUSES an entry with BOTH owner identities set, and one with NEITHER', () => {
    expect(validateAllocation([{ ownerMemberId: 'm1', ownerBusinessEntityId: 'e1', basisPoints: 10000 }])).toMatchObject({
      ok: false,
      reason: 'owner_identity_missing_or_ambiguous',
    });
    expect(validateAllocation([{ basisPoints: 10000 }])).toMatchObject({ ok: false, reason: 'owner_identity_missing_or_ambiguous' });
  });

  it('REFUSES an empty allocation', () => {
    expect(validateAllocation([])).toEqual({ ok: false, reason: 'no_owners' });
  });

  it('returns COPIES, so a caller cannot mutate the validated set afterwards', () => {
    const input = [
      { ownerMemberId: 'm1', basisPoints: 5000 },
      { ownerMemberId: 'm2', basisPoints: 5000 },
    ];
    const result = validateAllocation(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.entries[0].basisPoints = 1;
      expect(input[0].basisPoints).toBe(5000);
    }
  });

  it('every default equal split, for 1..12 owners, validates', () => {
    for (let n = 1; n <= 12; n += 1) {
      const owners = Array.from({ length: n }, (_, i) => ({ ownerMemberId: `m${i}` }));
      expect(validateAllocation(defaultEqualAllocation(owners)).ok, `n=${n}`).toBe(true);
    }
  });
});

describe('PC5 K.6 — allocationOwnerKey mirrors the database unique index expression', () => {
  it('uses the member id, then the entity id', () => {
    expect(allocationOwnerKey({ ownerMemberId: 'm1', basisPoints: 1 })).toBe('m1');
    expect(allocationOwnerKey({ ownerBusinessEntityId: 'e1', basisPoints: 1 })).toBe('e1');
  });
  it('returns null when both are set, so an ambiguous row can never produce a key', () => {
    expect(allocationOwnerKey({ ownerMemberId: 'm1', ownerBusinessEntityId: 'e1', basisPoints: 1 })).toBeNull();
  });
});

describe('PC5 K.5/K.6 — ownerRoleForAllocation introduces no new ownership vocabulary', () => {
  it('a genuine split is the EXISTING "joint" role', () => {
    expect(ownerRoleForAllocation([{ ownerMemberId: 'a', basisPoints: 5000 }, { ownerMemberId: 'b', basisPoints: 5000 }], 'self')).toBe('joint');
  });

  it('a sole 100% holding keeps that person\'s own role — calling it "joint" would be wrong in the register', () => {
    expect(ownerRoleForAllocation([{ ownerMemberId: 'a', basisPoints: 10000 }], 'spouse')).toBe('spouse');
  });

  it('every role it can return is one of the canonical eight', () => {
    const produced = [
      ownerRoleForAllocation([{ ownerMemberId: 'a', basisPoints: 5000 }, { ownerMemberId: 'b', basisPoints: 5000 }], 'self'),
      ...OWNER_VALUES.map((role) => ownerRoleForAllocation([{ ownerMemberId: 'a', basisPoints: 10000 }], role)),
    ];
    for (const role of produced) expect(OWNER_VALUES).toContain(role);
  });
});

describe('PC5 — formatBasisPoints is presentation only', () => {
  it.each([
    [10000, '100.00%'],
    [5000, '50.00%'],
    [3333, '33.33%'],
    [3334, '33.34%'],
    [1, '0.01%'],
  ])('%i -> %s', (bp, expected) => {
    expect(formatBasisPoints(bp)).toBe(expected);
  });
});
