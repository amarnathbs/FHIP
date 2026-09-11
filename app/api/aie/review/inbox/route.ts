import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isAieReviewUiEnabled } from '@/lib/aie/review/featureFlags';
import { listRunsForUser, getIntakeDisplayFilename, countItemsBlockingAcceptanceForRun, latestReconciliationOutcomesForRun, getAdapterIdForRun, hasWriteBatchForRun } from '@/lib/aie/db/repository';
import { computeUserFacingState } from '@/lib/aie/review/userState';
import { resolveModuleDescriptorByAdapterId } from '@/lib/aie/review/moduleRegistry';
import { worstOutcome } from '@/lib/aie/reconciliation/types';
import type { AieReviewRunSummary } from '@/lib/aie/review/types';

// GET /api/aie/review/inbox — AIE15-IA-09: "one dashboard/inbox entry
// point." Lists the caller's own runs (never another user's — every read
// below is scoped by `.eq('user_id', userId)` inside the repository
// functions themselves) with a computed, privacy-safe user-facing summary.
// No raw document content, provider output or PII appears anywhere in this
// response (PRIV-02).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!isAieReviewUiEnabled()) return bad('The AIE review inbox is not currently enabled in this environment.', 403);

  const runs = await listRunsForUser(user.id, 50);

  const summaries: AieReviewRunSummary[] = await Promise.all(
    runs.map(async (run): Promise<AieReviewRunSummary> => {
      const [displayFilename, blockingCount, reconciliationOutcomes, adapterId, hasEverReachedWritePending] = await Promise.all([
        getIntakeDisplayFilename(run.intakeId),
        countItemsBlockingAcceptanceForRun(run.id),
        latestReconciliationOutcomesForRun(run.id),
        getAdapterIdForRun(run.id),
        hasWriteBatchForRun(run.id),
      ]);
      const descriptor = resolveModuleDescriptorByAdapterId(adapterId);
      const reconciliationOutcome = worstOutcome(reconciliationOutcomes.map((r) => ({ ruleId: r.ruleId, ruleVersion: '1', outcome: r.outcome })));
      return {
        runId: run.id,
        intakeId: run.intakeId,
        userState: computeUserFacingState({
          runStatus: run.status,
          reconciliationOutcome,
          openBlockingItemCount: blockingCount,
          hasEverReachedWritePending,
        }),
        runStatus: run.status,
        moduleLabel: descriptor?.label ?? 'Document',
        reconciliationOutcome,
        openBlockingItemCount: blockingCount,
        openWarningItemCount: 0,
        displayFilename,
        createdAt: run.startedAt,
      };
    }),
  );

  return ok({ runs: summaries });
}
