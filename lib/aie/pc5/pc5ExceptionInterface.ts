/**
 * AIE-1 closure mission (section 11) — the AIE-side interface a future PC5
 * (Investment Intelligence's own "owner/reconciliation resolution workflow"
 * roadmap phase — `docs/investment-intelligence/II_PC4_STATUS_2026_09_07.md`
 * line 138) would consume to query and resolve AIE's unresolved items.
 *
 * PC5 DOES NOT EXIST IN THIS REPOSITORY (confirmed by exhaustive search —
 * no table, route, or module anywhere named or shaped like it; it is a
 * planned, unstarted roadmap phase). This module is therefore the interface
 * and contract side of mission section 11's work, completed and tested
 * against a real consumer shape; END-TO-END PC5 CLOSURE IS EXPLICITLY
 * BLOCKED — there is no real PC5 caller to integrate with yet. Do not read
 * this module as "PC5 integration complete."
 *
 * NO PARALLEL EXCEPTION SYSTEM. Every function here is a thin, capability-
 * checked wrapper over AIE's OWN existing, already-certified mechanisms —
 * `repo.listOpenUnresolvedItemsForUser` for reads and `decideOnItem` (AIE-
 * 1.5's "the ONE path an item's status can change through") for writes. No
 * new table, no new status vocabulary, no new lifecycle. `aie_unresolved_
 * item` remains the single source of truth; this module never caches or
 * projects a second copy of it anywhere.
 *
 * CAPABILITY CHECK IS INJECTED, NOT ASSUMED. PC5 not existing means this
 * mission has no real capability/permission model to hard-code (inventing
 * one would itself be the "labelling a stub as completed integration"
 * mission section 11 explicitly forbids). `Pc5ExceptionInterfaceDeps.
 * checkCapability` is a required, caller-supplied function — whichever real
 * module eventually plays PC5's role supplies its OWN genuine capability
 * check here; this interface refuses to proceed without one (there is no
 * default that "allows everything", which would defeat the whole point).
 */

import { listOpenUnresolvedItemsForUser } from '../db/repository';
import { decideOnItem, type DecideOnItemParams, type DecideOnItemOutcome } from '../review/decide';

export interface Pc5ExceptionInterfaceDeps {
  /**
   * Returns whether `callerId` (the PC5-authenticated identity, whatever
   * that turns out to be) is permitted to act on `targetUserId`'s AIE
   * exceptions right now. MUST perform its own real authorisation check —
   * this interface applies AIE's own tenant scoping (every underlying query
   * is already scoped by `targetUserId`) as a SECOND, independent layer
   * regardless of what this function returns, matching this codebase's
   * consistent "neither layer replaces the other" discipline (see
   * `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` section 5 for the identical
   * principle applied to S3 tag-based access control).
   */
  checkCapability: (callerId: string, targetUserId: string) => Promise<boolean>;
}

export interface Pc5UnresolvedItemView {
  id: string;
  runId: string;
  reasonCode: string;
  severity: 'blocking' | 'warning';
  status: 'open' | 'in_review' | 'resolved' | 'rejected' | 'deferred' | 'superseded';
  displayCandidate: string | null;
  itemVersion: number;
}

export type Pc5ListOutcome = { ok: true; items: Pc5UnresolvedItemView[] } | { ok: false; reason: 'capability_denied' };

/**
 * Query AIE unresolved items for one tenant (mission section 11: "Query AIE
 * unresolved items. Display ownership and relevant status. Enforce tenant
 * and capability restrictions."). `targetUserId` is the AIE-side tenant
 * whose items are being listed — never inferred from the caller's own
 * identity, always explicit, so a capability check has something concrete
 * to authorise against.
 */
export async function listUnresolvedItemsForPc5(callerId: string, targetUserId: string, deps: Pc5ExceptionInterfaceDeps): Promise<Pc5ListOutcome> {
  const allowed = await deps.checkCapability(callerId, targetUserId);
  if (!allowed) return { ok: false, reason: 'capability_denied' };
  const items = await listOpenUnresolvedItemsForUser(targetUserId);
  return { ok: true, items };
}

export interface Pc5ResolveParams {
  callerId: string;
  targetUserId: string;
  itemId: string;
  action: DecideOnItemParams['action'];
  itemVersion: number;
  idempotencyKey: string;
  fieldName?: string;
  rawValue?: string;
  rationale?: string;
}

export type Pc5ResolveOutcome = { ok: false; reason: 'capability_denied' } | DecideOnItemOutcome;

/**
 * Resolve through AIE's supported transition (mission section 11: "Resolve
 * through AIE's supported transition. Preserve source identity and audit.
 * Prevent stale or double resolution."). Delegates ENTIRELY to `decideOnItem`
 * — the exact same version-checked, idempotency-keyed, tenant-scoped path
 * AIE's own review UI uses — so a PC5-initiated resolution can never diverge
 * from, or bypass, AIE's own rules for what a valid transition is. Source
 * identity is preserved because `decideOnItem` looks up the item by
 * `(itemId, targetUserId)` itself and records the decision against AIE's
 * own `aie_review_decision`/audit trail unchanged; nothing here writes a
 * second, PC5-specific resolution record anywhere.
 *
 * Stale/double resolution is prevented by the SAME mechanism AIE's own UI
 * relies on (`decideOnItem`'s `itemVersion` check plus `recordReviewDecision`'s
 * idempotency key) — this function adds no additional and no weaker guard.
 */
export async function resolveUnresolvedItemForPc5(params: Pc5ResolveParams, deps: Pc5ExceptionInterfaceDeps): Promise<Pc5ResolveOutcome> {
  const allowed = await deps.checkCapability(params.callerId, params.targetUserId);
  if (!allowed) return { ok: false, reason: 'capability_denied' };
  return decideOnItem({
    itemId: params.itemId,
    userId: params.targetUserId,
    action: params.action,
    itemVersion: params.itemVersion,
    idempotencyKey: params.idempotencyKey,
    actorId: params.callerId,
    rationale: params.rationale,
    fieldName: params.fieldName,
    rawValue: params.rawValue,
  });
}
