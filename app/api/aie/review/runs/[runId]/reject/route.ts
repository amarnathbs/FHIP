import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { rejectRun } from '@/lib/aie/review/reject';

// POST /api/aie/review/runs/{runId}/reject — ACT-05: "reject document/
// import with clear consequence." Document-level, irreversible within this
// pass (no undo path is built — AMEND-06/07 scope, deferred).
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { runId } = await params;
  let rationale: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.rationale === 'string') rationale = body.rationale.slice(0, 500);
  } catch {
    // A body is optional for this action.
  }

  const outcome = await rejectRun({ runId, userId: user.id, rationale });
  if (!outcome.ok) {
    const statusByReason: Record<string, number> = { not_found: 404, not_eligible: 409, stale_conflict: 409 };
    return bad(`could not reject document: ${outcome.reason}`, statusByReason[outcome.reason] ?? 400, outcome.reason);
  }
  return ok({ rejected: true });
}
