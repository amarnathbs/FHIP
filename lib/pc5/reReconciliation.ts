/**
 * PC5 (M4) — K.19: *"Every PC5 decision that changes owner, duplicate
 * status, correction or statement interpretation must trigger the
 * appropriate AIE/II reconciliation rerun."*
 *
 * ================================================================
 * THE GAP THIS CLOSES, VERIFIED FRESH AGAINST THE CURRENT TREE
 * ================================================================
 * `lib/aie/review/revalidate.ts` is AIE's re-reconciliation engine, and its
 * rule resolver reads, in full:
 *
 *     export function resolveReconciliationRuleForAdapter(adapterId) {
 *       if (adapterId === 'insurance_generic_schedule_v1') return buildInsuranceReconciliationRule();
 *       return null;
 *     }
 *
 * `null` means `unsupported_adapter`. So TODAY, every `correct` or
 * `not_present` decision on an Investment Intelligence item returns
 * `revalidation: { ok: false, reason: 'unsupported_adapter' }` and leaves
 * the run in `unresolved` — permanently. The only other exit from
 * `unresolved` is `rejectRun`. An II document that needed any decision at
 * all could therefore only ever be thrown away.
 *
 * That is not an oversight in `revalidate.ts`. Its own header is explicit
 * that it returns `null` rather than `noDomainAdapterReconciliationRule`
 * precisely so it can never fabricate a PASS for an adapter it cannot
 * actually re-check — which would silently move a run to
 * `awaiting_acceptance` without re-running the check that blocked it. The
 * gap is that nobody had built II's re-check. This module is that.
 *
 * ================================================================
 * WHY THIS IS NOT A SECOND LIFECYCLE (K.3)
 * ================================================================
 * Every state-changing primitive used below is AIE's own, from
 * `lib/aie/db/repository.ts`: `transitionRunStatusCas`,
 * `recordReconciliationRuns`, `resolveItemBySystem`, `createUnresolvedItems`,
 * `recordRunTransitionAudit`. This module is a THIRD caller of them,
 * alongside `revalidate.ts` and `dispatch.ts`, which already call the same
 * set for the same purposes. It defines no status, no table and no id
 * space of its own; `aie_unresolved_item` remains the single source of
 * exception truth throughout.
 *
 * It is a separate module rather than a branch inside `revalidateRun`
 * because the two differ in a way that cannot be parameterised cleanly:
 * `revalidateRun` calls a SYNCHRONOUS `rule({ runId, candidates })`, while
 * Investment Intelligence's rule needs an asynchronously-loaded read-only
 * snapshot of canonical state (`buildInvestmentReconciliationContext`) AND
 * must recompute IDENTITY findings (owner, account, instrument, statement
 * period) that are not expressible as reconciliation results at all.
 * Forcing both through one signature would have meant making the insurance
 * path async and context-aware for no reason, or smuggling I/O into a type
 * documented as "unit-testable with zero database access".
 *
 * ================================================================
 * WHAT A RESOLUTION DECISION ACTUALLY CHANGES
 * ================================================================
 * The overrides below are the ONLY things a user decision may change, and
 * each is applied to the CONTEXT — never to the evidence. The candidates
 * are read back untouched from `aie_field_candidate` (see
 * `rehydrate.ts` for why the PDF is deliberately not re-read), so a
 * decision can change which existing account a folio resolves to, or who
 * owns it, or whether an overlap counts as a duplicate — and can never
 * change what the statement said.
 */

import * as repo from '@/lib/aie/db/repository';
import { recordAieAuditEvent } from '@/lib/aie/audit';
import { blockingItemsForReconciliation, worstOutcome } from '@/lib/aie/reconciliation/types';
import { stripCoreReconciliationPrefix } from '@/lib/aie/review/reasonCodes';
import { buildInvestmentReconciliationContext } from '@/lib/aie/adapters/investment-intelligence/context';
import { buildInvestmentReconciliationRule } from '@/lib/aie/adapters/investment-intelligence/reconciliationRule';
import { rehydrateParsedDocument } from '@/lib/aie/adapters/investment-intelligence/rehydrate';
import { checkStatementPeriod } from '@/lib/aie/adapters/investment-intelligence/statementMatching';
import { II_ADAPTER_ID } from '@/lib/aie/adapters/investment-intelligence';
import {
  unresolvedItemForOwnerMismatch,
  unresolvedItemForOwnerUnresolved,
  unresolvedItemForStatementPeriod,
  unresolvedItemsForAccountMatches,
  unresolvedItemsForInstrumentMatches,
} from '@/lib/aie/adapters/investment-intelligence/unresolvedItems';
import {
  collapseOwnerEvidence,
  loadHouseholdMembersForMatching,
} from '@/lib/aie/adapters/investment-intelligence/householdContext';
import { matchStatementOwner, PC5_DEFAULT_OWNER_MATCH_POLICY } from '@/lib/aie/adapters/investment-intelligence/ownerMatching';
import type { AccountMatchOutcome } from '@/lib/aie/adapters/investment-intelligence/accountMatching';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import type { AieReconciliationRunResult, AieUnresolvedItemInput } from '@/lib/aie/types';

/** The identity-mirror rule-id prefix `dispatch.ts` uses. Reproduced from
 * one place (`reviewStatus.ts`) rather than re-typed, so the mirror written
 * here and the mirror PC5's projection drops can never diverge. */
import { II_IDENTITY_RECONCILIATION_RULE_PREFIX } from './reviewStatus';

export interface Pc5ResolutionOverrides {
  /** The household member (or business entity) the user says owns this
   * statement. Applied to owner matching; never to the extracted evidence. */
  ownerMemberId?: string | null;
  /** `accountResolutionKey` -> the existing `ii_accounts.id` the user chose
   * for an ambiguous folio. */
  resolvedAccountIdByKey?: Record<string, string>;
  /** K.10's answer. `'separate_genuine_events'` suppresses the
   * duplicate-overlap finding for this run; the other two values do not
   * (one keeps the existing data, the other discards the statement — both
   * handled by their own paths, not by suppressing a check). */
  duplicateResolution?: 'same_economic_event' | 'separate_genuine_events' | 'wrong_statement_or_source';
}

export type Pc5ReReconcileOutcome =
  | {
      ok: false;
      reason: 'not_found' | 'wrong_state' | 'unsupported_adapter' | 'no_candidates' | 'evidence_unavailable' | 'lost_race';
    }
  | {
      ok: true;
      runStatus: 'unresolved' | 'awaiting_acceptance';
      worstOutcome: ReturnType<typeof worstOutcome>;
      openBlockingItemCount: number;
      newItemIds: string[];
      resolvedItemIds: string[];
      reconciledAt: string;
    };

export interface Pc5ReReconcileDeps {
  getRunForUser: typeof repo.getRunForUser;
  getAdapterIdForRun: typeof repo.getAdapterIdForRun;
  listFieldCandidatesForRun: typeof repo.listFieldCandidatesForRun;
  listUnresolvedItemsForRunPc5: typeof repo.listUnresolvedItemsForRunPc5;
  /** Needed to find identity rules that have CLEARED since the last pass —
   * see the `clearedIdentityResults` block below. Injected like every other
   * side effect in this module rather than called on the repository
   * directly: a direct call made the "an identity check that now passes"
   * path untestable without a database, which is precisely the path most
   * worth testing. */
  latestReconciliationOutcomesForRun: typeof repo.latestReconciliationOutcomesForRun;
  transitionRunStatusCas: typeof repo.transitionRunStatusCas;
  recordReconciliationRuns: typeof repo.recordReconciliationRuns;
  resolveItemBySystem: typeof repo.resolveItemBySystem;
  createUnresolvedItems: typeof repo.createUnresolvedItems;
  recordRunTransitionAudit: typeof repo.recordRunTransitionAudit;
  buildContext: typeof buildInvestmentReconciliationContext;
  loadHouseholdMembers: typeof loadHouseholdMembersForMatching;
  audit: typeof recordAieAuditEvent;
  iiAudit: typeof emitAuditEvent;
}

export function createDefaultPc5ReReconcileDeps(): Pc5ReReconcileDeps {
  return {
    getRunForUser: repo.getRunForUser,
    getAdapterIdForRun: repo.getAdapterIdForRun,
    listFieldCandidatesForRun: repo.listFieldCandidatesForRun,
    listUnresolvedItemsForRunPc5: repo.listUnresolvedItemsForRunPc5,
    latestReconciliationOutcomesForRun: repo.latestReconciliationOutcomesForRun,
    transitionRunStatusCas: repo.transitionRunStatusCas,
    recordReconciliationRuns: repo.recordReconciliationRuns,
    resolveItemBySystem: repo.resolveItemBySystem,
    createUnresolvedItems: repo.createUnresolvedItems,
    recordRunTransitionAudit: repo.recordRunTransitionAudit,
    buildContext: buildInvestmentReconciliationContext,
    loadHouseholdMembers: loadHouseholdMembersForMatching,
    audit: recordAieAuditEvent,
    iiAudit: emitAuditEvent,
  };
}

/**
 * Applies a user's account choice to the read-only match result.
 *
 * This is the one place a decision changes a MATCH. It converts an
 * `ambiguous` outcome into a `resolved` one for the key the user answered,
 * and ONLY if the id they chose was among the candidates the matcher itself
 * produced. A chosen id outside that set is ignored rather than honoured —
 * so even if every layer above this were bypassed, a user could not attach
 * a statement to an arbitrary account of their own, let alone anyone
 * else's.
 */
export function applyAccountOverrides(
  outcomes: readonly AccountMatchOutcome[],
  overrides: Record<string, string> | undefined,
): AccountMatchOutcome[] {
  if (!overrides || Object.keys(overrides).length === 0) return [...outcomes];
  return outcomes.map((o) => {
    if (o.kind !== 'ambiguous') return o;
    const chosen = overrides[o.key];
    if (!chosen || !o.candidateAccountIds.includes(chosen)) return o;
    return { kind: 'resolved', key: o.key, folioNumber: o.folioNumber, amcName: o.amcName, accountId: chosen };
  });
}

/**
 * The full re-reconciliation.
 *
 * STATE HANDLING MIRRORS `revalidateRun` EXACTLY, including the CAS in and
 * out through `reconciling` and the restore-on-refusal — the run status
 * FSM (`AIE_RUN_TRANSITIONS`) has no direct `unresolved -> awaiting_acceptance`
 * shortcut and no direct `awaiting_acceptance -> unresolved` edge either,
 * so `reconciling` is the only legal waypoint in both directions. A run
 * that cannot be re-checked is put back exactly where it was rather than
 * stranded mid-flight.
 */
export async function reReconcileInvestmentRun(
  params: { runId: string; userId: string; countryCode: string; overrides: Pc5ResolutionOverrides; triggerDecisionId?: string | null },
  deps: Pc5ReReconcileDeps = createDefaultPc5ReReconcileDeps(),
): Promise<Pc5ReReconcileOutcome> {
  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };

  // Only a run that is genuinely still unresolved has anything to re-check.
  // `awaiting_acceptance` means every blocking item is already gone;
  // re-running would be a no-op at best and, at worst, would race the
  // acceptance gate.
  if (run.status !== 'unresolved') return { ok: false, reason: 'wrong_state' };

  const adapterId = await deps.getAdapterIdForRun(run.id);
  if (adapterId !== II_ADAPTER_ID) return { ok: false, reason: 'unsupported_adapter' };

  const candidates = await deps.listFieldCandidatesForRun(run.id);
  if (candidates.length === 0) return { ok: false, reason: 'no_candidates' };

  const rehydrated = rehydrateParsedDocument(candidates);
  if (!rehydrated.ok) return { ok: false, reason: 'evidence_unavailable' };
  const parsed = rehydrated.parsed;

  // Take the run into `reconciling` BEFORE any of the expensive work, for
  // the same reason `revalidateRun` does: it is the lock. A concurrent
  // second decision on the same run loses this CAS and is told `lost_race`
  // rather than both passes racing to write contradictory item sets
  // (K.22's "concurrent resolution idempotency").
  const locked = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'unresolved', toStatus: 'reconciling' });
  if (!locked) return { ok: false, reason: 'lost_race' };

  try {
    const context = await deps.buildContext({
      userId: params.userId,
      countryCode: params.countryCode,
      sourceKey: parsed.metadata.sourceKey,
      parsed,
    });

    // --- Apply the user's decisions to the CONTEXT, never the evidence ---
    const overriddenOutcomes = applyAccountOverrides(context.accountMatches.outcomes, params.overrides.resolvedAccountIdByKey);
    const effectiveContext = {
      ...context,
      accountMatches: {
        ...context.accountMatches,
        outcomes: overriddenOutcomes,
        byKey: new Map(overriddenOutcomes.map((o) => [o.key, o])),
      },
    };

    // --- Arithmetic reconciliation ---------------------------------------
    const rule = buildInvestmentReconciliationRule(effectiveContext);
    let results: AieReconciliationRunResult[] = rule({ runId: run.id, candidates });

    // K.10: "both genuine separate events" means the OVERLAP finding is no
    // longer the right verdict for this run. It is suppressed by REMOVING
    // the rule's result, not by rewriting it to `pass` — a suppressed check
    // and a passed check are different facts, and recording a `pass` for a
    // check the user overrode would put a false clean result into the
    // reconciliation history. The user's decision itself is recorded in
    // `aie_review_decision`, so the audit trail explains the absence.
    if (params.overrides.duplicateResolution === 'separate_genuine_events') {
      results = results.filter((r) => !r.ruleId.startsWith('ii_adapter_duplicate_overlap'));
    }

    // --- Identity findings, recomputed ------------------------------------
    const ownerMemberId = params.overrides.ownerMemberId ?? null;
    const ownerEvidence = collapseOwnerEvidence(parsed.accounts);
    const householdMembers = ownerMemberId ? await deps.loadHouseholdMembers(params.userId) : [];
    const ownerMatch = ownerMemberId ? matchStatementOwner(ownerEvidence, householdMembers, PC5_DEFAULT_OWNER_MATCH_POLICY) : null;

    // A user who has EXPLICITLY chosen an owner has resolved the mismatch
    // by asserting it — that is the whole point of the choice, and K.4's
    // "no fuzzy auto-match" constrains the MACHINE, not the human. So an
    // exact match against a different member is no longer escalated here
    // (unlike at dispatch time, where nobody had been asked yet): the user
    // has now been asked and has answered. What is NOT waived is the joint
    // case — a joint holding still needs an allocation, and one person
    // asserting sole ownership of a folio the document says is jointly held
    // is exactly the claim that needs the split recorded rather than
    // accepted.
    const ownerItems =
      ownerMatch && ownerMatch.kind === 'joint_holding'
        ? unresolvedItemForOwnerMismatch(ownerMatch, ownerMemberId)
        : [];

    const identityItems: AieUnresolvedItemInput[] = [
      ...unresolvedItemsForAccountMatches(overriddenOutcomes),
      ...unresolvedItemsForInstrumentMatches(effectiveContext.instrumentMatches),
      ...unresolvedItemForStatementPeriod(checkStatementPeriod(parsed.metadata)),
      ...(ownerMemberId ? [] : unresolvedItemForOwnerUnresolved(overriddenOutcomes.length > 0)),
      ...ownerItems,
    ];

    // Identity findings are ALSO recorded as reconciliation rows, exactly as
    // `dispatch.ts` does, so the acceptance gate's two independent
    // signals (blocking-item count, reconciliation outcome) stay
    // consistent. A run blocked on one but reading `pass` on the other is
    // the inconsistency that invites an "accept anyway" shortcut.
    const identityResults: AieReconciliationRunResult[] = identityItems.map((item) => ({
      ruleId: `${II_IDENTITY_RECONCILIATION_RULE_PREFIX}${item.reasonCode}`,
      ruleVersion: '1',
      outcome: 'fail' as const,
    }));

    // AN IDENTITY CHECK THAT NOW PASSES MUST BE RECORDED AS PASSING, not
    // merely omitted. `latestReconciliationOutcomesForRun` keeps the LATEST
    // row per rule id, so a previously-failing identity rule that is simply
    // absent from this pass would keep its old `fail` forever and the
    // acceptance gate would refuse the run for a condition that no longer
    // exists. This is the single most important line in the file.
    const priorOutcomes = await deps.latestReconciliationOutcomesForRun(run.id);
    const stillFailingIdentityRuleIds = new Set(identityResults.map((r) => r.ruleId));
    const clearedIdentityResults: AieReconciliationRunResult[] = priorOutcomes
      .filter((p) => p.ruleId.startsWith(II_IDENTITY_RECONCILIATION_RULE_PREFIX) && !stillFailingIdentityRuleIds.has(p.ruleId))
      .map((p) => ({ ruleId: p.ruleId, ruleVersion: '1', outcome: 'pass' as const }));

    const allResults = [...results, ...identityResults, ...clearedIdentityResults];
    await deps.recordReconciliationRuns({ runId: run.id, intakeId: run.intakeId, userId: run.userId, results: allResults });

    // --- Reconcile the OPEN ITEM SET against the new findings -------------
    // Same algorithm as `revalidateRun`: an open item whose condition no
    // longer reproduces is resolved BY THE SYSTEM (through the same
    // version-checked decision trail a human decision uses, with a null
    // actor so the history never implies a human clicked something);
    // a condition that still holds and has no open item gets a new one.
    const arithmeticItems = blockingItemsForReconciliation(results);
    const wantedItems: AieUnresolvedItemInput[] = [...arithmeticItems, ...identityItems];
    const wantedReasonCodes = new Set(wantedItems.map((i) => i.reasonCode));

    const openItems = await deps.listUnresolvedItemsForRunPc5(run.id, run.userId, ['open', 'in_review', 'deferred']);
    const resolvedItemIds: string[] = [];
    const stillOpenReasonCodes = new Set<string>();
    const supersededItemIdByRuleId = new Map<string, string>();

    for (const item of openItems) {
      if (wantedReasonCodes.has(item.reasonCode)) {
        stillOpenReasonCodes.add(item.reasonCode);
        continue;
      }
      const ruleId = stripCoreReconciliationPrefix(item.reasonCode);
      const sameRuleDifferentOutcome = wantedItems.some((w) => stripCoreReconciliationPrefix(w.reasonCode) === ruleId);
      const resolution = await deps.resolveItemBySystem({
        itemId: item.id,
        intakeId: run.intakeId,
        userId: run.userId,
        expectedItemVersion: item.itemVersion,
        decisionType: sameRuleDifferentOutcome ? 'superseded_by_revalidation' : 'auto_resolved_by_revalidation',
        // Keyed on the item VERSION as well as the id, so a replay of the
        // same pass is idempotent while a genuinely later pass on a changed
        // item is not mistaken for one.
        idempotencyKey: `${run.id}:pc5-rereconcile:${item.id}:${item.itemVersion}`,
        rationale: sameRuleDifferentOutcome
          ? 'Superseded — the same underlying check now reports a different outcome after your decision.'
          : 'Re-checked after your decision; this condition no longer occurs.',
      });
      if (resolution.ok) {
        resolvedItemIds.push(item.id);
        if (sameRuleDifferentOutcome) supersededItemIdByRuleId.set(ruleId, item.id);
      }
      // A `stale_conflict` means something else moved this item since it
      // was listed. Left exactly as it is rather than force-written — the
      // next pass, or the item's own decision endpoint, will see its true
      // state.
    }

    const itemsToCreate = wantedItems
      .filter((i) => !stillOpenReasonCodes.has(i.reasonCode))
      .map((i) => {
        const supersedes = supersededItemIdByRuleId.get(stripCoreReconciliationPrefix(i.reasonCode));
        return supersedes ? { ...i, evidenceRef: { ...(i.evidenceRef ?? {}), supersedesItemId: supersedes } } : i;
      });

    let newItemIds: string[] = [];
    if (itemsToCreate.length > 0) {
      newItemIds = await deps.createUnresolvedItems({ runId: run.id, intakeId: run.intakeId, userId: run.userId, items: itemsToCreate });
      await deps.audit({
        intakeId: run.intakeId,
        runId: run.id,
        userId: run.userId,
        eventType: 'unresolved_item_created',
        actorType: 'system',
        metadata: { count: itemsToCreate.length, trigger: 'pc5_re_reconciliation' },
      });
    }

    const openBlockingItemCount =
      [...stillOpenReasonCodes].length + itemsToCreate.filter((i) => i.severity === 'blocking').length;
    const finalStatus = openBlockingItemCount > 0 ? 'unresolved' : 'awaiting_acceptance';
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'reconciling', toStatus: finalStatus });
    await deps.recordRunTransitionAudit({
      runId: run.id,
      intakeId: run.intakeId,
      userId: run.userId,
      fromState: 'reconciling',
      toState: finalStatus,
      actorType: 'system',
      reason: 'pc5_post_decision_re_reconciliation',
    });

    const reconciledAt = new Date().toISOString();
    await deps.iiAudit({
      userId: run.userId,
      eventType: 'pc5_re_reconciliation_triggered',
      subjectType: 'aie_extraction_run',
      subjectId: run.id,
      actorType: 'user',
      metadata: {
        triggerDecisionId: params.triggerDecisionId ?? null,
        finalStatus,
        openBlockingItemCount,
        newItemCount: newItemIds.length,
        resolvedItemCount: resolvedItemIds.length,
      },
    });

    return {
      ok: true,
      runStatus: finalStatus,
      worstOutcome: worstOutcome(allResults),
      openBlockingItemCount,
      newItemIds,
      resolvedItemIds,
      reconciledAt,
    };
  } catch (error) {
    // NEVER LEAVE THE RUN STRANDED IN `reconciling`. That status has no
    // user-facing meaning (`computeUserFacingState` maps it to
    // "processing"), so a run left there would look permanently busy to
    // its owner with no action available and no error shown.
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'reconciling', toStatus: 'unresolved' });
    throw error;
  }
}
