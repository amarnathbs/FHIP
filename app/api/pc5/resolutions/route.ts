import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isPc5ResolutionEnabled } from '@/lib/pc5/featureFlags';
import { projectResolutionsForRun, projectResolutionsForUser } from '@/lib/pc5/projection';

/**
 * GET /api/pc5/resolutions — PC5's Review Centre listing (K.13, K.16).
 *
 * `?run=<runId>` narrows to one document; `?material=all` opts out of the
 * exception-only default and returns everything; `?history=1` additionally
 * includes terminal (resolved/superseded/rejected) items.
 *
 * WHAT THIS ROUTE DOES NOT RETURN, AND WHY IT MATTERS: no persisted PC5
 * row, because there is none. Every item in the response is projected live
 * from `aie_unresolved_item` on this request. That is what keeps K.3's "no
 * divergent open-count" true by construction rather than by a refresh job
 * that could fall behind — `stillBlockingCount` is derived from the same
 * predicate `repo.countItemsBlockingAcceptanceForRun` uses, so this
 * response and the acceptance gate's refusal can never disagree.
 *
 * Ownership is enforced inside every repository read by an explicit
 * `.eq('user_id', userId)` filter — never by trusting a query parameter.
 * A `?run=` id belonging to another user returns an empty list, not a 403,
 * so the endpoint cannot be used to discover which run ids exist.
 */
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!isPc5ResolutionEnabled()) {
    return bad('The guided resolution workflow is not currently enabled in this environment.', 403, 'feature_flag_disabled');
  }

  const url = new URL(req.url);
  const runId = url.searchParams.get('run');
  const materialOnly = url.searchParams.get('material') !== 'all';
  const includeHistory = url.searchParams.get('history') === '1';

  const result = runId
    ? await projectResolutionsForRun({ userId: user.id, runId, materialOnly, includeHistory })
    : await projectResolutionsForUser({ userId: user.id, materialOnly, includeHistory });

  return ok({
    items: result.items,
    stillBlockingCount: result.stillBlockingCount,
    hiddenNonMaterialCount: result.hiddenNonMaterialCount,
    // Stated in the response rather than assumed by the client, so a
    // consumer can render "showing exceptions only — N other items hidden"
    // truthfully instead of guessing which mode it asked for.
    materialOnly,
    includeHistory,
  });
}
