// Statements & data list grouping (2026-09-29 fix, real UX bug confirmed
// live on /investment-intelligence/data): a document that has been fully
// processed, reviewed, certified AND published never left the working list
// — every uploaded statement stayed in the same flat list forever regardless
// of status, so a user with months of statements had to scroll past
// everything already finished to find anything new or still actionable.
//
// Extracted as a pure, importable function (rather than kept private inside
// InvestmentIntelligenceClient.tsx) so the grouping rule itself can be unit
// tested directly, the same way lib/investment-intelligence/
// analysisAvailability.ts's pure functions are — this repo's vitest baseline
// is node-environment-only with no jsdom/testing-library (see
// tests/unit/iiPc2WorkspaceUiContract.test.ts's own header), so a plain,
// dependency-free function is the only way to test real behaviour rather
// than asserting against source text.
//
// THE CONDITION, deliberately conservative (PO instruction: never guess a
// document into "done"):
//   1. `status === 'parsed'` — the document itself finished successfully.
//      Anything still mid-flow, failed, awaiting AI review, superseded, or
//      otherwise not 'parsed' is left in the active list by definition.
//   2. Zero OPEN reconciliation exceptions — nothing left to decide.
//   3. Zero positions the Portfolio Truth step still flags as needing
//      attention — matches the same OK_STATUSES discipline the
//      source-documents route already uses for that count.
//   4. It produced at least one holding, AND every holding it produced has
//      an ACTIVE publication (ii_fhip_publications.status = 'published',
//      keyed off canonical_position_id — the real FK, not an inference).
//      "Certified" alone is not "done": publishing is a separate, explicit
//      user action (R3, spec sections 41-42), so a certified-but-unpublished
//      position must keep its source document in the active list.
//   A document with zero holdings (nothing was ever extracted/published)
//   never qualifies — there is nothing published to confirm, so guessing it
//   into "previously processed" would be the same kind of unearned
//   inference spec section 30 forbids elsewhere in this module ("never infer
//   AVAILABLE merely because route exists").
export interface SourceDocumentGroupingSignals {
  status: string;
  openReconciliationCaseCount?: number;
  positionsNeedingAttentionCount?: number;
  totalHoldingsCount?: number;
  publishedHoldingsCount?: number;
}

export function isSourceDocumentFullyProcessed(doc: SourceDocumentGroupingSignals): boolean {
  return (
    doc.status === 'parsed' &&
    !doc.openReconciliationCaseCount &&
    !doc.positionsNeedingAttentionCount &&
    (doc.totalHoldingsCount ?? 0) > 0 &&
    doc.publishedHoldingsCount === doc.totalHoldingsCount
  );
}

export function partitionSourceDocumentsByProcessedState<T extends SourceDocumentGroupingSignals>(
  documents: T[]
): { active: T[]; previouslyProcessed: T[] } {
  const active: T[] = [];
  const previouslyProcessed: T[] = [];
  for (const doc of documents) {
    (isSourceDocumentFullyProcessed(doc) ? previouslyProcessed : active).push(doc);
  }
  return { active, previouslyProcessed };
}
