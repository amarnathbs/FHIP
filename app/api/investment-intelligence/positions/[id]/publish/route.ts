import { requireUser, ok, bad } from '@/lib/api';
import { publishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';

// R3 — the real, production-connected publish confirmation (replaces R1's
// structural-only stub, spec sections 11/43-46). [id] is an
// ii_holding_snapshots.id (a canonical_position_id) owned by the caller.
// Body (all optional):
//   linkToExistingInvestmentId — user-confirmed: this position IS the same
//     economic investment as this existing manual investments.id row.
//   acknowledgedNoDuplicate — user reviewed the preview's duplicate
//     candidates and confirmed none apply; required to proceed past a
//     REQUIRES_REVIEW result without linking.
//   confirmedAnnualContribution — the user's confirmed forward-looking
//     annual contribution plan (never inferred from historical SIPs).
//   correlationId — client-generated id tying one publish request's audit
//     trail together; the server also uses it to answer a duplicate/retry
//     request idempotently.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  let body: { linkToExistingInvestmentId?: string; acknowledgedNoDuplicate?: boolean; confirmedAnnualContribution?: number; correlationId?: string } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return bad('Invalid request body', 422);
  }

  const result = await publishPosition(user.id, id, {
    linkToExistingInvestmentId: body.linkToExistingInvestmentId ?? null,
    acknowledgedNoDuplicate: body.acknowledgedNoDuplicate ?? false,
    confirmedAnnualContribution: body.confirmedAnnualContribution ?? null,
    correlationId: body.correlationId,
  });

  if (result.error) {
    const status = result.errorCode === 'REVIEW_REQUIRED' ? 409 : result.errorCode === 'NOT_ELIGIBLE' || result.errorCode === 'TARGET_NOT_ACTIVATED' ? 422 : 500;
    return bad(result.error, status);
  }
  return ok(result);
}
