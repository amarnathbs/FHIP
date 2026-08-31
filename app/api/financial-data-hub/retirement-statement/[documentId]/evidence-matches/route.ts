import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  getRetirementStatementIdForDocument,
  matchRetirementContributionsToPayslips,
  matchRetirementActivitiesToBank,
  matchRetirementRollovers,
} from '@/lib/financial-data-hub/services/retirementStatementProcessingService';

// POST /api/financial-data-hub/retirement-statement/{documentId}/evidence-matches
//
// Run the three evidence-reconciliation passes in one call:
//   1. payslip  (spec sections 22-27, 64-67) — FDH-9 employer super evidence
//   2. bank     (spec sections 77-81)        — personal contributions and
//                                              withdrawals only; internal
//                                              activities are never matched
//   3. rollover (spec sections 33-35)        — pairing the two legs of a
//                                              fund-to-fund transfer
//
// ALL THREE ARE EVIDENCE LINKING. None creates, deletes or reclassifies an
// income row, an expense row, a bank transaction or a canonical balance —
// FDH-12 has no write path to any of them.

export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const payslip = await matchRetirementContributionsToPayslips(user.id, statementId);
  if (payslip.error) return bad(payslip.error, 400);

  const bank = await matchRetirementActivitiesToBank(user.id, statementId);
  if (bank.error) return bad(bank.error, 400);

  const rollover = await matchRetirementRollovers(user.id, statementId);
  if (rollover.error) return bad(rollover.error, 400);

  return ok({
    statement_id: statementId,
    payslip: {
      matched: payslip.matched,
      no_match: payslip.noMatch,
      multiple_candidates: payslip.multipleCandidates,
      variance_review: payslip.varianceReview,
      // A distinct state from "no match": a fund contribution without a
      // payslip is perfectly valid evidence, not a problem to resolve
      // (spec section 65).
      payslip_evidence_not_available: payslip.noPayslipEvidence,
    },
    bank: {
      matched: bank.matched,
      no_match: bank.noMatch,
      multiple_candidates: bank.multipleCandidates,
      // Internal fund activity: no household cash movement is expected, so no
      // review item is raised (spec section 81).
      not_expected: bank.notExpected,
      bank_evidence_not_available: bank.noBankEvidence,
    },
    rollover: {
      matched: rollover.matched,
      no_match: rollover.noMatch,
      multiple_candidates: rollover.multipleCandidates,
    },
  });
}
