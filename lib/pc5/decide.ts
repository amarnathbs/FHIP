/**
 * PC5 (M4) — the governed decision service. This is the write half of
 * K.2's *"turn unresolved ownership/reconciliation from a passive Review
 * Centre observation into a governed user-resolution workflow."*
 *
 * ================================================================
 * THE ORDER OF OPERATIONS, AND WHY EACH STEP IS WHERE IT IS
 * ================================================================
 *   1. FLAG. Refused first so a disabled environment never touches data.
 *   2. LOAD THE ITEM, OWNERSHIP-SCOPED. `.eq('user_id', ...)` inside the
 *      query, so a cross-tenant id is `not_found` — indistinguishable from
 *      a nonexistent one, and therefore useless for probing which ids exist
 *      (K.20).
 *   3. RE-DERIVE THE PERMITTED ACTION SET SERVER-SIDE, from the persisted
 *      `permitted_action_types` bound, the reason-code registry and the
 *      item's live status. NEVER from anything the client sent. A client
 *      that posts `action: 'choose_value'` for an item whose row does not
 *      permit it is refused here even though the UI would never offer it.
 *   4. RE-DERIVE THE PERMITTED OPTION SET, from canonical tenant-scoped
 *      data — again, not from the client, and not from the candidate ids
 *      recorded in `evidence_ref` (those are an audit of what was offered,
 *      not a live permission). This is the step that makes "browser forges
 *      a victim's household-member id" structurally impossible: the id
 *      simply is not in the set, because the set came from a query filtered
 *      by the caller's own user id.
 *   5. VALIDATE THE ALLOCATION, if one was supplied. Totals to exactly
 *      10000 basis points, no duplicates, every owner drawn from the same
 *      re-derived option set.
 *   6. RECORD THE DECISION through AIE's own version-checked path.
 *   7. WRITE THE ALLOCATION, only after the decision row exists, so the
 *      allocation can reference the decision that authorised it.
 *   8. RE-RECONCILE, and stamp the decision with when that happened.
 *
 * Steps 6-8 are not one transaction and cannot be (PostgREST exposes no
 * multi-statement transaction). The order is chosen so every interruption
 * leaves a truthful state: a decision with no allocation reads as "decided,
 * not yet applied" and its item is still `in_review` and still blocking; an
 * allocation with no decision cannot occur, because the decision is
 * written first.
 *
 * ================================================================
 * WHAT THIS SERVICE CANNOT DO, BY CONSTRUCTION
 * ================================================================
 *   - It cannot mark an item `resolved`. `recordGovernedResolutionForPc5`
 *     types `newStatus` to `'in_review'`. Only a re-reconciliation that
 *     genuinely stopped reproducing the condition may resolve an item, via
 *     AIE's own `resolveItemBySystem`. This is K.13's "Acknowledge/Dismiss
 *     must never masquerade as resolution" enforced one layer below the UI.
 *   - It cannot write a canonical Investment Intelligence table. It imports
 *     no II write service and holds no reference to `processSourceDocument`
 *     (K.20: "PC5 cannot direct-write canonical Investment tables"). The
 *     only path to a canonical row remains
 *     `POST /api/aie/review/runs/{runId}/accept`.
 *   - It cannot accept a typed balancing number for a summary mismatch.
 *     K.9's option set contains no free-form value at all.
 */

import {
  getUnresolvedItemForUserPc5,
  getParserVersionForRun,
  getAdapterIdForRun,
  listDecisionsForItemsPc5,
  markDecisionReReconciled,
  type AieUnresolvedItemFullRow,
} from '@/lib/aie/db/repository';
import { recordGovernedResolutionForPc5 } from '@/lib/aie/pc5/pc5ExceptionInterface';
import { resolveModuleDescriptorByAdapterId, resolveReasonCodeMeta } from '@/lib/aie/review/moduleRegistry';
import { II_ADAPTER_ID } from '@/lib/aie/adapters/investment-intelligence';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { createPc5CapabilityDeps } from './capability';
import { isPc5ResolutionEnabled } from './featureFlags';
import { defaultEqualAllocation, ownerRoleForAllocation, validateAllocation } from './jointAllocation';
import { candidateIdsFromEvidence, isCurrentlyDismissed, PC5_DECISION_ACKNOWLEDGE, PC5_DECISION_CHOOSE, PC5_DECISION_DISMISS } from './projection';
import { isPermittedChoice, PC5_JOINT_OPTION_VALUE, resolveOptionsForSource, resolveOwnerOptions } from './optionSets';
import { permittedPc5Actions } from './reviewStatus';
import { recordAllocationGroup } from './allocationStore';
import { reReconcileInvestmentRun, type Pc5ResolutionOverrides } from './reReconciliation';
import type { Pc5AllocationEntry, Pc5DecisionRefusal, Pc5ResolutionAction } from './types';

export interface Pc5DecideParams {
  userId: string;
  itemId: string;
  action: Pc5ResolutionAction;
  itemVersion: number;
  idempotencyKey: string;
  /** For `choose_value`. */
  chosenValue?: string;
  /** For a joint choice — K.6. Omitted for a single-owner choice. */
  allocation?: readonly Pc5AllocationEntry[];
  /** The ii_accounts row the allocation attaches to. Required only when an
   * allocation is supplied. */
  iiAccountId?: string;
  rationale?: string;
  /** Needed to rebuild the reconciliation context. Resolved by the route
   * from the authenticated profile — never from the document. */
  countryCode: string;
}

export type Pc5DecideOutcome =
  | { ok: false; reason: Pc5DecisionRefusal; detail?: string }
  | {
      ok: true;
      decisionId: string | null;
      replayed: boolean;
      allocationGroupId: string | null;
      reReconciliation:
        | { ran: false; reason: string }
        | { ran: true; runStatus: 'unresolved' | 'awaiting_acceptance'; openBlockingItemCount: number; newItemIds: string[]; resolvedItemIds: string[] };
    };

/** Maps a PC5 action to the `decision_type` recorded in
 * `aie_review_decision`. Every value is `pc5_`-prefixed so the decision
 * trail distinguishes a PC5-originated decision from AIE's own
 * (`correct`/`not_present`/`defer`) and from its system actors
 * (`auto_resolved_by_revalidation`/`superseded_by_revalidation`) without
 * needing a second column. */
export function decisionTypeFor(action: Pc5ResolutionAction): string {
  switch (action) {
    case 'choose_value':
      return PC5_DECISION_CHOOSE;
    case 'acknowledge':
      return PC5_DECISION_ACKNOWLEDGE;
    case 'dismiss':
      return PC5_DECISION_DISMISS;
    case 'discard_statement':
      // Handled by `discard.ts`, which acts on the RUN, not one item.
      return 'pc5_discard_statement';
    default: {
      const exhaustive: never = action;
      throw new Error(`decisionTypeFor: unhandled action ${String(exhaustive)}`);
    }
  }
}

/**
 * The overrides a decision contributes to the re-reconciliation, derived
 * from the item's reason code and the chosen value.
 *
 * Deliberately a pure function of (reasonCode, chosenValue, evidenceRef) so
 * the mapping from "what the user answered" to "what changes in the
 * re-check" is directly testable and cannot be read differently by two call
 * sites.
 */
export function overridesForDecision(params: {
  reasonCode: string;
  chosenValue: string | undefined;
  evidenceRef: Record<string, unknown> | null;
  existingOwnerMemberId: string | null;
}): Pc5ResolutionOverrides {
  const { reasonCode, chosenValue, evidenceRef, existingOwnerMemberId } = params;
  const overrides: Pc5ResolutionOverrides = { ownerMemberId: existingOwnerMemberId };

  if (!chosenValue) return overrides;

  if (reasonCode === 'ii_adapter:owner_unresolved' || reasonCode === 'ii_adapter:owner_mismatch' || reasonCode === 'ii_adapter:owner_joint_allocation_required') {
    // `PC5_JOINT_OPTION_VALUE` is not a member id — for a joint choice the
    // owner used for re-matching is the FIRST allocated owner, supplied
    // separately via the allocation. Recorded as null here so the joint
    // path cannot accidentally assert a single owner.
    overrides.ownerMemberId = chosenValue === PC5_JOINT_OPTION_VALUE ? null : chosenValue;
    return overrides;
  }

  if (reasonCode === 'ii_adapter:ambiguous_account') {
    const key = typeof evidenceRef?.folioNumber === 'string' || evidenceRef?.folioNumber === null
      ? `${(evidenceRef?.folioNumber as string | null) ?? ''}|${(evidenceRef?.amcName as string | null) ?? ''}`
      : null;
    // The account-resolution key AIE itself used is not stored verbatim on
    // the item, so it is reconstructed from the same two fields
    // `accountResolutionKey(folioNumber, amcName)` is built from. If the
    // reconstruction does not match, `applyAccountOverrides` simply finds
    // no matching key and the ambiguity legitimately stays open — a
    // no-op, never a wrong resolution.
    if (key) overrides.resolvedAccountIdByKey = { [key]: chosenValue };
    return overrides;
  }

  if (reasonCode.startsWith('ii_adapter_duplicate_overlap') || reasonCode.includes('ii_adapter_duplicate_overlap')) {
    if (chosenValue === 'same_economic_event' || chosenValue === 'separate_genuine_events' || chosenValue === 'wrong_statement_or_source') {
      overrides.duplicateResolution = chosenValue;
    }
    return overrides;
  }

  return overrides;
}

/** The owner currently recorded against this run's intake, used as the
 * baseline for re-reconciliation when a decision does not change it. Read
 * from the LAST PC5 owner choice on this run, because the intake's original
 * `owner_member_id` query parameter is not persisted anywhere queryable
 * once dispatch has run. */
async function currentOwnerChoiceForRun(itemIds: readonly string[]): Promise<string | null> {
  const decisions = await listDecisionsForItemsPc5(itemIds);
  const ownerChoices = decisions.filter((d) => d.decisionType === PC5_DECISION_CHOOSE && d.correctionFieldName === 'ownerMemberId');
  const last = ownerChoices[ownerChoices.length - 1];
  const value = last?.correctionValueNormalized ?? null;
  return value === PC5_JOINT_OPTION_VALUE ? null : value;
}

export async function decidePc5Resolution(params: Pc5DecideParams): Promise<Pc5DecideOutcome> {
  if (!isPc5ResolutionEnabled()) return { ok: false, reason: 'feature_flag_disabled' };

  const item: AieUnresolvedItemFullRow | null = await getUnresolvedItemForUserPc5(params.itemId, params.userId);
  if (!item) return { ok: false, reason: 'not_found' };
  if (item.itemVersion !== params.itemVersion) return { ok: false, reason: 'stale_conflict' };

  const adapterId = await getAdapterIdForRun(item.runId);
  const descriptor = resolveModuleDescriptorByAdapterId(adapterId);
  const meta = resolveReasonCodeMeta(descriptor, item.reasonCode);

  // --- Re-derive what is permitted, server-side --------------------------
  const spec = meta.choosableFields?.[0];
  const options = spec
    ? await resolveOptionsForSource({
        source: spec.optionSource,
        userId: params.userId,
        candidateIds: candidateIdsFromEvidence(item.evidenceRef, spec.optionSource),
      })
    : [];
  const priorDecisions = await listDecisionsForItemsPc5([item.id]);
  const allowed = permittedPc5Actions({
    severity: item.severity,
    aieStatus: item.status,
    persistedPermittedActionTypes: item.permittedActionTypes,
    hasChoiceField: options.length > 0,
    alreadyDismissed: isCurrentlyDismissed(priorDecisions),
  });
  if (!allowed.includes(params.action)) {
    // K.13's dismissal rule gets its own typed refusal rather than a
    // generic one, because "you may not dismiss a blocking exception" is a
    // policy a caller should be able to surface precisely.
    if (params.action === 'dismiss' && item.severity === 'blocking') {
      return { ok: false, reason: 'cannot_dismiss_blocking_item' };
    }
    return { ok: false, reason: 'action_not_permitted' };
  }

  // --- Validate the choice against the RE-DERIVED option set -------------
  if (params.action === 'choose_value') {
    if (!params.chosenValue) return { ok: false, reason: 'invalid_choice', detail: 'no value supplied' };
    if (!isPermittedChoice(options, params.chosenValue)) {
      // This is the branch that defeats a forged owner/account id: the
      // option set was built by a query filtered on the CALLER's user id,
      // so another user's member id is simply absent from it.
      return { ok: false, reason: 'invalid_choice', detail: 'value is not among the options available to you' };
    }
  }

  // --- Validate the allocation, if any ----------------------------------
  const chosenOption = options.find((o) => o.value === params.chosenValue);
  const allocationRequired = chosenOption?.requiresAllocation === true;
  let allocationEntries: Pc5AllocationEntry[] | null = null;

  if (allocationRequired) {
    if (!params.iiAccountId) return { ok: false, reason: 'invalid_allocation', detail: 'iiAccountId is required for a joint allocation' };
    const supplied = params.allocation;
    if (!supplied || supplied.length === 0) return { ok: false, reason: 'allocation_required' };

    // Every allocated owner must be drawn from the SAME server-derived
    // owner option set. Re-resolved here rather than reusing `options`
    // because the choice field's source may not have been `household_owner`
    // (it is, today, for every allocation-capable item — but relying on
    // that coupling would break silently if a future reason code allowed an
    // allocation from a different source).
    const ownerOptions = await resolveOwnerOptions(params.userId);
    const permittedOwnerIds = new Set(ownerOptions.filter((o) => o.kind !== 'joint').map((o) => o.value));
    for (const entry of supplied) {
      const id = entry.ownerMemberId ?? entry.ownerBusinessEntityId;
      if (!id || !permittedOwnerIds.has(id)) {
        return { ok: false, reason: 'invalid_allocation', detail: 'an allocated owner is not among the owners available to you' };
      }
    }

    const validated = validateAllocation(supplied);
    if (!validated.ok) return { ok: false, reason: 'invalid_allocation', detail: validated.reason };
    allocationEntries = validated.entries;
  } else if (params.allocation && params.allocation.length > 0) {
    // An allocation supplied where none is permitted is REFUSED rather than
    // ignored. Silently dropping it would leave the user believing they had
    // recorded a split that does not exist.
    return { ok: false, reason: 'allocation_not_permitted' };
  }

  // --- K.12 provenance, captured BEFORE the write -----------------------
  const parserVersion = await getParserVersionForRun(item.runId);
  // The masked/tokenised form only. `display_candidate` is AIE's own
  // privacy-safe display value (for an owner mismatch it is the
  // irreversibly-masked holder name); there is no recoverable original
  // anywhere in the system to capture instead.
  const originalValueMasked = item.displayCandidate;

  const recorded = await recordGovernedResolutionForPc5(
    {
      callerId: params.userId,
      targetUserId: params.userId,
      itemId: item.id,
      decisionType: decisionTypeFor(params.action),
      itemVersion: params.itemVersion,
      idempotencyKey: params.idempotencyKey,
      rationale: params.rationale?.slice(0, 500),
      chosenFieldName: params.action === 'choose_value' ? spec?.fieldName : undefined,
      chosenValue: params.action === 'choose_value' ? params.chosenValue : undefined,
      originalValueAtDecision: originalValueMasked,
      parserVersionAtDecision: parserVersion,
    },
    createPc5CapabilityDeps(),
  );

  if (!recorded.ok) {
    if (recorded.reason === 'capability_denied') return { ok: false, reason: 'forbidden' };
    if (recorded.reason === 'status_not_live') return { ok: false, reason: 'stale_conflict' };
    // The sanitised database detail is carried through so a caller — and
    // PC5's own live-DEV matrix — can tell a transient failure from a
    // schema gap. Without it, every one is an opaque `db_error`.
    return { ok: false, reason: recorded.reason, detail: recorded.detail };
  }

  await emitAuditEvent({
    userId: params.userId,
    eventType: 'pc5_resolution_decision_recorded',
    subjectType: 'aie_unresolved_item',
    subjectId: item.id,
    actorType: 'user',
    actorId: params.userId,
    metadata: {
      action: params.action,
      reasonCode: item.reasonCode,
      // The chosen value is an id or a closed-vocabulary token, never free
      // text and never a name — safe for the audit metadata, which must
      // never carry raw document content or PII.
      chosenValue: params.action === 'choose_value' ? params.chosenValue : null,
      replayed: recorded.replayed,
    },
  });

  // --- Allocation (K.6) --------------------------------------------------
  let allocationGroupId: string | null = null;
  if (allocationEntries && params.iiAccountId) {
    const stored = await recordAllocationGroup({
      userId: params.userId,
      iiAccountId: params.iiAccountId,
      entries: allocationEntries,
      ownerRole: ownerRoleForAllocation(allocationEntries, 'self'),
      source: 'user',
      aieReviewDecisionId: recorded.decisionId,
      aieRunId: item.runId,
    });
    if (!stored.ok) return { ok: false, reason: 'invalid_allocation', detail: stored.detail };
    allocationGroupId = stored.allocationGroupId;
  }

  // --- K.19: re-reconciliation ------------------------------------------
  // Acknowledgement and dismissal deliberately do NOT trigger one: neither
  // changes owner, duplicate status, correction or statement
  // interpretation, which is exactly the set K.19 enumerates. Running a
  // re-check for them would be worse than pointless — a re-check that
  // happens to clear an item for an unrelated reason would make it look as
  // though acknowledging resolved it, which is the masquerade K.13
  // forbids.
  if (params.action !== 'choose_value') {
    return { ok: true, decisionId: recorded.decisionId, replayed: recorded.replayed, allocationGroupId, reReconciliation: { ran: false, reason: 'action_does_not_change_interpretation' } };
  }
  if (adapterId !== II_ADAPTER_ID) {
    return { ok: true, decisionId: recorded.decisionId, replayed: recorded.replayed, allocationGroupId, reReconciliation: { ran: false, reason: 'unsupported_adapter' } };
  }

  const existingOwner = await currentOwnerChoiceForRun([item.id]);
  const overrides = overridesForDecision({
    reasonCode: item.reasonCode,
    chosenValue: params.chosenValue,
    evidenceRef: item.evidenceRef,
    existingOwnerMemberId: existingOwner,
  });

  const reconciled = await reReconcileInvestmentRun({
    runId: item.runId,
    userId: params.userId,
    countryCode: params.countryCode,
    overrides,
    triggerDecisionId: recorded.decisionId,
  });

  if (!reconciled.ok) {
    // The decision STANDS even when the re-check could not run. That is
    // deliberate: the user genuinely made it, it is genuinely audited, and
    // rolling it back would lose a real assertion because of a transient
    // or structural failure elsewhere. What does NOT happen is the item
    // being resolved — it stays `in_review` and still blocks, and
    // `resulting_reconciliation_at` stays null, which is exactly how a
    // later reader tells "decided but not yet re-checked" from "decided
    // and re-checked".
    return {
      ok: true,
      decisionId: recorded.decisionId,
      replayed: recorded.replayed,
      allocationGroupId,
      reReconciliation: { ran: false, reason: reconciled.reason },
    };
  }

  if (recorded.decisionId) await markDecisionReReconciled(recorded.decisionId, reconciled.reconciledAt);

  return {
    ok: true,
    decisionId: recorded.decisionId,
    replayed: recorded.replayed,
    allocationGroupId,
    reReconciliation: {
      ran: true,
      runStatus: reconciled.runStatus,
      openBlockingItemCount: reconciled.openBlockingItemCount,
      newItemIds: reconciled.newItemIds,
      resolvedItemIds: reconciled.resolvedItemIds,
    },
  };
}

/** K.6's default, exposed so the UI can pre-fill an equal split without
 * inventing its own arithmetic. */
export { defaultEqualAllocation };
