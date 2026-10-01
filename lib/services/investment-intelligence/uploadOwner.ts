/**
 * Owner-before-upload (Phase 1) -- Investment Intelligence upload route
 * helpers: which owner columns an upload writes, and how an identical re-upload
 * under a DIFFERENT owner is recognised (PO decision 6).
 *
 * Kept out of the route so both rules are unit-testable without a request, a
 * storage bucket or a database.
 */

import type { ResolvedOwner } from '@/lib/ownership/validateOwnerSelection';
import { ownerSignature, labelOfSignature, ownerNames } from './documentOwner';
import { createAdminClient } from '@/lib/supabase/admin';

/** The owner columns an ii_source_documents INSERT carries for a validated owner. */
export function ownerColumnsFor(owner: ResolvedOwner): Record<string, unknown> {
  return {
    owner_member_id: owner.kind === 'member' ? owner.ownerMemberId : null,
    owner_business_entity_id: owner.kind === 'entity' ? owner.ownerBusinessEntityId : null,
    owner_role: owner.ownerRole,
    owner_selection_source: 'user_selected',
    owner_allocation:
      owner.kind === 'joint' && owner.allocations
        ? owner.allocations.map((a) => ({ ...(a.ownerMemberId ? { ownerMemberId: a.ownerMemberId } : { ownerBusinessEntityId: a.ownerBusinessEntityId }), basisPoints: a.basisPoints }))
        : null,
  };
}

/** The columns that exist before migration 0236 (member-owned uploads still
 * work on a database one migration behind). */
export function legacyOwnerColumnsFor(owner: ResolvedOwner): Record<string, unknown> {
  return { owner_member_id: owner.kind === 'member' ? owner.ownerMemberId : null };
}

export function isMissingOwnerColumnError(message: string | null | undefined): boolean {
  return /owner_(role|business_entity_id|selection_source|allocation|review)/.test(message ?? '') && /(column|schema cache|does not exist)/i.test(message ?? '');
}

export function signatureOfResolvedOwner(owner: ResolvedOwner): string | null {
  return ownerSignature({
    memberId: owner.ownerMemberId,
    entityId: owner.ownerBusinessEntityId,
    allocations: owner.allocations?.map((a) => ({ ownerMemberId: a.ownerMemberId ?? null, ownerBusinessEntityId: a.ownerBusinessEntityId ?? null, basisPoints: a.basisPoints })) ?? null,
  });
}

export function signatureOfDocumentRow(row: Record<string, unknown>): string | null {
  const alloc = row.owner_allocation as Array<{ ownerMemberId?: string; ownerBusinessEntityId?: string; basisPoints: number }> | null | undefined;
  return ownerSignature({
    memberId: (row.owner_member_id as string | null | undefined) ?? null,
    entityId: (row.owner_business_entity_id as string | null | undefined) ?? null,
    allocations: Array.isArray(alloc) && alloc.length > 1 ? alloc : null,
  });
}

export type IdenticalUploadOwnerVerdict =
  | { kind: 'same_owner' }
  | { kind: 'different_owner'; existingOwnerLabel: string }
  | { kind: 'existing_has_no_owner' };

/** PURE once the labels are supplied. Decision 6: same bytes + a different
 * owner is never silently accepted. */
export function compareIdenticalUploadOwner(existingSig: string | null, selectedSig: string | null, labelOf: (sig: string) => string): IdenticalUploadOwnerVerdict {
  if (!existingSig) return { kind: 'existing_has_no_owner' };
  if (existingSig === selectedSig) return { kind: 'same_owner' };
  return { kind: 'different_owner', existingOwnerLabel: labelOf(existingSig) };
}

export async function verdictForIdenticalUpload(userId: string, existingRow: Record<string, unknown>, owner: ResolvedOwner): Promise<IdenticalUploadOwnerVerdict> {
  const existingSig = signatureOfDocumentRow(existingRow);
  const selectedSig = signatureOfResolvedOwner(owner);
  if (!existingSig || existingSig === selectedSig) return compareIdenticalUploadOwner(existingSig, selectedSig, () => '');
  const names = await ownerNames(userId, createAdminClient());
  return compareIdenticalUploadOwner(existingSig, selectedSig, (sig) => labelOfSignature(sig, names));
}

export function identicalUploadMessage(verdict: Exclude<IdenticalUploadOwnerVerdict, { kind: 'same_owner' }>, selectedLabel: string): string {
  if (verdict.kind === 'existing_has_no_owner') {
    return (
      'This exact file was already uploaded, and no owner was recorded for it. It was not uploaded again, and your choice of ' +
      `${selectedLabel} was not applied to it. Open the existing statement and set the owner on its folios under Resolutions.`
    );
  }
  return (
    `This exact file was already uploaded under ${verdict.existingOwnerLabel}. You chose ${selectedLabel} this time, so it was not uploaded again. ` +
    'If the first owner was wrong, change it on the existing statement; otherwise choose the same owner as before.'
  );
}
