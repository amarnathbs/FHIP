/**
 * Investment Intelligence -- account ownership model (2026-10-01): the pure
 * rules behind "change an account's owner to a household member, a Trust / HUF
 * / Company, or a joint split with percentages".
 *
 * Every NEGATIVE CONTROL below names the rule it guards. The report
 * (docs/ownership/OWNER_ENTITY_JOINT_EDIT_REPORT.md, "Negative controls")
 * records, for each rule, the deliberate source mutation that made THIS
 * assertion fail -- a green control is not evidence until it has been seen red.
 */
import { describe, it, expect } from 'vitest';
import {
  buildOwnerOptions,
  caseTypesResolvedBy,
  deriveAccountOwnership,
  describeOwnership,
  ownerChangeRequestSchema,
  ownershipAuditShape,
  ownershipBlocksPersonalPublication,
  ownershipKey,
  resolutionMethodFor,
  sameOwnership,
  validateOwnerSelection,
  type OwnerChoiceContext,
} from '@/lib/services/investment-intelligence/ownerModel';
import { evaluateEligibility } from '@/lib/services/investment-intelligence/publicationLogic';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SELF = id(1);
const SPOUSE = id(2);
const INACTIVE = id(3);
const TRUST = id(11);
const HUF = id(12);
const COMPANY = id(13);
const FOREIGN_MEMBER = id(91); // belongs to ANOTHER tenant: absent from this user's loaded rows
const FOREIGN_ENTITY = id(92);

function ctx(overrides: Partial<OwnerChoiceContext> = {}): OwnerChoiceContext {
  return {
    members: [
      { id: SELF, full_name: 'Asha Rao', relationship: 'self', is_active: true },
      { id: SPOUSE, full_name: 'Ravi Rao', relationship: 'spouse', is_active: true },
      { id: INACTIVE, full_name: 'Old Member', relationship: 'child', is_active: false },
    ],
    entities: [
      { id: TRUST, name: 'Rao Family Trust', entity_type: 'family_trust', is_active: true },
      { id: HUF, name: 'Rao HUF', entity_type: 'huf', is_active: true },
      { id: COMPANY, name: 'Rao Pty Ltd', entity_type: 'company', is_active: true },
    ],
    homeCountry: 'IN',
    ...overrides,
  };
}

const failure = (r: ReturnType<typeof validateOwnerSelection>) => (r.ok ? null : r);

describe('validateOwnerSelection -- single owners', () => {
  it('accepts an active household member of this user', () => {
    const r = validateOwnerSelection({ kind: 'member', member_id: SPOUSE }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.owner.pointerMemberId).toBe(SPOUSE);
      expect(r.owner.ownerRole).toBe('spouse');
      expect(r.owner.shares).toEqual([{ memberId: SPOUSE, basisPoints: 10000 }]);
    }
  });

  it('NEGATIVE CONTROL [cross-tenant member]: a member id that is not in THIS user\'s rows is "not found", with no existence leak', () => {
    const f = failure(validateOwnerSelection({ kind: 'member', member_id: FOREIGN_MEMBER }, ctx()));
    expect(f?.code).toBe('OWNER_MEMBER_NOT_FOUND');
    expect(f?.status).toBe(404);
  });

  it('NEGATIVE CONTROL [inactive member]: an inactive member is refused, not silently resurrected', () => {
    const f = failure(validateOwnerSelection({ kind: 'member', member_id: INACTIVE }, ctx()));
    expect(f?.code).toBe('OWNER_MEMBER_INACTIVE');
    expect(f?.status).toBe(422);
  });

  it('NEGATIVE CONTROL [cross-tenant entity]: an entity id that is not in this user\'s rows is "not found"', () => {
    const f = failure(validateOwnerSelection({ kind: 'entity', business_entity_id: FOREIGN_ENTITY }, ctx()));
    expect(f?.code).toBe('OWNER_ENTITY_NOT_FOUND');
  });

  it('NEGATIVE CONTROL [company only if the user has one]: assigning to a company when the user has none is refused', () => {
    const f = failure(validateOwnerSelection({ kind: 'entity', business_entity_id: COMPANY }, ctx({ entities: [] })));
    expect(f?.code).toBe('OWNER_ENTITY_NOT_FOUND');
  });

  it('accepts a Family Trust and a Company for any confirmed country', () => {
    for (const country of ['AU', 'IN', null]) {
      const t = validateOwnerSelection({ kind: 'entity', business_entity_id: TRUST }, ctx({ homeCountry: country }));
      const c = validateOwnerSelection({ kind: 'entity', business_entity_id: COMPANY }, ctx({ homeCountry: country }));
      expect(t.ok).toBe(true);
      expect(c.ok).toBe(true);
    }
  });

  it('NEGATIVE CONTROL [HUF is India-only]: an HUF owner is refused for an AU user, a generic-country user and an unresolved country', () => {
    for (const country of ['AU', null, 'GB']) {
      const f = failure(validateOwnerSelection({ kind: 'entity', business_entity_id: HUF }, ctx({ homeCountry: country })));
      expect(f?.code, `country ${String(country)}`).toBe('OWNER_ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY');
      expect(f?.status).toBe(403);
    }
  });

  it('an HUF owner is accepted for an India-confirmed user, with the coarse role "other" (never a ninth owner value)', () => {
    const r = validateOwnerSelection({ kind: 'entity', business_entity_id: HUF }, ctx({ homeCountry: 'IN' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.owner.ownerRole).toBe('other');
      expect(r.owner.pointerMemberId).toBeNull();
      expect(r.owner.hasEntity).toBe(true);
    }
  });

  it('the HUF gate also applies INSIDE a joint split', () => {
    const f = failure(
      validateOwnerSelection(
        { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 5000 }, { business_entity_id: HUF, basis_points: 5000 }] },
        ctx({ homeCountry: 'AU' })
      )
    );
    expect(f?.code).toBe('OWNER_ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY');
  });
});

describe('validateOwnerSelection -- joint splits', () => {
  const joint = (allocations: { member_id?: string; business_entity_id?: string; basis_points: number }[]) => validateOwnerSelection({ kind: 'joint', allocations }, ctx());

  it('accepts two members 60/40, and a member + entity 50/50', () => {
    const a = joint([{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: 4000 }]);
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.owner.ownerRole).toBe('joint');
      expect(a.owner.pointerMemberId).toBeNull();
      expect(a.owner.hasEntity).toBe(false);
    }
    const b = joint([{ member_id: SELF, basis_points: 5000 }, { business_entity_id: TRUST, basis_points: 5000 }]);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.owner.hasEntity).toBe(true);
  });

  it('accepts a three-way 33.33 / 33.33 / 33.34 split (basis points make the total exact)', () => {
    const r = joint([{ member_id: SELF, basis_points: 3333 }, { member_id: SPOUSE, basis_points: 3333 }, { business_entity_id: TRUST, basis_points: 3334 }]);
    expect(r.ok).toBe(true);
  });

  it('NEGATIVE CONTROL [total must be exactly 10000]: 9999 and 10001 are refused, never scaled', () => {
    for (const second of [3999, 4001]) {
      const f = failure(joint([{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: second }]));
      expect(f?.code, `total ${6000 + second}`).toBe('JOINT_ALLOCATION_INVALID');
      expect(f?.reason).toBe('total_not_100_percent');
    }
  });

  it('NEGATIVE CONTROL [no duplicate owner]: the same member twice is refused', () => {
    const f = failure(joint([{ member_id: SELF, basis_points: 5000 }, { member_id: SELF, basis_points: 5000 }]));
    expect(f?.code).toBe('JOINT_ALLOCATION_INVALID');
    expect(f?.reason).toBe('duplicate_owner');
  });

  it('NEGATIVE CONTROL [no zero share]: a 0% owner is refused rather than dropped', () => {
    const f = failure(joint([{ member_id: SELF, basis_points: 10000 }, { member_id: SPOUSE, basis_points: 0 }]));
    expect(f?.code).toBe('JOINT_ALLOCATION_INVALID');
    expect(f?.reason).toBe('out_of_range_basis_points');
  });

  it('NEGATIVE CONTROL [fractional basis points]: a share with more than two decimal places in percent is refused', () => {
    const f = failure(joint([{ member_id: SELF, basis_points: 5000.5 }, { member_id: SPOUSE, basis_points: 4999.5 }]));
    expect(f?.reason).toBe('non_integer_basis_points');
  });

  it('NEGATIVE CONTROL [a joint split needs two owners]: a single line is refused as "joint"', () => {
    const f = failure(joint([{ member_id: SELF, basis_points: 10000 }]));
    expect(f?.code).toBe('JOINT_REQUIRES_TWO_OWNERS');
  });

  it('NEGATIVE CONTROL [one identity per line]: a line naming both a member and an entity, or neither, is refused', () => {
    expect(failure(joint([{ member_id: SELF, business_entity_id: TRUST, basis_points: 5000 }, { member_id: SPOUSE, basis_points: 5000 }]))?.reason).toBe('owner_identity_missing_or_ambiguous');
    expect(failure(joint([{ basis_points: 5000 }, { member_id: SPOUSE, basis_points: 5000 }]))?.reason).toBe('owner_identity_missing_or_ambiguous');
  });

  it('NEGATIVE CONTROL [cross-tenant inside a joint]: one foreign id fails the WHOLE split as not-found, before the maths', () => {
    const f = failure(joint([{ member_id: SELF, basis_points: 5000 }, { member_id: FOREIGN_MEMBER, basis_points: 5000 }]));
    expect(f?.code).toBe('OWNER_MEMBER_NOT_FOUND');
  });

  it('NEGATIVE CONTROL [inactive inside a joint]: an inactive member fails the whole split', () => {
    const f = failure(joint([{ member_id: SELF, basis_points: 5000 }, { member_id: INACTIVE, basis_points: 5000 }]));
    expect(f?.code).toBe('OWNER_MEMBER_INACTIVE');
  });
});

describe('request schema', () => {
  it('maps the legacy { ownerMemberId } body to kind "member" and still carries confirm', () => {
    const r = ownerChangeRequestSchema.safeParse({ ownerMemberId: SELF, confirm: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.owner).toEqual({ kind: 'member', member_id: SELF });
      expect(r.data.confirm).toBe(true);
    }
  });
  it('rejects a non-uuid owner id and an unknown kind', () => {
    expect(ownerChangeRequestSchema.safeParse({ owner: { kind: 'member', member_id: 'not-a-uuid' } }).success).toBe(false);
    expect(ownerChangeRequestSchema.safeParse({ owner: { kind: 'smsf', member_id: SELF } }).success).toBe(false);
  });
});

describe('effective ownership + idempotency key', () => {
  const row = (m: string | null, e: string | null, bp: number, extra: Record<string, unknown> = {}) => ({ owner_member_id: m, owner_business_entity_id: e, allocation_basis_points: bp, ii_instrument_id: null, status: 'active', ...extra });

  it('with no allocation, the sole-member pointer decides; with neither, the account is unassigned', () => {
    expect(deriveAccountOwnership(SELF, []).kind).toBe('member');
    expect(deriveAccountOwnership(null, []).kind).toBe('unassigned');
  });

  it('an active allocation is authoritative over the pointer: one entity row = entity, two rows = joint', () => {
    expect(deriveAccountOwnership(null, [row(null, TRUST, 10000)]).kind).toBe('entity');
    expect(deriveAccountOwnership(SELF, [row(null, TRUST, 10000)]).kind).toBe('entity'); // pointer stale -> allocation wins
    const j = deriveAccountOwnership(null, [row(SELF, null, 6000), row(null, TRUST, 4000)]);
    expect(j.kind).toBe('joint');
    expect(j.kind !== 'unassigned' && j.hasEntity).toBe(true);
  });

  it('ignores superseded rows and instrument-grain rows', () => {
    expect(deriveAccountOwnership(SELF, [row(null, TRUST, 10000, { status: 'superseded' })]).kind).toBe('member');
    expect(deriveAccountOwnership(null, [row(null, TRUST, 10000, { ii_instrument_id: 'inst-1' })]).kind).toBe('unassigned');
  });

  it('ownershipKey is order-independent and distinguishes different shares (drives replay idempotency)', () => {
    const a = deriveAccountOwnership(null, [row(SELF, null, 6000), row(SPOUSE, null, 4000)]);
    const b = deriveAccountOwnership(null, [row(SPOUSE, null, 4000), row(SELF, null, 6000)]);
    const c = deriveAccountOwnership(null, [row(SELF, null, 5000), row(SPOUSE, null, 5000)]);
    expect(ownershipKey(a)).toBe(ownershipKey(b));
    expect(sameOwnership(a, b)).toBe(true);
    expect(sameOwnership(a, c)).toBe(false);
  });

  it('audit shape carries ids and basis points ONLY -- no names, no folio, no PAN', () => {
    const o = deriveAccountOwnership(null, [row(SELF, null, 6000), row(null, TRUST, 4000)]);
    const json = JSON.stringify(ownershipAuditShape(o));
    expect(json).toContain(SELF);
    expect(json).toContain('6000');
    expect(json).not.toMatch(/Asha|Rao|Trust/);
    expect(Object.keys(ownershipAuditShape(o).shares[0]).sort()).toEqual(['basisPoints', 'memberId']);
  });

  it('describeOwnership resolves readable labels from the user\'s own rows', () => {
    const v = describeOwnership(deriveAccountOwnership(null, [row(SELF, null, 6000), row(null, TRUST, 4000)]), ctx());
    expect(v.owners.map((o) => `${o.label}:${o.basisPoints}`)).toEqual(['Asha Rao:6000', 'Rao Family Trust:4000']);
  });
});

describe('case rules', () => {
  it('a joint holding is resolved ONLY by a joint split; owner_unmatched / owner_mismatch by any owner', () => {
    expect(caseTypesResolvedBy('joint')).toContain('joint_holding_allocation_required');
    expect(caseTypesResolvedBy('member')).not.toContain('joint_holding_allocation_required');
    expect(caseTypesResolvedBy('entity')).not.toContain('joint_holding_allocation_required');
    expect(caseTypesResolvedBy('entity')).toEqual(expect.arrayContaining(['owner_unmatched', 'owner_mismatch']));
  });
  it('resolution methods: member keeps the pre-existing value', () => {
    expect(resolutionMethodFor('member', false)).toBe('user_mapped_owner');
    expect(resolutionMethodFor('entity', false)).toBe('user_mapped_entity_owner');
    expect(resolutionMethodFor('joint', false)).toBe('user_assigned_joint_allocation');
    expect(resolutionMethodFor('joint', true)).toBe('user_amended_owner');
  });
});

describe('owner options offered to the user', () => {
  it('self first, then members, then entities; HUF is NOT offered to a non-India user; inactive are not offered', () => {
    const au = buildOwnerOptions(ctx({ homeCountry: 'AU' }));
    expect(au.options.map((o) => o.label)).toEqual(['Asha Rao', 'Ravi Rao', 'Rao Family Trust', 'Rao Pty Ltd']);
    const india = buildOwnerOptions(ctx({ homeCountry: 'IN' }));
    expect(india.options.map((o) => o.label)).toContain('Rao HUF');
    expect(india.jointAvailable).toBe(true);
  });
  it('joint is not available with fewer than two possible owners', () => {
    expect(buildOwnerOptions(ctx({ members: [{ id: SELF, full_name: 'A', relationship: 'self', is_active: true }], entities: [] })).jointAvailable).toBe(false);
  });
});

describe('entity separation in publication eligibility (PO ruling 2026-09-21)', () => {
  const base = { instrumentClass: 'mutual_fund' as const, accountType: 'mf_folio' as const, portfolioTruthStatus: 'certified', hasBlockingReconciliation: false, currentValue: 1000, countryCode: 'IN', currencyCode: 'INR' };
  const codes = (r: ReturnType<typeof evaluateEligibility>) => r.blockingReasons.map((b) => b.code);

  it('NEGATIVE CONTROL [entity-owned never publishes]: an entity-owned account is NOT_ELIGIBLE with OWNER_IS_BUSINESS_ENTITY, even though it is otherwise perfect', () => {
    const r = evaluateEligibility({ ...base, ownerMemberId: null, ownership: { kind: 'entity', hasEntity: true } });
    expect(r.status).toBe('NOT_ELIGIBLE');
    expect(codes(r)).toContain('OWNER_IS_BUSINESS_ENTITY');
    expect(codes(r)).not.toContain('OWNER_UNRESOLVED');
  });
  it('a joint split that includes an entity share is also blocked', () => {
    expect(codes(evaluateEligibility({ ...base, ownerMemberId: null, ownership: { kind: 'joint', hasEntity: true } }))).toContain('OWNER_IS_BUSINESS_ENTITY');
  });
  it('a joint split between household members only is publishable (owner counts as resolved)', () => {
    const r = evaluateEligibility({ ...base, ownerMemberId: null, ownership: { kind: 'joint', hasEntity: false } });
    expect(r.status).toBe('ELIGIBLE');
  });
  it('legacy callers (no ownership field) behave exactly as before: no member = OWNER_UNRESOLVED, member = eligible', () => {
    expect(codes(evaluateEligibility({ ...base, ownerMemberId: null }))).toContain('OWNER_UNRESOLVED');
    expect(evaluateEligibility({ ...base, ownerMemberId: SELF }).status).toBe('ELIGIBLE');
  });
  it('an unassigned account stays OWNER_UNRESOLVED', () => {
    expect(codes(evaluateEligibility({ ...base, ownerMemberId: null, ownership: { kind: 'unassigned', hasEntity: false } }))).toContain('OWNER_UNRESOLVED');
  });
  it('ownershipBlocksPersonalPublication is true for entity and any joint with an entity share, false otherwise', () => {
    expect(ownershipBlocksPersonalPublication({ kind: 'entity', shares: [{ businessEntityId: TRUST, basisPoints: 10000 }], hasEntity: true })).toBe(true);
    expect(ownershipBlocksPersonalPublication({ kind: 'joint', shares: [], hasEntity: false })).toBe(false);
    expect(ownershipBlocksPersonalPublication({ kind: 'unassigned' })).toBe(false);
  });
});
