/**
 * AIE-1.2 — conservative, READ-ONLY account/owner matching (mandatory
 * execution sequence step 7: "implement account/owner/instrument/statement-
 * period matching conservatively — unknown or conflicting evidence becomes
 * a typed unresolved item, never a plausible-default guess").
 *
 * REUSE. `planFolioAccountResolution`/`accountResolutionKey`/
 * `normaliseFolioNumber`/`UNKNOWN_AMC_SENTINEL` are Investment
 * Intelligence's OWN pure, DB-free functions
 * (lib/services/investment-intelligence/accountResolution.ts) — reused
 * unmodified to compute the exact same (folio, AMC) identity keys the real
 * write path (`resolveOrCreateAccount`) would use. This file does NOT
 * reimplement that matching logic; it mirrors only `resolveOrCreateAccount`'s
 * own READ path (its exact-match and unknown-AMC-adoption rules, same file,
 * same function, read above) against a caller-supplied snapshot of existing
 * accounts, and never writes.
 *
 * "Candidates only, not direct writes" (execution sequence step 8) applies
 * here too: a genuinely first-seen (folio, AMC) pair is reported as
 * `new_account_candidate` — informational, NOT an unresolved item (matching
 * `documentProcessing.ts`'s own comment: "a genuinely first-seen scheme is
 * expected, not an error" — the same is true of a first-seen folio). Only
 * an AMBIGUOUS match (more than one existing unknown-AMC account shares
 * this folio number, so a human cannot be silently guessed for) becomes a
 * typed unresolved item — built by `unresolvedItems.ts`, not this file.
 */

import {
  accountResolutionKey,
  normaliseFolioNumber,
  planFolioAccountResolution,
  UNKNOWN_AMC_SENTINEL,
  type FolioAmcAssignment,
} from '@/lib/services/investment-intelligence/accountResolution';
import type { ParsedAccountRecord, ParsedHoldingRecord, ParsedTransactionRecord } from '@/lib/services/investment-intelligence/parsers/types';

export interface ExistingAccountForMatching {
  id: string;
  folioNumber: string | null;
  institutionName: string;
}

export type AccountMatchOutcome =
  | { kind: 'resolved'; key: string; folioNumber: string | null; amcName: string; accountId: string }
  | { kind: 'new_account_candidate'; key: string; folioNumber: string | null; amcName: string }
  | { kind: 'ambiguous'; key: string; folioNumber: string | null; amcName: string; candidateAccountIds: string[] };

export interface AccountMatchingResult {
  plan: ReturnType<typeof planFolioAccountResolution>;
  outcomes: AccountMatchOutcome[];
  /** key -> outcome, for O(1) lookup by the reconciliation stage. */
  byKey: Map<string, AccountMatchOutcome>;
}

export function matchAccountsReadOnly(
  parsed: { accounts: ParsedAccountRecord[]; transactions: ParsedTransactionRecord[]; holdings: ParsedHoldingRecord[] },
  existingAccounts: readonly ExistingAccountForMatching[],
): AccountMatchingResult {
  const plan = planFolioAccountResolution(parsed);
  const outcomes: AccountMatchOutcome[] = [];

  for (const assignment of plan.assignments) {
    outcomes.push(matchOneAssignment(assignment, existingAccounts));
  }

  const byKey = new Map(outcomes.map((o) => [o.key, o]));
  return { plan, outcomes, byKey };
}

function matchOneAssignment(assignment: FolioAmcAssignment, existingAccounts: readonly ExistingAccountForMatching[]): AccountMatchOutcome {
  const normalisedFolio = normaliseFolioNumber(assignment.folioNumber);
  const key = accountResolutionKey(assignment.folioNumber, assignment.amcName);

  // (a) exact match: same institution name + same normalised folio —
  // mirrors resolveOrCreateAccount's first query exactly.
  const exact = existingAccounts.find(
    (a) => a.institutionName === assignment.amcName && normaliseFolioNumber(a.folioNumber) === normalisedFolio,
  );
  if (exact) return { kind: 'resolved', key, folioNumber: assignment.folioNumber, amcName: assignment.amcName, accountId: exact.id };

  if (normalisedFolio) {
    const sameFolio = existingAccounts.filter((a) => normaliseFolioNumber(a.folioNumber) === normalisedFolio);

    if (assignment.amcName === UNKNOWN_AMC_SENTINEL) {
      // This import carries no real institution evidence for this folio.
      // Exactly one existing account sharing the folio is an unambiguous
      // match (mirrors resolveOrCreateAccount); two or more is genuinely
      // ambiguous and must not be silently guessed.
      if (sameFolio.length === 1) {
        return { kind: 'resolved', key, folioNumber: assignment.folioNumber, amcName: assignment.amcName, accountId: sameFolio[0].id };
      }
      if (sameFolio.length > 1) {
        return {
          kind: 'ambiguous',
          key,
          folioNumber: assignment.folioNumber,
          amcName: assignment.amcName,
          candidateAccountIds: sameFolio.map((a) => a.id),
        };
      }
    } else {
      // Real institution name on this import — an existing unknown-AMC
      // account for the same folio would be ADOPTED/upgraded by the real
      // write path (resolveOrCreateAccount), which is a write; matching
      // reports it as resolved to that existing account id so
      // reconciliation can proceed against its real history, without
      // performing the upgrade itself.
      const unknownMatch = sameFolio.find((a) => a.institutionName === UNKNOWN_AMC_SENTINEL);
      if (unknownMatch) {
        return { kind: 'resolved', key, folioNumber: assignment.folioNumber, amcName: assignment.amcName, accountId: unknownMatch.id };
      }
    }
  }

  return { kind: 'new_account_candidate', key, folioNumber: assignment.folioNumber, amcName: assignment.amcName };
}
