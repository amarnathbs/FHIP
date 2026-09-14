/**
 * AIE-1.5 — shared review/acceptance contract types.
 *
 * These types sit ON TOP of AIE-1.1's own authoritative vocabulary
 * (`lib/aie/types.ts`, migration 0140) — they never introduce a competing
 * status or a second exception system (section 4: "no second exception
 * table/state machine/queue"). Everything here is a VIEW/PROJECTION of the
 * real `aie_extraction_run` / `aie_unresolved_item` / `aie_review_decision`
 * rows, computed on the fly, never persisted as a parallel truth.
 */

import type { AieItemSeverity, AieReconciliationOutcome, AieRunStatus, AieUnresolvedItemStatus } from '../types';

/**
 * AIE15-IA-01..07 / section 35's "Required user-state mapping" table,
 * collapsed from AIE-1.1's 18 internal run states into the 7 states a human
 * actually needs to reason about. Never shown alongside the raw backend
 * state name (IA-07: "do not expose raw worker/provider/schema state names
 * as primary user language").
 */
export const AIE_USER_FACING_STATES = [
  'processing',
  'ready_to_accept',
  'needs_your_review',
  'unable_to_process_safely',
  'accepted_importing',
  'import_failed',
  'completed',
] as const;
export type AieUserFacingState = (typeof AIE_USER_FACING_STATES)[number];

/** The five review actions AIE-1.5 section 12 defines. "request_reprocessing"
 * and "reject_document" are RUN/document-level (there is no partial-document
 * accept); "correct", "not_present" and "defer" are ITEM-level. */
export type AieReviewActionType = 'accept' | 'correct' | 'not_present' | 'defer' | 'reject_document' | 'request_reprocessing';

export type AieCorrectableFieldType = 'string' | 'number' | 'date' | 'enum';

export interface AieCorrectableFieldSpec {
  fieldName: string;
  /** Plain-language label shown next to the correction input — never the
   * raw fieldName/reason code (ITEM-01). */
  label: string;
  type: AieCorrectableFieldType;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
}

/**
 * One entry in the reason-code -> human-language/action registry
 * (Appendix A: "Reason/action registry"). Keyed by the exact reason code OR
 * a rule-id PREFIX (AIE-1.2's own rule ids embed a dynamic
 * `:accountId`/`:instrumentId` suffix — see reasonCodes.ts's matching
 * function) a module's reconciliation rule / unresolved-item creator emits.
 */
export interface AieReasonCodeMeta {
  /** ITEM-01: "show a plain-language question rather than internal reason
   * code." */
  humanQuestion: string;
  /** ITEM-04: why review is needed, evidence/reconciliation-grounded —
   * never model-confidence jargon (no confidence value exists anywhere in
   * this codebase's AIE reconciliation contract, P4). */
  explanation: string;
  severity: AieItemSeverity;
  /** ITEM-05: "show only permitted correction types for the reason code" —
   * this list is the SINGLE source of truth for what a reviewer may do with
   * an item carrying this reason code. Deliberately independent of (and
   * authoritative over) AIE-1.1 core's own generic
   * `aie_unresolved_item.permitted_action_types` column, which
   * `blockingItemsForReconciliation` hard-codes to
   * `['request_reprocessing', 'reject_document']` for every rule
   * regardless of whether a narrower field-level correction is actually
   * meaningful — a disclosed, deliberate AIE-1.5 extension over an AIE-1.1
   * gap that phase never anticipated (see AIE_1_5_IMPLEMENTATION.md
   * section 4 for the full reasoning), not a contradiction of it: nothing
   * here ever *widens* what the database allows (every actual status
   * mutation still goes through `recordReviewDecision`'s server-side
   * version check), it only narrows/enriches what the UI legitimately
   * offers for a specific, known rule.
   */
  allowedActions: readonly AieReviewActionType[];
  /** Populated only when 'correct' is in allowedActions. */
  correctableFields?: readonly AieCorrectableFieldSpec[];
}

/** AIE15-MOD-01/12 — one module's rendering/reason-code metadata. Module
 * renderers customise MEANING, never lifecycle/authorization/audit
 * (section 2's binding principle) — nothing in this interface can change a
 * status, bypass a version check or skip revalidation. */
export interface AieReviewModuleDescriptor {
  moduleKey: 'insurance' | 'investment_intelligence' | 'fdh_bank';
  label: string;
  /** True only for a module this AIE-1.5 pass actually ran end-to-end
   * through a real orchestrator + reconciliation + write gate in this
   * repository's own tests. False means "reason codes below are
   * transcribed from that adapter's own source on its own branch and are
   * believed accurate, but this pass never executed that adapter's code" —
   * reported honestly in AIE_1_5_IMPLEMENTATION.md, never presented as
   * equally proven. */
  integrationTested: boolean;
  /** Matches this module's `aie_parser_attempt.adapter_id` values. */
  matchesAdapterId: (adapterId: string) => boolean;
  /** Canonical field display order for the clean-result summary
   * (TRI-01/02/09). */
  summaryFieldOrder: readonly string[];
  /** Exact-match reason codes. */
  reasonCodes: Record<string, AieReasonCodeMeta>;
  /** Prefix-matched reason codes for adapters whose rule ids embed a
   * dynamic id segment (e.g. AIE-1.2's `ii_adapter_roll_forward:<acctId>:
   * <instrumentId>`). Checked in order; first match wins. */
  reasonCodePrefixes?: readonly { prefix: string; meta: AieReasonCodeMeta }[];
}

export interface AieReviewItemView {
  id: string;
  runId: string;
  reasonCode: string;
  status: AieUnresolvedItemStatus;
  severity: AieItemSeverity;
  itemVersion: number;
  displayCandidate: string | null;
  meta: AieReasonCodeMeta;
  /** Non-sensitive evidence pointer only (rule id/version/delta/tolerance
   * today — never a raw document value, EVID-01/AIE-1.1's own evidence_ref
   * discipline). */
  evidenceRef: Record<string, unknown> | null;
}

export interface AieReviewCandidateView {
  fieldName: string;
  /** Masked-by-default display value (MASK-01). Null when the field itself
   * is null/not-found. */
  displayValue: string | null;
  isNull: boolean;
  sourceMethod: 'deterministic' | 'ai' | 'ocr';
  /** True when a user correction currently overrides the original
   * document-extracted value for this field (TRI-05/VALID-09: keep source
   * fact and user assertion distinguishable). The original extracted value
   * is never discarded — see revalidate.ts's merge function. */
  userCorrected: boolean;
  originalValueRaw: string | null;
}

export interface AieReviewRunSummary {
  runId: string;
  intakeId: string;
  userState: AieUserFacingState;
  runStatus: AieRunStatus;
  moduleLabel: string;
  reconciliationOutcome: AieReconciliationOutcome;
  openBlockingItemCount: number;
  openWarningItemCount: number;
  displayFilename: string | null;
  createdAt: string;
}
