/**
 * Financial Data Hub — raw-document retention configuration.
 *
 * ONE place, not a magic number scattered through services and scripts.
 *
 * LR-1 (Upload Security, Strict Raw-File Deletion & Document Lifecycle)
 * SUPERSEDES the original FDH-3 "keep the raw file through the review grace
 * window as evidence" design. The Product Owner's LR-1 decision is STRICT
 * RAW-FILE DELETION: FHIP retains structured financial data and minimal
 * audit metadata only. A raw uploaded document (PDF/CSV/image/etc.) is used
 * only long enough to validate and extract required structured information,
 * then deleted — independently verified absent, not merely "requested".
 *
 * `FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES` is the hard, absolute backstop
 * (LR-1 spec: "if none exists, implement a 60-minute maximum raw-file
 * lifetime from receipt"). No branch below may exceed it, and
 * `services/purge.ts#enforceRawFileHardBackstop()` force-schedules a purge
 * for ANY document whose raw object has outlived it regardless of
 * processing_status — a safety net that does not depend on every ingestion
 * pipeline remembering to call the per-branch scheduling functions below.
 */
export const FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES = 60;

/**
 * Per-branch scheduling, in MINUTES after the triggering event before a raw
 * document becomes due for purge. Never "never", and never larger than
 * `FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES` measured from upload receipt.
 */
export const FDH_DOCUMENT_RETENTION_MINUTES = {
  /** Approved: the user has confirmed the extracted, structured information
   * is correct and it has been durably written to canonical/staging tables.
   * The raw source document is no longer needed for anything — purge is
   * scheduled immediately (LR-1's strict-deletion principle), not after a
   * multi-day "evidence" grace window. */
  approved: 0,
  /** Rejected, or a pre-processing validation failure: nothing further will
   * ever be done with this file — purge immediately. */
  rejected_or_failed: 0,
  /** An upload session that was created but never completed. Bounded well
   * under the 60-minute hard cap (the session itself already expires 15
   * minutes after creation — see migration 0058). */
  abandoned_minutes: 20,
} as const;

/** @deprecated kept only so any historical caller passing whole days still
 * compiles; new code should call `computePurgeDueDateMinutes`. Converts to
 * the same finite-due-date contract using minutes internally. */
export function computePurgeDueDate(nowIso: string, days: number): string {
  return computePurgeDueDateMinutes(nowIso, days * 24 * 60);
}

export function computePurgeDueDateMinutes(nowIso: string, minutes: number): string {
  return new Date(new Date(nowIso).getTime() + minutes * 60 * 1000).toISOString();
}
