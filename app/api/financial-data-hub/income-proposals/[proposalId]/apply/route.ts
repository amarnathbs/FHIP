import { z } from 'zod';
import { requireUser, bad, ok } from '@/lib/api';
import { applyIncomeProposalAtomic } from '@/lib/import-bridge/applyIncomeProposalAtomic';
import { USER_APPLY_DECISIONS } from '@/lib/import-bridge/types';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

const bodySchema = z.object({
  decision: z.enum(USER_APPLY_DECISIONS),
  selectedFields: z.array(z.string()).max(20).optional(),
});

// POST /api/financial-data-hub/income-proposals/{proposalId}/apply — THE
// ONLY route in FDH-9 permitted to change canonical Income (spec sections
// 4, 21, 29-31). Never issues a direct PATCH to `fhip_import_proposals` or
// `income_sources` — every mutation goes through
// `fdh9_apply_income_proposal()`, the atomic SECURITY DEFINER RPC (spec
// section 31 is non-negotiable). User identity comes only from the
// authenticated session (spec section 30) — the request body carries no
// user/household/owner id of any kind, only the decision and which fields
// (of the ones the SERVER's own proposal already offered) are selected.
export async function POST(req: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const { proposalId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const rawBody = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return bad('Invalid request body.', 422);

  const result = await applyIncomeProposalAtomic({
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
    eventType: parsed.data.decision === 'keep_existing' ? 'income_proposal_dismissed' : 'income_proposal_applied',
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
