import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isAieReviewUiEnabled } from '@/lib/aie/review/featureFlags';
import { decideOnItem, type ItemDecisionAction } from '@/lib/aie/review/decide';

const VALID_ACTIONS: readonly ItemDecisionAction[] = ['correct', 'not_present', 'defer'];

// POST /api/aie/review/items/{itemId}/decide — ACT-01..12. The ONLY path a
// client can influence an `aie_unresolved_item`'s status through. Every
// field here is typed and server-validated (ACT-09/VALID-01..12) —
// `fieldName`/`rawValue` are only meaningful (and only ever accepted) for
// action 'correct', and even then only against the specific item's own
// registry-declared allowlist (see decide.ts).
export async function POST(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!isAieReviewUiEnabled()) return bad('The AIE review inbox is not currently enabled in this environment.', 403);

  const { itemId } = await params;
  let body: { action?: string; itemVersion?: number; idempotencyKey?: string; fieldName?: string; rawValue?: string; rationale?: string };
  try {
    body = await req.json();
  } catch {
    return bad('invalid request body', 422);
  }

  if (!body.action || !VALID_ACTIONS.includes(body.action as ItemDecisionAction)) return bad('invalid action', 422);
  if (typeof body.itemVersion !== 'number' || !Number.isInteger(body.itemVersion) || body.itemVersion < 1) return bad('itemVersion is required', 422);
  if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length > 200) return bad('idempotencyKey is required', 422);
  if (body.action === 'correct' && (typeof body.fieldName !== 'string' || typeof body.rawValue !== 'string')) {
    return bad('fieldName and rawValue are required for a correction', 422);
  }

  const outcome = await decideOnItem({
    itemId,
    userId: user.id,
    action: body.action as ItemDecisionAction,
    itemVersion: body.itemVersion,
    idempotencyKey: body.idempotencyKey,
    actorId: user.id,
    rationale: body.rationale?.slice(0, 500),
    fieldName: body.fieldName,
    rawValue: body.rawValue,
  });

  if (!outcome.ok) {
    const statusByReason: Record<string, number> = {
      not_found: 404,
      forbidden: 403,
      stale_conflict: 409,
      db_error: 500,
      action_not_permitted: 422,
      field_not_correctable: 422,
      invalid_value: 422,
    };
    return bad(`could not record decision: ${outcome.reason}`, statusByReason[outcome.reason] ?? 400, outcome.reason);
  }

  return ok({
    decided: true,
    revalidation: outcome.revalidation && outcome.revalidation.ok
      ? { runStatus: outcome.revalidation.runStatus, openBlockingItemCount: outcome.revalidation.openBlockingItemCount, worstOutcome: outcome.revalidation.worstOutcome }
      : null,
  });
}
