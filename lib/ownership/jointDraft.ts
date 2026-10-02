/**
 * Owner-before-upload (Phase 1) -- the joint-owner entry state, as pure logic.
 *
 * The OwnerSelector renders one row per candidate owner (checkbox + percent).
 * This module turns those rows into either a valid joint OwnerSelection (shares
 * in basis points summing to exactly 10000) or a plain-language reason it is
 * not valid yet. It lives outside the component so the conversion the user
 * relies on -- percent typed, basis points sent -- is unit-tested rather than
 * trusted to a render.
 *
 * The same rules the server enforces (lib/ownership/validateOwnerSelection.ts,
 * which delegates to lib/pc5/jointAllocation.ts validateAllocation) are applied
 * here only to give early feedback; the server never trusts this result.
 */

import { OWNER_TOTAL_BASIS_POINTS, equalShares, percentToBasisPoints, type OwnerSelection } from './ownerSelection';

export interface JointDraftRow {
  /** Stable key: `member:<id>` or `entity:<id>`. */
  key: string;
  checked: boolean;
  /** What the user typed, e.g. "33.34". */
  percentText: string;
}

export type JointDraftResult =
  | { ok: true; selection: Extract<OwnerSelection, { kind: 'joint' }>; totalBasisPoints: number }
  | { ok: false; message: string; totalBasisPoints: number };

export function parseOwnerKey(key: string): { memberId?: string; entityId?: string } | null {
  const [kind, id] = key.split(':');
  if (!id) return null;
  if (kind === 'member') return { memberId: id };
  if (kind === 'entity') return { entityId: id };
  return null;
}

/** Re-splits equally among the checked rows (used when the owner set changes). */
export function withEqualSplit(rows: readonly JointDraftRow[]): JointDraftRow[] {
  const shares = equalShares(rows.filter((r) => r.checked).length);
  let i = 0;
  return rows.map((r) => (r.checked ? { ...r, percentText: (shares[i++] / 100).toFixed(2).replace(/\.?0+$/, '') } : { ...r, percentText: '' }));
}

export function evaluateJointDraft(rows: readonly JointDraftRow[]): JointDraftResult {
  const chosen = rows.filter((r) => r.checked);
  if (chosen.length < 2) return { ok: false, message: 'Choose at least two owners for a joint statement.', totalBasisPoints: 0 };

  const allocations: Array<{ memberId?: string; entityId?: string; basisPoints: number }> = [];
  let total = 0;
  for (const r of chosen) {
    const owner = parseOwnerKey(r.key);
    if (!owner) return { ok: false, message: 'One of the owners could not be read. Please choose again.', totalBasisPoints: total };
    const bp = percentToBasisPoints(r.percentText);
    if (bp === null) return { ok: false, message: 'Enter each share as a percentage with up to two decimal places.', totalBasisPoints: total };
    if (bp <= 0) return { ok: false, message: 'Every joint owner needs a share above 0%. Untick an owner who has no share.', totalBasisPoints: total };
    total += bp;
    allocations.push({ ...owner, basisPoints: bp });
  }
  if (total !== OWNER_TOTAL_BASIS_POINTS) {
    return { ok: false, message: `The shares add up to ${(total / 100).toFixed(2)}%. They must add up to exactly 100%.`, totalBasisPoints: total };
  }
  return { ok: true, selection: { kind: 'joint', allocations }, totalBasisPoints: total };
}
