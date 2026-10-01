/**
 * Owner-before-upload (Phase 1) -- server-side validation of an owner
 * selection. The browser's choice is a CLAIM; this is where it becomes a fact.
 *
 * TWO LAYERS, so the rules are testable without a database:
 *   - `validateOwnerSelectionAgainst(context, input, flow)` is PURE. It is
 *     given the user's own household members / entities and authoritative home
 *     country and decides everything.
 *   - `validateOwnerSelection(userId, input, flow)` loads that context (service
 *     role, every query filtered by `user_id`) and calls the pure layer.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE IS A SEPARATE FAILURE CODE
 *   owner_required            nothing was supplied. Owner is mandatory.
 *   owner_invalid             supplied but malformed.
 *   owner_not_found           an id that is not one of THIS user's members /
 *                             entities. A cross-tenant id and a made-up id are
 *                             deliberately indistinguishable to the caller.
 *   owner_inactive            a deactivated member / entity. Filing a new
 *                             document against one would resurrect it
 *                             implicitly (same rule as pc5/optionSets).
 *   owner_not_allowed_for_country
 *                             HUF is India-only, SMSF is AU-only. The country
 *                             is the user's AUTHORITATIVE home country
 *                             (user_profiles.country_of_residence) -- never a
 *                             value from the request. Unresolved fails closed.
 *   owner_not_allowed_for_flow
 *                             a kind this flow cannot carry safely today. See
 *                             the bank policy below.
 *   joint_*                   joint allocation failures, mapped one-to-one from
 *                             lib/pc5/jointAllocation.ts validateAllocation.
 *
 * "COMPANY ONLY IF THE USER CREATED ONE" needs no special case: an entity can
 * only be chosen by id, and ids are resolved from the user's own
 * business_entities, so a user with no Company has nothing to select.
 *
 * ---------------------------------------------------------------------------
 * PER-FLOW POLICY, AND THE ENTITY-SEPARATION RULING (PO 2026-09-21, decision 7)
 * ---------------------------------------------------------------------------
 * Trust / HUF / Company / SMSF data must stay out of personal totals. What the
 * canonical read models handle TODAY (lib/read-models/core/types.ts
 * `isHouseholdOwner`): only `owner = 'smsf'` is excluded from household
 * totals; EVERY other owner value -- including 'family_trust', 'company' and
 * 'other' (which is what an HUF resolves to) -- is treated as household. So a
 * bank statement stamped as Trust/HUF/Company would flow straight into the
 * household's spending and income. Therefore:
 *
 *   bank   : member (self / spouse only), joint (no percentages), smsf (AU).
 *            Entities are REFUSED -- owner_not_allowed_for_flow -- until the
 *            read models grow entity separation. fdh_financial_accounts.
 *            owner_role also only admits self/spouse/joint/smsf (migration
 *            0207), so there is nowhere correct to store one.
 *   ii_cas : member (any active member), entity (Trust / Company; HUF for
 *            India), joint (percentages required, members and/or entities).
 *            No SMSF (AU-only, and a CAS is an India document). An
 *            entity-owned or joint CAS position keeps its owner on the account
 *            and in ii_ownership_allocation but is NOT published into the
 *            personal investment totals: publication requires a single
 *            household member (investmentPublicationService OWNER_UNRESOLVED),
 *            which is the safe direction for decision 7.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { getUserFullExperienceHomeCountry, type FullExperienceCountryCode } from '@/lib/services/jurisdiction';
import { mapRelationshipToOwner } from '@/lib/services/investment-intelligence/publicationLogic';
import type { HouseholdMemberRelationship } from '@/lib/services/investment-intelligence/types';
import { BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY, type BusinessEntityType } from '@/lib/validation/businessEntity';
import { businessEntityOwnerRole } from '@/lib/pc5/optionSets';
import { validateAllocation } from '@/lib/pc5/jointAllocation';
import type { Pc5AllocationEntry } from '@/lib/pc5/types';
import type { Owner } from '@/lib/constants';
import { ownerSelectionSchema, type OwnerFlow, type OwnerSelection } from './ownerSelection';

export type OwnerValidationCode =
  | 'owner_required'
  | 'owner_invalid'
  | 'owner_not_found'
  | 'owner_inactive'
  | 'owner_not_allowed_for_country'
  | 'owner_not_allowed_for_flow'
  | 'joint_allocation_required'
  | 'joint_allocation_not_used'
  | 'joint_needs_two_owners'
  | 'joint_duplicate_owner'
  | 'joint_zero_share'
  | 'joint_share_invalid'
  | 'joint_total_not_100'
  | 'joint_owner_identity';

export interface ResolvedOwner {
  kind: OwnerSelection['kind'];
  /** The canonical FHIP owner role (lib/constants OWNER_VALUES). */
  ownerRole: Owner;
  ownerMemberId: string | null;
  ownerBusinessEntityId: string | null;
  /** Business-entity type when kind = 'entity' (company / family_trust / huf). */
  entityType: BusinessEntityType | null;
  /** The joint split in basis points (kind = 'joint' with allocations). */
  allocations: Pc5AllocationEntry[] | null;
  /** Human label for messages: "Priya", "Sharma Family Trust", "Joint", "SMSF". */
  label: string;
}

export type OwnerValidationResult =
  | { ok: true; owner: ResolvedOwner }
  | { ok: false; code: OwnerValidationCode; message: string; status: 403 | 422 };

export interface OwnerContextMember {
  id: string;
  fullName: string;
  relationship: HouseholdMemberRelationship;
  isActive: boolean;
}
export interface OwnerContextEntity {
  id: string;
  name: string;
  entityType: BusinessEntityType;
  isActive: boolean;
}
export interface OwnerContext {
  /** The AUTHORITATIVE home country (AU / IN) or null when unresolved / generic. */
  homeCountry: FullExperienceCountryCode | null;
  members: OwnerContextMember[];
  entities: OwnerContextEntity[];
}

// ---------------------------------------------------------------------------
// Per-flow policy (data, so a test reads the real table).
// ---------------------------------------------------------------------------

export interface OwnerFlowPolicy {
  allowedKinds: readonly OwnerSelection['kind'][];
  /** Member roles (after mapRelationshipToOwner) this flow can carry. */
  allowedMemberRoles: readonly Owner[];
  /** Entity types this flow can carry (empty when entities are not allowed). */
  allowedEntityTypes: readonly BusinessEntityType[];
  /** Joint: 'required' = percentages mandatory; 'forbidden' = not used. */
  jointAllocation: 'required' | 'forbidden';
  /** Why entities are not offered, shown to the user / report. */
  entityRefusalReason?: string;
}

export const OWNER_FLOW_POLICIES: Record<OwnerFlow, OwnerFlowPolicy> = {
  bank: {
    allowedKinds: ['member', 'joint', 'smsf'],
    allowedMemberRoles: ['self', 'spouse'],
    allowedEntityTypes: [],
    jointAllocation: 'forbidden',
    entityRefusalReason:
      'Trust, HUF and company statements cannot be imported here yet: bank transactions are counted in your household spending and income, and entity money must stay separate from your personal totals.',
  },
  ii_cas: {
    allowedKinds: ['member', 'entity', 'joint'],
    allowedMemberRoles: ['self', 'spouse', 'child', 'other', 'joint', 'family_trust', 'company', 'smsf'],
    allowedEntityTypes: ['family_trust', 'huf', 'company'],
    jointAllocation: 'required',
  },
};

type Fail = Extract<OwnerValidationResult, { ok: false }>;

function fail(code: OwnerValidationCode, message: string, status: 403 | 422 = 422): Fail {
  return { ok: false, code, message, status };
}
const isFail = (v: unknown): v is Fail => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

interface ResolvedPart {
  ownerRole: Owner;
  memberId: string | null;
  entityId: string | null;
  entityType: BusinessEntityType | null;
  label: string;
}

function resolveMember(ctx: OwnerContext, policy: OwnerFlowPolicy, memberId: string): ResolvedPart | Fail {
  const member = ctx.members.find((m) => m.id === memberId);
  if (!member) return fail('owner_not_found', 'That household member was not found.');
  if (!member.isActive) return fail('owner_inactive', `${member.fullName || 'That household member'} is no longer active. Reactivate them before choosing them as an owner.`);
  const role = mapRelationshipToOwner(member.relationship) as Owner;
  if (!policy.allowedMemberRoles.includes(role)) {
    return fail('owner_not_allowed_for_flow', `${member.fullName || 'That household member'} cannot be chosen as the owner of this kind of document.`);
  }
  return { ownerRole: role, memberId: member.id, entityId: null, entityType: null, label: member.fullName || 'Household member' };
}

function resolveEntity(ctx: OwnerContext, policy: OwnerFlowPolicy, entityId: string): ResolvedPart | Fail {
  const entity = ctx.entities.find((e) => e.id === entityId);
  if (!entity) return fail('owner_not_found', 'That entity was not found.');
  if (!entity.isActive) return fail('owner_inactive', `${entity.name} is no longer active. Reactivate it before choosing it as an owner.`);
  if (policy.allowedEntityTypes.length === 0) {
    return fail('owner_not_allowed_for_flow', policy.entityRefusalReason ?? 'Entities cannot be chosen for this kind of document.');
  }
  if (!policy.allowedEntityTypes.includes(entity.entityType)) {
    return fail('owner_not_allowed_for_flow', `${entity.name} cannot be chosen as the owner of this kind of document.`);
  }
  const requiredCountry = BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY[entity.entityType];
  if (requiredCountry && ctx.homeCountry !== requiredCountry) {
    return fail(
      'owner_not_allowed_for_country',
      'A Hindu Undivided Family (HUF) can only be the owner of documents for accounts confirmed in India.',
      403,
    );
  }
  return { ownerRole: businessEntityOwnerRole(entity.entityType), memberId: null, entityId: entity.id, entityType: entity.entityType, label: entity.name };
}

/** PURE. See the file header for every rule. */
export function validateOwnerSelectionAgainst(ctx: OwnerContext, input: unknown, flow: OwnerFlow): OwnerValidationResult {
  if (input === undefined || input === null) {
    return fail('owner_required', 'Choose who this document belongs to before uploading it.');
  }
  const parsed = ownerSelectionSchema.safeParse(input);
  if (!parsed.success) return fail('owner_invalid', 'The owner choice was not understood. Please choose the owner again.');
  const selection = parsed.data;
  const policy = OWNER_FLOW_POLICIES[flow];

  if (!policy.allowedKinds.includes(selection.kind)) {
    if (selection.kind === 'entity') {
      return fail('owner_not_allowed_for_flow', policy.entityRefusalReason ?? 'Entities cannot be chosen for this kind of document.');
    }
    return fail('owner_not_allowed_for_flow', 'That owner type cannot be chosen for this kind of document.');
  }

  switch (selection.kind) {
    case 'member': {
      const part = resolveMember(ctx, policy, selection.memberId);
      if (isFail(part)) return part;
      return { ok: true, owner: { kind: 'member', ownerRole: part.ownerRole, ownerMemberId: part.memberId, ownerBusinessEntityId: null, entityType: null, allocations: null, label: part.label } };
    }
    case 'entity': {
      const part = resolveEntity(ctx, policy, selection.entityId);
      if (isFail(part)) return part;
      return { ok: true, owner: { kind: 'entity', ownerRole: part.ownerRole, ownerMemberId: null, ownerBusinessEntityId: part.entityId, entityType: part.entityType, allocations: null, label: part.label } };
    }
    case 'smsf': {
      // SMSF is not a business entity (it lives in smsf_funds) and is AU-only.
      if (ctx.homeCountry !== 'AU') {
        return fail('owner_not_allowed_for_country', 'An SMSF can only be chosen by accounts confirmed in Australia.', 403);
      }
      return { ok: true, owner: { kind: 'smsf', ownerRole: 'smsf', ownerMemberId: null, ownerBusinessEntityId: null, entityType: null, allocations: null, label: 'SMSF' } };
    }
    case 'joint': {
      const raw = selection.allocations;
      if (policy.jointAllocation === 'forbidden') {
        if (raw && raw.length > 0) {
          return fail('joint_allocation_not_used', 'Percentage shares are not used for bank statements. Choose "Joint" without percentages.');
        }
        return { ok: true, owner: { kind: 'joint', ownerRole: 'joint', ownerMemberId: null, ownerBusinessEntityId: null, entityType: null, allocations: null, label: 'Joint' } };
      }
      if (!raw || raw.length === 0) {
        return fail('joint_allocation_required', 'A joint statement needs each owner and their percentage share, adding up to 100%.');
      }
      if (raw.length < 2) return fail('joint_needs_two_owners', 'A joint statement needs at least two owners. For one owner, choose that owner instead.');

      const entries: Pc5AllocationEntry[] = [];
      const labels: string[] = [];
      for (const e of raw) {
        const hasMember = Boolean(e.memberId);
        const hasEntity = Boolean(e.entityId);
        if (hasMember === hasEntity) {
          return fail('joint_owner_identity', 'Each joint owner must be exactly one household member or one entity.');
        }
        const part = hasMember ? resolveMember(ctx, policy, e.memberId as string) : resolveEntity(ctx, policy, e.entityId as string);
        if (isFail(part)) return part;
        labels.push(part.label);
        entries.push({
          ...(part.memberId ? { ownerMemberId: part.memberId } : { ownerBusinessEntityId: part.entityId as string }),
          basisPoints: e.basisPoints,
        } as Pc5AllocationEntry);
      }
      const checked = validateAllocation(entries);
      if (!checked.ok) {
        switch (checked.reason) {
          case 'duplicate_owner':
            return fail('joint_duplicate_owner', 'The same owner appears more than once in the joint split.');
          case 'out_of_range_basis_points': {
            const bp = entries[(checked as { index: number }).index]?.basisPoints;
            if (bp !== undefined && bp <= 0) return fail('joint_zero_share', 'Every joint owner needs a share above zero. Remove an owner who has no share.');
            return fail('joint_share_invalid', 'A joint share must be between 0.01% and 100%.');
          }
          case 'non_integer_basis_points':
            return fail('joint_share_invalid', 'A joint share could not be read. Use up to two decimal places.');
          case 'total_not_100_percent':
            return fail('joint_total_not_100', 'The joint shares must add up to exactly 100%.');
          case 'owner_identity_missing_or_ambiguous':
            return fail('joint_owner_identity', 'Each joint owner must be exactly one household member or one entity.');
          default:
            return fail('joint_allocation_required', 'A joint statement needs each owner and their percentage share, adding up to 100%.');
        }
      }
      return {
        ok: true,
        owner: { kind: 'joint', ownerRole: 'joint', ownerMemberId: null, ownerBusinessEntityId: null, entityType: null, allocations: checked.entries, label: `Joint (${labels.join(', ')})` },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Database layer.
// ---------------------------------------------------------------------------

/** Loads the user's own owner context. Service role, EVERY query filtered by
 * `user_id`; the country comes from user_profiles, never from the request. */
export async function loadOwnerContext(userId: string): Promise<OwnerContext> {
  const admin = createAdminClient();
  const [homeCountry, membersRes, entitiesRes] = await Promise.all([
    getUserFullExperienceHomeCountry(userId, admin),
    admin.from('household_members').select('id, full_name, relationship, is_active').eq('user_id', userId).order('created_at', { ascending: true }),
    admin.from('business_entities').select('id, name, entity_type, is_active').eq('user_id', userId).order('created_at', { ascending: true }),
  ]);
  return {
    homeCountry,
    members: ((membersRes.data ?? []) as Array<Record<string, unknown>>).map((m) => ({
      id: m.id as string,
      fullName: ((m.full_name as string | null) ?? '').trim(),
      relationship: m.relationship as HouseholdMemberRelationship,
      isActive: m.is_active !== false,
    })),
    entities: ((entitiesRes.data ?? []) as Array<Record<string, unknown>>).map((e) => ({
      id: e.id as string,
      name: (e.name as string | null) ?? 'Entity',
      entityType: e.entity_type as BusinessEntityType,
      isActive: e.is_active !== false,
    })),
  };
}

export interface ValidateOwnerSelectionDeps {
  loadContext?: (userId: string) => Promise<OwnerContext>;
}

/** Server entry point: load the user's own context, then validate. */
export async function validateOwnerSelection(
  userId: string,
  input: unknown,
  flow: OwnerFlow,
  deps: ValidateOwnerSelectionDeps = {},
): Promise<OwnerValidationResult> {
  // Presence is checked BEFORE any database read: a missing owner costs nothing.
  if (input === undefined || input === null) return validateOwnerSelectionAgainst({ homeCountry: null, members: [], entities: [] }, input, flow);
  const ctx = await (deps.loadContext ?? loadOwnerContext)(userId);
  return validateOwnerSelectionAgainst(ctx, input, flow);
}
