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
  /**
   * The publication's own position. A publication is one-per-position (account + instrument) and is made from the position's LATEST
   * certified snapshot, which is often a snapshot of a DIFFERENT, newer statement than the one a row in the list belongs to.
   * Matching on the snapshot id alone therefore reported "17 ready to publish" for a statement whose 17 positions were all
   * published (found on production 29-10-2026). Optional only so a caller that cannot supply them still gets the older exact-id match.
   */
  account_id?: string;
  instrument_id?: string;
  status: string;
}

export interface SourceDocumentCounts {
  openReconciliationCaseCount: number;
  /** Positions (account + instrument) from this statement that are NOT certified and need the person to act. */
  positionsNeedingAttentionCount: number;
  /** Distinct positions this statement recorded. */
  totalHoldingsCount: number;
  /** Of those, the positions that have an ACTIVE publication (whichever statement's snapshot it was made from). */
  publishedHoldingsCount: number;
  /** Of those, the positions that are certified (also with warnings) and NOT yet published: exactly the Publish clicks still to make. */
  readyToPublishCount: number;
}

const TRUTH_OK_STATUSES = new Set(['certified', 'certified_with_warnings']);
/** A position that a newer evaluation replaced, or that was archived: nothing is waiting on the person for it. */
const TRUTH_INACTIVE_STATUSES = new Set(['superseded', 'archived']);

const pairKey = (accountId: string, instrumentId: string) => `${accountId}:${instrumentId}`;

/**
 * Builds a `source_document_id -> counts` map from the raw rows the route
 * fetches. Every input array may be empty; a document with no matching rows
 * anywhere simply gets all-zero counts (via `EMPTY_COUNTS` at the call site).
 *
 * Counting is by POSITION (account + instrument), once per statement, never by snapshot row:
 *   - published     = the position has an active ('published') publication row. An unpublished or superseded row is not a live
 *                     publication; a position unpublished and then published again is simply published again.
 *   - ready         = certified (or certified with warnings) AND not published.
 *   - needs attention = not certified (never evaluated, pending, reconciliation required, failed), published or not.
 * `archivedDocumentIds`: an archived statement is history. Its open issues and its positions are not "to do" for the person, so it
 * reports zero issues / attention / ready (its totals are still reported).
 */
export function computeSourceDocumentCounts(input: {
  openCases: RawOpenCase[];
  holdings: RawHolding[];
  truthStatuses: RawTruthStatus[];
  publications: RawPublication[];
  archivedDocumentIds?: ReadonlySet<string>;
}): Map<string, SourceDocumentCounts> {
  const { openCases, holdings, truthStatuses, publications } = input;
  const archived = input.archivedDocumentIds ?? new Set<string>();
  const counts = new Map<string, SourceDocumentCounts>();

  const get = (docId: string): SourceDocumentCounts => {
    let c = counts.get(docId);
    if (!c) {
      c = { openReconciliationCaseCount: 0, positionsNeedingAttentionCount: 0, totalHoldingsCount: 0, publishedHoldingsCount: 0, readyToPublishCount: 0 };
      counts.set(docId, c);
    }
    return c;
  };

  for (const c of openCases) {
    if (!c.source_document_id) continue;
    if (archived.has(c.source_document_id)) continue;
    get(c.source_document_id).openReconciliationCaseCount += 1;
  }

  const statusByPosition = new Map(truthStatuses.map((t) => [pairKey(t.account_id, t.instrument_id), t.status]));
  // Only an ACTIVE ('published') row counts — 'unpublished'/'superseded'
  // must not be mistaken for a live publication (see ii_fhip_publications'
  // own status check discipline in investmentPublicationService.ts).
  const active = publications.filter((p) => p.status === 'published');
  const publishedSnapshotIds = new Set(active.map((p) => p.canonical_position_id));
  const publishedPositions = new Set(active.filter((p) => p.account_id && p.instrument_id).map((p) => pairKey(p.account_id as string, p.instrument_id as string)));

  // One statement can hold several snapshot rows for the same position: reduce to one entry per (statement, position) first. It counts
  // as published if the position is published, or any of this statement's snapshots of it is the published snapshot.
  const positionsByDoc = new Map<string, Map<string, { published: boolean }>>();
  for (const h of holdings) {
    if (!h.source_document_id) continue;
    get(h.source_document_id); // a statement with holdings always gets an entry
    let positions = positionsByDoc.get(h.source_document_id);
    if (!positions) positionsByDoc.set(h.source_document_id, (positions = new Map()));
    const key = pairKey(h.account_id, h.instrument_id);
    const published = publishedPositions.has(key) || publishedSnapshotIds.has(h.id);
    const prev = positions.get(key);
    positions.set(key, { published: (prev?.published ?? false) || published });
  }

  for (const [docId, positions] of positionsByDoc) {
    const entry = get(docId);
    const isArchived = archived.has(docId);
    for (const [key, { published }] of positions) {
      entry.totalHoldingsCount += 1;
      if (published) entry.publishedHoldingsCount += 1;
      if (isArchived) continue;
      const status = statusByPosition.get(key);
      if (status && TRUTH_OK_STATUSES.has(status)) {
        if (!published) entry.readyToPublishCount += 1;
      } else if (!status || !TRUTH_INACTIVE_STATUSES.has(status)) {
        // No truth-status row at all (never evaluated) counts as needing attention too — that is not the same as "certified".
        entry.positionsNeedingAttentionCount += 1;
      }
    }
  }

  return counts;
}

export const EMPTY_SOURCE_DOCUMENT_COUNTS: SourceDocumentCounts = {
  openReconciliationCaseCount: 0,
  positionsNeedingAttentionCount: 0,
  totalHoldingsCount: 0,
  publishedHoldingsCount: 0,
  readyToPublishCount: 0,
};
