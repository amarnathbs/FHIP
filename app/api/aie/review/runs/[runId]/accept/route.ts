import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { acceptRun } from '@/lib/aie/review/accept';
import { OWNER_VALUES } from '@/lib/constants';

// POST /api/aie/review/runs/{runId}/accept — the ONE structural gate a
// canonical write for this run can ever pass through (ACPT-01..12).
// `idempotencyKey` is caller-supplied (CONC-03: "stable idempotency key so
// repeated clicks/retries produce one decision") but is only ever USED to
// key a lookup/insert — it grants no authority of its own; every other
// gate (ownership, run status, blocking items, reconciliation freshness)
// is re-derived from the database inside `acceptRun`, never trusted from
// the request body.
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { runId } = await params;
  let body: { ownerHouseholdRole?: string; masterItemKey?: string | null; notes?: string | null; idempotencyKey?: string; ownerMemberId?: string | null; countryCode?: string };
  try {
    body = await req.json();
  } catch {
    return bad('invalid request body', 422);
  }

  if (!body.ownerHouseholdRole || !(OWNER_VALUES as readonly string[]).includes(body.ownerHouseholdRole)) {
    return bad('ownerHouseholdRole is required and must be a valid household role', 422);
  }
  if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length > 200) {
    return bad('idempotencyKey is required', 422);
  }

  // ownerMemberId/countryCode are only meaningful (and only required) for a
  // run this resolves as an Investment Intelligence run — acceptRun() itself
  // is the one place that actually knows the run's real adapter id and
  // enforces this (`missing_required_input`); this route passes them
  // through verbatim, never guessing a value for either.
  const outcome = await acceptRun({
    runId,
    userId: user.id,
    acceptedByUserId: user.id,
    ownerHouseholdRole: body.ownerHouseholdRole as (typeof OWNER_VALUES)[number],
    masterItemKey: body.masterItemKey ?? null,
    notes: body.notes ?? null,
    idempotencyKey: body.idempotencyKey,
    ownerMemberId: body.ownerMemberId ?? null,
    countryCode: body.countryCode,
  });

  if (!outcome.ok) {
    const statusByReason: Record<string, number> = {
      feature_flag_disabled: 403,
      not_found: 404,
      not_ready: 409,
      items_still_blocking: 409,
      reconciliation_not_fresh: 409,
      stale_conflict: 409,
      unsupported_adapter: 422,
      missing_required_input: 422,
      write_failed: 502,
    };
    return bad(`could not accept run: ${outcome.reason}`, statusByReason[outcome.reason] ?? 400, outcome.reason);
  }

  return ok({
    accepted: true,
    alreadyCompleted: outcome.alreadyCompleted,
    insurancePolicyId: outcome.insurancePolicyId ?? null,
    iiSourceDocumentId: outcome.iiSourceDocumentId ?? null,
    statementUploadId: outcome.statementUploadId ?? null,
  });
}
