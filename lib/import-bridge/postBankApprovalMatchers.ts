/**
 * Post-bank-approval matchers -- the integration seam (WP-01 (j)) through
 * which evidence from OTHER documents is matched against bank lines once those
 * lines become approved.
 *
 * WHY A SEAM. Several approved documents corroborate a bank leg: a payslip
 * (its net pay credit), a card/loan statement (the repayment debit), a broker
 * statement (the funding debit / sale proceeds / dividend credit) and a super
 * statement (a personal contribution debit). Each of those is matched once at
 * processing time, which misses every bank statement approved LATER (GAP-10,
 * G4, INV-G4, GAP-RET-07). Rather than each package editing the three bank
 * approval routes, each package registers ONE matcher here and the routes run
 * them all after a successful approval.
 *
 * CONTRACT FOR A MATCHER.
 *  - It receives only (userId, statementUploadId, trigger) and does its own,
 *    user-scoped reads/writes. It must be idempotent: the same statement can
 *    be approved, reopened and approved again.
 *  - It must never throw past `run` on purpose; if it does, the runner
 *    catches it, reports it through `onMatcherError` (the routes audit it as
 *    `post_approval_matcher_failed`) and carries on with the next matcher.
 *  - It never fails, delays beyond its own work, or changes the result of the
 *    approval that triggered it. The approval has already committed.
 *
 * This file deliberately imports nothing, so it can be unit-tested without a
 * database and adds nothing to any bundle it is not already in.
 */

export type PostBankApprovalTrigger = 'statement_approve' | 'category_approve_all' | 'category_approve_group';

export interface PostBankApprovalContext {
  userId: string;
  statementUploadId: string;
  trigger: PostBankApprovalTrigger;
}

export interface PostBankApprovalMatcherOutcome {
  /** Evidence rows newly linked to a bank leg by this run. */
  linked?: number;
  /** Bank legs reclassified (through fdh_internal_reclassify_corroborated_leg). */
  reclassified?: number;
}

export interface PostBankApprovalMatcher {
  /** Stable id, used in audit metadata. e.g. 'wp09_payroll_bank_rematch'. */
  id: string;
  /** Owning work package, for the registry of who may edit what. */
  ownerWp: string;
  run(ctx: PostBankApprovalContext): Promise<PostBankApprovalMatcherOutcome | void>;
}

/**
 * The registry. EMPTY in WP-01 by design. Each downstream package appends
 * exactly one entry on its own line (WP-09 payroll re-match, WP-10/11 card and
 * loan repayment back-match, WP-12 broker funding/proceeds/dividend, WP-13
 * super personal contribution), so their edits never touch the same line.
 */
export const POST_BANK_APPROVAL_MATCHERS: readonly PostBankApprovalMatcher[] = [
  { id: 'wp09_payroll_bank_rematch', ownerWp: 'WP-09', run: (ctx) => import('./payslipBankRematch').then((m) => m.runPayslipBankRematch(ctx)) },
];

export interface PostBankApprovalMatcherResult {
  id: string;
  status: 'ok' | 'failed';
  outcome?: PostBankApprovalMatcherOutcome;
  /** Error NAME / code only -- never a message (it may carry row data). */
  errorName?: string;
}

export interface RunPostBankApprovalMatchersOptions {
  matchers?: readonly PostBankApprovalMatcher[];
  onMatcherError?: (matcherId: string, error: unknown, ctx: PostBankApprovalContext) => Promise<void> | void;
}

function errorNameOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length <= 64) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length <= 64) return name;
  }
  return 'Error';
}

/**
 * Runs every matcher in order. Never throws: a failing matcher (or a failing
 * error reporter) is recorded in the result and the next matcher still runs.
 */
export async function runPostBankApprovalMatchers(
  ctx: PostBankApprovalContext,
  options: RunPostBankApprovalMatchersOptions = {},
): Promise<PostBankApprovalMatcherResult[]> {
  const matchers = options.matchers ?? POST_BANK_APPROVAL_MATCHERS;
  const results: PostBankApprovalMatcherResult[] = [];
  for (const matcher of matchers) {
    try {
      const outcome = await matcher.run(ctx);
      results.push({ id: matcher.id, status: 'ok', outcome: outcome ?? undefined });
    } catch (error) {
      results.push({ id: matcher.id, status: 'failed', errorName: errorNameOf(error) });
      try {
        await options.onMatcherError?.(matcher.id, error, ctx);
      } catch {
        // The reporter failing must not stop the remaining matchers either.
      }
    }
  }
  return results;
}
