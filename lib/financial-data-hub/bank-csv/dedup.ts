/**
 * R7 — Bank CSV Engine: deterministic deduplication (spec sections 32-38).
 *
 * PURE DECISION LOGIC ONLY — this module never touches the database. The
 * caller (orchestrator/service layer) builds a `DedupIndex` from BOTH
 * already-persisted transactions (cross-import dedup, spec 32) and rows
 * already accepted earlier in the SAME processing run (within-file
 * duplicate rows, spec 68), so one code path handles both.
 *
 * WHY NOT AUTO-DISCARD ON DATE+AMOUNT+DESCRIPTION ALONE (spec 33-34). Two
 * genuine same-day/same-amount purchases (two coffees) must not be silently
 * merged into one. `computeEconomicFingerprint()` (fingerprint.ts) already
 * incorporates `reference` and `balanceAfter` when the source provides them
 * — a source that DOES supply a reference number or a running balance gives
 * strong deterministic evidence that two matching fingerprints really are
 * the same transaction (a genuine second coffee purchase gets a different
 * reference/balance). When the source supplies NEITHER (pure date+amount+
 * description), a fingerprint match is downgraded from CONFIRMED to
 * CANDIDATE — flagged for a human, never silently discarded (spec 34's
 * "do not automatically discard weak fuzzy matches").
 */

import type { FdhDuplicateMatchMethod, FdhTransactionDedupStatus } from '../constants/enums';

export interface DedupIndexEntry {
  transactionId: string;
  /** Did the ORIGINAL (already-accepted) row carry a reference or balance?
   * Strong evidence requires BOTH sides of the match to carry it — a
   * reference-bearing new row matching a reference-less stored row is not
   * itself strong evidence that the stored row's reference-less identity is
   * reliable. */
  hasStrongEvidence: boolean;
}

export type DedupIndex = Map<string, DedupIndexEntry[]>;

export interface DedupCandidateInput {
  economicFingerprint: string;
  /** True when the row's reference or running balance was present and
   * non-empty — the strong-evidence signal (spec 33-34). */
  hasStrongEvidence: boolean;
}

export interface DedupDecision {
  status: FdhTransactionDedupStatus;
  matchedTransactionId: string | null;
  matchMethod: FdhDuplicateMatchMethod | null;
  confidence: number;
}

export function decideDedup(candidate: DedupCandidateInput, index: DedupIndex): DedupDecision {
  const matches = index.get(candidate.economicFingerprint);
  if (!matches || matches.length === 0) {
    return { status: 'unique', matchedTransactionId: null, matchMethod: null, confidence: 1 };
  }

  const match = matches[0];
  const strongBothSides = candidate.hasStrongEvidence && match.hasStrongEvidence;

  if (strongBothSides) {
    return {
      status: 'duplicate_confirmed',
      matchedTransactionId: match.transactionId,
      matchMethod: 'exact_hash',
      confidence: 0.99,
    };
  }
  return {
    status: 'duplicate_candidate',
    matchedTransactionId: match.transactionId,
    matchMethod: 'fuzzy_amount_date',
    confidence: 0.6,
  };
}

/** Adds a newly-accepted candidate to the index so a LATER row in the same
 * (or a later) batch can be compared against it — the mechanism that makes
 * within-file duplicate rows (spec 68) and cross-import overlap (spec 32)
 * share one code path. */
export function addToDedupIndex(index: DedupIndex, fingerprint: string, entry: DedupIndexEntry): void {
  const existing = index.get(fingerprint);
  if (existing) existing.push(entry);
  else index.set(fingerprint, [entry]);
}
