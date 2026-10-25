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
//   - it has open reconciliation issues (also when it is archived or superseded: an open issue is never hidden);
//   - positions from it still need attention (not certified);
//   - it is certified but not fully published, i.e. there is still a Publish to FHIP click to make (publishing is a separate, explicit
//     user action, so "certified" alone is not "done");
//   - a processing job for it is queued, running or waiting for the person.
// Everything else is QUIET: parsed with nothing left to do (including a statement that produced no holdings and has no issue), archived
// or superseded without an open issue.
//
// Pure and dependency-free so the rule is unit tested directly (this repository's unit baseline is node-only, no DOM).
export interface SourceDocumentGroupingSignals {
  status: string;
  openReconciliationCaseCount?: number;
  positionsNeedingAttentionCount?: number;
  totalHoldingsCount?: number;
  publishedHoldingsCount?: number;
}

/** Statuses that are finished and need nothing from the person by themselves. */
const QUIET_STATUSES = new Set(['parsed', 'archived', 'superseded']);

export function statementNeedsAction(doc: SourceDocumentGroupingSignals, hasUnfinishedJob = false): boolean {
  if (hasUnfinishedJob) return true;
  if (!QUIET_STATUSES.has(doc.status)) return true;
  if (doc.openReconciliationCaseCount) return true;
  if (doc.positionsNeedingAttentionCount) return true;
  // Certified but not fully published: a Publish to FHIP click is still to be made (only meaningful for a parsed statement).
  if (doc.status === 'parsed' && (doc.totalHoldingsCount ?? 0) > 0 && (doc.publishedHoldingsCount ?? 0) < (doc.totalHoldingsCount ?? 0)) return true;
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
  if (doc.status === 'parse_failed') out.push('Parse failed');
  if (doc.openReconciliationCaseCount) out.push(`${doc.openReconciliationCaseCount} issue${doc.openReconciliationCaseCount === 1 ? '' : 's'}`);
  if (doc.positionsNeedingAttentionCount) out.push(`${doc.positionsNeedingAttentionCount} position${doc.positionsNeedingAttentionCount === 1 ? '' : 's'} need attention`);
  if (doc.status === 'parsed' && (doc.totalHoldingsCount ?? 0) > 0 && (doc.publishedHoldingsCount ?? 0) < (doc.totalHoldingsCount ?? 0) && !doc.positionsNeedingAttentionCount) {
    const n = (doc.totalHoldingsCount ?? 0) - (doc.publishedHoldingsCount ?? 0);
    out.push(`${n} ready to publish`);
  }
  return out;
}
