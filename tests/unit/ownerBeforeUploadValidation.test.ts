/**
 * Owner-before-upload (Phase 1): server-side owner validation.
 *
 * Every rule here has a NEGATIVE CONTROL: the same input that is refused for one
 * context is ACCEPTED when only the thing under test is changed (the user's
 * country, an id's tenant, an entity's active flag...). A refusal that is also
 * what happens when the rule is deleted would prove nothing; each pair below
 * names the assertion that fails if the rule is broken.
 */
import { describe, it, expect } from 'vitest';
import {
  OWNER_FLOW_POLICIES,
  validateOwnerSelection,
  validateOwnerSelectionAgainst,
  type OwnerContext,
  type OwnerValidationResult,
} from '@/lib/ownership/validateOwnerSelection';
import { buildOwnerOptions } from '@/lib/ownership/ownerOptions';
import { isHouseholdOwner } from '@/lib/read-models/core/types';
import { OWNER_VALUES } from '@/lib/constants';
import { businessEntityOwnerRole } from '@/lib/pc5/optionSets';

const SELF = 'a1111111-1111-4111-8111-111111111111';
const SPOUSE = 'a2222222-2222-4222-8222-222222222222';
const CHILD = 'a3333333-3333-4333-8333-333333333333';
const GONE = 'a4444444-4444-4444-8444-444444444444'; // inactive
const FOREIGN = 'b1111111-1111-4111-8111-111111111111'; // belongs to ANOTHER user
const TRUST = 'e1111111-1111-4111-8111-111111111111';
const HUF = 'e2222222-2222-4222-8222-222222222222';
const COMPANY = 'e3333333-3333-4333-8333-333333333333';
const OLD_TRUST = 'e4444444-4444-4444-8444-444444444444'; // inactive

function ctx(over: Partial<OwnerContext> = {}): OwnerContext {
  return {
    homeCountry: 'IN',
    members: [
      { id: SELF, fullName: 'Anil', relationship: 'self', isActive: true },
      { id: SPOUSE, fullName: 'Priya', relationship: 'spouse', isActive: true },
      { id: CHILD, fullName: 'Rohan', relationship: 'child', isActive: true },
      { id: GONE, fullName: 'Old Member', relationship: 'partner', isActive: false },
    ],
    entities: [
      { id: TRUST, name: 'Sharma Family Trust', entityType: 'family_trust', isActive: true },
      { id: HUF, name: 'Sharma HUF', entityType: 'huf', isActive: true },
      { id: COMPANY, name: 'Sharma Pty', entityType: 'company', isActive: true },
      { id: OLD_TRUST, name: 'Old Trust', entityType: 'family_trust', isActive: false },
    ],
    ...over,
  };
}
const AU = ctx({ homeCountry: 'AU', entities: ctx().entities.filter((e) => e.entityType !== 'huf') });
const code = (r: OwnerValidationResult) => (r.ok ? 'ok' : r.code);

describe('owner is REQUIRED (server-side)', () => {
  it.each(['bank', 'ii_cas'] as const)('no owner at all is refused for the %s flow', (flow) => {
    expect(code(validateOwnerSelectionAgainst(ctx(), undefined, flow))).toBe('owner_required');
    expect(code(validateOwnerSelectionAgainst(ctx(), null, flow))).toBe('owner_required');
  });
  it('a missing owner is refused before any database read (validateOwnerSelection never loads a context)', async () => {
    let loads = 0;
    const result = await validateOwnerSelection('u', undefined, 'bank', { loadContext: async () => { loads += 1; return ctx(); } });
    expect(code(result)).toBe('owner_required');
    expect(loads).toBe(0);
    // CONTROL: with an owner supplied the context IS loaded, so the 0 above is the rule's doing.
    await validateOwnerSelection('u', { kind: 'member', memberId: SELF }, 'bank', { loadContext: async () => { loads += 1; return ctx(); } });
    expect(loads).toBe(1);
  });
  it('a garbled owner is owner_invalid, not owner_required', () => {
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: '__invalid_json__' }, 'bank'))).toBe('owner_invalid');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: 'not-a-uuid' }, 'bank'))).toBe('owner_invalid');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: SELF, extra: 1 }, 'bank'))).toBe('owner_invalid');
  });
});

describe('ids must belong to THIS user and be active', () => {
  it("cross-tenant owner id is refused -- the context only ever holds the caller's own rows", () => {
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: FOREIGN }, 'ii_cas'))).toBe('owner_not_found');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'entity', entityId: FOREIGN }, 'ii_cas'))).toBe('owner_not_found');
    // CONTROL: the SAME id is accepted once it is one of the caller's own members
    // -- so the refusal above is the ownership lookup, not the id's shape.
    const withIt = ctx({ members: [...ctx().members, { id: FOREIGN, fullName: 'Now mine', relationship: 'spouse', isActive: true }] });
    expect(code(validateOwnerSelectionAgainst(withIt, { kind: 'member', memberId: FOREIGN }, 'ii_cas'))).toBe('ok');
  });
  it('the loader scopes by user_id: a joint entry naming a foreign id is refused too', () => {
    const r = validateOwnerSelectionAgainst(
      ctx(),
      { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 5000 }, { memberId: FOREIGN, basisPoints: 5000 }] },
      'ii_cas',
    );
    expect(code(r)).toBe('owner_not_found');
  });
  it('an inactive member is refused; the active one is accepted (control)', () => {
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: GONE }, 'ii_cas'))).toBe('owner_inactive');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: SPOUSE }, 'ii_cas'))).toBe('ok');
  });
  it('an inactive entity is refused; the active one is accepted (control)', () => {
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'entity', entityId: OLD_TRUST }, 'ii_cas'))).toBe('owner_inactive');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'entity', entityId: TRUST }, 'ii_cas'))).toBe('ok');
  });
});

describe('country rules use the AUTHORITATIVE home country only', () => {
  const huf = { kind: 'entity', entityId: HUF } as const;
  it('HUF is refused for a non-India user and accepted for an India user', () => {
    // An AU user who somehow holds an HUF row (a direct PostgREST insert) is still refused.
    const auWithHuf = ctx({ homeCountry: 'AU' });
    expect(code(validateOwnerSelectionAgainst(auWithHuf, huf, 'ii_cas'))).toBe('owner_not_allowed_for_country');
    expect(code(validateOwnerSelectionAgainst(ctx({ homeCountry: null }), huf, 'ii_cas'))).toBe('owner_not_allowed_for_country'); // unresolved fails closed
    expect(code(validateOwnerSelectionAgainst(ctx({ homeCountry: 'IN' }), huf, 'ii_cas'))).toBe('ok'); // CONTROL
  });
  it('the request carries no country: a body that claims India cannot make an AU user an HUF owner', async () => {
    const hostile = { kind: 'entity', entityId: HUF, countryCode: 'IN', country_code: 'IN', country: 'IN' };
    // Extra keys are rejected outright (strict schema) ...
    expect(code(validateOwnerSelectionAgainst(ctx({ homeCountry: 'AU' }), hostile, 'ii_cas'))).toBe('owner_invalid');
    // ... and the real validator resolves the country from the loader, never the input.
    const r = await validateOwnerSelection('u', { kind: 'entity', entityId: HUF }, 'ii_cas', { loadContext: async () => ctx({ homeCountry: 'AU' }) });
    expect(code(r)).toBe('owner_not_allowed_for_country');
    const ok = await validateOwnerSelection('u', { kind: 'entity', entityId: HUF }, 'ii_cas', { loadContext: async () => ctx({ homeCountry: 'IN' }) });
    expect(code(ok)).toBe('ok');
  });
  it('SMSF is AU only: refused for India and unresolved, accepted for AU (bank)', () => {
    expect(code(validateOwnerSelectionAgainst(ctx({ homeCountry: 'IN' }), { kind: 'smsf' }, 'bank'))).toBe('owner_not_allowed_for_country');
    expect(code(validateOwnerSelectionAgainst(ctx({ homeCountry: null }), { kind: 'smsf' }, 'bank'))).toBe('owner_not_allowed_for_country');
    expect(code(validateOwnerSelectionAgainst(AU, { kind: 'smsf' }, 'bank'))).toBe('ok');
  });
  it('SMSF is not a CAS owner even for an AU user (the flow does not allow it)', () => {
    expect(code(validateOwnerSelectionAgainst(AU, { kind: 'smsf' }, 'ii_cas'))).toBe('owner_not_allowed_for_flow');
  });
});

describe('Company / Trust only if the user created one', () => {
  it('a user with no Company has nothing to select: an entity id is refused; with one it is accepted', () => {
    const none = ctx({ entities: [] });
    expect(code(validateOwnerSelectionAgainst(none, { kind: 'entity', entityId: COMPANY }, 'ii_cas'))).toBe('owner_not_found');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'entity', entityId: COMPANY }, 'ii_cas'))).toBe('ok');
    expect(buildOwnerOptions(none, 'ii_cas').entities).toEqual([]);
    expect(buildOwnerOptions(ctx(), 'ii_cas').entities.map((e) => e.entityType).sort()).toEqual(['company', 'family_trust', 'huf']);
  });
});

describe('joint (CAS): percentages are required and validated in basis points', () => {
  const joint = (allocations: Array<{ memberId?: string; entityId?: string; basisPoints: number }> | undefined) =>
    validateOwnerSelectionAgainst(ctx(), { kind: 'joint', allocations }, 'ii_cas');

  it('a valid split summing to exactly 10000 is accepted and returned in basis points', () => {
    const r = joint([{ memberId: SELF, basisPoints: 3334 }, { memberId: SPOUSE, basisPoints: 3333 }, { entityId: TRUST, basisPoints: 3333 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.owner.ownerRole).toBe('joint');
      expect(r.owner.allocations?.reduce((n, a) => n + a.basisPoints, 0)).toBe(10000);
    }
  });
  it('no allocations at all is refused for a CAS', () => {
    expect(code(joint(undefined))).toBe('joint_allocation_required');
    expect(code(joint([]))).toBe('joint_allocation_required');
  });
  it('NEGATIVE: a total of 9999 and of 10001 are refused (never scaled to fit)', () => {
    expect(code(joint([{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 4999 }]))).toBe('joint_total_not_100');
    expect(code(joint([{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5001 }]))).toBe('joint_total_not_100');
    expect(code(joint([{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5000 }]))).toBe('ok'); // CONTROL
  });
  it('NEGATIVE: a duplicate owner is refused', () => {
    expect(code(joint([{ memberId: SELF, basisPoints: 5000 }, { memberId: SELF, basisPoints: 5000 }]))).toBe('joint_duplicate_owner');
  });
  it('NEGATIVE: a zero share is refused, not dropped', () => {
    expect(code(joint([{ memberId: SELF, basisPoints: 10000 }, { memberId: SPOUSE, basisPoints: 0 }]))).toBe('joint_zero_share');
  });
  it('NEGATIVE: a fractional share is refused (basis points are integers)', () => {
    expect(code(joint([{ memberId: SELF, basisPoints: 5000.5 }, { memberId: SPOUSE, basisPoints: 4999.5 }]))).toBe('joint_share_invalid');
  });
  it('a single owner is not a joint split; an entry naming both a member and an entity is refused', () => {
    expect(code(joint([{ memberId: SELF, basisPoints: 10000 }]))).toBe('joint_needs_two_owners');
    expect(code(joint([{ memberId: SELF, entityId: TRUST, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5000 }]))).toBe('joint_owner_identity');
    expect(code(joint([{ basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5000 }]))).toBe('joint_owner_identity');
  });
  it('an HUF inside a joint split is held to the same India rule', () => {
    const r = validateOwnerSelectionAgainst(
      ctx({ homeCountry: 'AU' }),
      { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 5000 }, { entityId: HUF, basisPoints: 5000 }] },
      'ii_cas',
    );
    expect(code(r)).toBe('owner_not_allowed_for_country');
  });
});

describe('bank flow (decision 3 limitation and decision 7 entity separation)', () => {
  it('joint stays as it is today: role joint, no percentages', () => {
    const r = validateOwnerSelectionAgainst(ctx(), { kind: 'joint' }, 'bank');
    expect(r.ok && r.owner.ownerRole).toBe('joint');
    expect(r.ok && r.owner.allocations).toBeNull();
    // percentages are refused rather than silently dropped
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5000 }] }, 'bank'))).toBe('joint_allocation_not_used');
  });
  it('self and spouse map to the existing owner_role values; a child member cannot own a bank statement', () => {
    const self = validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: SELF }, 'bank');
    const spouse = validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: SPOUSE }, 'bank');
    expect(self.ok && self.owner.ownerRole).toBe('self');
    expect(spouse.ok && spouse.owner.ownerRole).toBe('spouse');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: CHILD }, 'bank'))).toBe('owner_not_allowed_for_flow');
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'member', memberId: CHILD }, 'ii_cas'))).toBe('ok'); // CONTROL: fine for a CAS
  });
  it.each([TRUST, HUF, COMPANY])('NEGATIVE: entity %s is refused for a bank statement and accepted for a CAS', (id) => {
    const r = validateOwnerSelectionAgainst(ctx(), { kind: 'entity', entityId: id }, 'bank');
    expect(code(r)).toBe('owner_not_allowed_for_flow');
    expect(!r.ok && r.message).toMatch(/household spending and income/);
    expect(code(validateOwnerSelectionAgainst(ctx(), { kind: 'entity', entityId: id }, 'ii_cas'))).toBe('ok');
  });
  it('DECISION 7 INVARIANT: every owner role bank can carry is handled correctly by the read models TODAY', () => {
    // What the read models do with each role: only smsf leaves household totals.
    expect(isHouseholdOwner('smsf')).toBe(false);
    for (const role of ['self', 'spouse', 'joint']) expect(isHouseholdOwner(role)).toBe(true);
    // The entity roles are NOT excluded from household totals today ...
    for (const type of ['family_trust', 'huf', 'company'] as const) {
      expect(isHouseholdOwner(businessEntityOwnerRole(type))).toBe(true);
    }
    // ... which is exactly why bank refuses every entity type. If someone enables entities for bank
    // WITHOUT first teaching the read models to exclude them, THIS assertion fails.
    for (const type of OWNER_FLOW_POLICIES.bank.allowedEntityTypes) {
      expect(isHouseholdOwner(businessEntityOwnerRole(type))).toBe(false);
    }
    expect(OWNER_FLOW_POLICIES.bank.allowedEntityTypes).toEqual([]);
    // and every role the bank policy accepts is one fdh_financial_accounts.owner_role (0207) can store.
    for (const role of OWNER_FLOW_POLICIES.bank.allowedMemberRoles) expect(['self', 'spouse', 'joint', 'smsf']).toContain(role);
    expect(OWNER_VALUES).toContain('smsf');
  });
});

describe('the options list is the same rule as the validator', () => {
  it('India: self first, spouse, child, trust, HUF, company, joint -- inactive ones never listed; no SMSF', () => {
    const o = buildOwnerOptions(ctx(), 'ii_cas');
    expect(o.members.map((m) => m.label)).toEqual(['Anil', 'Priya', 'Rohan']);
    expect(o.members[0].ownerRole).toBe('self');
    expect(o.entities.map((e) => e.label)).toEqual(['Sharma Family Trust', 'Sharma HUF', 'Sharma Pty']);
    expect(o.joint).toMatchObject({ available: true, requiresPercentages: true });
    expect(o.smsf.available).toBe(false);
    expect(o.entityNotice).toBeNull();
  });
  it('AU user never sees an HUF even if one exists; AU bank offers SMSF but no entities', () => {
    const auCas = buildOwnerOptions(ctx({ homeCountry: 'AU' }), 'ii_cas');
    expect(auCas.entities.map((e) => e.entityType)).not.toContain('huf');
    const bank = buildOwnerOptions(AU, 'bank');
    expect(bank.entities).toEqual([]);
    expect(bank.entityNotice).toMatch(/entity money must stay separate/);
    expect(bank.smsf.available).toBe(true);
    expect(bank.joint).toMatchObject({ available: true, requiresPercentages: false });
    expect(bank.members.map((m) => m.label)).toEqual(['Anil', 'Priya']); // no child
  });
  it('India bank: no SMSF', () => {
    expect(buildOwnerOptions(ctx(), 'bank').smsf.available).toBe(false);
  });
  it('joint needs two selectable owners for a CAS', () => {
    const lone = ctx({ members: [ctx().members[0]], entities: [] });
    expect(buildOwnerOptions(lone, 'ii_cas').joint.available).toBe(false);
    expect(buildOwnerOptions(ctx(), 'ii_cas').joint.available).toBe(true);
  });
});
