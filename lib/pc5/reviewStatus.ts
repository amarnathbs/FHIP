/**
 * PC5 (M4) — K.13: Review Centre status semantics, and K.16's
 * exception-only default.
 *
 * THE ONE THING THIS FILE EXISTS TO PREVENT: *"Acknowledge/Dismiss must
 * never masquerade as resolution."* (K.13, verbatim.)
 *
 * It prevents it structurally rather than by convention. Acknowledgement
 * and dismissal are recorded as `aie_review_decision` rows whose resulting
 * `aie_unresolved_item.status` is `'in_review'` — a status the acceptance
 * gate (`repo.countItemsBlockingAcceptanceForRun`, which counts
 * `open`/`in_review`/`deferred`) counts as STILL BLOCKING. So a user can
 * acknowledge every exception on a document and the document still cannot
 * be accepted, because nothing about the underlying condition changed. The
 * only statuses that stop blocking are `resolved` and `superseded`, and the
 * only writers of those are AIE's own `resolveItemBySystem` (after a real
 * re-reconciliation genuinely stopped reproducing the condition) and
 * `rejectRun`. PC5 cannot write them at all.
 *
 * DISMISSAL IS REFUSED OUTRIGHT FOR A BLOCKING ITEM. K.13 permits dismissal
 * only as "presentation suppression where allowed". There is no financial
 * circumstance in which suppressing a BLOCKING exception from view is
 * allowed — the user would then be looking at a clean-looking document that
 * still cannot be accepted, with no visible reason. So `permittedPc5Actions`
 * omits `dismiss` for `severity: 'blocking'`, and the decision service
 * refuses it a second time server-side (`cannot_dismiss_blocking_item`).
 * Warning-severity items may be dismissed.
 */

import type { AieItemSeverity, AieUnresolvedItemStatus } from '../aie/types';
import type { Pc5ResolutionAction, Pc5ResolutionStatus } from './types';

/**
 * The AIE status -> PC5 presentation status mapping. TOTAL over
 * `AieUnresolvedItemStatus` (the `never` check below fails compilation if
 * AIE ever adds a status without this function being updated — the same
 * discipline `lib/aie/review/userState.ts` already applies to run states).
 *
 * `in_review` is where the interesting judgement lives. AIE uses it for two
 * different things: "a correction has been submitted and revalidation has
 * not yet decided", and — as of PC5 — "the user has acknowledged this". Both
 * mean *the condition still exists and this item still blocks*, which is
 * exactly K.13's ACKNOWLEDGED. Mapping it to `resolved` would be the
 * masquerade this module exists to prevent; mapping it to `open` would
 * lose the fact that a human has already engaged with it.
 */
export function toPc5Status(aieStatus: AieUnresolvedItemStatus, dismissed: boolean): Pc5ResolutionStatus {
  // A dismissal is a presentation fact layered ON TOP of the AIE status,
  // never a replacement for it — which is why it is a separate parameter
  // rather than a sixth AIE status. The underlying row keeps saying
  // `in_review`, and the acceptance gate keeps counting it.
  if (dismissed) return 'dismissed';
  switch (aieStatus) {
    case 'open':
      return 'open';
    case 'in_review':
      return 'acknowledged';
    case 'resolved':
      return 'resolved';
    case 'superseded':
      return 'superseded';
    case 'rejected':
      // The whole document was declined. The item is no longer live, and
      // calling that "resolved" would imply the condition was fixed.
      return 'superseded';
    case 'deferred':
      // "Not now" is not "seen and understood", and it is emphatically not
      // resolved. AIE counts a deferred item as blocking
      // (`countItemsBlockingAcceptanceForRun`) while EXCLUDING it from
      // `listOpenUnresolvedItemsForRun` — so a deferred item currently
      // blocks the accept button while being invisible in the run detail
      // response. PC5's own listing reads a status set that includes
      // 'deferred' precisely so that cannot happen here.
      return 'open';
    default: {
      const exhaustive: never = aieStatus;
      throw new Error(`toPc5Status: unhandled AieUnresolvedItemStatus ${String(exhaustive)}`);
    }
  }
}

/** The AIE statuses PC5 lists. Deliberately WIDER than
 * `listOpenUnresolvedItemsForRun`'s `['open','in_review']`: it adds
 * `'deferred'` so the set PC5 shows and the set the acceptance gate counts
 * are the same set. A user must never be blocked by something they cannot
 * see. */
export const PC5_LIVE_ITEM_STATUSES: readonly AieUnresolvedItemStatus[] = ['open', 'in_review', 'deferred'];

/** Statuses that no longer block and are shown only in history. */
export const PC5_TERMINAL_ITEM_STATUSES: readonly AieUnresolvedItemStatus[] = ['resolved', 'rejected', 'superseded'];

/** True when this item still stands between the user and acceptance. Mirrors
 * `repo.countItemsBlockingAcceptanceForRun`'s own predicate exactly
 * (`severity = 'blocking'` AND status in open/in_review/deferred) — stated
 * once here so the UI's "N still to resolve" and the server's refusal can
 * never disagree. */
export function itemStillBlocks(severity: AieItemSeverity, aieStatus: AieUnresolvedItemStatus): boolean {
  return severity === 'blocking' && (PC5_LIVE_ITEM_STATUSES as readonly string[]).includes(aieStatus);
}

/**
 * ASSUMPTION VERIFIED FRESH, NOT INHERITED: an Investment Intelligence
 * IDENTITY exception is deliberately recorded TWICE by
 * `lib/aie/adapters/investment-intelligence/dispatch.ts` — once as a typed
 * `aie_unresolved_item`, and once as a paired `fail` row in
 * `aie_reconciliation_run` carrying rule id
 * `ii_adapter_identity:<that item's reasonCode>` (dispatch.ts's own
 * `recordReconciliationRuns` call). That is intentional and correct at the
 * AIE layer: the acceptance gate checks the blocking-item COUNT and the
 * reconciliation OUTCOME independently, and a document blocked on one
 * signal but reading `pass` on the other is the inconsistency that invites
 * an "accept anyway" shortcut later.
 *
 * It is NOT correct to show a user two exceptions for one problem. This
 * predicate identifies the reconciliation half so a PC5 view can drop it:
 * the typed item is the one with a human question, a permitted action set
 * and a resolution path, so the typed item is the one that survives.
 */
export const II_IDENTITY_RECONCILIATION_RULE_PREFIX = 'ii_adapter_identity:';

export function isIdentityMirrorRuleId(ruleId: string): boolean {
  return ruleId.startsWith(II_IDENTITY_RECONCILIATION_RULE_PREFIX);
}

export function reasonCodeBehindIdentityMirror(ruleId: string): string | null {
  return isIdentityMirrorRuleId(ruleId) ? ruleId.slice(II_IDENTITY_RECONCILIATION_RULE_PREFIX.length) : null;
}

/**
 * Drops the reconciliation half of every identity pair from a list of
 * reconciliation findings, given the typed items that exist alongside them.
 * A mirror row whose typed partner is MISSING is kept — that would mean the
 * pairing invariant has broken, and hiding the only remaining evidence of a
 * real blocking condition would be far worse than showing one extra row.
 */
export function dropIdentityMirrors<T extends { ruleId: string }>(
  reconciliationFindings: readonly T[],
  typedItemReasonCodes: ReadonlySet<string>,
): T[] {
  return reconciliationFindings.filter((f) => {
    const mirrored = reasonCodeBehindIdentityMirror(f.ruleId);
    if (mirrored === null) return true;
    return !typedItemReasonCodes.has(mirrored);
  });
}

/**
 * K.16 — exception-only review. The default surface shows only MATERIAL
 * unresolved items; everything correctly extracted stays behind an
 * expandable full view. "Material" is defined by AIE's own severity, not by
 * a PC5 opinion: `blocking` is always material; `warning` is material only
 * while it is still live.
 */
export function isMaterialForDefaultView(severity: AieItemSeverity, aieStatus: AieUnresolvedItemStatus): boolean {
  if (severity === 'blocking') return (PC5_LIVE_ITEM_STATUSES as readonly string[]).includes(aieStatus);
  return aieStatus === 'open';
}

/**
 * Which PC5 actions are offered for an item, as a pure function of facts
 * that are all server-side.
 *
 * `persistedPermittedActionTypes` is `aie_unresolved_item.permitted_action_
 * types` — the column AIE-1.1 has written on every item since migration
 * 0140 and which, before this phase, NOTHING EVER READ BACK. That was a real
 * latent hazard rather than harmless dead weight: the persisted bound and
 * the static reason-code registry could diverge silently and no test or
 * runtime check would notice. PC5 now reads it and treats it as the OUTER
 * BOUND: an action must be permitted by the row AND meaningful for the
 * reason code AND legal under PC5's own domain rules. Narrowing is always
 * safe; widening is never done here.
 */
export function permittedPc5Actions(params: {
  severity: AieItemSeverity;
  aieStatus: AieUnresolvedItemStatus;
  persistedPermittedActionTypes: readonly string[];
  /** True when the reason code has a resolvable domain choice (an owner to
   * pick, an account to disambiguate, a duplicate to confirm). */
  hasChoiceField: boolean;
  alreadyDismissed: boolean;
}): Pc5ResolutionAction[] {
  const { severity, aieStatus, persistedPermittedActionTypes, hasChoiceField, alreadyDismissed } = params;

  // Nothing is actionable on an item that is no longer live.
  if (!(PC5_LIVE_ITEM_STATUSES as readonly string[]).includes(aieStatus)) return [];

  const bound = new Set(persistedPermittedActionTypes);
  const actions: Pc5ResolutionAction[] = [];

  if (hasChoiceField && bound.has('choose_value')) actions.push('choose_value');

  // Acknowledge is always available on a live item and needs no persisted
  // permission: it changes nothing financial, asserts nothing, and cannot
  // unblock anything. It exists so a user can record "I have seen this"
  // without that being mistaken for a resolution.
  if (aieStatus !== 'in_review') actions.push('acknowledge');

  // K.13: presentation suppression only, and never for a blocking item.
  if (severity === 'warning' && !alreadyDismissed) actions.push('dismiss');

  // K.11: discarding the whole statement is always offered on a live item —
  // "this is not my document" must never be a dead end.
  actions.push('discard_statement');

  return actions;
}
