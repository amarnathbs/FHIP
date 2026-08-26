import { requireUser, bad, ok } from '@/lib/api';
import { getLiabilityStatementIdForDocument } from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import {
  generateLiabilityProposal,
  getLiabilityProposalForReview,
  LiabilityProposalError,
} from '@/lib/import-bridge/liabilityProposalService';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

async function resolveProposalIdForDocument(userId: string, documentId: string): Promise<string | null> {
  const statementId = await getLiabilityStatementIdForDocument(userId, documentId);
  if (!statementId) return null;
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data } = await supabase
    .from('fhip_import_proposals')
    .select('id')
    .eq('user_id', userId)
    .eq('source_liability_statement_id', statementId)
    .eq('status', 'ready')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// POST /api/financial-data-hub/liability-statement/{documentId}/proposal —
// generate the Liability Import Proposal from approved statement evidence
// (spec sections 4, 22, 41). Generating a proposal NEVER changes Liability
// (spec section 21).
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getLiabilityStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  try {
    const { proposalId, recommendedApplyMode } = await generateLiabilityProposal(user.id, statementId);
    await recordDocumentAuditEvent({
      userId: user.id,
      documentId,
      eventType: 'liability_proposal_generated',
      actorType: 'system',
      metadata: { proposal_id: proposalId, statement_id: statementId, recommended_apply_mode: recommendedApplyMode },
    });
    const review = await getLiabilityProposalForReview(user.id, proposalId);
    return ok({ proposal_id: proposalId, proposal: review?.proposal ?? null, fields: review?.fields ?? [] });
  } catch (e) {
    if (e instanceof LiabilityProposalError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'not_approved' ? 409 : 500;
      return bad(e.message, status);
    }
    return bad('We could not prepare a liability comparison for this statement.', 500);
  }
}

// GET /api/financial-data-hub/liability-statement/{documentId}/proposal —
// the CURRENT vs PROPOSED comparison read-model (spec section 23). Read-only.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const proposalId = await resolveProposalIdForDocument(user.id, documentId);
  if (!proposalId) return ok({ proposal: null, fields: [] });

  const review = await getLiabilityProposalForReview(user.id, proposalId);
  if (!review) return ok({ proposal: null, fields: [] });
  return ok({ proposal_id: proposalId, proposal: review.proposal, fields: review.fields });
}
