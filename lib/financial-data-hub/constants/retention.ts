/**
 * Financial Data Hub — FDH-3 raw-document retention configuration (spec
 * sections 39-40).
 *
 * ONE place, not a magic number scattered through services and scripts.
 * Every value is a NUMBER OF DAYS after the triggering event before a raw
 * document becomes due for purge — never an indefinite retention, per the
 * Product Owner principle: "raw user financial documents are temporary
 * processing artefacts, not permanent financial records."
 *
 * These are conservative FDH-3 defaults (a real product decision on exact
 * durations belongs to a later, explicitly product-reviewed pass); what
 * matters structurally is that every branch of the lifecycle has a FINITE,
 * configured due date and none of them is "never".
 */
export const FDH_DOCUMENT_RETENTION_DAYS = {
  /** Approved: the user has confirmed the extracted information is correct.
   * A short grace window (not instant deletion — spec section 36: "do not
   * overpromise immediate deletion") before the raw file is purged. */
  approved: 7,
  /** Rejected, or a pre-processing validation failure: nothing further will
   * ever be done with this file, so it may purge quickly. */
  rejected_or_failed: 1,
  /** An upload session that was created but never completed, or a document
   * that has sat with no forward progress for this many days — treated as
   * abandoned and purged automatically (spec section 48). */
  abandoned_days: 2,
} as const;

export function computePurgeDueDate(nowIso: string, days: number): string {
  return new Date(new Date(nowIso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
