/**
 * R8 — global/user classification rule evaluation (spec section 42).
 *
 * Evaluates ONE transaction against a rule's `match_definition`, returning
 * whether it matches. Only the `match_kind`s that can ever fire against a
 * CSV-sourced `fdh_transactions` row are implemented for real:
 * `description_contains`, `narrative_pattern`, `institution_narrative`,
 * `account_scoped_default`, `merchant_exact`, `merchant_alias`.
 * `mcc` and `source_provided_category` are intentionally NEVER matched here
 * — R8-P0 confirmed no CSV-sourced transaction ever carries an MCC or a
 * source-provided category (R7's canonical contract has no such column;
 * see `docs/financial-data-hub/R8_ASSUMPTION_RECONCILIATION.md` section 6).
 * Rather than silently no-op these two match_kinds forever, `matchesRule`
 * still evaluates them structurally (returns false — they cannot match
 * without data that does not exist) so a future release that adds a data
 * source carrying MCC/source-category only needs to supply that field, not
 * rewrite this matcher.
 */

import type { FdhClassificationRule, FdhUserClassificationRule } from '../domain/types';
import { containsTerm, matchesNarrativePattern, toMatchText } from './textMatch';

export interface RuleMatchTransaction {
  descriptionClean: string | null;
  merchantRaw: string | null;
  financialAccountId: string;
  institutionId: string | null;
}

export function matchesRule(
  txn: RuleMatchTransaction,
  matchDefinition: FdhClassificationRule['match_definition'],
): boolean {
  const haystack = toMatchText([txn.descriptionClean, txn.merchantRaw].filter(Boolean).join(' '));
  switch (matchDefinition.match_kind) {
    case 'description_contains':
      return containsTerm(
        matchDefinition.case_sensitive ? (txn.descriptionClean ?? '') : haystack,
        matchDefinition.case_sensitive
          ? matchDefinition.needle_normalised
          : toMatchText(matchDefinition.needle_normalised),
      );
    case 'narrative_pattern':
      return matchesNarrativePattern(
        haystack,
        matchDefinition.required_terms_normalised.map(toMatchText),
        (matchDefinition.excluded_terms_normalised ?? []).map(toMatchText),
      );
    case 'institution_narrative':
      return (
        txn.institutionId === matchDefinition.institution_id &&
        containsTerm(haystack, toMatchText(matchDefinition.narrative_normalised))
      );
    case 'account_scoped_default':
      return txn.financialAccountId === matchDefinition.financial_account_id;
    case 'merchant_exact':
      // Resolved by identity elsewhere (the caller already knows the
      // matched merchant, if any, from merchantMatching.ts) — a rule of
      // this match_kind matches only when that resolved merchant's id
      // agrees, which the caller checks, not this function (it has no
      // merchant context to check against on its own).
      return false;
    case 'merchant_alias':
      return containsTerm(haystack, toMatchText(matchDefinition.alias_normalised));
    case 'mcc':
    case 'source_provided_category':
      // No CSV-sourced transaction ever carries this data — see module
      // header. Structurally cannot match.
      return false;
    case 'payment_rail_narrative':
      // Rail annotation only — never feeds economic-type classification.
      return false;
    default:
      return false;
  }
}

/** Evaluates a list of rules against one transaction, in `priority` order
 * (lower number = evaluated/trusted first — matches FDH-2's own documented
 * convention), returning every rule that matched. The caller picks the
 * highest-precedence match; this function does not rank across rule
 * *sources* (global vs user) — that is `classificationPrecedence.ts`'s job. */
export function evaluateRules<TRule extends { match_definition: FdhClassificationRule['match_definition']; action_definition: unknown; priority: number; active: boolean }>(
  txn: RuleMatchTransaction,
  rules: TRule[],
): TRule[] {
  return rules
    .filter((r) => r.active && matchesRule(txn, r.match_definition))
    .sort((a, b) => a.priority - b.priority);
}

export type { FdhClassificationRule, FdhUserClassificationRule };
