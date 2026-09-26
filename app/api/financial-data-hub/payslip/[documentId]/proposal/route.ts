import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getPayrollEventIdForDocument, findEarlierIdenticalPayslip } from '@/lib/financial-data-hub/services/payslipProcessingService';
import {
  generateIncomeProposal,
  getIncomeProposalForReview,
  IncomeProposalError,
  CHOOSABLE_INCOME_FREQUENCIES,
  type ChoosableIncomeFrequency,
} from '@/lib/import-bridge/incomeProposalService';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

const bodySchema = z.object({ frequency: z.enum(CHOOSABLE_INCOME_FREQUENCIES).optional() }).strict();

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
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const payrollEventId = await getPayrollEventIdForDocument(user.id, documentId);
  if (!payrollEventId) {
    // A re-upload of an already-imported payslip has no payroll event of its
    // own. Point at the original instead of dead-ending (production,
    // 2026-09-25: "No payroll evidence has been extracted" after a re-upload).
    const original = await findEarlierIdenticalPayslip(user.id, documentId);
    if (original) {
      return Response.json(
        {
          error: 'duplicate_payslip',
          message: 'This payslip was already imported. Continue with the copy already on file.',
          duplicate_of_document_id: original.documentId,
        },
        { status: 409 },
      );
    }
    return bad('No payroll evidence has been extracted from this document yet.', 404);
  }

  // WP-09 (GAP-12): an optional frequency the user chose for a payslip whose
  // own frequency (semimonthly / irregular / unknown) has no Income
  // equivalent. An empty body is the original call and still works.
  let frequency: ChoosableIncomeFrequency | undefined;
  const raw = await req.text().catch(() => '');
  if (raw.trim() !== '') {
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return bad('Invalid request body.', 422);
    frequency = parsed.data.frequency;
  }

  try {
    const { proposalId, recommendedApplyMode, summary } = await generateIncomeProposal(user.id, payrollEventId, { frequency });
    await recordDocumentAuditEvent({
      userId: user.id,
      documentId,
      eventType: 'income_proposal_generated',
      actorType: 'system',
      metadata: { proposal_id: proposalId, payroll_event_id: payrollEventId, recommended_apply_mode: recommendedApplyMode, frequency_chosen: frequency ?? null },
    });
    const review = await getIncomeProposalForReview(user.id, proposalId);
    // `summary` is what the adapter built for THIS proposal (also stored on
    // the proposal row once 0207 is applied): the explanation the compare
    // step shows -- title, lines and review reasons (GAP-07).
    return ok({ proposal_id: proposalId, proposal: review?.proposal ?? null, fields: review?.fields ?? [], summary });
  } catch (e) {
    if (e instanceof IncomeProposalError) {
      // GAP-04: the payslip is already in Income -- say where, never a second proposal.
      if (e.code === 'already_applied') {
        return Response.json({ error: e.message, code: 'ALREADY_APPLIED', target_entity_id: e.targetEntityId }, { status: 409 });
      }
      // GAP-11: a re-upload of a payslip that was never approved lands here;
      // the panel opens the review step instead of an error.
      if (e.code === 'not_approved') {
        return Response.json({ error: e.message, code: 'NOT_APPROVED', document_id: documentId }, { status: 409 });
      }
      if (e.code === 'superseded') return Response.json({ error: e.message, code: 'SUPERSEDED' }, { status: 409 });
      if (e.code === 'invalid_frequency') return bad(e.message, 422);
      const status = e.code === 'not_found' ? 404 : 500;
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
