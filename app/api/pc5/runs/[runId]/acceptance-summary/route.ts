import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isPc5ResolutionEnabled } from '@/lib/pc5/featureFlags';
import { buildAcceptanceSummary } from '@/lib/pc5/acceptanceSummary';

/**
 * GET /api/pc5/runs/{runId}/acceptance-summary — K.15 and K.16.
 *
 * The concise summary a user sees BEFORE a canonical write: source type,
 * owner/entity, accounts/folios, schemes, transaction and holding counts,
 * statement period, unresolved warnings, history completeness and financial
 * reconciliation status — with the full extracted dataset returned only
 * when `?full=1` is asked for.
 *
 * `readyToAccept` IN THIS RESPONSE IS ADVISORY AND SAYS SO. It mirrors the
 * acceptance gate's conditions, but `POST /api/aie/review/runs/{runId}/accept`
 * re-derives every one of them server-side from the database and remains
 * the only authority. A client must never treat this flag as permission —
 * which is why the accept route does not read it and could not be made to.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!isPc5ResolutionEnabled()) {
    return bad('The guided resolution workflow is not currently enabled in this environment.', 403, 'feature_flag_disabled');
  }

  const { runId } = await params;
  const includeFullExtract = new URL(req.url).searchParams.get('full') === '1';

  const outcome = await buildAcceptanceSummary({ userId: user.id, runId, includeFullExtract });
  if (!outcome.ok) {
    const statusByReason: Record<string, number> = { not_found: 404, unsupported_adapter: 422, no_candidates: 409 };
    return bad(`could not build acceptance summary: ${outcome.reason}`, statusByReason[outcome.reason] ?? 400, outcome.reason);
  }

  return ok({
    summary: outcome.summary,
    // Null unless explicitly requested — K.16's expandable full view is a
    // second request by design, so the default response stays small and the
    // user is not handed several hundred transaction rows they did not ask
    // to audit.
    fullExtract: outcome.fullExtract,
  });
}
