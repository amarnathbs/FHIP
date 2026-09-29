// Per-document counts for GET /api/investment-intelligence/source-documents
// (2026-09-28 fix: openReconciliationCaseCount/positionsNeedingAttentionCount;
// 2026-09-29 fix: totalHoldingsCount/publishedHoldingsCount, added so the
// "Statements & data" list can tell a merely-certified position apart from
// an actually-published one — see lib/investment-intelligence/
// sourceDocumentGrouping.ts, which consumes these same four counts to decide
// whether a document belongs in "Previously processed").
//
// Extracted as a pure function, independent of Supabase, so the aggregation
// itself is unit-testable with plain arrays rather than only reachable
// through a mocked query chain — the route (route.ts) stays a thin
// fetch-then-call wrapper.
export interface RawOpenCase {
  source_document_id: string | null;
}

export interface RawHolding {
  id: string;
  source_document_id: string | null;
  account_id: string;
  instrument_id: string;
}

export interface RawTruthStatus {
  account_id: string;
  instrument_id: string;
  status: string;
}

export interface RawPublication {
  canonical_position_id: string;
  status: string;
}

export interface SourceDocumentCounts {
  openReconciliationCaseCount: number;
  positionsNeedingAttentionCount: number;
  totalHoldingsCount: number;
  publishedHoldingsCount: number;
}

const TRUTH_OK_STATUSES = new Set(['certified', 'certified_with_warnings']);

/**
 * Builds a `source_document_id -> counts` map from the raw rows the route
 * fetches. Every input array may be empty; a document with no matching rows
 * anywhere simply gets all-zero counts (via `EMPTY_COUNTS` at the call site).
 */
export function computeSourceDocumentCounts(input: {
  openCases: RawOpenCase[];
  holdings: RawHolding[];
  truthStatuses: RawTruthStatus[];
  publications: RawPublication[];
}): Map<string, SourceDocumentCounts> {
  const { openCases, holdings, truthStatuses, publications } = input;
  const counts = new Map<string, SourceDocumentCounts>();

  const get = (docId: string): SourceDocumentCounts => {
    let c = counts.get(docId);
    if (!c) {
      c = { openReconciliationCaseCount: 0, positionsNeedingAttentionCount: 0, totalHoldingsCount: 0, publishedHoldingsCount: 0 };
      counts.set(docId, c);
    }
    return c;
  };

  for (const c of openCases) {
    if (!c.source_document_id) continue;
    get(c.source_document_id).openReconciliationCaseCount += 1;
  }

  const statusByPosition = new Map(truthStatuses.map((t) => [`${t.account_id}:${t.instrument_id}`, t.status]));
  // Only an ACTIVE ('published') row counts — 'unpublished'/'superseded'
  // must not be mistaken for a live publication (see ii_fhip_publications'
  // own status check discipline in investmentPublicationService.ts).
  const publishedPositionIds = new Set(publications.filter((p) => p.status === 'published').map((p) => p.canonical_position_id));

  for (const h of holdings) {
    if (!h.source_document_id) continue;
    const entry = get(h.source_document_id);
    entry.totalHoldingsCount += 1;
    if (publishedPositionIds.has(h.id)) entry.publishedHoldingsCount += 1;

    const status = statusByPosition.get(`${h.account_id}:${h.instrument_id}`);
    // No truth-status row at all (never evaluated) counts as needing
    // attention too — that is not the same as "certified".
    if (!status || !TRUTH_OK_STATUSES.has(status)) {
      entry.positionsNeedingAttentionCount += 1;
    }
  }

  return counts;
}

export const EMPTY_SOURCE_DOCUMENT_COUNTS: SourceDocumentCounts = {
  openReconciliationCaseCount: 0,
  positionsNeedingAttentionCount: 0,
  totalHoldingsCount: 0,
  publishedHoldingsCount: 0,
};
