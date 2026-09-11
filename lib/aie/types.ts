/**
 * AIE-1.1 — shared type vocabulary for the document-processing gateway.
 *
 * Mirrors `supabase/migrations/0140_aie1_1_shared_document_gateway.sql`
 * exactly — every string-union below matches a CHECK constraint in that
 * migration. Kept in one file (like
 * `lib/financial-data-hub/constants/enums.ts`) so the DB vocabulary and the
 * TypeScript vocabulary can never silently drift apart.
 */

export const AIE_INTAKE_STATUSES = [
  'received',
  'quarantined',
  'rejected',
  'ready',
  'cancelled',
  'deleted',
] as const;
export type AieIntakeStatus = (typeof AIE_INTAKE_STATUSES)[number];

export const AIE_RUN_STATUSES = [
  'local_extracting',
  'local_complete',
  'deterministic_complete',
  'deterministic_partial',
  'masking',
  'privacy_blocked',
  'ai_pending',
  'ai_running',
  'ai_complete',
  'schema_rejected',
  'reconciling',
  'unresolved',
  'awaiting_acceptance',
  'accepted',
  'write_pending',
  'completed',
  'failed_retryable',
  'failed_terminal',
] as const;
export type AieRunStatus = (typeof AIE_RUN_STATUSES)[number];

/** Terminal run states — no onward transition exists. */
export const AIE_TERMINAL_RUN_STATUSES: readonly AieRunStatus[] = [
  'completed',
  'failed_terminal',
  'privacy_blocked',
];

export type AieDeterministicOutcome = 'not_applicable' | 'complete' | 'partial' | 'failed';

export type AieSourceMethod = 'deterministic' | 'ai' | 'ocr';

export const AIE_RECONCILIATION_OUTCOMES = ['pass', 'pass_with_tolerance', 'fail', 'indeterminate', 'not_applicable'] as const;
export type AieReconciliationOutcome = (typeof AIE_RECONCILIATION_OUTCOMES)[number];

export const AIE_UNRESOLVED_ITEM_STATUSES = ['open', 'in_review', 'resolved', 'rejected', 'deferred', 'superseded'] as const;
export type AieUnresolvedItemStatus = (typeof AIE_UNRESOLVED_ITEM_STATUSES)[number];

export type AieItemSeverity = 'blocking' | 'warning';

export type AieActorType = 'system' | 'worker' | 'user' | 'admin';

export type AieAiOutcome = 'success' | 'timeout' | 'rate_limited' | 'provider_error' | 'schema_rejected' | 'refused';

export type AieSourceModuleHint = 'investment_intelligence' | 'fdh_bank' | 'other' | null;

/** UPL/QUA-level admission failure reasons — privacy-safe, client-facing. */
export type AieAdmissionFailureCode =
  | 'unsupported_file_type'
  | 'file_too_large'
  | 'mime_mismatch'
  | 'file_corrupt'
  | 'structural_reject'
  | 'malware_scan_failed_closed'
  | 'password_protected';

export interface AieAdmissionResult {
  ok: boolean;
  detectedMimeType?: string;
  fileHash?: string;
  passwordRequired?: boolean;
  structuralWarnings?: string[];
  failureCode?: AieAdmissionFailureCode;
}

/**
 * Field-level candidate produced by either a deterministic parser or the
 * masked AI fallback — never raw source text. `sourceReference` should point
 * back to page/row/table coordinates the deterministic extraction stage
 * already recorded (kept generic and jsonb-shaped in the DB since AIE-1.1
 * has no page/table-artifact persistence yet — see the migration header's
 * "deferred" note).
 */
export interface AieFieldCandidate {
  fieldName: string;
  valueRaw: string | null;
  isNull: boolean;
  nullReason?: string;
  sourceMethod: AieSourceMethod;
  sourceReference?: Record<string, unknown>;
}

export interface AieReconciliationRunResult {
  ruleId: string;
  ruleVersion: string;
  outcome: AieReconciliationOutcome;
  delta?: number | null;
  tolerance?: number | null;
  materiality?: string | null;
}

export interface AieUnresolvedItemInput {
  reasonCode: string;
  severity: AieItemSeverity;
  displayCandidate?: string | null;
  evidenceRef?: Record<string, unknown>;
  permittedActionTypes: string[];
}
