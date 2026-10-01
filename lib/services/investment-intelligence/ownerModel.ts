/**
 * Investment Intelligence -- account ownership model (2026-10-01).
 *
 * PURE: no I/O, no Supabase, no clock. Everything the owner-change API, the
 * Review / Resolutions dialogs and the tests need to agree on lives here, so
 * the rules ("belongs to the user", "active", "HUF is India-only", "a joint
 * split totals exactly 100%") exist in exactly one place and can be exercised
 * without a database.
 *
 * WHAT THE OWNER OF AN `ii_accounts` ROW CAN NOW BE
 *   - a household member               ({ kind: 'member', member_id })
 *   - a business entity                ({ kind: 'entity', business_entity_id })
 *                                       Family Trust, Company, and HUF for
 *                                       India-confirmed users only
 *   - a joint split across 2+ owners   ({ kind: 'joint', allocations: [...] })
 *                                       members and/or entities, each with a
 *                                       share in BASIS POINTS (10000 = 100%)
 *
 * WHERE EACH OF THOSE IS STORED (the design decision, see
 * docs/ownership/OWNER_ENTITY_JOINT_EDIT_REPORT.md):
 *   - `ii_accounts.owner_member_id` keeps meaning exactly what it always did:
 *     "the SOLE household-member owner". It stays NULL for an entity-owned or
 *     jointly-owned account.
 *   - the entity / joint owner lives ONLY in `ii_ownership_allocation`
 *     (migration 0153, PC5 K.6): one ACTIVE allocation group per account.
 *     A 100% allocation to one entity is how "owned by a Trust" is recorded.
 *   - the EFFECTIVE owner of an account is therefore derived, by
 *     `deriveAccountOwnership()` below, from (pointer, active allocation
 *     rows). The allocation group, when present, is authoritative.
 *
 * Field names deliberately mirror the in-flight "owner before upload" Phase 1
 * contract (`member_id`, `business_entity_id`, `allocations[].basis_points`,
 * basis-point convention) so the two converge on one shared schema later.
 */

import { z } from 'zod';
import { PC5_TOTAL_BASIS_POINTS, validateAllocation, type Pc5AllocationValidationFailure } from '@/lib/pc5/jointAllocation';
import type { Pc5AllocationEntry } from '@/lib/pc5/types';
import { businessEntityOwnerRole } from '@/lib/pc5/optionSets';
import { BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY, type BusinessEntityType } from '@/lib/validation/businessEntity';
import { mapRelationshipToOwner } from './publicationLogic';
import type { HouseholdMemberRelationship } from './types';

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

const jointAllocationInputSchema = z.object({
  member_id: uuid.optional(),
  business_entity_id: uuid.optional(),
  basis_points: z.number(),
});

export const ownerSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), member_id: uuid }),
  z.object({ kind: z.literal('entity'), business_entity_id: uuid }),
  z.object({ kind: z.literal('joint'), allocations: z.array(jointAllocationInputSchema).min(1).max(10) }),
]);

export type OwnerSelection = z.infer<typeof ownerSelectionSchema>;
export type JointAllocationInput = z.infer<typeof jointAllocationInputSchema>;

/**
 * The owner-change request body. `confirm` is parsed loosely on purpose: a
 * missing / false value must produce the explicit, readable
 * OWNER_CHANGE_NOT_CONFIRMED answer rather than a generic zod 422.
 *
 * LEGACY BODY: `{ ownerMemberId }` (the shape the pre-2026-10-01 Review and
 * Resolutions controls sent) is mapped to `{ owner: { kind: 'member', ... } }`.
 * It is NOT exempt from the confirm requirement.
 */
export const ownerChangeRequestSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (o.owner === undefined && typeof o.ownerMemberId === 'string') {
        return { ...o, owner: { kind: 'member', member_id: o.ownerMemberId } };
      }
    }
    return raw;
  },
  z.object({
    owner: ownerSelectionSchema,
    confirm: z.boolean().optional(),
    /**
     * PO decision 2026-10-01: a joint-holding case MAY be resolved with a sole
     * owner, but only with this second, explicit "this is not a joint holding"
     * confirmation (in addition to `confirm`).
     */
    confirm_not_joint: z.boolean().optional(),
    case_id: uuid.optional(),
  })
);
export type OwnerChangeRequest = z.infer<typeof ownerChangeRequestSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type OwnerErrorCode =
  | 'OWNER_MEMBER_NOT_FOUND'
  | 'OWNER_MEMBER_INACTIVE'
  | 'OWNER_ENTITY_NOT_FOUND'
  | 'OWNER_ENTITY_INACTIVE'
  | 'OWNER_ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY'
  | 'JOINT_REQUIRES_TWO_OWNERS'
  | 'JOINT_ALLOCATION_INVALID'
  | 'OWNER_CHANGE_NOT_CONFIRMED'
  | 'ACCOUNT_PUBLISHED_UNPUBLISH_FIRST'
  | 'JOINT_CASE_REQUIRES_JOINT_OWNER'
  | 'ACCOUNT_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'OWNERSHIP_FEATURE_NOT_AVAILABLE'
  | 'OWNER_WRITE_FAILED';

export interface OwnerFailure {
  ok: false;
  status: number;
  code: OwnerErrorCode;
  message: string;
  /** Machine detail for JOINT_ALLOCATION_INVALID (the validateAllocation reason). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Option rows (what the server loaded for ONE user -- never the client's claim)
// ---------------------------------------------------------------------------

export interface OwnerChoiceMember {
  id: string;
  full_name: string;
  relationship: string;
  is_active: boolean | null;
}
export interface OwnerChoiceEntity {
  id: string;
  name: string;
  entity_type: string;
  is_active: boolean | null;
}
export interface OwnerChoiceContext {
  members: readonly OwnerChoiceMember[];
  entities: readonly OwnerChoiceEntity[];
  /** The caller's AUTHORITATIVE home country (user_profiles), never the request's. null = unresolved/generic. */
  homeCountry: string | null;
}

// ---------------------------------------------------------------------------
// Effective ownership
// ---------------------------------------------------------------------------

export interface OwnerShare {
  memberId?: string;
  businessEntityId?: string;
  basisPoints: number;
}

export type AccountOwnership =
  | { kind: 'unassigned' }
  | { kind: 'member' | 'entity' | 'joint'; shares: OwnerShare[]; hasEntity: boolean };

export interface ActiveAllocationRow {
  owner_member_id: string | null;
  owner_business_entity_id: string | null;
  allocation_basis_points: number;
  ii_instrument_id?: string | null;
  status?: string;
}

/**
 * The effective owner of an account. An ACTIVE account-grain allocation group
 * is authoritative; with none, the sole-member pointer decides; with neither
 * the account is unassigned. Instrument-grain rows (ii_instrument_id set) are
 * a different, narrower decision and never describe the whole account.
 */
export function deriveAccountOwnership(pointerMemberId: string | null | undefined, activeRows: readonly ActiveAllocationRow[]): AccountOwnership {
  const accountGrain = activeRows.filter((r) => (r.status === undefined || r.status === 'active') && (r.ii_instrument_id ?? null) === null);
  if (accountGrain.length > 0) {
    const shares: OwnerShare[] = accountGrain.map((r) =>
      r.owner_member_id ? { memberId: r.owner_member_id, basisPoints: r.allocation_basis_points } : { businessEntityId: r.owner_business_entity_id as string, basisPoints: r.allocation_basis_points }
    );
    const hasEntity = shares.some((s) => !!s.businessEntityId);
    if (shares.length === 1) {
      return { kind: shares[0].businessEntityId ? 'entity' : 'member', shares, hasEntity };
    }
    return { kind: 'joint', shares, hasEntity };
  }
  if (pointerMemberId) return { kind: 'member', shares: [{ memberId: pointerMemberId, basisPoints: PC5_TOTAL_BASIS_POINTS }], hasEntity: false };
  return { kind: 'unassigned' };
}

const shareKey = (s: OwnerShare) => `${s.memberId ? 'm' : 'e'}:${s.memberId ?? s.businessEntityId}:${s.basisPoints}`;

/** Canonical identity of an ownership, order-independent. Drives idempotency. */
export function ownershipKey(o: AccountOwnership): string {
  if (o.kind === 'unassigned') return 'unassigned';
  const kind = o.shares.length > 1 ? 'joint' : o.shares[0].businessEntityId ? 'entity' : 'member';
  return `${kind}|${[...o.shares].map(shareKey).sort().join(',')}`;
}

export function sameOwnership(a: AccountOwnership, b: AccountOwnership): boolean {
  return ownershipKey(a) === ownershipKey(b);
}

/** IDs and basis points only -- the ONLY shape ever put into audit metadata or case details. No names, no PAN, no folio. */
export interface OwnershipAuditShape {
  kind: AccountOwnership['kind'];
  shares: { memberId?: string; businessEntityId?: string; basisPoints: number }[];
}
export function ownershipAuditShape(o: AccountOwnership): OwnershipAuditShape {
  if (o.kind === 'unassigned') return { kind: 'unassigned', shares: [] };
  return { kind: o.kind, shares: o.shares.map((s) => ({ ...(s.memberId ? { memberId: s.memberId } : { businessEntityId: s.businessEntityId }), basisPoints: s.basisPoints })) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidatedOwner {
  kind: 'member' | 'entity' | 'joint';
  /** Shares in the canonical shape; one 100% share for member / entity. */
  shares: OwnerShare[];
  hasEntity: boolean;
  /** The canonical FHIP owner ROLE of the result (one of the existing eight). 'joint' for a split. */
  ownerRole: string;
  /** Allocation entries to persist (member: only used when an allocation group must be superseded). */
  entries: Pc5AllocationEntry[];
  /** `ii_accounts.owner_member_id` to store: the sole member, else null. */
  pointerMemberId: string | null;
}

function fail(status: number, code: OwnerErrorCode, message: string, reason?: string): OwnerFailure {
  return { ok: false, status, code, message, ...(reason ? { reason } : {}) };
}

const ENTITY_TYPE_LABEL: Record<string, string> = { company: 'company', family_trust: 'family trust', huf: 'Hindu Undivided Family (HUF)' };

type OwnerRef = { memberId: string } | { businessEntityId: string };

function checkOneOwner(ref: OwnerRef, ctx: OwnerChoiceContext): { ok: true; role: string } | OwnerFailure {
  if ('memberId' in ref) {
    // Rows were loaded filtered by user_id, so another tenant's member id is
    // simply absent here: "not found", never an existence leak.
    const m = ctx.members.find((x) => x.id === ref.memberId);
    if (!m) return fail(404, 'OWNER_MEMBER_NOT_FOUND', 'That household member was not found.');
    if (m.is_active === false) return fail(422, 'OWNER_MEMBER_INACTIVE', 'That household member is no longer active. Reactivate them first, or choose someone else.');
    return { ok: true, role: mapRelationshipToOwner(m.relationship as HouseholdMemberRelationship) };
  }
  const e = ctx.entities.find((x) => x.id === ref.businessEntityId);
  if (!e) return fail(404, 'OWNER_ENTITY_NOT_FOUND', 'That trust, HUF or company was not found.');
  if (e.is_active === false) return fail(422, 'OWNER_ENTITY_INACTIVE', 'That trust, HUF or company is no longer active.');
  const requiredCountry = BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY[e.entity_type as BusinessEntityType];
  if (requiredCountry && ctx.homeCountry !== requiredCountry) {
    return fail(
      403,
      'OWNER_ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY',
      `A ${ENTITY_TYPE_LABEL[e.entity_type] ?? 'entity of this type'} can only own accounts for users confirmed in ${requiredCountry === 'IN' ? 'India' : requiredCountry}.`
    );
  }
  return { ok: true, role: businessEntityOwnerRole(e.entity_type) };
}

const ALLOCATION_REASON_MESSAGE: Record<Pc5AllocationValidationFailure['reason'], string> = {
  no_owners: 'Add at least two owners.',
  duplicate_owner: 'Each owner can appear only once in a joint split.',
  owner_identity_missing_or_ambiguous: 'Each line must name exactly one owner.',
  non_integer_basis_points: 'Percentages can have at most two decimal places.',
  out_of_range_basis_points: 'Every owner needs a share greater than 0% and at most 100%.',
  total_not_100_percent: 'The shares must add up to exactly 100%.',
};

/**
 * Validates an owner selection against what the SERVER loaded for this user.
 * Order matters and is tested: ownership of every id first (so a foreign id is
 * "not found" even in an otherwise-invalid split), then the allocation maths.
 */
export function validateOwnerSelection(selection: OwnerSelection, ctx: OwnerChoiceContext): { ok: true; owner: ValidatedOwner } | OwnerFailure {
  if (selection.kind === 'member') {
    const r = checkOneOwner({ memberId: selection.member_id }, ctx);
    if (!r.ok) return r;
    return {
      ok: true,
      owner: {
        kind: 'member',
        shares: [{ memberId: selection.member_id, basisPoints: PC5_TOTAL_BASIS_POINTS }],
        hasEntity: false,
        ownerRole: r.role,
        entries: [{ ownerMemberId: selection.member_id, basisPoints: PC5_TOTAL_BASIS_POINTS }],
        pointerMemberId: selection.member_id,
      },
    };
  }

  if (selection.kind === 'entity') {
    const r = checkOneOwner({ businessEntityId: selection.business_entity_id }, ctx);
    if (!r.ok) return r;
    return {
      ok: true,
      owner: {
        kind: 'entity',
        shares: [{ businessEntityId: selection.business_entity_id, basisPoints: PC5_TOTAL_BASIS_POINTS }],
        hasEntity: true,
        ownerRole: r.role,
        entries: [{ ownerBusinessEntityId: selection.business_entity_id, basisPoints: PC5_TOTAL_BASIS_POINTS }],
        pointerMemberId: null,
      },
    };
  }

  // joint
  const lines = selection.allocations;
  for (const line of lines) {
    if (line.member_id && line.business_entity_id) return fail(422, 'JOINT_ALLOCATION_INVALID', ALLOCATION_REASON_MESSAGE.owner_identity_missing_or_ambiguous, 'owner_identity_missing_or_ambiguous');
    if (!line.member_id && !line.business_entity_id) return fail(422, 'JOINT_ALLOCATION_INVALID', ALLOCATION_REASON_MESSAGE.owner_identity_missing_or_ambiguous, 'owner_identity_missing_or_ambiguous');
  }
  for (const line of lines) {
    const r = checkOneOwner(line.member_id ? { memberId: line.member_id } : { businessEntityId: line.business_entity_id as string }, ctx);
    if (!r.ok) return r;
  }
  if (lines.length < 2) return fail(422, 'JOINT_REQUIRES_TWO_OWNERS', 'A joint split needs at least two owners. For a single owner, choose that owner directly.', 'no_owners');

  const entries: Pc5AllocationEntry[] = lines.map((l) => ({
    ...(l.member_id ? { ownerMemberId: l.member_id } : { ownerBusinessEntityId: l.business_entity_id as string }),
    basisPoints: l.basis_points,
  }));
  const validated = validateAllocation(entries);
  if (!validated.ok) return fail(422, 'JOINT_ALLOCATION_INVALID', ALLOCATION_REASON_MESSAGE[validated.reason], validated.reason);

  const shares: OwnerShare[] = validated.entries.map((e) => (e.ownerMemberId ? { memberId: e.ownerMemberId, basisPoints: e.basisPoints } : { businessEntityId: e.ownerBusinessEntityId as string, basisPoints: e.basisPoints }));
  return { ok: true, owner: { kind: 'joint', shares, hasEntity: shares.some((s) => !!s.businessEntityId), ownerRole: 'joint', entries: validated.entries, pointerMemberId: null } };
}

export function validatedOwnerToOwnership(v: ValidatedOwner): AccountOwnership {
  return { kind: v.kind, shares: v.shares, hasEntity: v.hasEntity };
}

// ---------------------------------------------------------------------------
// Case rules
// ---------------------------------------------------------------------------

export const OWNER_CASE_TYPES = ['owner_unmatched', 'owner_mismatch', 'joint_holding_allocation_required'] as const;
export type OwnerCaseType = (typeof OWNER_CASE_TYPES)[number];

/** Which open owner-exception types a given owner choice may resolve. A joint
 *  holding is resolved by a joint split, or -- PO decision 2026-10-01 -- by a
 *  sole owner ONLY when the caller has explicitly confirmed "this is not a
 *  joint holding" (`notJointConfirmed`). */
export function caseTypesResolvedBy(kind: ValidatedOwner['kind'], notJointConfirmed = false): readonly OwnerCaseType[] {
  return kind === 'joint' || notJointConfirmed ? OWNER_CASE_TYPES : ['owner_unmatched', 'owner_mismatch'];
}

/**
 * The joint-case rule, in one place for both routes. A joint-holding case with a
 * non-joint owner needs `confirm_not_joint: true`. Returns a failure or null.
 */
export function jointCaseOwnerFailure(discrepancyType: string, ownerKind: ValidatedOwner['kind'], confirmNotJoint: boolean | undefined): OwnerFailure | null {
  if (discrepancyType !== 'joint_holding_allocation_required' || ownerKind === 'joint' || confirmNotJoint === true) return null;
  return {
    ok: false,
    status: 422,
    code: 'JOINT_CASE_REQUIRES_JOINT_OWNER',
    message: 'This statement prints a joint holding. Split it between two or more owners, or confirm that it is not a joint holding to assign a single owner.',
  };
}

export function isOwnerCaseType(t: unknown): t is OwnerCaseType {
  return typeof t === 'string' && (OWNER_CASE_TYPES as readonly string[]).includes(t);
}

/** Resolution method recorded on the case. 'user_mapped_owner' is the pre-existing value for a member. */
export function resolutionMethodFor(kind: ValidatedOwner['kind'], amend: boolean, notJointConfirmed = false): string {
  if (amend) return 'user_amended_owner';
  if (notJointConfirmed && kind !== 'joint') return 'user_confirmed_not_joint';
  if (kind === 'entity') return 'user_mapped_entity_owner';
  if (kind === 'joint') return 'user_assigned_joint_allocation';
  return 'user_mapped_owner';
}

/** Does this owner put value outside the personal household (any entity share)? Drives the publish block. */
export function ownershipBlocksPersonalPublication(o: AccountOwnership): boolean {
  return o.kind !== 'unassigned' && o.hasEntity;
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure) -- labels for the owner picker and for showing
// "current owner" in the dialogs. Labels are resolved from rows the server
// loaded for THIS user; ids are never echoed without a label the user can read.
// ---------------------------------------------------------------------------

export interface OwnerOptionView {
  kind: 'member' | 'entity';
  id: string;
  label: string;
  detail: string;
  ownerRole: string;
}

export interface OwnershipView {
  kind: AccountOwnership['kind'];
  owners: { kind: 'member' | 'entity'; id: string; label: string; detail: string; basisPoints: number }[];
}

const MEMBER_RELATIONSHIP_LABEL: Record<string, string> = {
  self: 'You',
  spouse: 'Spouse',
  partner: 'Partner',
  child: 'Child',
  parent: 'Parent',
  other_dependant: 'Dependant',
};
export const memberRelationshipLabel = (relationship: string) => MEMBER_RELATIONSHIP_LABEL[relationship] ?? 'Household member';

const ENTITY_TYPE_DETAIL: Record<string, string> = { company: 'Company', family_trust: 'Family trust', huf: 'Hindu Undivided Family (HUF)' };
export const entityTypeDetail = (entityType: string) => ENTITY_TYPE_DETAIL[entityType] ?? 'Company';

/**
 * The owners a user may pick from. ACTIVE members, and ACTIVE entities whose
 * type is allowed for the user's authoritative country (an HUF the user
 * somehow still has is NOT offered unless they are confirmed in India).
 * Ordering is stable: self first, then other members, then entities.
 */
export function buildOwnerOptions(ctx: OwnerChoiceContext): { options: OwnerOptionView[]; jointAvailable: boolean } {
  const members: OwnerOptionView[] = ctx.members
    .filter((m) => m.is_active !== false)
    .map((m) => ({
      kind: 'member' as const,
      id: m.id,
      label: m.full_name || '(unnamed household member)',
      detail: memberRelationshipLabel(m.relationship),
      ownerRole: mapRelationshipToOwner(m.relationship as HouseholdMemberRelationship),
    }));
  members.sort((a, b) => (a.ownerRole === 'self' ? 0 : 1) - (b.ownerRole === 'self' ? 0 : 1));
  const entities: OwnerOptionView[] = ctx.entities
    .filter((e) => e.is_active !== false)
    .filter((e) => {
      const required = BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY[e.entity_type as BusinessEntityType];
      return !required || ctx.homeCountry === required;
    })
    .map((e) => ({ kind: 'entity' as const, id: e.id, label: e.name, detail: entityTypeDetail(e.entity_type), ownerRole: businessEntityOwnerRole(e.entity_type) }));
  const options = [...members, ...entities];
  return { options, jointAvailable: options.length >= 2 };
}

export function describeOwnership(o: AccountOwnership, ctx: OwnerChoiceContext): OwnershipView {
  if (o.kind === 'unassigned') return { kind: 'unassigned', owners: [] };
  return {
    kind: o.kind,
    owners: o.shares.map((s) => {
      if (s.memberId) {
        const m = ctx.members.find((x) => x.id === s.memberId);
        return { kind: 'member' as const, id: s.memberId, label: m?.full_name || '(unknown member)', detail: m ? memberRelationshipLabel(m.relationship) : 'Household member', basisPoints: s.basisPoints };
      }
      const e = ctx.entities.find((x) => x.id === s.businessEntityId);
      return { kind: 'entity' as const, id: s.businessEntityId as string, label: e?.name ?? '(unknown entity)', detail: e ? entityTypeDetail(e.entity_type) : 'Entity', basisPoints: s.basisPoints };
    }),
  };
}
