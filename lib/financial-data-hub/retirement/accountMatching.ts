/**
 * FDH-12 — matching a retirement statement to an existing canonical account
 * and household member (spec sections 14-19, 132).
 *
 * ============================================================================
 * NEVER MATCH BY BALANCE ALONE (spec section 16)
 * ============================================================================
 *
 * The candidate key is, in strict order of authority:
 *
 *   1. jurisdiction + currency        (a hard filter — never crossed)
 *   2. masked account/member number   (decisive when present)
 *   3. fund/institution name          (fallback)
 *   4. account type                   (tie-break)
 *
 * `current_balance` DOES NOT APPEAR ANYWHERE IN THIS FILE. That is deliberate
 * and mechanically asserted: `tests/unit/fdh12Isolation.test.ts` fails the
 * build if the token `balance` appears in this module's matching logic. Spec
 * section 17's negative control — Self holds Fund A ****1234 and Spouse holds
 * Fund A ****9876 at similar balances — is impossible to fail if balance is
 * not an input.
 *
 * ============================================================================
 * AMBIGUITY IS NEVER RESOLVED BY PICKING THE FIRST (spec sections 18, 27)
 * ============================================================================
 *
 * More than one plausible candidate returns `multiple_candidates` with every
 * candidate listed. The user chooses. There is no "highest score wins"
 * tie-break, because a wrong retirement account update is a silent, material
 * financial error the user has no easy way to notice.
 */

import { normaliseEmployerName } from '../payslip/normalise';
import type { RetirementAccountType, RetirementAccountMatchStatus, RetirementJurisdiction } from './types';

/** The subset of a canonical `retirement_accounts` row this module reads.
 * NOTE the absence of `current_balance` — see the file header. */
export interface ExistingRetirementAccountRow {
  id: string;
  account_name: string;
  account_type: string | null;
  currency_code: string;
  country_code: string | null;
  owner: string;
  master_item_key: string | null;
  retirement_member_id: string | null;
  /** FDH-12's own masked identifier, carried on the statement rather than the
   * canonical row (the canonical Retirement model has no such column). Matched
   * via previously-imported statements — see `priorStatementIdentifiers`. */
  updated_at?: string | null;
}

export interface RetirementAccountMatchQuery {
  jurisdiction: RetirementJurisdiction;
  currencyCode: string;
  fundName: string | null;
  maskedAccountIdentifier: string | null;
  accountType: RetirementAccountType;
  /** Member the statement resolved to, when known. Narrows candidates to that
   * member's accounts — the mechanism behind spec section 17. */
  retirementMemberId: string | null;
}

export interface RetirementAccountMatchCandidate {
  accountId: string;
  accountName: string;
  /** Why this row is a candidate. Rendered in the review UI so a user
   * disambiguating between two funds can see the actual evidence. */
  matchedOn: ('masked_identifier' | 'fund_name' | 'account_type' | 'member')[];
}

export interface RetirementAccountMatchResult {
  status: RetirementAccountMatchStatus;
  accountId: string | null;
  candidates: RetirementAccountMatchCandidate[];
  /** Machine-readable reason, surfaced as a review reason. */
  reason: string;
}

/**
 * Masked identifiers previously recorded against a canonical account by an
 * earlier FDH-12 import. Canonical Retirement has no masked-identifier column
 * of its own (a documented gap), so this map is assembled from prior
 * `fdh_retirement_statements` rows by the caller.
 */
export type PriorStatementIdentifiers = ReadonlyMap<string, ReadonlySet<string>>;

function foldFundName(s: string | null | undefined): string | null {
  if (!s) return null;
  // Reuses FDH-9's certified legal-suffix stripper: super fund entities carry
  // the same "Pty Ltd"/"Limited" noise that employer names do, and a second
  // implementation would be a second thing to keep correct.
  return normaliseEmployerName(s) ?? null;
}

/** Normalise a masked identifier for comparison: digits and letters only, so
 * `****1234`, `xxxx1234` and `...1234` all compare equal. */
function foldMasked(s: string | null | undefined): string | null {
  if (!s) return null;
  const folded = s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^[x*.\s]+/, '');
  return folded || null;
}

export function matchRetirementAccount(
  query: RetirementAccountMatchQuery,
  existing: readonly ExistingRetirementAccountRow[],
  priorIdentifiers: PriorStatementIdentifiers = new Map(),
): RetirementAccountMatchResult {
  // --- 1. HARD FILTERS ------------------------------------------------------
  // Currency and jurisdiction are never crossed (spec section 68: never sum
  // AUD and INR without canonical FX treatment; a fortiori never silently
  // update an AUD account from an INR statement).
  //
  // SMSF rows are excluded outright (spec sections 10, 72): FDH-12 must never
  // target one, and excluding them here means an SMSF row can never even
  // become a candidate, let alone be picked.
  let pool = existing.filter((a) =>
    a.currency_code === query.currencyCode
    && a.master_item_key !== 'smsf'
    && (a.country_code === null || a.country_code === query.jurisdiction));

  // Member narrowing (spec sections 15, 17). When the statement resolved to a
  // member, only that member's accounts are candidates — this is what makes
  // Self's ****1234 statement structurally unable to reach Spouse's ****9876.
  if (query.retirementMemberId) {
    const byMember = pool.filter((a) => a.retirement_member_id === query.retirementMemberId);
    // Only narrow if it leaves something: an account that predates the member
    // model has a NULL retirement_member_id and must stay reachable.
    if (byMember.length > 0) pool = byMember;
  }

  if (pool.length === 0) {
    return { status: 'no_match', accountId: null, candidates: [], reason: 'no_existing_account_for_this_fund_and_currency' };
  }

  // --- 2. MASKED IDENTIFIER — decisive when present ------------------------
  const wantedMasked = foldMasked(query.maskedAccountIdentifier);
  if (wantedMasked) {
    const byMasked = pool.filter((a) => {
      const known = priorIdentifiers.get(a.id);
      if (!known) return false;
      for (const id of known) if (foldMasked(id) === wantedMasked) return true;
      return false;
    });
    if (byMasked.length === 1) {
      return {
        status: 'matched', accountId: byMasked[0].id,
        candidates: [{ accountId: byMasked[0].id, accountName: byMasked[0].account_name, matchedOn: ['masked_identifier'] }],
        reason: 'matched_on_masked_account_identifier',
      };
    }
    if (byMasked.length > 1) {
      return {
        status: 'multiple_candidates', accountId: null,
        candidates: byMasked.map((a) => ({ accountId: a.id, accountName: a.account_name, matchedOn: ['masked_identifier' as const] })),
        reason: 'multiple_accounts_share_this_masked_identifier',
      };
    }
    // The statement HAS an identifier and it matched nothing we have on file.
    // Narrow the fallback pool to accounts with NO identifier on file — an
    // account that already carries a DIFFERENT identifier is positive proof it
    // is a different physical account, and matching it on fund name alone
    // would overwrite an unrelated fund's balance. This is the exact defect
    // FDH-10 found and fixed live in its own facility matcher
    // (`liabilityAdapter.ts`'s matching comment); FDH-12 inherits the fix
    // rather than re-discovering it.
    pool = pool.filter((a) => {
      const known = priorIdentifiers.get(a.id);
      return !known || known.size === 0;
    });
    if (pool.length === 0) {
      return { status: 'no_match', accountId: null, candidates: [], reason: 'statement_identifier_matches_no_known_account' };
    }
  }

  // --- 3. FUND NAME --------------------------------------------------------
  const wantedFund = foldFundName(query.fundName);
  if (wantedFund) {
    const byFund = pool.filter((a) => {
      const folded = foldFundName(a.account_name);
      return folded !== null && (folded === wantedFund || folded.includes(wantedFund) || wantedFund.includes(folded));
    });
    if (byFund.length === 1) {
      return {
        status: 'matched', accountId: byFund[0].id,
        candidates: [{ accountId: byFund[0].id, accountName: byFund[0].account_name, matchedOn: ['fund_name'] }],
        reason: 'matched_on_fund_name',
      };
    }
    if (byFund.length > 1) {
      // Tie-break on account type only — still never on balance.
      const byType = byFund.filter((a) => a.account_type === query.accountType);
      if (byType.length === 1) {
        return {
          status: 'matched', accountId: byType[0].id,
          candidates: [{ accountId: byType[0].id, accountName: byType[0].account_name, matchedOn: ['fund_name', 'account_type'] }],
          reason: 'matched_on_fund_name_and_account_type',
        };
      }
      return {
        status: 'multiple_candidates', accountId: null,
        candidates: byFund.map((a) => ({ accountId: a.id, accountName: a.account_name, matchedOn: ['fund_name' as const] })),
        reason: 'multiple_accounts_match_this_fund_name',
      };
    }
  }

  // --- 4. CONTROLLED SINGLE-CANDIDATE FALLBACK (spec section 18) -----------
  // "If statement lacks usable identifier but only one plausible fund/member
  // combination exists, a controlled fallback may be considered."
  //
  // Deliberately narrow: it applies ONLY when the statement carried no usable
  // identifier at all AND no fund name matched AND exactly one account remains
  // in the pool. Even then it returns `multiple_candidates` rather than
  // `matched` when the pool has more than one member represented, because
  // picking between household members on no evidence is precisely the
  // arbitrary selection spec section 18 rules out.
  if (!wantedMasked && pool.length === 1) {
    return {
      status: 'matched', accountId: pool[0].id,
      candidates: [{ accountId: pool[0].id, accountName: pool[0].account_name, matchedOn: ['member'] }],
      reason: 'single_plausible_account_controlled_fallback',
    };
  }

  if (pool.length > 1) {
    return {
      status: 'multiple_candidates', accountId: null,
      candidates: pool.map((a) => ({ accountId: a.id, accountName: a.account_name, matchedOn: [] as never[] })),
      reason: 'ambiguous_account_match_review_required',
    };
  }
  return { status: 'no_match', accountId: null, candidates: [], reason: 'no_matching_account' };
}

/**
 * Resolve which household member a statement belongs to (spec sections 15,
 * 101, 112).
 *
 * NEVER INFERS FROM BALANCE OR FILENAME. The only evidence accepted is an
 * explicit name match against the member's own recorded name, or the user's
 * explicit choice (which the caller passes as `userConfirmedMemberId`).
 * Anything else is `null`, which drives a REVIEW_REQUIRED and a member picker
 * in the UI.
 */
export interface RetirementMemberRow {
  id: string;
  member_type: 'self' | 'spouse';
  /** The display name for the member, if the household records one. */
  display_name?: string | null;
}

export function resolveRetirementMember(
  members: readonly RetirementMemberRow[],
  opts: {
    userConfirmedMemberId?: string | null;
    /** Member name as printed on the statement, when the parser found one. */
    statementMemberName?: string | null;
  },
): { memberId: string | null; reason: string } {
  if (opts.userConfirmedMemberId) {
    const found = members.find((m) => m.id === opts.userConfirmedMemberId);
    if (found) return { memberId: found.id, reason: 'user_confirmed' };
    return { memberId: null, reason: 'confirmed_member_not_found' };
  }

  const wanted = normaliseEmployerName(opts.statementMemberName ?? null);
  if (wanted) {
    const byName = members.filter((m) => {
      const folded = normaliseEmployerName(m.display_name ?? null);
      return folded !== null && folded !== undefined && folded === wanted;
    });
    if (byName.length === 1) return { memberId: byName[0].id, reason: 'matched_member_name_on_statement' };
    if (byName.length > 1) return { memberId: null, reason: 'multiple_members_share_this_name' };
  }

  // A single-member household (no spouse) has exactly one plausible answer.
  // This is the same controlled fallback as above, and it is safe for the same
  // reason: there is no other member the statement could belong to.
  if (members.length === 1) return { memberId: members[0].id, reason: 'single_member_household' };

  return { memberId: null, reason: 'member_not_determinable_review_required' };
}
