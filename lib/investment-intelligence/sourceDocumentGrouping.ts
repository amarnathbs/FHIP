// Statements & data list grouping.
//
// 2026-09-29: a document that had been fully processed never left the working list, so a person with months of statements had to scroll
// past everything finished to find anything still actionable.
//
// Document2 (4) WP-J (25-10-2026, Product Owner request): the list now shows PROMINENTLY only the statements that need action, and folds
// everything else into one quiet "Processed statements (N)" disclosure (the rows, their detail panels and "Upload replacement copy" all
// still work from inside it).
//
// A statement NEEDS ACTION when any of these is true:
//   - it is not in a finished state: uploaded and never processed, processing, failed to parse ("Parse failed"), password required,
//     unsupported, reconciliation required, an AI reading waiting for a check;
//   - it has open reconciliation issues (also when it is superseded: an open issue is never hidden. NOT when it is archived, see below);
//   - positions from it still need attention (not certified);
//   - it has certified positions that are not yet published, i.e. there is still a Publish to FHIP click to make (publishing is a
//     separate, explicit user action, so "certified" alone is not "done"). Counted per POSITION and only for positions that are not
//     published already (29-10-2026: a fully published statement used to be called "17 ready to publish");
//   - a processing job for it is queued, running or waiting for the person.
// Everything else is QUIET: parsed with nothing left to do (including a statement that produced no holdings and has no issue), superseded
// without an open issue, and every ARCHIVED statement.
//
// ARCHIVED (Product Owner, 29-10-2026): an archived statement never appears in the prominent "Your statements" list, whatever issue it
// still carries. It is history: it is listed, greyed and without any issue count, under the collapsed "Processed statements" disclosure,
// where its detail (and so its old issue) can still be opened. Nothing is deleted. A running job on it still makes it prominent, since
// that is the person's own live action.
//
// Pure and dependency-free so the rule is unit tested directly (this repository's unit baseline is node-only, no DOM).
export interface SourceDocumentGroupingSignals {
  status: string;
  openReconciliationCaseCount?: number;
  positionsNeedingAttentionCount?: number;
  totalHoldingsCount?: number;
  publishedHoldingsCount?: number;
  /** Certified (also with warnings) positions that are not yet published. */
  readyToPublishCount?: number;
}

/** Statuses that are finished and need nothing from the person by themselves. */
const QUIET_STATUSES = new Set(['parsed', 'archived', 'superseded']);

export function statementNeedsAction(doc: SourceDocumentGroupingSignals, hasUnfinishedJob = false): boolean {
  if (hasUnfinishedJob) return true;
  // History, never "to do": see the ARCHIVED note above.
  if (doc.status === 'archived') return false;
  if (!QUIET_STATUSES.has(doc.status)) return true;
  if (doc.openReconciliationCaseCount) return true;
  if (doc.positionsNeedingAttentionCount) return true;
  // Certified but not published: a Publish to FHIP click is still to be made (only meaningful for a parsed statement).
  if (doc.status === 'parsed' && (doc.readyToPublishCount ?? 0) > 0) return true;
  return false;
}

/** True when nothing is left to do on this statement (kept under its earlier name for existing callers). */
export function isSourceDocumentFullyProcessed(doc: SourceDocumentGroupingSignals): boolean {
  return !statementNeedsAction(doc, false);
}

export function partitionSourceDocumentsByProcessedState<T extends SourceDocumentGroupingSignals & { id?: string }>(
  documents: T[],
  documentIdsWithUnfinishedJob: ReadonlySet<string> = new Set(),
): { active: T[]; previouslyProcessed: T[] } {
  const active: T[] = [];
  const previouslyProcessed: T[] = [];
  for (const doc of documents) {
    (statementNeedsAction(doc, doc.id !== undefined && documentIdsWithUnfinishedJob.has(doc.id)) ? active : previouslyProcessed).push(doc);
  }
  return { active, previouslyProcessed };
}

/** The small chips that say WHY a statement is in the prominent list (plain words; an empty list means it is quiet). */
export function statementActionReasons(doc: SourceDocumentGroupingSignals, hasUnfinishedJob = false): string[] {
  const out: string[] = [];
  if (hasUnfinishedJob) out.push('Processing');
  if (doc.status === 'archived') return out;
  if (doc.status === 'parse_failed') out.push('Parse failed');
  if (doc.openReconciliationCaseCount) out.push(`${doc.openReconciliationCaseCount} issue${doc.openReconciliationCaseCount === 1 ? '' : 's'}`);
  if (doc.positionsNeedingAttentionCount) out.push(`${doc.positionsNeedingAttentionCount} position${doc.positionsNeedingAttentionCount === 1 ? '' : 's'} need attention`);
  if (doc.status === 'parsed' && (doc.readyToPublishCount ?? 0) > 0 && !doc.positionsNeedingAttentionCount) out.push(`${doc.readyToPublishCount} ready to publish`);
  return out;
}

/**
 * The publication pill on a statement row (29-10-2026). Only a certified, not-yet-published position is "ready to publish"; when
 * nothing is waiting and positions are published the row says so in positive words instead of repeating a to-do that is done.
 * Archived statements and statements with an issue / positions needing attention show no publication pill (those signals come first).
 */
export type StatementPublicationPill = { tone: 'ready'; text: string; title: string } | { tone: 'published'; text: string; title: string } | null;

export function statementPublicationPill(doc: SourceDocumentGroupingSignals): StatementPublicationPill {
  if (doc.status !== 'parsed') return null;
  if (doc.openReconciliationCaseCount || doc.positionsNeedingAttentionCount) return null;
  const ready = doc.readyToPublishCount ?? 0;
  const published = doc.publishedHoldingsCount ?? 0;
  const total = doc.totalHoldingsCount ?? 0;
  if (ready > 0) {
    return { tone: 'ready', text: `${ready} ready to publish`, title: 'These positions are certified and can be published to FHIP' };
  }
  if (published > 0) {
    return {
      tone: 'published',
      text: total > 0 && published === total ? (total === 1 ? '1 published' : `All ${total} published`) : `${published} published`,
      title: 'These positions are published to FHIP and counted in your net worth',
    };
  }
  return null;
}
