/**
 * WP-12's post-bank-approval matcher (INV-G4, the WP-01 seam in
 * lib/import-bridge/postBankApprovalMatchers.ts).
 *
 * A broker statement is bank-matched once, when it is processed. A bank
 * statement approved LATER (the common order: upload the broker CSV, then the
 * bank statement that funded it) used to leave every broker activity at
 * 'bank_evidence_not_available' forever, so the $10k funding debit stayed
 * counted as spending. This re-runs the (now real) broker matcher for the user
 * and re-types each newly corroborated bank leg of an approved statement.
 *
 * Idempotent (an already-matched activity keeps its match; the reclassify
 * helper reports 'unchanged' on a second run) and user-scoped. It never throws
 * past the seam's runner on purpose; the runner audits any failure.
 */

import type { PostBankApprovalContext, PostBankApprovalMatcherOutcome } from '@/lib/import-bridge/postBankApprovalMatchers';
import { rematchAuStatementsAfterBankApproval } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';

export async function runBrokerBankRematch(ctx: PostBankApprovalContext): Promise<PostBankApprovalMatcherOutcome> {
  const result = await rematchAuStatementsAfterBankApproval(ctx.userId);
  return { linked: result.linked, reclassified: result.reclassified };
}
