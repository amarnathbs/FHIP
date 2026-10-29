/**
 * "Check the categories again" (30-10-2026): re-runs the classification engine over a statement that was imported BEFORE the engine learned
 * more, so the person does not have to upload the file again.
 *
 * What it changes: only lines still waiting for approval whose category the engine itself guessed (or that have none). A line the person
 * approved, a category the person chose, a line the statement itself typed, a user rule and an AI proposal are never touched (the engine's
 * own skips, plus `retractStale` for the guesses today's rules no longer support). It approves nothing.
 *
 * The engine works on all of the person's pending lines, so other statements waiting for approval are re-checked too; the result reports the
 * figures for THIS statement only.
 */

import { getStatementCategoryReview, type StatementCategoryReview } from './categoryReviewService';
import { classifyUserTransactions, type ClassificationRunSummary } from './transactionClassificationService';

export type RecheckStatus = 'done' | 'nothing_to_check';

export interface RecheckResult {
  status: RecheckStatus;
  /** Lines needing the person's own choice, before and after. */
  needs_decision_before: number;
  needs_decision_after: number;
  /** Lines ready for the person to approve inside a category total, before and after. */
  ready_before: number;
  ready_after: number;
  /** Earlier guesses on pending lines that no rule supports now (sent back to "needs your choice"). */
  guesses_withdrawn: number;
  /** Lines already approved on this statement: left exactly as they were. */
  approved_untouched: number;
}

export interface RecheckDeps {
  /** Test seams; production never sets them. */
  getReview?: (userId: string, statementId: string) => Promise<StatementCategoryReview>;
  classify?: (userId: string, options: { retractStale: true }) => Promise<ClassificationRunSummary>;
}

export async function recheckStatementCategories(userId: string, statementId: string, deps: RecheckDeps = {}): Promise<RecheckResult> {
  const getReview = deps.getReview ?? getStatementCategoryReview;
  const classify = deps.classify ?? classifyUserTransactions;

  const before = await getReview(userId, statementId); // also proves the statement is this person's own (not_found otherwise)
  const approved = before.counts.approved;
  if (before.counts.waiting_for_approval === 0) {
    return {
      status: 'nothing_to_check',
      needs_decision_before: before.counts.needs_decision,
      needs_decision_after: before.counts.needs_decision,
      ready_before: before.counts.ready_to_approve,
      ready_after: before.counts.ready_to_approve,
      guesses_withdrawn: 0,
      approved_untouched: approved,
    };
  }

  const summary = await classify(userId, { retractStale: true });
  const after = await getReview(userId, statementId);
  return {
    status: 'done',
    needs_decision_before: before.counts.needs_decision,
    needs_decision_after: after.counts.needs_decision,
    ready_before: before.counts.ready_to_approve,
    ready_after: after.counts.ready_to_approve,
    guesses_withdrawn: summary.transactionsRetracted ?? 0,
    approved_untouched: approved,
  };
}
