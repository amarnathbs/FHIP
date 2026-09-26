import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  applyLiabilityProposalAtomic,
  LIABILITY_APPLY_DECISIONS,
  LIABILITY_IMPORT_OWNERS,
  statusForLiabilityApplyError,
} from '@/lib/import-bridge/applyLiabilityProposalAtomic';

const bodySchema = z.object({
  decision: z.enum(LIABILITY_APPLY_DECISIONS),
  selectedFields: z.array(z.string()).max(20).optional(),
  // WP-11 (G8, PO D-10): whose card or loan this is. Optional; the RPC
  // validates it again and defaults a NEW liability to 'self'.
  owner: z.enum(LIABILITY_IMPORT_OWNERS).optional(),
  // WP-11: the user accepts that ADJUSTMENT / OTHER lines are recorded as
  // not counted. Without it such a statement is refused with BLOCKING_REVIEW.
  acknowledgeUnclassified: z.boolean().optional(),
});

// POST /api/financial-data-hub/liability-proposals/{proposalId}/apply — THE
// ONLY route permitted to change canonical Liability from a statement import
// (spec sections 4, 21, 24-27, 53-58). Never issues a direct PATCH to
// `fhip_import_proposals`, `liabilities` or the ledger — every mutation goes
// through `fdh10_apply_liability_proposal()`, the atomic SECURITY DEFINER RPC
// (spec section 53 is non-negotiable), which since migration 0209 also writes
// the statement's activities to the canonical ledger and records the audit
// events (with the document id) INSIDE the same transaction (G12) — so this
// route no longer writes an audit event of its own after the commit. User
// identity comes only from the authenticated session (spec section 20).
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
    owner: parsed.data.owner,
    acknowledgeUnclassified: parsed.data.acknowledgeUnclassified,
  });

  if (!result.ok) {
    return Response.json(
      { error: result.error, code: result.code, staleness: result.staleness, blockers: result.blockers },
      { status: statusForLiabilityApplyError(result.code) },
    );
  }

  return ok({
    outcome: result.outcome,
    apply_mode: result.applyMode,
    target_entity_id: result.targetEntityId,
    application_id: result.applicationId,
    applied_fields: result.appliedFields,
    ledger: result.ledger,
    activities_rejected: result.activitiesRejected,
  });
}
