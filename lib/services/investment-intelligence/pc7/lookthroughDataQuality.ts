// PC7 (M7) — the look-through data-quality model (O.9), and the freshness
// vocabulary the X-Ray surface must speak (O.8).
//
// PURE BY DESIGN. Every function here takes rows and returns verdicts. The
// admin route does the I/O; this module does the judgement, so every O.9
// signal is unit-testable without a database and so the same judgement can be
// applied to a PGlite replay, a live query, or a fixture.
//
// O.8's RULE, encoded rather than described: a signal is never allowed to
// report zero when it means "unknown". Every result carries an explicit state
// — `ok` / `never_ingested` / `unavailable` — so "this fund discloses 0%
// equity" and "we have never seen this fund's portfolio" can never render the
// same way.

import { HOLDINGS_FRESHNESS_DAYS } from '@/lib/config/investment-intelligence/xrayThresholds';

export const PC7_QUALITY_VERSION = 'pc7-lookthrough-quality-v1';

export type QualitySignalState = 'ok' | 'never_ingested' | 'unavailable';

export interface QualitySignal<T> {
  state: QualitySignalState;
  data?: T;
  reason?: string;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00.000Z`) - Date.parse(`${fromIso}T00:00:00.000Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// O.9 (a) — missing scheme disclosures
// ---------------------------------------------------------------------------

export interface SchemeRef {
  instrumentId: string;
  schemeName: string;
  /** Whether any user currently holds it. Drives priority, not inclusion. */
  heldByAnyUser: boolean;
}

export interface MissingDisclosure {
  instrumentId: string;
  schemeName: string;
  heldByAnyUser: boolean;
}

export interface MissingDisclosureReport {
  totalSchemes: number;
  withDisclosure: number;
  missing: MissingDisclosure[];
  /** Missing AND held by a user — the operator's actual work queue. */
  missingAndHeld: number;
}

/**
 * Which schemes have no usable disclosure at all.
 *
 * Reports held-but-undisclosed separately because the two are operationally
 * different: an undisclosed scheme nobody owns is a backlog item, while an
 * undisclosed scheme somebody owns is actively degrading that user's X-Ray
 * coverage right now.
 */
export function findMissingDisclosures(schemes: SchemeRef[], schemeIdsWithSnapshot: Set<string>): MissingDisclosureReport {
  const missing = schemes
    .filter((s) => !schemeIdsWithSnapshot.has(s.instrumentId))
    .map((s) => ({ instrumentId: s.instrumentId, schemeName: s.schemeName, heldByAnyUser: s.heldByAnyUser }));
  return {
    totalSchemes: schemes.length,
    withDisclosure: schemes.length - missing.length,
    missing,
    missingAndHeld: missing.filter((m) => m.heldByAnyUser).length,
  };
}

// ---------------------------------------------------------------------------
// O.9 (b) — stale snapshots / O.8 freshness
// ---------------------------------------------------------------------------

export type SnapshotFreshness = 'CURRENT' | 'ACCEPTABLE' | 'STALE' | 'VERY_STALE' | 'MISSING';

export interface SnapshotRef {
  snapshotId: string;
  fundInstrumentId: string;
  holdingsAsOfDate: string;
  sourceKey: string | null;
  disclosedWeightTotalPct: number | null;
  qualityStatus: string;
  lineCount: number;
}

export interface StalenessVerdict {
  snapshotId: string;
  fundInstrumentId: string;
  holdingsAsOfDate: string;
  ageDays: number;
  freshness: SnapshotFreshness;
}

/**
 * Freshness of one snapshot.
 *
 * Uses the SAME day thresholds as the certified R5 X-Ray engine
 * (`xrayThresholds.ts`) rather than declaring PC7's own. Two different
 * definitions of "stale" between the ingestion surface and the user-facing
 * surface would mean the operator dashboard can read green while a user is
 * shown a stale-data warning, which is worse than either being wrong.
 */
export function classifySnapshotFreshness(holdingsAsOfDate: string | null, asOfDate: string): { freshness: SnapshotFreshness; ageDays: number | null } {
  if (!holdingsAsOfDate) return { freshness: 'MISSING', ageDays: null };
  const ageDays = daysBetween(holdingsAsOfDate, asOfDate);
  if (ageDays < 0) return { freshness: 'MISSING', ageDays };
  if (ageDays <= HOLDINGS_FRESHNESS_DAYS.CURRENT_MAX) return { freshness: 'CURRENT', ageDays };
  if (ageDays <= HOLDINGS_FRESHNESS_DAYS.ACCEPTABLE_MAX) return { freshness: 'ACCEPTABLE', ageDays };
  if (ageDays <= HOLDINGS_FRESHNESS_DAYS.STALE_MAX) return { freshness: 'STALE', ageDays };
  return { freshness: 'VERY_STALE', ageDays };
}

export interface StalenessReport {
  asOfDate: string;
  snapshotCount: number;
  current: number;
  acceptable: number;
  stale: number;
  veryStale: number;
  /** Worst first — the operator's queue. */
  stalest: StalenessVerdict[];
}

export function assessSnapshotStaleness(snapshots: SnapshotRef[], asOfDate: string, limit = 50): StalenessReport {
  // One verdict per FUND, using that fund's newest snapshot. Judging every
  // historical snapshot would report a fund with five years of preserved
  // monthly disclosures as "60 stale snapshots", which is not a problem and
  // would bury the funds that genuinely have none recent.
  const newestByFund = new Map<string, SnapshotRef>();
  for (const s of snapshots) {
    const prev = newestByFund.get(s.fundInstrumentId);
    if (!prev || s.holdingsAsOfDate > prev.holdingsAsOfDate) newestByFund.set(s.fundInstrumentId, s);
  }
  const verdicts: StalenessVerdict[] = [...newestByFund.values()].map((s) => {
    const { freshness, ageDays } = classifySnapshotFreshness(s.holdingsAsOfDate, asOfDate);
    return { snapshotId: s.snapshotId, fundInstrumentId: s.fundInstrumentId, holdingsAsOfDate: s.holdingsAsOfDate, ageDays: ageDays ?? -1, freshness };
  });
  return {
    asOfDate,
    snapshotCount: verdicts.length,
    current: verdicts.filter((v) => v.freshness === 'CURRENT').length,
    acceptable: verdicts.filter((v) => v.freshness === 'ACCEPTABLE').length,
    stale: verdicts.filter((v) => v.freshness === 'STALE').length,
    veryStale: verdicts.filter((v) => v.freshness === 'VERY_STALE').length,
    stalest: verdicts.filter((v) => v.freshness === 'STALE' || v.freshness === 'VERY_STALE').sort((a, b) => b.ageDays - a.ageDays).slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// O.9 (c) — unmapped securities
// ---------------------------------------------------------------------------

export interface HoldingLineRef {
  snapshotId: string;
  holdingName: string;
  isin: string | null;
  assetKind: string;
  weightPct: number;
  underlyingInstrumentId: string | null;
}

export interface UnmappedSecurity {
  holdingName: string;
  isin: string | null;
  /** How many distinct snapshots carry this unresolved name. */
  occurrences: number;
  /** Largest within-fund weight seen. Mapping the biggest first buys the most coverage. */
  maxWeightPct: number;
}

export interface UnmappedSecurityReport {
  totalSecurityLines: number;
  resolvedLines: number;
  unresolvedLines: number;
  /** Distinct unresolved securities, worst first. */
  unmapped: UnmappedSecurity[];
}

/**
 * Which constituents never resolved to a canonical security.
 *
 * Grouped by (ISIN, else name) so an operator sees "HDFC Bank appears
 * unresolved in 41 snapshots at up to 9.5%" — one mapping decision worth 41
 * fixes — rather than 41 individually unremarkable rows.
 *
 * Cash / derivative / other buckets are EXCLUDED: they are not securities and
 * were never meant to resolve, so counting them as mapping gaps would inflate
 * the queue with work that must never be done.
 */
export function findUnmappedSecurities(lines: HoldingLineRef[], limit = 100): UnmappedSecurityReport {
  const securityLines = lines.filter((l) => l.assetKind === 'security');
  const unresolved = securityLines.filter((l) => l.underlyingInstrumentId === null);
  const byKey = new Map<string, UnmappedSecurity & { snapshots: Set<string> }>();
  for (const l of unresolved) {
    const key = l.isin ?? `name:${l.holdingName.toUpperCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.snapshots.add(l.snapshotId);
      existing.occurrences = existing.snapshots.size;
      existing.maxWeightPct = Math.max(existing.maxWeightPct, l.weightPct);
    } else {
      byKey.set(key, { holdingName: l.holdingName, isin: l.isin, occurrences: 1, maxWeightPct: l.weightPct, snapshots: new Set([l.snapshotId]) });
    }
  }
  const unmapped = [...byKey.values()]
    .map(({ snapshots, ...rest }) => rest)
    .sort((a, b) => b.occurrences - a.occurrences || b.maxWeightPct - a.maxWeightPct || a.holdingName.localeCompare(b.holdingName))
    .slice(0, limit);
  return {
    totalSecurityLines: securityLines.length,
    resolvedLines: securityLines.length - unresolved.length,
    unresolvedLines: unresolved.length,
    unmapped,
  };
}

// ---------------------------------------------------------------------------
// O.9 (d) — coverage gaps
// ---------------------------------------------------------------------------

/**
 * Below this disclosed total a snapshot is a COVERAGE GAP for the operator.
 * Set at the same 90% the ingestion runner uses for `partial_disclosure`, so
 * a snapshot flagged partial at write time is the same snapshot flagged as a
 * gap at read time.
 */
export const COVERAGE_GAP_BELOW_PCT = 90;

export interface CoverageGap {
  snapshotId: string;
  fundInstrumentId: string;
  holdingsAsOfDate: string;
  disclosedWeightTotalPct: number | null;
  lineCount: number;
  reason: 'below_threshold' | 'no_lines' | 'not_recorded';
}

export interface CoverageReport {
  snapshotCount: number;
  withFullCoverage: number;
  gaps: CoverageGap[];
}

/**
 * Snapshots whose disclosure does not cover the fund.
 *
 * `no_lines` is called out separately and deliberately. A snapshot HEADER with
 * zero lines is the most dangerous shape in this whole subsystem: the fund
 * looks like it has a disclosure, the look-through engine selects it as the
 * latest usable snapshot, and every exposure computed from it is zero — a
 * measured-looking zero, which is precisely what O.8 forbids. Migration 0044
 * cannot express "a snapshot must have lines" as a constraint, so it is
 * detected here.
 */
export function findCoverageGaps(snapshots: SnapshotRef[]): CoverageReport {
  const gaps: CoverageGap[] = [];
  for (const s of snapshots) {
    if (s.lineCount === 0) {
      gaps.push({ snapshotId: s.snapshotId, fundInstrumentId: s.fundInstrumentId, holdingsAsOfDate: s.holdingsAsOfDate, disclosedWeightTotalPct: s.disclosedWeightTotalPct, lineCount: 0, reason: 'no_lines' });
      continue;
    }
    if (s.disclosedWeightTotalPct === null) {
      gaps.push({ snapshotId: s.snapshotId, fundInstrumentId: s.fundInstrumentId, holdingsAsOfDate: s.holdingsAsOfDate, disclosedWeightTotalPct: null, lineCount: s.lineCount, reason: 'not_recorded' });
      continue;
    }
    if (s.disclosedWeightTotalPct < COVERAGE_GAP_BELOW_PCT) {
      gaps.push({ snapshotId: s.snapshotId, fundInstrumentId: s.fundInstrumentId, holdingsAsOfDate: s.holdingsAsOfDate, disclosedWeightTotalPct: s.disclosedWeightTotalPct, lineCount: s.lineCount, reason: 'below_threshold' });
    }
  }
  return { snapshotCount: snapshots.length, withFullCoverage: snapshots.length - gaps.length, gaps };
}

// ---------------------------------------------------------------------------
// O.9 (e) — parser / import failures
// ---------------------------------------------------------------------------

export interface BatchRef {
  id: string;
  batchKind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  rowsRead: number | null;
  rowsAccepted: number | null;
  rowsRejected: number | null;
  errorCode: string | null;
}

export interface ImportFailureReport {
  batchCount: number;
  succeeded: number;
  failed: number;
  running: number;
  /** Rejected / read, across the window. */
  rejectionRate: number | null;
  lastSuccessAt: string | null;
  recentFailures: BatchRef[];
}

export function summariseImportFailures(batches: BatchRef[], limit = 25): ImportFailureReport {
  const pc7 = batches.filter((b) => b.batchKind === 'fund_holdings_disclosure');
  const succeeded = pc7.filter((b) => b.status === 'succeeded');
  const failed = pc7.filter((b) => b.status === 'failed' || b.status === 'rolled_back');
  const read = pc7.reduce((n, b) => n + (b.rowsRead ?? 0), 0);
  const rejected = pc7.reduce((n, b) => n + (b.rowsRejected ?? 0), 0);
  const lastSuccess = succeeded
    .map((b) => b.finishedAt ?? b.startedAt)
    .sort()
    .at(-1) ?? null;
  return {
    batchCount: pc7.length,
    succeeded: succeeded.length,
    failed: failed.length,
    running: pc7.filter((b) => b.status === 'running').length,
    // null, not 0: a window with no rows read has an UNKNOWN rejection rate,
    // and 0% would read as a perfectly healthy importer.
    rejectionRate: read > 0 ? rejected / read : null,
    lastSuccessAt: lastSuccess,
    recentFailures: failed.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// O.9 (f) — source changes
// ---------------------------------------------------------------------------

export interface LayoutObservation {
  batchId: string;
  observedAt: string;
  /** Ordered header labels as found, joined. The layout's identity. */
  columnSignature: string;
  sectionsSeen: string[];
  rejectionRate: number | null;
}

export type SourceChangeKind = 'COLUMN_LAYOUT_CHANGED' | 'NEW_SECTION_APPEARED' | 'SECTION_DISAPPEARED' | 'REJECTION_RATE_SPIKE';

export interface SourceChange {
  kind: SourceChangeKind;
  detail: string;
  fromBatchId: string;
  toBatchId: string;
}

/** A rejection rate above this, having previously been below it, is a spike. */
export const REJECTION_SPIKE_RATE = 0.05;

/**
 * Detect that the PUBLISHER changed, not that the data changed.
 *
 * This is the signal that catches the worst silent failure in reference
 * ingestion: a publisher quietly renames or reorders columns, the parser keeps
 * "working", and every number after that date is drawn from the wrong column.
 * A column-signature change is therefore reported even when the import
 * SUCCEEDED — especially then, because a successful import of a changed layout
 * is exactly the case nobody looks at.
 */
export function detectSourceChanges(observations: LayoutObservation[]): SourceChange[] {
  const sorted = [...observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const changes: SourceChange[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.columnSignature !== cur.columnSignature) {
      changes.push({
        kind: 'COLUMN_LAYOUT_CHANGED',
        detail: `Column layout changed between ${prev.observedAt} and ${cur.observedAt}. Before: "${prev.columnSignature}". After: "${cur.columnSignature}". A successful import under a changed layout is more dangerous than a failed one — verify the mapping before trusting anything ingested after this point.`,
        fromBatchId: prev.batchId,
        toBatchId: cur.batchId,
      });
    }
    for (const s of cur.sectionsSeen) {
      if (!prev.sectionsSeen.includes(s)) {
        changes.push({ kind: 'NEW_SECTION_APPEARED', detail: `Section "${s}" appeared at ${cur.observedAt} and was not present at ${prev.observedAt}.`, fromBatchId: prev.batchId, toBatchId: cur.batchId });
      }
    }
    for (const s of prev.sectionsSeen) {
      if (!cur.sectionsSeen.includes(s)) {
        changes.push({ kind: 'SECTION_DISAPPEARED', detail: `Section "${s}" was present at ${prev.observedAt} and is absent at ${cur.observedAt}. A genuinely exited asset class and a renamed header look identical here — check which it was.`, fromBatchId: prev.batchId, toBatchId: cur.batchId });
      }
    }
    if (prev.rejectionRate !== null && cur.rejectionRate !== null && prev.rejectionRate <= REJECTION_SPIKE_RATE && cur.rejectionRate > REJECTION_SPIKE_RATE) {
      changes.push({
        kind: 'REJECTION_RATE_SPIKE',
        detail: `Rejection rate rose from ${(prev.rejectionRate * 100).toFixed(1)}% to ${(cur.rejectionRate * 100).toFixed(1)}% (threshold ${(REJECTION_SPIKE_RATE * 100).toFixed(0)}%). A rejection spike usually means the source changed format, not that the data went bad.`,
        fromBatchId: prev.batchId,
        toBatchId: cur.batchId,
      });
    }
  }
  return changes;
}
