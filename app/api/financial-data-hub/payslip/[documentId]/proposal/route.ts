import { requireUser, bad, ok } from '@/lib/api';
import { getPayrollEventIdForDocument } from '@/lib/financial-data-hub/services/payslipProcessingService';
import {
  generateIncomeProposal,
  getIncomeProposalForReview,
  IncomeProposalError,
} from '@/lib/import-bridge/incomeProposalService';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

async function resolveProposalIdForDocument(userId: string, documentId: string): Promise<string | null> {
  const payrollEventId = await getPayrollEventIdForDocument(userId, documentId);
  if (!payrollEventId) return null;
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data } = await supabase
    .from('fhip_import_proposals')
    .select('id')
    .eq('user_id', userId)
    .eq('source_payroll_event_id', payrollEventId)
    .eq('status', 'ready')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// POST /api/financial-data-hub/payslip/{documentId}/proposal — generate the
// Income Import Proposal from approved payroll evidence (spec sections 4, 21,
// 36-37). Generating a proposal NEVER changes Income (spec section 4).
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const payrollEventId = await getPayrollEventIdForDocument(user.id, documentId);
  if (!payrollEventId) return bad('No payroll evidence has been extracted from this document yet.', 404);

  try {
    const { proposalId, recommendedApplyMode } = await generateIncomeProposal(user.id, payrollEventId);
    await recordDocumentAuditEvent({
      userId: user.id,
      documentId,
      eventType: 'income_proposal_generated',
      actorType: 'system',
      metadata: { proposal_id: proposalId, payroll_event_id: payrollEventId, recommended_apply_mode: recommendedApplyMode },
    });
    const review = await getIncomeProposalForReview(user.id, proposalId);
    return ok({ proposal_id: proposalId, proposal: review?.proposal ?? null, fields: review?.fields ?? [] });
  } catch (e) {
    if (e instanceof IncomeProposalError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'not_approved' ? 409 : 500;
      return bad(e.message, status);
    }
    return bad('We could not prepare an income comparison for this payslip.', 500);
  }
}

// GET /api/financial-data-hub/payslip/{documentId}/proposal — the CURRENT vs
// PROPOSED comparison read-model (spec section 37). Read-only.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const proposalId = await resolveProposalIdForDocument(user.id, documentId);
  if (!proposalId) return ok({ proposal: null, fields: [] });

  const review = await getIncomeProposalForReview(user.id, proposalId);
  if (!review) return ok({ proposal: null, fields: [] });
  return ok({ proposal_id: proposalId, proposal: review.proposal, fields: review.fields });
}
