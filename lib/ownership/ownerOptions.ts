/**
 * Owner-before-upload (Phase 1) -- the owners a user may choose from, for one
 * upload flow.
 *
 * Built by running every candidate through `validateOwnerSelectionAgainst`, so
 * the list the browser SHOWS and the rule the server ENFORCES are one piece of
 * logic -- an option can never be offered that the upload would then refuse.
 *
 * Inactive members / entities are not listed at all (reactivate first, where
 * the consequence is visible). HUF is listed only for an India user; SMSF only
 * for an AU user in a flow that allows it. The country is the authoritative
 * home country in the context, never a request value.
 */

import { OWNER_FLOW_POLICIES, validateOwnerSelectionAgainst, type OwnerContext } from './validateOwnerSelection';
import type { OwnerFlow } from './ownerSelection';
import type { Owner } from '@/lib/constants';

export interface OwnerMemberOption {
  id: string;
  label: string;
  /** "You", "Spouse", "Partner", "Child", ... */
  detail: string;
  ownerRole: Owner;
}
export interface OwnerEntityOption {
  id: string;
  label: string;
  /** "Family trust", "HUF", "Company". */
  detail: string;
  entityType: 'company' | 'family_trust' | 'huf';
}
export interface OwnerOptionsPayload {
  flow: OwnerFlow;
  members: OwnerMemberOption[];
  entities: OwnerEntityOption[];
  joint: { available: boolean; requiresPercentages: boolean; candidateCount: number };
  smsf: { available: boolean };
  /** Shown when this flow cannot take entities at all (bank, today). */
  entityNotice: string | null;
}

const ENTITY_DETAIL: Record<string, string> = {
  company: 'Company',
  family_trust: 'Family trust',
  huf: 'HUF',
};

function relationshipDetail(relationship: string): string {
  switch (relationship) {
    case 'self':
      return 'You';
    case 'spouse':
      return 'Spouse';
    case 'partner':
      return 'Partner';
    case 'child':
      return 'Child';
    case 'parent':
      return 'Parent';
    case 'other_dependant':
      return 'Dependant';
    default:
      return 'Household member';
  }
}

export function buildOwnerOptions(ctx: OwnerContext, flow: OwnerFlow): OwnerOptionsPayload {
  const policy = OWNER_FLOW_POLICIES[flow];

  const members: OwnerMemberOption[] = [];
  for (const m of ctx.members) {
    if (!m.isActive) continue;
    const verdict = validateOwnerSelectionAgainst(ctx, { kind: 'member', memberId: m.id }, flow);
    if (!verdict.ok) continue;
    members.push({ id: m.id, label: m.fullName || '(unnamed household member)', detail: relationshipDetail(m.relationship), ownerRole: verdict.owner.ownerRole });
  }
  // Self first, then creation order (the loader already orders by created_at).
  members.sort((a, b) => (a.ownerRole === 'self' ? 0 : 1) - (b.ownerRole === 'self' ? 0 : 1));

  const entities: OwnerEntityOption[] = [];
  if (policy.allowedKinds.includes('entity')) {
    for (const e of ctx.entities) {
      if (!e.isActive) continue;
      const verdict = validateOwnerSelectionAgainst(ctx, { kind: 'entity', entityId: e.id }, flow);
      if (!verdict.ok) continue;
      entities.push({ id: e.id, label: e.name, detail: ENTITY_DETAIL[e.entityType] ?? 'Entity', entityType: e.entityType });
    }
  }

  const candidateCount = members.length + entities.length;
  const jointAllowed = policy.allowedKinds.includes('joint');
  const joint = {
    available: jointAllowed && (policy.jointAllocation === 'forbidden' || candidateCount >= 2),
    requiresPercentages: policy.jointAllocation === 'required',
    candidateCount,
  };

  const smsf = {
    available: policy.allowedKinds.includes('smsf') && validateOwnerSelectionAgainst(ctx, { kind: 'smsf' }, flow).ok,
  };

  return {
    flow,
    members,
    entities,
    joint,
    smsf,
    entityNotice: policy.allowedKinds.includes('entity') ? null : policy.entityRefusalReason ?? null,
  };
}
