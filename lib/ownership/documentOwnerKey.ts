/**
 * Owner-before-upload (Phase 2) -- a canonical, order-independent key for "who a
 * document belongs to", comparable across storage shapes. Pure and client-safe.
 *
 * Used to decide whether the identical file uploaded again names the SAME owner
 * (PO decision 6) for every flow, including those whose owner has no id (an SMSF,
 * or a joint account that carries no split).
 */

export interface OwnerKeyParts {
  role: string | null | undefined;
  memberId?: string | null;
  entityId?: string | null;
  /** The joint split, as stored on the document (owner_allocation) or resolved at upload. */
  allocations?: ReadonlyArray<{ ownerMemberId?: string | null; ownerBusinessEntityId?: string | null; basisPoints: number }> | null;
}

export function documentOwnerKey(p: OwnerKeyParts): string | null {
  if (!p.role) return null;
  const alloc = (p.allocations ?? [])
    .map((a) => `${a.ownerMemberId ? `member:${a.ownerMemberId}` : `entity:${a.ownerBusinessEntityId}`}=${a.basisPoints}`)
    .sort()
    .join(',');
  return [p.role, p.memberId ?? '', p.entityId ?? '', alloc].join('|');
}
