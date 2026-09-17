import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isAieReviewUiEnabled } from '@/lib/aie/review/featureFlags';
import {
  getRunForUser,
  getIntakeDisplayFilename,
  listFieldCandidatesForRun,
  listLatestCorrectionsForRun,
  listOpenUnresolvedItemsForRun,
  countItemsBlockingAcceptanceForRun,
  latestReconciliationOutcomesForRun,
  getAdapterIdForRun,
  hasWriteBatchForRun,
} from '@/lib/aie/db/repository';
import { computeUserFacingState } from '@/lib/aie/review/userState';
import { resolveModuleDescriptorByAdapterId, resolveReasonCodeMeta, narrowInsuranceRequiredFieldsCorrection } from '@/lib/aie/review/moduleRegistry';
import { buildCandidateViews } from '@/lib/aie/review/projection';
import { worstOutcome } from '@/lib/aie/reconciliation/types';
import type { AieReviewItemView } from '@/lib/aie/review/types';

// GET /api/aie/review/runs/{runId} — the full review detail for one run:
// clean-summary fields (TRI-01..12) if there is nothing to review, or the
// exception item list (ITEM-01..12) if there is. Ownership is enforced by
// `getRunForUser`'s own `.eq('user_id', userId)` filter (IDOR/PRIV-06) —
// never by trusting the path parameter alone.
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!isAieReviewUiEnabled()) return bad('The AIE review inbox is not currently enabled in this environment.', 403);

  const { runId } = await params;
  const run = await getRunForUser(runId, user.id);
  if (!run) return bad('run not found', 404);

  const [displayFilename, originalCandidates, corrections, openItems, blockingCount, reconciliationOutcomes, adapterId, hasEverReachedWritePending] = await Promise.all([
    getIntakeDisplayFilename(run.intakeId),
    listFieldCandidatesForRun(run.id),
    listLatestCorrectionsForRun(run.id),
    listOpenUnresolvedItemsForRun(run.id),
    countItemsBlockingAcceptanceForRun(run.id),
    latestReconciliationOutcomesForRun(run.id),
    getAdapterIdForRun(run.id),
    hasWriteBatchForRun(run.id),
  ]);

  const descriptor = resolveModuleDescriptorByAdapterId(adapterId);
  const reconciliationOutcome = worstOutcome(reconciliationOutcomes.map((r) => ({ ruleId: r.ruleId, ruleVersion: '1', outcome: r.outcome })));
  const userState = computeUserFacingState({ runStatus: run.status, reconciliationOutcome, openBlockingItemCount: blockingCount, hasEverReachedWritePending });

  const presentFieldNames = new Set(originalCandidates.filter((c) => !c.isNull && c.valueRaw !== null).map((c) => c.fieldName));
  const items: AieReviewItemView[] = openItems.map((item) => {
    const meta = narrowInsuranceRequiredFieldsCorrection(resolveReasonCodeMeta(descriptor, item.reasonCode), presentFieldNames);
    return {
      id: item.id,
      runId: run.id,
      reasonCode: item.reasonCode,
      status: item.status,
      severity: item.severity,
      itemVersion: item.itemVersion,
      displayCandidate: item.displayCandidate,
      meta,
      evidenceRef: item.evidenceRef,
    };
  });

  return ok({
    summary: {
      runId: run.id,
      intakeId: run.intakeId,
      userState,
      runStatus: run.status,
      moduleLabel: descriptor?.label ?? 'Document',
      reconciliationOutcome,
      openBlockingItemCount: blockingCount,
      openWarningItemCount: 0,
      displayFilename,
      createdAt: run.startedAt,
    },
    // TRI-09: candidates are only meaningful/shown when there is something
    // to review, or as the clean-summary field set — the frontend decides
    // which to render based on `userState`, but both are always returned
    // so a stale-vs-fresh comparison (TRI-11) never needs a second request.
    candidates: buildCandidateViews(originalCandidates, corrections),
    summaryFieldOrder: descriptor?.summaryFieldOrder ?? [],
    items,
    integrationTested: descriptor?.integrationTested ?? false,
  });
}
