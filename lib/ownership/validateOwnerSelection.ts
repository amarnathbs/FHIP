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
import type { BusinessEntityType } from '@/lib/validation/businessEntity';
import type { Pc5AllocationEntry } from '@/lib/pc5/types';
// ONE ownership model (PO-OBU-04). Who may be an owner -- belongs to the user, active, HUF only for an
// India-confirmed user, a joint split exactly 100% -- is decided by the canonical model every owner
// mutation uses (Investment Intelligence's ownerModel.validateOwnerSelection). This module adds only what
// admission needs on top: the per-FLOW policy (which kinds / roles a document type can carry), SMSF
// (which is not a business entity), and a required-owner / wire-format layer. It restates none of the rules.
import { validateOwnerSelection as validateCanonicalOwner, type OwnerChoiceContext, type OwnerFailure } from '@/lib/services/investment-intelligence/ownerModel';
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
  /** Why SMSF is not offered for this flow (it is a separate workspace, not an owner label). */
  smsfRefusalReason?: string;
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
  // ---- Phase 2 ------------------------------------------------------------
  // Income: a payslip is a person's income. The Income architecture records the owner as
  // 'self' | 'spouse' (income_sources.owner / fdh_payroll_events.income_owner, 0207/0210);
  // it has no SMSF, trust, HUF or company income isolation, so none is offered.
  payslip: {
    allowedKinds: ['member'],
    allowedMemberRoles: ['self', 'spouse'],
    allowedEntityTypes: [],
    jointAllocation: 'forbidden',
    entityRefusalReason: 'Income from a company, trust or HUF cannot be imported here yet: it would need its own separate income records, so it is not mixed into your personal income.',
    smsfRefusalReason: 'An SMSF does not receive payslips. Choose the person the payslip belongs to.',
  },
  // Liabilities: only owners the canonical Liabilities model separates correctly today
  // (fdh_financial_accounts.owner_role self/spouse/joint/smsf; isHouseholdOwner excludes
  // smsf). Company / trust / HUF debt is refused until entity debt isolation exists, so no
  // entity debt can enter personal DTI / DSR.
  liability: {
    allowedKinds: ['member', 'joint', 'smsf'],
    allowedMemberRoles: ['self', 'spouse'],
    allowedEntityTypes: [],
    jointAllocation: 'forbidden',
    entityRefusalReason: 'Company, trust and HUF loans and cards cannot be imported here yet: entity debt must stay out of your personal debt ratios until it has its own separate records.',
  },
  // Retirement: super belongs to a person (the Retirement model's members). An SMSF is its own
  // workspace with its own balances; a generic "owner" label on a statement must never create
  // a second copy of SMSF value, so SMSF is not an owner here.
  retirement: {
    allowedKinds: ['member'],
    allowedMemberRoles: ['self', 'spouse'],
    allowedEntityTypes: [],
    jointAllocation: 'forbidden',
    entityRefusalReason: 'Retirement statements belong to a person. Companies, trusts and HUFs do not hold super or provident fund accounts.',
    smsfRefusalReason: 'A self-managed super fund is managed in the SMSF section of the Retirement page, not by importing a statement under an owner label.',
  },
  // AU investment statements: Self / Spouse / Joint (percentages required, same allocation
  // model as the CAS). Entity-held AU holdings stay out until the entity investment
  // architecture keeps them out of personal holdings.
  au_investment: {
    allowedKinds: ['member', 'joint'],
    allowedMemberRoles: ['self', 'spouse'],
    allowedEntityTypes: [],
    jointAllocation: 'required',
    entityRefusalReason: 'Investments held by a company, trust or SMSF cannot be imported here yet: they must stay out of your personal holdings until they have their own separate records.',
    smsfRefusalReason: 'SMSF holdings are managed in the SMSF section, not by importing a statement under an owner label.',
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

function toCanonicalContext(ctx: OwnerContext): OwnerChoiceContext {
  return {
    homeCountry: ctx.homeCountry,
    members: ctx.members.map((m) => ({ id: m.id, full_name: m.fullName, relationship: m.relationship, is_active: m.isActive })),
    entities: ctx.entities.map((e) => ({ id: e.id, name: e.name, entity_type: e.entityType, is_active: e.isActive })),
  };
}

/** Maps a canonical-model failure to this module's admission codes and wording. */
function fromCanonical(f: OwnerFailure, lines?: ReadonlyArray<{ basisPoints: number }>): Fail {
  switch (f.code) {
    case 'OWNER_MEMBER_NOT_FOUND':
      return fail('owner_not_found', 'That household member was not found.');
    case 'OWNER_ENTITY_NOT_FOUND':
      return fail('owner_not_found', 'That entity was not found.');
    case 'OWNER_MEMBER_INACTIVE':
      return fail('owner_inactive', 'That household member is no longer active. Reactivate them before choosing them as an owner.');
    case 'OWNER_ENTITY_INACTIVE':
      return fail('owner_inactive', 'That entity is no longer active. Reactivate it before choosing it as an owner.');
    case 'OWNER_ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY':
      return fail('owner_not_allowed_for_country', 'A Hindu Undivided Family (HUF) can only be the owner of documents for accounts confirmed in India.', 403);
    case 'JOINT_REQUIRES_TWO_OWNERS':
      return fail('joint_needs_two_owners', 'A joint statement needs at least two owners. For one owner, choose that owner instead.');
    case 'JOINT_ALLOCATION_INVALID':
      switch (f.reason) {
        case 'duplicate_owner':
          return fail('joint_duplicate_owner', 'The same owner appears more than once in the joint split.');
        case 'out_of_range_basis_points':
          return lines?.some((l) => l.basisPoints <= 0)
            ? fail('joint_zero_share', 'Every joint owner needs a share above zero. Remove an owner who has no share.')
            : fail('joint_share_invalid', 'A joint share must be between 0.01% and 100%.');
        case 'non_integer_basis_points':
          return fail('joint_share_invalid', 'A joint share could not be read. Use up to two decimal places.');
        case 'total_not_100_percent':
          return fail('joint_total_not_100', 'The joint shares must add up to exactly 100%.');
        case 'owner_identity_missing_or_ambiguous':
          return fail('joint_owner_identity', 'Each joint owner must be exactly one household member or one entity.');
        default:
          return fail('joint_allocation_required', 'A joint statement needs each owner and their percentage share, adding up to 100%.');
      }
    default:
      return fail('owner_invalid', 'The owner choice was not understood. Please choose the owner again.');
  }
}

function resolveMember(ctx: OwnerContext, policy: OwnerFlowPolicy, memberId: string): ResolvedPart | Fail {
  const canonical = validateCanonicalOwner({ kind: 'member', member_id: memberId }, toCanonicalContext(ctx));
  if (!canonical.ok) return fromCanonical(canonical);
  const member = ctx.members.find((m) => m.id === memberId) as OwnerContextMember;
  const role = canonical.owner.ownerRole as Owner;
  if (!policy.allowedMemberRoles.includes(role)) {
    return fail('owner_not_allowed_for_flow', `${member.fullName || 'That household member'} cannot be chosen as the owner of this kind of document.`);
  }
  return { ownerRole: role, memberId: member.id, entityId: null, entityType: null, label: member.fullName || 'Household member' };
}

function resolveEntity(ctx: OwnerContext, policy: OwnerFlowPolicy, entityId: string): ResolvedPart | Fail {
  const canonical = validateCanonicalOwner({ kind: 'entity', business_entity_id: entityId }, toCanonicalContext(ctx));
  if (!canonical.ok) return fromCanonical(canonical);
  const entity = ctx.entities.find((e) => e.id === entityId) as OwnerContextEntity;
  if (policy.allowedEntityTypes.length === 0) {
    return fail('owner_not_allowed_for_flow', policy.entityRefusalReason ?? 'Entities cannot be chosen for this kind of document.');
  }
  if (!policy.allowedEntityTypes.includes(entity.entityType)) {
    return fail('owner_not_allowed_for_flow', `${entity.name} cannot be chosen as the owner of this kind of document.`);
  }
  return { ownerRole: canonical.owner.ownerRole as Owner, memberId: null, entityId: entity.id, entityType: entity.entityType, label: entity.name };
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
    if (selection.kind === 'smsf' && policy.smsfRefusalReason) {
      return fail('owner_not_allowed_for_flow', policy.smsfRefusalReason);
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
      }
      // The split itself (no duplicate owner, no zero / fractional share, exactly 10000 bp) is the canonical
      // model's rule, so an upload and an owner amendment can never disagree about what a valid split is.
      const canonical = validateCanonicalOwner(
        { kind: 'joint', allocations: raw.map((e) => ({ ...(e.memberId ? { member_id: e.memberId } : { business_entity_id: e.entityId as string }), basis_points: e.basisPoints })) },
        toCanonicalContext(ctx),
      );
      if (!canonical.ok) return fromCanonical(canonical, raw);
      return {
        ok: true,
        owner: { kind: 'joint', ownerRole: 'joint', ownerMemberId: null, ownerBusinessEntityId: null, entityType: null, allocations: canonical.owner.entries as Pc5AllocationEntry[], label: `Joint (${labels.join(', ')})` },
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
