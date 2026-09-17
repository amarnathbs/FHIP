import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isPc5ResolutionEnabled } from '@/lib/pc5/featureFlags';
import { projectItemContext } from '@/lib/pc5/projection';
import { getRunForUser } from '@/lib/aie/db/repository';
import { amendmentPathForRunStatus, PC5_AMENDMENT_GUIDANCE } from '@/lib/pc5/amendment';
import { aieRunReviewHref, pc5PasswordUnlockHref } from '@/lib/pc5/deepLinks';

/**
 * GET /api/pc5/resolutions/{itemId} — K.14's destination: the exact
 * underlying case, with everything needed to decide it.
 *
 * IDOR: `projectItemContext` proves ownership by the query itself
 * (`.eq('user_id', userId)`), so a cross-user item id returns null and this
 * route answers 404 — indistinguishable from a nonexistent id, and
 * therefore useless for enumerating which items exist (K.20).
 *
 * THE RESPONSE INCLUDES THE CORRECTION OVERLAY (K.12), and every entry in
 * it carries `originalValueIsRecoverable: false`. That is not a hint for
 * the UI to interpret — it is a fact about this system: Phase 4 implemented
 * the Product Owner's one-way-HMAC decision by DELETING the reversible
 * token map, so no reveal path exists to offer. The UI states it in words
 * rather than rendering a control that would always fail.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!isPc5ResolutionEnabled()) {
    return bad('The guided resolution workflow is not currently enabled in this environment.', 403, 'feature_flag_disabled');
  }

  const { itemId } = await params;
  const context = await projectItemContext({ userId: user.id, itemId });
  if (!context) return bad('resolution item not found', 404);

  const run = await getRunForUser(context.item.runId, user.id);
  const amendmentPath = run ? amendmentPathForRunStatus(run.status) : 'nothing_to_amend';

  return ok({
    item: context.item,
    overlay: context.overlay,
    runStatus: run?.status ?? null,
    // K.18 — the user is told which amendment path applies to them right
    // now, in plain language, rather than discovering it from a refusal.
    amendment: {
      path: amendmentPath,
      guidance: PC5_AMENDMENT_GUIDANCE[amendmentPath],
    },
    links: {
      // K.8: a password-required document deep-links to the real unlock
      // flow. There is no `request_reprocessing` implementation anywhere in
      // this repository to link to instead — see `deepLinks.ts`.
      passwordUnlock: pc5PasswordUnlockHref(context.item.intakeId),
      aieRunReview: aieRunReviewHref(context.item.runId),
    },
  });
}
