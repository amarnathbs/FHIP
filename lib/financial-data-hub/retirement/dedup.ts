/**
 * FDH-12 — retirement activity deduplication (spec sections 51-54, 130-131).
 *
 * ============================================================================
 * THE THREE DUPLICATE CLASSES, AND WHAT HANDLES EACH
 * ============================================================================
 *
 * 1. THE SAME FILE UPLOADED TWICE (spec section 51).
 *    Handled upstream by FDH-3's byte hash: `fdh_statement_uploads.file_hash`
 *    is a sha-256 of the bytes, and `duplicate_of_document_id` flags the
 *    second upload. The processing service short-circuits and returns the
 *    EXISTING statement rather than creating a second one — so duplicate
 *    activities, contributions, proposals and accounts are all 0 without this
 *    module being involved at all. FDH-12 reuses that mechanism rather than
 *    duplicating it.
 *
 * 2. OVERLAPPING PERIODS (spec sections 52, 131).
 *    Statement A covers Jul-Dec, statement B covers Oct-Mar. October to
 *    December's activity appears on both, in two different files with two
 *    different byte hashes. The byte hash cannot help. THIS module handles it,
 *    via `activityFingerprint`.
 *
 * 3. ANNUAL PLUS MONTHLY (spec section 53).
 *    Twelve monthly statements plus one annual statement covering the same
 *    year must not yield thirteen copies of the year's activity. Two
 *    mechanisms combine: the annual statement's per-line rows fingerprint
 *    identically to the monthly ones (so they dedup as class 2), and its
 *    PRINTED TOTALS are flagged `is_summary_total` and excluded from
 *    activity-level arithmetic entirely (see `./reconciliation.ts`).
 *
 * ============================================================================
 * THE FINGERPRINT
 * ============================================================================
 *
 * Derived from the ECONOMIC CONTENT of the activity, never from a row number,
 * a file name or an upload id — those differ between two files describing the
 * same event, which is precisely the case that must dedup.
 *
 * Components: canonical account + activity type + date + exact amount minor
 * units + currency + normalised employer. Summary and YTD rows are
 * deliberately EXCLUDED from fingerprinting (they get a null fingerprint):
 * they are not economic events, and giving an annual total the same identity
 * space as an individual line risks a total suppressing a real activity.
 *
 * A null fingerprint never collides — migration 0112's
 * `uq_fdh_retirement_activities_fingerprint` is a PARTIAL unique index
 * `where activity_fingerprint is not null`.
 */

import { createHash } from 'node:crypto';
import { normaliseEmployerName } from '../payslip/normalise';
import { minorUnitsToDecimalString, tryParseMoneyToMinorUnits } from './money';
import type { RetirementActivityEvidence } from './types';

/** Bumping this invalidates every previously-computed fingerprint, so it
 * changes only when the fingerprint's MEANING changes. */
export const RETIREMENT_ACTIVITY_FINGERPRINT_VERSION = 'v1';

/**
 * Component separator for the fingerprint pre-image.
 *
 * A unit separator (U+001F) rather than a space or a pipe, because a
 * normalised employer name legitimately contains spaces and could in principle
 * contain punctuation. A separator that can occur inside a component would let
 * two DIFFERENT component splits produce the same joined string, and therefore
 * the same fingerprint — a silent false duplicate that would suppress real
 * evidence.
 *
 * Written as an escape sequence, never as a raw control character in the
 * source: a literal control byte makes this file unreadable to grep and every
 * other line-oriented tool.
 */
const FINGERPRINT_DELIMITER = '\u001F';

export interface FingerprintInput {
  /** The canonical account the statement resolved to. When the account is not
   * yet resolved the fingerprint is null — an unresolved activity cannot be
   * compared against another account's activity without risking a false
   * duplicate across two different funds. */
  canonicalAccountId: string | null;
  activityType: string;
  activityDate: string | null;
  amount: string;
  currencyCode: string;
  employerNameRaw?: string | null;
  isSummaryTotal: boolean;
  isYearToDate: boolean;
}

/**
 * Compute the stable identity of one economic retirement activity.
 *
 * Returns `null` when the activity cannot be identified with confidence — an
 * unresolved account, a missing date, or an unreadable amount. A null
 * fingerprint means "do not dedup this row", which is the safe direction: a
 * missed dedup is a visible duplicate the user can resolve, whereas a false
 * dedup silently deletes real evidence.
 */
export function computeActivityFingerprint(input: FingerprintInput): string | null {
  // Summary totals and YTD figures are not economic events (spec 116-118).
  if (input.isSummaryTotal || input.isYearToDate) return null;
  if (!input.canonicalAccountId) return null;
  if (!input.activityDate) return null;

  const minorUnits = tryParseMoneyToMinorUnits(input.amount);
  if (minorUnits === null) return null;

  const employer = normaliseEmployerName(input.employerNameRaw ?? null) ?? '';

  // A delimiter that cannot occur inside any component, so two different
  // component splits cannot produce the same joined string.
  const parts = [
    RETIREMENT_ACTIVITY_FINGERPRINT_VERSION,
    input.canonicalAccountId,
    input.activityType,
    input.activityDate,
    minorUnitsToDecimalString(minorUnits),
    input.currencyCode.toUpperCase(),
    employer,
  ];
  return createHash('sha256').update(parts.join(FINGERPRINT_DELIMITER)).digest('hex');
}

export interface DedupDecision {
  /** Index into the input array. */
  index: number;
  fingerprint: string | null;
  /** True when an earlier row in this batch, or an existing row on file,
   * already carries this fingerprint. */
  isDuplicate: boolean;
  /** The activity id of the row this one duplicates, when it is an existing
   * one on file. */
  duplicateOfActivityId: string | null;
}

/**
 * Decide, for a batch of newly-extracted activities, which are duplicates of
 * each other or of activities already on file.
 *
 * @param existingFingerprints  fingerprint -> existing activity id, for every
 *                              activity this user already has. The caller
 *                              builds it with a paginated read (spec 139).
 */
export function dedupActivities(
  activities: readonly RetirementActivityEvidence[],
  canonicalAccountId: string | null,
  existingFingerprints: ReadonlyMap<string, string>,
): DedupDecision[] {
  const seenInBatch = new Set<string>();
  return activities.map((a, index) => {
    const fingerprint = computeActivityFingerprint({
      canonicalAccountId,
      activityType: a.activityType,
      activityDate: a.activityDate ?? null,
      amount: a.amount,
      currencyCode: a.currencyCode,
      employerNameRaw: a.employerNameRaw ?? null,
      isSummaryTotal: a.isSummaryTotal,
      isYearToDate: a.isYearToDate,
    });

    if (fingerprint === null) {
      return { index, fingerprint: null, isDuplicate: false, duplicateOfActivityId: null };
    }
    const existingId = existingFingerprints.get(fingerprint) ?? null;
    if (existingId) {
      return { index, fingerprint, isDuplicate: true, duplicateOfActivityId: existingId };
    }
    if (seenInBatch.has(fingerprint)) {
      // Two identical rows within ONE statement. This is genuinely ambiguous —
      // a fund CAN credit the same employer the same amount twice on one day —
      // but the same is true across statements, and consistency matters more
      // than either guess. Flagged as a duplicate so the user sees it and can
      // un-flag; never silently dropped.
      return { index, fingerprint, isDuplicate: true, duplicateOfActivityId: null };
    }
    seenInBatch.add(fingerprint);
    return { index, fingerprint, isDuplicate: false, duplicateOfActivityId: null };
  });
}

/**
 * REVISED / REISSUED STATEMENTS (spec section 54).
 *
 * A fund reissues a corrected statement for a period already imported. Both
 * versions are retained — the original is not deleted, because deleting
 * evidence a user has already reviewed is not FDH-12's call — and the new one
 * records `supersedes_statement_id` pointing at the old.
 *
 * "Do not count both versions blindly" is then satisfied by the fingerprint:
 * lines unchanged between the two versions dedup, and only genuinely CHANGED
 * lines appear as new activity. That is the correct behaviour: a reissue that
 * corrected one fee should surface exactly that one corrected fee.
 *
 * This function decides whether a newly-parsed statement supersedes an
 * existing one. Same account, same period, later statement date.
 */
export interface StatementIdentity {
  id: string;
  canonicalAccountId: string | null;
  statementStartDate: string | null;
  statementEndDate: string | null;
  statementDate: string | null;
}

export function findSupersededStatement(
  incoming: Omit<StatementIdentity, 'id'>,
  existing: readonly StatementIdentity[],
): string | null {
  if (!incoming.canonicalAccountId || !incoming.statementStartDate || !incoming.statementEndDate) {
    return null;
  }
  const candidates = existing.filter((e) =>
    e.canonicalAccountId === incoming.canonicalAccountId
    && e.statementStartDate === incoming.statementStartDate
    && e.statementEndDate === incoming.statementEndDate);
  if (candidates.length === 0) return null;

  // Only supersede when the incoming statement is demonstrably NEWER. Without
  // both dates we cannot tell which is the revision, and guessing could make a
  // stale statement supersede a current one.
  if (!incoming.statementDate) return null;
  const newer = candidates.filter((c) => c.statementDate !== null && c.statementDate < incoming.statementDate!);
  if (newer.length !== 1) return null;
  return newer[0].id;
}
