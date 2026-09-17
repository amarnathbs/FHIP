import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, badValidation, ok } from '@/lib/api';
import { discardStatement, PC5_DISCARD_REASONS, type Pc5DiscardReason } from '@/lib/pc5/discard';

/**
 * POST /api/pc5/runs/{runId}/discard — K.11: the clear path to discard a
 * statement uploaded for the wrong person or household.
 *
 * DOCUMENT-LEVEL, NOT ITEM-LEVEL, deliberately. "This is not my statement"
 * is never true of one exception and false of its siblings, and offering it
 * per-item would let a user discard "the owner problem" while leaving the
 * statement half-live. There is no partial discard, exactly as there is no
 * partial accept.
 *
 * The reason is a CLOSED VOCABULARY rather than free text. A free-text
 * reason on a discard is the one field most likely to contain the very PII
 * the discard exists to remove ("this is my brother Anil's statement"), and
 * it would then be retained in an audit row that is explicitly supposed to
 * be privacy-safe.
 */

const discardSchema = z.object({
  reason: z.enum(PC5_DISCARD_REASONS as unknown as [Pc5DiscardReason, ...Pc5DiscardReason[]]),
});

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { runId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('invalid request body', 422);
  }
  const parsed = discardSchema.safeParse(body);
  if (!parsed.success) return badValidation(parsed.error);

  const outcome = await discardStatement({ runId, userId: user.id, reason: parsed.data.reason });
  if (!outcome.ok) {
    const statusByReason: Record<string, number> = {
      feature_flag_disabled: 403,
      not_found: 404,
      not_eligible: 409,
      // K.18: an accepted statement is not discardable. It is superseded,
      // through Investment Intelligence's own path. 409 rather than 403 —
      // the request is legitimate, the state is wrong.
      already_accepted: 409,
      stale_conflict: 409,
    };
    return bad(`could not discard statement: ${outcome.reason}`, statusByReason[outcome.reason] ?? 400, outcome.reason);
  }

  return ok({
    discarded: true,
    // `scheduled_for_retry` is reported rather than smoothed over: it means
    // the delete call did not verify as absent and the sweep will retry
    // within its bounded window, with the 24-hour hard backstop behind it.
    // Telling the user "deleted" when verification failed would be a
    // privacy claim the system had not actually kept.
    binary: outcome.binary,
    tokenMapRowsPurged: outcome.tokenMapRowsPurged,
  });
}
