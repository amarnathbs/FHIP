import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { applyLiabilityProposalAtomic } from '@/lib/import-bridge/applyLiabilityProposalAtomic';
import { USER_APPLY_DECISIONS } from '@/lib/import-bridge/types';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

const bodySchema = z.object({
  decision: z.enum(USER_APPLY_DECISIONS),
  selectedFields: z.array(z.string()).max(20).optional(),
});

// POST /api/financial-data-hub/liability-proposals/{proposalId}/apply — THE
// ONLY route permitted to change canonical Liability from a statement import
// (spec sections 4, 21, 24-27, 53-58). Never issues a direct PATCH to
// `fhip_import_proposals` or `liabilities` — every mutation goes through
// `fdh10_apply_liability_proposal()`, the atomic SECURITY DEFINER RPC (spec
// section 53 is non-negotiable). User identity comes only from the
// authenticated session (spec section 20) — the request body carries no
// user/household/owner id of any kind, only the decision and which fields
// (of the ones the SERVER's own proposal already offered) are selected.
export async function POST(req: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const { proposalId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const rawBody = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return bad('Invalid request body.', 422);

  const result = await applyLiabilityProposalAtomic({
    proposalId,
    decision: parsed.data.decision,
    selectedFields: parsed.data.selectedFields,
  });

  if (!result.ok) {
    const status =
      result.code === 'PROPOSAL_NOT_FOUND' ? 404 :
      result.code === 'STALE_PROPOSAL' ? 409 :
      result.code === 'ALREADY_APPLIED' ? 409 :
      result.code === 'NO_FIELDS_SELECTED' || result.code === 'FORBIDDEN_FIELD' || result.code === 'INVALID_APPLY_MODE' || result.code === 'DOMAIN_VALIDATION_FAILED' ? 422 :
      400;
    return Response.json({ error: result.error, code: result.code, staleness: 'staleness' in result ? result.staleness : undefined }, { status });
  }

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId: null,
    eventType: parsed.data.decision === 'keep_existing' ? 'liability_proposal_dismissed' : 'liability_proposal_applied',
    actorType: 'user',
    actorId: user.id,
    metadata: { proposal_id: proposalId, decision: parsed.data.decision, outcome: result.outcome },
  });

  return ok({
    outcome: result.outcome,
    apply_mode: result.applyMode,
    target_entity_id: result.targetEntityId,
    application_id: result.applicationId,
    applied_fields: result.appliedFields,
  });
}
