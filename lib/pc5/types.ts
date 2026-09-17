/**
 * PC5 (M4) — shared vocabulary for the governed resolution workflow.
 *
 * WHAT PC5 IS, IN ONE SENTENCE: the layer that turns an AIE unresolved
 * ownership/reconciliation item from something a user can only *look at*
 * into something a user can *decide*, without PC5 ever becoming a second
 * source of exception truth.
 *
 * THE BOUNDARY THIS FILE EXISTS TO MAKE VISIBLE (K.3 / AIE10-EXC-08/09/10).
 * Nothing in `lib/pc5/` defines a status, an item id space, an open-count,
 * or a lifecycle of its own. Every type below is either
 *   (a) a PROJECTION over `aie_unresolved_item`'s real columns, computed on
 *       the fly and never persisted, or
 *   (b) the shape of a DECISION that is submitted through AIE's own
 *       `recordReviewDecision` version-checked path.
 * `Pc5ResolutionStatus` in particular is a *derived presentation* of
 * `AieUnresolvedItemStatus`, not a parallel vocabulary — the mapping is a
 * pure function in `reviewStatus.ts` and is total in both directions'
 * sense: every AIE status maps to exactly one PC5 status, and no PC5 status
 * can be written anywhere.
 */

import type { AieItemSeverity, AieUnresolvedItemStatus } from '../aie/types';

/**
 * K.13's four Review Centre semantics, stated so they cannot be confused
 * with each other:
 *
 *   `open`         — an unresolved condition exists and nobody has looked.
 *   `acknowledged` — a user has SEEN it. **The condition still exists.**
 *   `resolved`     — the underlying condition NO LONGER EXISTS, because a
 *                    real resolution or reprocess removed it.
 *   `dismissed`    — presentation suppression only, where permitted. **Not
 *                    a financial correction**, and never available for a
 *                    blocking item.
 *   `superseded`   — replaced by a newer item with lineage (AIE's own
 *                    revalidation lineage, surfaced rather than hidden).
 *
 * `acknowledged` and `dismissed` can NEVER clear a blocking item's grip on
 * acceptance — that is enforced structurally, not by convention: the
 * acceptance gate counts `aie_unresolved_item` rows by their AIE status and
 * has no knowledge of these presentation states at all.
 */
export const PC5_RESOLUTION_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed', 'superseded'] as const;
export type Pc5ResolutionStatus = (typeof PC5_RESOLUTION_STATUSES)[number];

/**
 * The PC5-owned resolution actions. These are DOMAIN decisions that need
 * canonical household/account context to validate — which is exactly why
 * they live here and not in `lib/aie/review/decide.ts`, whose three actions
 * (`correct` / `not_present` / `defer`) are adapter-agnostic and validate
 * against a static per-reason-code field allowlist.
 *
 * `choose_value` is the "choose/confirm a value" action this mission made
 * PC5 responsible for adding to the shared vocabulary. Its permitted option
 * set is NEVER supplied by the client and never static: it is resolved
 * server-side, per user and per item, from canonical data (household
 * members, the account-match candidate ids AIE itself recorded in
 * `evidence_ref`, and so on). See `optionSets.ts`.
 */
export const PC5_RESOLUTION_ACTIONS = [
  'choose_value',
  'acknowledge',
  'dismiss',
  'discard_statement',
] as const;
export type Pc5ResolutionAction = (typeof PC5_RESOLUTION_ACTIONS)[number];

/** Where a `choose_value` option set comes from. The server resolves each
 * of these from real, tenant-scoped canonical data at request time.
 *
 * K.10's duplicate confirmation is modelled as a `choose_value` over the
 * closed three-option `duplicate_resolution` set rather than as a separate
 * `confirm_duplicate` action. Its three options ARE K.10's three questions
 * ("same economic event" / "both genuine separate events" / "wrong
 * statement or source"), so it is a choice, not a yes/no confirmation, and
 * giving it its own action verb would mean a second validation path, a
 * second audit shape and a second re-reconciliation trigger for no gain. */
export const PC5_OPTION_SOURCES = [
  'household_owner',
  'account_match_candidates',
  'instrument_match_candidates',
  'duplicate_resolution',
  'summary_mismatch_resolution',
] as const;
export type Pc5OptionSource = (typeof PC5_OPTION_SOURCES)[number];

export interface Pc5ChoiceOption {
  /** The value actually submitted back. Always an id or a closed-vocabulary
   * token — never free text the user typed. */
  value: string;
  /** Plain-language label. May carry a MASKED holder name; never a
   * recoverable original (see `ownerMatching.ts`). */
  label: string;
  /** Optional second line of context (e.g. "Folio 12345678 · HDFC"). */
  detail?: string;
  /** True when choosing this option additionally requires an allocation
   * split to be supplied (K.6 — 'joint'). */
  requiresAllocation?: boolean;
}

export interface Pc5ChoiceFieldSpec {
  fieldName: string;
  label: string;
  optionSource: Pc5OptionSource;
  options: Pc5ChoiceOption[];
  /** True when the item cannot be resolved by choosing (no legitimate
   * option exists for this user) — the UI must then offer only
   * reprocess/discard, and must say why. */
  unresolvableReason?: string;
}

/** K.6 — one owner's share of one economic position. Basis points out of
 * 10000; see migration 0153 for why not percent. */
export interface Pc5AllocationEntry {
  /** Exactly one of these two is set. */
  ownerMemberId?: string;
  ownerBusinessEntityId?: string;
  basisPoints: number;
}

/**
 * A PC5 item as PROJECTED for display. Note what is absent: no PC5 id, no
 * PC5-owned status column, no PC5 counter. `id` is AIE's own item id and
 * `itemVersion` is AIE's own optimistic-concurrency token, carried through
 * unchanged so a decision can be version-checked by AIE itself.
 */
export interface Pc5ResolutionItemView {
  id: string;
  runId: string;
  intakeId: string;
  reasonCode: string;
  severity: AieItemSeverity;
  /** AIE's real status, shown alongside the derived one rather than hidden,
   * so a reader can always audit the mapping. */
  aieStatus: AieUnresolvedItemStatus;
  status: Pc5ResolutionStatus;
  itemVersion: number;
  /** Privacy-safe display candidate from AIE (`display_candidate`). */
  displayCandidate: string | null;
  humanQuestion: string;
  explanation: string;
  /** Actions permitted for THIS item, after intersecting the persisted
   * `aie_unresolved_item.permitted_action_types` bound with the reason-code
   * registry and with PC5's own domain rules. */
  permittedPc5Actions: Pc5ResolutionAction[];
  /** AIE's own item-level actions that remain available (correct /
   * not_present / defer / reject_document / request_reprocessing). Surfaced
   * so PC5 never has to duplicate them. */
  permittedAieActions: string[];
  /** Populated when `choose_value` is permitted. */
  choiceField: Pc5ChoiceFieldSpec | null;
  /** Non-sensitive evidence pointer (rule id, delta, tolerance, candidate
   * ids). Never raw document text. */
  evidenceRef: Record<string, unknown> | null;
  /** K.14 — the exact underlying case, not the statement list. */
  deepLinkHref: string;
  /** True when this row is the typed half of an identity exception that AIE
   * deliberately records TWICE (a typed `aie_unresolved_item` plus a paired
   * `fail` row in `aie_reconciliation_run` with rule id
   * `ii_adapter_identity:<reasonCode>`). PC5 counts the pair ONCE — see
   * `reviewStatus.ts`'s `dedupeIdentityPairs`. */
  isIdentityPairedWithReconciliationRow: boolean;
}

/** K.9 — what a summary mismatch must show. Every field is required
 * because "show the variance but not the source reference" is exactly the
 * kind of half-disclosure K.9 forbids. */
export interface Pc5SummaryMismatchView {
  /** As printed on the statement. */
  statementValue: string;
  /** As reconstructed from transactions/holdings. */
  reconstructedValue: string;
  variance: string;
  /** Which scheme/account the variance belongs to. */
  affectedAccountLabel: string;
  affectedSchemeLabel: string | null;
  /** The rule id + version that produced this finding. Not a document
   * quote — AIE's evidence discipline forbids one. */
  sourceEvidenceReference: string;
  /** The permitted user actions, already narrowed. Never includes "type a
   * balancing number". */
  allowedActions: string[];
}

/** K.12 — the correction overlay, as stored and as displayed. */
export interface Pc5CorrectionOverlayView {
  fieldName: string;
  /** The MASKED/tokenised extracted value only. Phase 4's one-way-HMAC
   * decision means there is no recoverable original anywhere in the
   * system, and the UI must say so rather than imply a reveal exists. */
  originalValueMasked: string | null;
  originalValueIsRecoverable: false;
  parserVersionAtDecision: string | null;
  decisionType: string;
  userValue: string | null;
  reason: string | null;
  actorId: string | null;
  decidedAt: string;
  resultingReconciliationAt: string | null;
}

export type Pc5DecisionRefusal =
  | 'feature_flag_disabled'
  | 'not_found'
  | 'forbidden'
  | 'stale_conflict'
  | 'action_not_permitted'
  | 'invalid_choice'
  | 'invalid_allocation'
  | 'allocation_required'
  | 'allocation_not_permitted'
  | 'cannot_dismiss_blocking_item'
  | 'reconciliation_refused'
  | 'db_error';
