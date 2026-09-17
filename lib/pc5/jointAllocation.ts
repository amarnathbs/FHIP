/**
 * PC5 (M4) — K.6: joint ownership allocation.
 *
 * WHAT K.6 ACTUALLY ASKS FOR, AND WHAT MAKES IT HARD.
 *   - default equal ownership (50/50 for two owners) where no better
 *     evidence exists;
 *   - the user may edit the allocation;
 *   - **the total must equal 100%**;
 *   - allocations are explicit evidence/decision records, audited and
 *     effective-dated/amended as appropriate;
 *   - and, crucially: *"household total must still count the economic asset
 *     once, with owner breakdown separately represented."*
 *
 * The last clause is global invariant D.2 restated, and it is the reason
 * this module produces basis points and nothing else. An allocation row
 * carries no amount and no currency, so there is no arithmetic path by
 * which the breakdown could ever add a second contribution to net worth —
 * the position is counted once from its canonical Investment Intelligence
 * row, exactly as it is today, and this module only says how to attribute
 * that single number. Structural impossibility, rather than a rule someone
 * has to remember.
 *
 * WHY BASIS POINTS RATHER THAN PERCENT. "The total must equal 100%" is a
 * hard requirement, not a tolerance, and a three-way split cannot satisfy
 * it in two decimal places: 33.33 x 3 = 99.99. Integers out of 10000 make
 * 3333 + 3333 + 3334 exact and the check trivially decidable. The existing
 * `business_entities.ownership_percentage numeric(5,2)` shape was
 * deliberately NOT reused for the same reason — it models a single entity's
 * consolidation factor, where no cross-row sum is ever asserted.
 *
 * THE REMAINDER RULE. An equal default for a count that does not divide
 * evenly gives the remainder to the LAST owner in the supplied order, and
 * the order is the caller's stable order (matched holders first, in the
 * order the statement printed them). That is deterministic and inspectable.
 * It is not "fair" in any deeper sense, and it is not trying to be: the
 * point of a default is to be a starting position the user can see and
 * edit, per K.6's own "user may edit allocation".
 */

import type { Pc5AllocationEntry } from './types';

export const PC5_TOTAL_BASIS_POINTS = 10000;

export type Pc5AllocationValidationFailure =
  | { ok: false; reason: 'no_owners' }
  | { ok: false; reason: 'duplicate_owner'; ownerKey: string }
  | { ok: false; reason: 'owner_identity_missing_or_ambiguous'; index: number }
  | { ok: false; reason: 'non_integer_basis_points'; index: number }
  | { ok: false; reason: 'out_of_range_basis_points'; index: number }
  | { ok: false; reason: 'total_not_100_percent'; total: number };

export type Pc5AllocationValidationResult = Pc5AllocationValidationFailure | { ok: true; entries: Pc5AllocationEntry[] };

/** The stable key identifying one owner within an allocation group — the
 * same expression the database's own unique index uses
 * (`coalesce(owner_member_id, owner_business_entity_id)`), so application
 * validation and the constraint cannot disagree about what "the same owner
 * twice" means. */
export function allocationOwnerKey(entry: Pc5AllocationEntry): string | null {
  if (entry.ownerMemberId && entry.ownerBusinessEntityId) return null; // ambiguous — both set
  return entry.ownerMemberId ?? entry.ownerBusinessEntityId ?? null;
}

/**
 * Validates a user-supplied allocation. PURE, and deliberately strict in
 * ways a UI might be tempted to soften:
 *   - a zero share is REJECTED, not normalised away. "Priya owns 0%" and
 *     "Priya is not an owner" are different assertions, and silently
 *     converting the first into the second would lose the user's actual
 *     statement. The database CHECK agrees (`allocation_basis_points > 0`).
 *   - a total of 9999 or 10001 is REJECTED rather than scaled to fit.
 *     Auto-scaling a near-miss would mean the stored allocation is not the
 *     one the user submitted, which K.6's "allocations are explicit
 *     evidence/decision records" forbids.
 */
export function validateAllocation(entries: readonly Pc5AllocationEntry[]): Pc5AllocationValidationResult {
  if (entries.length === 0) return { ok: false, reason: 'no_owners' };

  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const key = allocationOwnerKey(entry);
    if (!key) return { ok: false, reason: 'owner_identity_missing_or_ambiguous', index: i };
    if (seen.has(key)) return { ok: false, reason: 'duplicate_owner', ownerKey: key };
    seen.add(key);

    if (!Number.isInteger(entry.basisPoints)) return { ok: false, reason: 'non_integer_basis_points', index: i };
    if (entry.basisPoints <= 0 || entry.basisPoints > PC5_TOTAL_BASIS_POINTS) {
      return { ok: false, reason: 'out_of_range_basis_points', index: i };
    }
    total += entry.basisPoints;
  }

  if (total !== PC5_TOTAL_BASIS_POINTS) return { ok: false, reason: 'total_not_100_percent', total };
  return { ok: true, entries: entries.map((e) => ({ ...e })) };
}

/**
 * K.6's default: equal ownership where no better evidence exists. Two
 * owners give exactly 5000/5000; the remainder rule above handles the rest.
 *
 * Returns an empty array for an empty owner list rather than throwing — the
 * caller's own "is this joint at all" decision is upstream of this, and a
 * throw here would turn a legitimately-empty match set into a crash.
 */
export function defaultEqualAllocation(
  owners: readonly { ownerMemberId?: string; ownerBusinessEntityId?: string }[],
): Pc5AllocationEntry[] {
  if (owners.length === 0) return [];
  const base = Math.floor(PC5_TOTAL_BASIS_POINTS / owners.length);
  const remainder = PC5_TOTAL_BASIS_POINTS - base * owners.length;
  return owners.map((o, i) => ({
    ...o,
    basisPoints: i === owners.length - 1 ? base + remainder : base,
  }));
}

/** Presentation only. 3334 -> "33.34%". Never used for arithmetic. */
export function formatBasisPoints(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

/**
 * K.5 -> K.6 bridge. The canonical FHIP owner ROLE for a position whose
 * ownership has been split. This is the value that eventually reaches
 * `investments.owner` / `ii_fhip_publications.published_owner`, both of
 * which are constrained to the same eight-value enum since migration 0004.
 *
 * A split across two or more owners is `'joint'` — the enum's own existing
 * value for exactly this, which is why PC5 introduces no new ownership
 * vocabulary. A single-owner "allocation" (100% to one person) keeps that
 * person's own derived role instead, because calling a sole holding
 * "joint" would be wrong in the register and would change how downstream
 * engines read it.
 */
export function ownerRoleForAllocation(entries: readonly Pc5AllocationEntry[], singleOwnerRole: string): string {
  return entries.length > 1 ? 'joint' : singleOwnerRole;
}
