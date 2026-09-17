/**
 * PC5 (M4) — the read side: projecting AIE's unresolved items into a
 * governed resolution surface.
 *
 * ================================================================
 * THE SINGLE MOST IMPORTANT PROPERTY OF THIS FILE: IT PERSISTS NOTHING.
 * ================================================================
 * K.3 permits PC5 to "query/project" AIE unresolved items and forbids it to
 * "maintain a divergent open-count" or "copy evidence into a parallel
 * lifecycle". Those two are the same requirement seen from two sides, and
 * the only reliable way to satisfy both is to compute the projection on
 * every read and store none of it.
 *
 * Concretely, this file was NOT written the obvious way. The obvious way —
 * and the one the codebase already has a table shaped for — would be to
 * upsert each AIE exception into `ii_review_items`, Investment
 * Intelligence's OWN Review Centre ledger (migration 0067), which already
 * has `status in ('open','acknowledged','resolved','dismissed','superseded')`,
 * `identity_key` dedup, `superseded_by_id` lineage and a working UI. It is
 * an almost exact fit for K.13's vocabulary.
 *
 * It is also exactly the thing K.3 forbids. `ii_review_items` has `for all`
 * RLS — the browser can write it directly — and its own status column,
 * its own resolution timestamps and its own open-count. Projecting AIE
 * exceptions into it would create a second row per exception, with a second
 * status a user could change without the underlying AIE item changing at
 * all, and a count that would drift from `countItemsBlockingAcceptanceForRun`
 * the first time a refresh was missed. A user could then "resolve" a
 * blocking exception in the Review Centre and still find the document
 * refused, with the two surfaces disagreeing and neither obviously wrong.
 *
 * So AIE exceptions are projected LIVE and rendered ALONGSIDE
 * `ii_review_items` rows, never INTO them. `ii_review_items` keeps covering
 * what it already covers (deterministic advisory observations over
 * already-certified data); PC5 covers AIE exceptions; and the two never
 * share a row. The one place they meet is the Review Centre page, which
 * reads both and labels which is which.
 */

import {
  getUnresolvedItemForUserPc5,
  listDecisionsForItemsPc5,
  listUnresolvedItemsForRunPc5,
  listUnresolvedItemsForUserPc5,
  getAdapterIdForRun,
  type AieDecisionHistoryRow,
  type AieUnresolvedItemFullRow,
} from '@/lib/aie/db/repository';
import { resolveModuleDescriptorByAdapterId, resolveReasonCodeMeta } from '@/lib/aie/review/moduleRegistry';
import type { AieChoosableFieldSpec, AieReasonCodeMeta } from '@/lib/aie/review/types';
import type { AieUnresolvedItemStatus } from '@/lib/aie/types';
import { resolveOptionsForSource } from './optionSets';
import { pc5ItemHref } from './deepLinks';
import { PC5_LIVE_ITEM_STATUSES, PC5_TERMINAL_ITEM_STATUSES, isMaterialForDefaultView, permittedPc5Actions, toPc5Status } from './reviewStatus';
import type { Pc5ChoiceFieldSpec, Pc5CorrectionOverlayView, Pc5ResolutionItemView } from './types';

/**
 * Is this item currently dismissed? Derived from the decision trail rather
 * than from a status column, because dismissal is a PRESENTATION fact
 * layered on top of AIE's status and deliberately does not get one of its
 * own (giving it a status would make it a second lifecycle).
 *
 * The rule is last-writer-wins between `pc5_dismiss` and any later
 * decision: a dismissal suppresses the row until the user does something
 * else with it, and any subsequent decision — acknowledging it again,
 * choosing a value, anything — un-suppresses it. That ordering is why the
 * decision list is read oldest-first.
 */
export function isCurrentlyDismissed(decisions: readonly AieDecisionHistoryRow[]): boolean {
  let dismissed = false;
  for (const d of decisions) {
    if (d.decisionType === PC5_DECISION_DISMISS) dismissed = true;
    else dismissed = false;
  }
  return dismissed;
}

export const PC5_DECISION_CHOOSE = 'pc5_choose_value';
export const PC5_DECISION_ACKNOWLEDGE = 'pc5_acknowledge';
export const PC5_DECISION_DISMISS = 'pc5_dismiss';

/** The candidate-id list an item's own `evidence_ref` recorded when it was
 * raised. Used ONLY to narrow an option set — never as authorisation; the
 * option set is re-derived from tenant-scoped canonical data regardless
 * (see `optionSets.ts`). */
export function candidateIdsFromEvidence(evidenceRef: Record<string, unknown> | null, source: AieChoosableFieldSpec['optionSource']): string[] {
  if (!evidenceRef) return [];
  const pick = (key: string): string[] => {
    const raw = evidenceRef[key];
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  };
  switch (source) {
    case 'account_match_candidates':
      return pick('candidateAccountIds');
    case 'instrument_match_candidates':
      return pick('candidateInstrumentIds');
    case 'household_owner':
      return [...pick('candidateMemberIds'), ...pick('matchedMemberIds')];
    case 'duplicate_resolution':
    case 'summary_mismatch_resolution':
      return [];
    default:
      return [];
  }
}

async function buildChoiceField(
  meta: AieReasonCodeMeta,
  item: AieUnresolvedItemFullRow,
  userId: string,
): Promise<Pc5ChoiceFieldSpec | null> {
  const spec = meta.choosableFields?.[0];
  if (!spec) return null;
  const options = await resolveOptionsForSource({
    source: spec.optionSource,
    userId,
    candidateIds: candidateIdsFromEvidence(item.evidenceRef, spec.optionSource),
  });
  return {
    fieldName: spec.fieldName,
    label: spec.label,
    optionSource: spec.optionSource,
    options,
    // An empty option set is a real, explainable state, not a rendering
    // bug: a household with no members cannot be offered an owner, and an
    // ambiguous instrument is deliberately not user-resolvable at all. The
    // UI says so and falls back to reprocess/discard.
    unresolvableReason:
      options.length === 0
        ? spec.optionSource === 'instrument_match_candidates'
          ? 'Choosing between near-identical scheme variants would risk a wrong cost base, so this one is resolved by reprocessing or discarding the statement.'
          : 'There is nothing available to choose from yet. Add the household member or entity this belongs to, then come back — or discard this statement.'
        : undefined,
  };
}

export interface Pc5ProjectionResult {
  items: Pc5ResolutionItemView[];
  /** The count that MATTERS: how many blocking items still stand between
   * the user and acceptance. Derived from exactly the same predicate
   * `repo.countItemsBlockingAcceptanceForRun` uses, so PC5 can never show a
   * different number from the one the acceptance gate enforces. */
  stillBlockingCount: number;
  /** K.16 — how many were hidden from the default (exception-only) view. */
  hiddenNonMaterialCount: number;
}

/**
 * Projects a set of AIE item rows. Split out from the two loaders below so
 * the per-run and per-user paths cannot diverge, and so it is directly
 * testable with fabricated rows and a stubbed option resolver.
 */
export async function projectItems(params: {
  userId: string;
  rows: readonly AieUnresolvedItemFullRow[];
  decisions: readonly AieDecisionHistoryRow[];
  /** run id -> adapter id. Passed in rather than fetched per row: a user's
   * exceptions typically cluster on one or two runs and a per-row fetch
   * would be N+1. */
  adapterIdByRunId: ReadonlyMap<string, string | null>;
  /** K.16 — when true, only material items are returned. */
  materialOnly: boolean;
}): Promise<Pc5ProjectionResult> {
  const { userId, rows, decisions, adapterIdByRunId, materialOnly } = params;

  const decisionsByItem = new Map<string, AieDecisionHistoryRow[]>();
  for (const d of decisions) {
    const list = decisionsByItem.get(d.itemId) ?? [];
    list.push(d);
    decisionsByItem.set(d.itemId, list);
  }

  // The reason codes present on each run, so the identity-pair note on each
  // view is accurate rather than assumed.
  const reasonCodesByRun = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = reasonCodesByRun.get(r.runId) ?? new Set<string>();
    set.add(r.reasonCode);
    reasonCodesByRun.set(r.runId, set);
  }

  const items: Pc5ResolutionItemView[] = [];
  let hiddenNonMaterialCount = 0;
  let stillBlockingCount = 0;

  for (const row of rows) {
    if (row.severity === 'blocking' && (PC5_LIVE_ITEM_STATUSES as readonly string[]).includes(row.status)) {
      stillBlockingCount += 1;
    }

    const material = isMaterialForDefaultView(row.severity, row.status);
    if (materialOnly && !material) {
      hiddenNonMaterialCount += 1;
      continue;
    }

    const descriptor = resolveModuleDescriptorByAdapterId(adapterIdByRunId.get(row.runId) ?? null);
    const meta = resolveReasonCodeMeta(descriptor, row.reasonCode);
    const itemDecisions = decisionsByItem.get(row.id) ?? [];
    const dismissed = isCurrentlyDismissed(itemDecisions);
    const choiceField = await buildChoiceField(meta, row, userId);

    items.push({
      id: row.id,
      runId: row.runId,
      intakeId: row.intakeId,
      reasonCode: row.reasonCode,
      severity: row.severity,
      aieStatus: row.status,
      status: toPc5Status(row.status, dismissed),
      itemVersion: row.itemVersion,
      displayCandidate: row.displayCandidate,
      humanQuestion: meta.humanQuestion,
      explanation: meta.explanation,
      permittedPc5Actions: permittedPc5Actions({
        severity: row.severity,
        aieStatus: row.status,
        persistedPermittedActionTypes: row.permittedActionTypes,
        // A choice field with zero resolvable options is not a choice. This
        // is why `hasChoiceField` is computed from the RESOLVED options
        // rather than from the registry's declaration: offering "choose"
        // and then showing an empty dropdown is the kind of dead end K.14
        // and K.16 both exist to prevent.
        hasChoiceField: (choiceField?.options.length ?? 0) > 0,
        alreadyDismissed: dismissed,
      }),
      permittedAieActions: [...meta.allowedActions],
      choiceField,
      evidenceRef: row.evidenceRef,
      deepLinkHref: pc5ItemHref(row.id),
      // See `reviewStatus.ts`'s `dropIdentityMirrors`. Every item whose
      // reason code the II dispatch mirrors as a reconciliation row carries
      // this flag so a consumer counting exceptions knows the pair is ONE
      // exception, not two.
      isIdentityPairedWithReconciliationRow: row.reasonCode.startsWith('ii_adapter:'),
    });
  }

  return { items, stillBlockingCount, hiddenNonMaterialCount };
}

async function adapterIdsForRuns(runIds: readonly string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(runIds)];
  const entries = await Promise.all(unique.map(async (runId) => [runId, await getAdapterIdForRun(runId)] as const));
  return new Map(entries);
}

/** The Review Centre listing: every live exception this user owns. */
export async function projectResolutionsForUser(params: {
  userId: string;
  materialOnly?: boolean;
  includeHistory?: boolean;
}): Promise<Pc5ProjectionResult> {
  const statuses: AieUnresolvedItemStatus[] = params.includeHistory
    ? [...PC5_LIVE_ITEM_STATUSES, ...PC5_TERMINAL_ITEM_STATUSES]
    : [...PC5_LIVE_ITEM_STATUSES];
  const rows = await listUnresolvedItemsForUserPc5(params.userId, statuses);
  if (rows.length === 0) return { items: [], stillBlockingCount: 0, hiddenNonMaterialCount: 0 };
  const [decisions, adapterIdByRunId] = await Promise.all([
    listDecisionsForItemsPc5(rows.map((r) => r.id)),
    adapterIdsForRuns(rows.map((r) => r.runId)),
  ]);
  return projectItems({
    userId: params.userId,
    rows,
    decisions,
    adapterIdByRunId,
    materialOnly: params.materialOnly ?? true,
  });
}

/** The same projection, narrowed to one document's run. */
export async function projectResolutionsForRun(params: {
  userId: string;
  runId: string;
  materialOnly?: boolean;
  includeHistory?: boolean;
}): Promise<Pc5ProjectionResult> {
  const statuses: AieUnresolvedItemStatus[] = params.includeHistory
    ? [...PC5_LIVE_ITEM_STATUSES, ...PC5_TERMINAL_ITEM_STATUSES]
    : [...PC5_LIVE_ITEM_STATUSES];
  const rows = await listUnresolvedItemsForRunPc5(params.runId, params.userId, statuses);
  if (rows.length === 0) return { items: [], stillBlockingCount: 0, hiddenNonMaterialCount: 0 };
  const [decisions, adapterIdByRunId] = await Promise.all([
    listDecisionsForItemsPc5(rows.map((r) => r.id)),
    adapterIdsForRuns(rows.map((r) => r.runId)),
  ]);
  return projectItems({
    userId: params.userId,
    rows,
    decisions,
    adapterIdByRunId,
    materialOnly: params.materialOnly ?? true,
  });
}

export interface Pc5ItemContext {
  item: Pc5ResolutionItemView;
  /** K.12 — the correction overlay, oldest decision first. Every entry
   * states explicitly that the original value is not recoverable. */
  overlay: Pc5CorrectionOverlayView[];
}

/**
 * K.14's destination: one item, with everything needed to decide it, and
 * nothing that would require a second request.
 *
 * Returns null for an item this user does not own — indistinguishable from
 * a nonexistent one, so the route above it answers 404 either way and
 * cannot be used to enumerate item ids (K.20).
 */
export async function projectItemContext(params: { userId: string; itemId: string }): Promise<Pc5ItemContext | null> {
  const row = await getUnresolvedItemForUserPc5(params.itemId, params.userId);
  if (!row) return null;

  const [decisions, adapterIdByRunId] = await Promise.all([listDecisionsForItemsPc5([row.id]), adapterIdsForRuns([row.runId])]);
  const projected = await projectItems({
    userId: params.userId,
    rows: [row],
    decisions,
    adapterIdByRunId,
    // Never filter on a direct link: a user who followed a deep link to a
    // specific item must see that item, even if the list view would have
    // folded it away as non-material.
    materialOnly: false,
  });
  const item = projected.items[0];
  if (!item) return null;

  const overlay: Pc5CorrectionOverlayView[] = decisions.map((d) => ({
    fieldName: d.correctionFieldName ?? '(document-level)',
    originalValueMasked: d.originalValueAtDecision,
    // A literal `false`, not a computed one. Phase 4 DELETED the reversible
    // token map (`lib/aie/masking/tokenMapCrypto.ts` is gone, and
    // `aie_mask_token_map` has had no writer since), so there is no
    // configuration in which this could be true and no flag that could turn
    // it on. Typed as the literal `false` in `Pc5CorrectionOverlayView` so
    // a future change that tried to make it conditional would not compile.
    originalValueIsRecoverable: false,
    parserVersionAtDecision: d.parserVersionAtDecision,
    decisionType: d.decisionType,
    userValue: d.correctionValueNormalized ?? d.correctionValueRaw,
    reason: d.rationale,
    actorId: d.actorId,
    decidedAt: d.createdAt,
    resultingReconciliationAt: d.resultingReconciliationAt,
  }));

  return { item, overlay };
}
