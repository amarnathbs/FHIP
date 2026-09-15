import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, badValidation, ok } from '@/lib/api';
import { decidePc5Resolution } from '@/lib/pc5/decide';
import { PC5_RESOLUTION_ACTIONS, type Pc5ResolutionAction } from '@/lib/pc5/types';
import { PC5_TOTAL_BASIS_POINTS } from '@/lib/pc5/jointAllocation';
import { resolveHouseholdCountryForUser, UnresolvedHouseholdCountryError } from '@/lib/aie/adapters/investment-intelligence/householdContext';

/**
 * POST /api/pc5/resolutions/{itemId}/decide — the ONE path a PC5 decision
 * can reach the database through (K.1, K.5, K.6, K.9, K.10).
 *
 * EVERY AUTHORITY-BEARING VALUE IS RE-DERIVED SERVER-SIDE, and the schema
 * below is shape validation only, never permission:
 *   - the PERMITTED ACTIONS come from the item's own persisted
 *     `permitted_action_types` intersected with the reason-code registry;
 *   - the PERMITTED OPTIONS come from a query filtered by the authenticated
 *     caller's own user id, so a forged household-member or account id is
 *     simply absent from the set (K.20);
 *   - the ITEM VERSION is re-checked three times on the way down, the last
 *     of them inside `recordReviewDecision`'s own conditional update, which
 *     is the one that is actually atomic;
 *   - the COUNTRY CODE is resolved from the authenticated profile and FAILS
 *     CLOSED — it is never taken from the request body, because a
 *     caller-supplied jurisdiction would silently change how instruments
 *     resolve and which currency is expected.
 *
 * `idempotencyKey` is caller-supplied but grants no authority of its own:
 * it only keys the unique constraint on `aie_review_decision`, so a
 * repeated click produces one decision rather than two (K.22's "concurrent
 * resolution idempotency").
 */

const allocationEntrySchema = z
  .object({
    ownerMemberId: z.string().uuid().optional(),
    ownerBusinessEntityId: z.string().uuid().optional(),
    basisPoints: z.number().int().positive().max(PC5_TOTAL_BASIS_POINTS),
  })
  .refine((e) => Boolean(e.ownerMemberId) !== Boolean(e.ownerBusinessEntityId), {
    message: 'exactly one of ownerMemberId or ownerBusinessEntityId is required',
  });

const decideSchema = z.object({
  action: z.enum(PC5_RESOLUTION_ACTIONS as unknown as [Pc5ResolutionAction, ...Pc5ResolutionAction[]]),
  itemVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(1).max(200),
  // An id or a closed-vocabulary token — never free text, and never a
  // number the user typed. K.9 is explicit that a user must not be able to
  // type a balancing figure into canonical truth, so there is no numeric
  // field anywhere in this schema.
  chosenValue: z.string().min(1).max(200).optional(),
  // At most a handful of owners; the cap is a denial-of-service bound, not
  // a product rule.
  allocation: z.array(allocationEntrySchema).min(1).max(20).optional(),
  iiAccountId: z.string().uuid().optional(),
  rationale: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { itemId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('invalid request body', 422);
  }

  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) return badValidation(parsed.error);

  // `discard_statement` acts on the RUN, not on one item, and has its own
  // route with its own reason vocabulary and its own purge consequences.
  // Refused here rather than silently ignored, so a caller that sent it to
  // the wrong endpoint is told exactly where it belongs.
  if (parsed.data.action === 'discard_statement') {
    return bad('discarding a statement is a document-level action — use POST /api/pc5/runs/{runId}/discard', 422, 'wrong_endpoint');
  }

  let countryCode: string;
  try {
    countryCode = await resolveHouseholdCountryForUser(user.id);
  } catch (err) {
    if (err instanceof UnresolvedHouseholdCountryError) {
      return bad('Your home country is not set yet, so this statement cannot be re-checked.', 409, 'home_country_unresolved');
    }
    throw err;
  }

  const outcome = await decidePc5Resolution({
    userId: user.id,
    itemId,
    action: parsed.data.action,
    itemVersion: parsed.data.itemVersion,
    idempotencyKey: parsed.data.idempotencyKey,
    chosenValue: parsed.data.chosenValue,
    allocation: parsed.data.allocation,
    iiAccountId: parsed.data.iiAccountId,
    rationale: parsed.data.rationale,
    countryCode,
  });

  if (!outcome.ok) {
    const statusByReason: Record<string, number> = {
      feature_flag_disabled: 403,
      not_found: 404,
      forbidden: 403,
      stale_conflict: 409,
      action_not_permitted: 422,
      invalid_choice: 422,
      invalid_allocation: 422,
      allocation_required: 422,
      allocation_not_permitted: 422,
      cannot_dismiss_blocking_item: 422,
      reconciliation_refused: 409,
      db_error: 500,
    };
    return bad(
      `could not record decision: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`,
      statusByReason[outcome.reason] ?? 400,
      outcome.reason,
    );
  }

  return ok({
    decided: true,
    decisionId: outcome.decisionId,
    replayed: outcome.replayed,
    allocationGroupId: outcome.allocationGroupId,
    // Reported honestly in both directions. `ran: false` with a reason is
    // NOT a failure of the decision — the decision stands and is audited —
    // it means the item is still `in_review` and still blocking, which is
    // exactly what the client should render.
    reReconciliation: outcome.reReconciliation,
  });
}
