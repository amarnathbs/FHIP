/**
 * AIE-1.5 — canonical-acceptance gate (AIE15-ACPT-01..12, section 20).
 *
 * WIRED FOR REAL AGAINST INSURANCE (`acceptAndWriteInsuranceCandidates`,
 * merged from `feature/aie-1-4-other-modules`) AND, as of the AIE-1 real
 * merge's own follow-up fix (section 4b of `AIE_1_MERGE_PLAN.md`),
 * Investment Intelligence (`acceptAndWriteInvestmentCandidates`, merged
 * from `feature/aie-1-2-investment-adapter`). Every gate below (blocking
 * items resolved, reconciliation fresh/passing, run status CAS'd, adapter
 * write called, idempotent retry) is the real, generic AIE-1.5 mechanism —
 * only the final "which adapter's write service do I call" step is
 * adapter-specific, dispatched by the run's own recorded `adapter_id`
 * (`repo.getAdapterIdForRun`, the same real fact `decide.ts`/`revalidate.ts`
 * already dispatch on — never `source_module_hint`, which AIE-1.1's own
 * docs are explicit is caller metadata, not an authority AIE-1.1 acts on).
 * FDH-bank (`commitFdhBankStatementImport`) is NOT wired here yet — see
 * `AIE_1_3_IMPLEMENTATION.md` section 5/8 and `AIE_1_MERGE_PLAN.md` section
 * 4a: it needs the ORIGINAL FILE BYTES re-run through FDH-5's own upload
 * pipeline, a materially different shape from Insurance's/Investment
 * Intelligence's candidate-based writes. A run recorded against any other
 * adapter id (including FDH-bank's, or none at all) is refused as
 * `unsupported_adapter` — never silently routed to Insurance's write
 * service, which is exactly the latent defect this fix closes (before this
 * fix, EVERY run reaching this point was unconditionally written through
 * Insurance's service, whatever adapter actually produced it).
 *
 * Every side effect is injected (`AcceptRunDeps`, matching
 * `lib/aie/orchestrator.ts` / `lib/aie/review/revalidate.ts`'s own
 * established pattern) so this — the single most safety-critical function
 * in AIE-1.5 ("no accept-anyway for material failed/indeterminate
 * reconciliation" MUST be structurally impossible, not merely untested) —
 * is fully unit-testable without a database (see
 * `tests/unit/aieReviewAccept.test.ts`).
 *
 * GATE ORDER (ACPT-02..05, in the order a reviewer should be told "no" in,
 * matching this pass's own insurance write.ts's established order, one
 * level up at the run):
 *   1. Run belongs to the caller (IDOR) — enforced by `getRunForUser`'s own
 *      `.eq('user_id', ...)` filter.
 *   2. Run status is exactly `awaiting_acceptance` (ACPT-05: not stale).
 *   3. Zero items currently blocking acceptance (ACPT-02, re-checked here,
 *      never trusted from a client-supplied summary).
 *   4. The LATEST reconciliation outcome for every rule is
 *      pass/pass_with_tolerance (ACPT-03/ACT-08/12: no confidence input
 *      anywhere in this signature, P4).
 *   5. CAS transition `awaiting_acceptance` -> `accepted` -> `write_pending`
 *      (CONC-01/02: a concurrent accept from another tab loses the race
 *      cleanly rather than double-writing).
 *   6. Call ONLY the domain-owned atomic write service (ACPT-08) — never a
 *      direct table write from this module. Which service is determined by
 *      the run's own recorded adapter id, never guessed or defaulted.
 */

import * as repo from '../db/repository';
import { recordAieAuditEvent } from '../audit';
import { worstOutcome } from '../reconciliation/types';
import { mergeCandidatesWithCorrections } from './candidateMerge';
import { acceptAndWriteInsuranceCandidates, createDefaultAcceptAndWriteInsuranceDeps, type AcceptAndWriteInsuranceDeps, type AcceptAndWriteInsuranceOutcome } from '../adapters/insurance';
import { acceptAndWriteInvestmentCandidates, createDefaultAcceptAndWriteDeps, II_ADAPTER_ID, type AcceptAndWriteDeps as AcceptAndWriteInvestmentDeps, type AcceptAndWriteOutcome as AcceptAndWriteInvestmentOutcome } from '../adapters/investment-intelligence';
import { isAieCanonicalAcceptanceEnabled } from './featureFlags';
import type { Owner as OwnerValue } from '@/lib/constants';

const INSURANCE_ADAPTER_ID = 'insurance_generic_schedule_v1';

export type AcceptRunOutcome =
  | { ok: false; reason: 'feature_flag_disabled' | 'not_found' | 'not_ready' | 'items_still_blocking' | 'reconciliation_not_fresh' | 'stale_conflict' | 'unsupported_adapter' | 'missing_required_input' | 'write_failed'; message?: string }
  | { ok: true; alreadyCompleted: boolean; insurancePolicyId?: string; iiSourceDocumentId?: string };

export interface AcceptRunParams {
  runId: string;
  userId: string;
  acceptedByUserId: string;
  ownerHouseholdRole: OwnerValue;
  masterItemKey?: string | null;
  notes?: string | null;
  idempotencyKey: string;
  /**
   * Investment Intelligence dispatch only (`II_ADAPTER_ID`). Never derived
   * from document text or inferred — same discipline as
   * `ownerHouseholdRole` above for Insurance: an explicit choice the
   * accepting user/caller supplies. Required only when the run being
   * accepted was actually produced by the Investment Intelligence adapter;
   * ignored otherwise.
   */
  ownerMemberId?: string | null;
  countryCode?: string;
}

export interface AcceptRunDeps {
  isCanonicalAcceptanceEnabled: () => boolean;
  getRunForUser: typeof repo.getRunForUser;
  getAdapterIdForRun: typeof repo.getAdapterIdForRun;
  getIntakeUploadMetadata: typeof repo.getIntakeUploadMetadata;
  countItemsBlockingAcceptanceForRun: typeof repo.countItemsBlockingAcceptanceForRun;
  latestReconciliationOutcomesForRun: typeof repo.latestReconciliationOutcomesForRun;
  listFieldCandidatesForRun: typeof repo.listFieldCandidatesForRun;
  listLatestCorrectionsForRun: typeof repo.listLatestCorrectionsForRun;
  transitionRunStatusCas: typeof repo.transitionRunStatusCas;
  findOrCreateWriteBatch: typeof repo.findOrCreateWriteBatch;
  markWriteBatchStatus: typeof repo.markWriteBatchStatus;
  audit: typeof recordAieAuditEvent;
  acceptAndWriteInsurance: (input: Parameters<typeof acceptAndWriteInsuranceCandidates>[0], deps: AcceptAndWriteInsuranceDeps) => Promise<AcceptAndWriteInsuranceOutcome>;
  insuranceWriteDeps: AcceptAndWriteInsuranceDeps;
  acceptAndWriteInvestment: (input: Parameters<typeof acceptAndWriteInvestmentCandidates>[0], deps: AcceptAndWriteInvestmentDeps) => Promise<AcceptAndWriteInvestmentOutcome>;
  investmentWriteDeps: AcceptAndWriteInvestmentDeps;
}

export function createDefaultAcceptRunDeps(): AcceptRunDeps {
  return {
    isCanonicalAcceptanceEnabled: isAieCanonicalAcceptanceEnabled,
    getRunForUser: repo.getRunForUser,
    getAdapterIdForRun: repo.getAdapterIdForRun,
    getIntakeUploadMetadata: repo.getIntakeUploadMetadata,
    countItemsBlockingAcceptanceForRun: repo.countItemsBlockingAcceptanceForRun,
    latestReconciliationOutcomesForRun: repo.latestReconciliationOutcomesForRun,
    listFieldCandidatesForRun: repo.listFieldCandidatesForRun,
    listLatestCorrectionsForRun: repo.listLatestCorrectionsForRun,
    transitionRunStatusCas: repo.transitionRunStatusCas,
    findOrCreateWriteBatch: repo.findOrCreateWriteBatch,
    markWriteBatchStatus: repo.markWriteBatchStatus,
    audit: recordAieAuditEvent,
    acceptAndWriteInsurance: acceptAndWriteInsuranceCandidates,
    insuranceWriteDeps: createDefaultAcceptAndWriteInsuranceDeps(),
    acceptAndWriteInvestment: acceptAndWriteInvestmentCandidates,
    investmentWriteDeps: createDefaultAcceptAndWriteDeps(),
  };
}

export async function acceptRun(params: AcceptRunParams, deps: AcceptRunDeps = createDefaultAcceptRunDeps()): Promise<AcceptRunOutcome> {
  if (!deps.isCanonicalAcceptanceEnabled()) return { ok: false, reason: 'feature_flag_disabled' };

  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };

  // Idempotent replay: already fully completed — do not attempt a second
  // CAS/write (ACPT-11/FAIL-04/10).
  if (run.status === 'completed') return { ok: true, alreadyCompleted: true };
  if (run.status !== 'awaiting_acceptance') {
    // 'accepted' / 'write_pending' means an earlier attempt is (or was)
    // mid-flight — never re-run acceptance concurrently with itself.
    return { ok: false, reason: 'not_ready' };
  }

  const [blockingCount, reconciliationOutcomes, adapterId] = await Promise.all([
    deps.countItemsBlockingAcceptanceForRun(run.id),
    deps.latestReconciliationOutcomesForRun(run.id),
    deps.getAdapterIdForRun(run.id),
  ]);
  if (blockingCount > 0) return { ok: false, reason: 'items_still_blocking' };

  const worst = worstOutcome(reconciliationOutcomes.map((r) => ({ ruleId: r.ruleId, ruleVersion: '1', outcome: r.outcome })));
  if (worst === 'fail' || worst === 'indeterminate') return { ok: false, reason: 'reconciliation_not_fresh' };
  // `not_applicable` (no domain adapter registered at all, or nothing to
  // reconcile) is deliberately NOT treated as a pass here — accepting a
  // document nothing ever actually checked would be exactly the silent
  // "schema-valid but never verified" gap AIE-1.6's own NO-GO criteria
  // warn about. Only a genuine pass/pass_with_tolerance may proceed.
  if (worst === 'not_applicable') return { ok: false, reason: 'reconciliation_not_fresh' };

  // Which adapter owns this run, decided ONCE, from the real recorded fact
  // (never guessed, never defaulted to Insurance) — checked BEFORE any CAS
  // transition so a run this function cannot write is refused cleanly,
  // rather than stranded mid-flight in `accepted`/`write_pending` for an
  // adapter it will never resolve.
  const isInsurance = adapterId === INSURANCE_ADAPTER_ID;
  const isInvestmentIntelligence = adapterId === II_ADAPTER_ID;
  if (!isInsurance && !isInvestmentIntelligence) return { ok: false, reason: 'unsupported_adapter' };

  // Investment Intelligence's write.ts needs the ORIGINAL upload's storage
  // location + declared metadata (it re-fetches the bytes from quarantine
  // itself) plus an explicit, caller-supplied ownerMemberId/countryCode
  // (never derived from document text — same discipline as
  // ownerHouseholdRole for Insurance). Resolved/validated up front, for the
  // same reason as the adapter check above.
  let investmentUploadMetadata: { storageKey: string; declaredMimeType: string; displayFilename: string | null } | null = null;
  if (isInvestmentIntelligence) {
    if (!params.ownerMemberId || !params.countryCode) return { ok: false, reason: 'missing_required_input', message: 'ownerMemberId and countryCode are required to accept an Investment Intelligence run' };
    investmentUploadMetadata = await deps.getIntakeUploadMetadata(run.intakeId);
    if (!investmentUploadMetadata) return { ok: false, reason: 'missing_required_input', message: 'original upload metadata not found for this intake' };
  }

  const movedToAccepted = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'awaiting_acceptance', toStatus: 'accepted' });
  if (!movedToAccepted) return { ok: false, reason: 'stale_conflict' };
  await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'run_transition', actorType: 'user', actorId: params.acceptedByUserId, metadata: { toState: 'accepted' } });

  const movedToWritePending = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'accepted', toStatus: 'write_pending' });
  if (!movedToWritePending) return { ok: false, reason: 'stale_conflict' };

  const targetModule = isInvestmentIntelligence ? 'investment_intelligence' : 'other';
  const batch = await deps.findOrCreateWriteBatch({ runId: run.id, intakeId: run.intakeId, userId: run.userId, targetModule, idempotencyKey: params.idempotencyKey });
  if (batch.status === 'committed') {
    // Idempotent replay after a previous call already committed the write
    // but the client never saw the response (FAIL-10).
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
    return { ok: true, alreadyCompleted: true };
  }

  const [originalCandidates, corrections] = await Promise.all([deps.listFieldCandidatesForRun(run.id), deps.listLatestCorrectionsForRun(run.id)]);
  const mergedCandidates = mergeCandidatesWithCorrections(originalCandidates, corrections);

  // Retryable vs terminal: a feature-flag/gate failure or schema rejection is
  // a genuine domain rejection (FAIL-01: terminal, do not silently retry
  // into the same wall); anything DB/network/storage-shaped is treated as
  // retryable so a future retry with the SAME idempotency key can still
  // succeed without duplicating. Investment Intelligence's write.ts has no
  // schema-validation reason of its own (it delegates the ENTIRE canonical
  // write to Investment Intelligence's own already-certified
  // `processSourceDocument`, unlike Insurance's own direct
  // `insuranceSchema.safeParse`) — its download/upload/insert/link failures
  // are all DB/storage-shaped and therefore retryable; this set of terminal
  // reasons is a superset covering both adapters' vocabularies.
  const TERMINAL_WRITE_REASONS = new Set(['feature_flag_disabled', 'reconciliation_not_passed', 'unresolved_items_open', 'schema_validation_failed']);

  const runId = run.id;
  const runIntakeId = run.intakeId;
  const runUserId = run.userId;
  async function finishFailedWrite(reason: string): Promise<void> {
    await deps.markWriteBatchStatus(batch.id, 'failed');
    const terminal = TERMINAL_WRITE_REASONS.has(reason);
    await deps.transitionRunStatusCas({ runId, fromStatus: 'write_pending', toStatus: terminal ? 'failed_terminal' : 'failed_retryable' });
    await deps.audit({ intakeId: runIntakeId, runId, userId: runUserId, eventType: 'run_failed', actorType: 'system', metadata: { reason } });
  }

  // Dispatch to the domain-owned atomic write service for the adapter that
  // actually produced this run (ACPT-08) — never Insurance's by default.
  // Handled as two fully separate, fully-typed branches (rather than a
  // shared union) because the two adapters' outcome shapes carry different,
  // adapter-specific identifier fields (insurancePolicyId vs
  // iiSourceDocumentId) with no common success field beyond `ok`.
  if (isInsurance) {
    const write = await deps.acceptAndWriteInsurance(
      {
        aieIntakeId: run.intakeId,
        aieRunId: run.id,
        userId: run.userId,
        ownerHouseholdRole: params.ownerHouseholdRole,
        candidates: mergedCandidates,
        acceptedByUserId: params.acceptedByUserId,
        reconciliationOutcome: worst,
        hasOpenBlockingUnresolvedItems: false, // already proven false above, re-asserted structurally rather than re-derived
        masterItemKey: params.masterItemKey ?? null,
        notes: params.notes ?? null,
      },
      deps.insuranceWriteDeps,
    );

    if (!write.ok && write.reason === 'already_written') {
      await deps.markWriteBatchStatus(batch.id, 'committed');
      await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
      return { ok: true, alreadyCompleted: true, insurancePolicyId: write.insurancePolicyId };
    }
    if (!write.ok) {
      await finishFailedWrite(write.reason);
      return { ok: false, reason: 'write_failed', message: write.reason };
    }

    await deps.markWriteBatchStatus(batch.id, 'committed');
    const movedToCompleted = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
    await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'run_completed', actorType: 'user', actorId: params.acceptedByUserId, metadata: { insurancePolicyId: write.insurancePolicyId } });
    if (!movedToCompleted) {
      // The write itself unquestionably succeeded (we have a real
      // insurancePolicyId) — a lost final-transition race must never be
      // reported as failure (FAIL-02: "never report completion before
      // domain transaction commits" cuts both ways: never report FAILURE
      // after it already committed, either).
      return { ok: true, alreadyCompleted: true, insurancePolicyId: write.insurancePolicyId };
    }
    return { ok: true, alreadyCompleted: false, insurancePolicyId: write.insurancePolicyId };
  }

  const write = await deps.acceptAndWriteInvestment(
    {
      aieIntakeId: run.intakeId,
      aieRunId: run.id,
      userId: run.userId,
      ownerMemberId: params.ownerMemberId ?? null,
      countryCode: params.countryCode!,
      originalFilename: investmentUploadMetadata!.displayFilename ?? 'unknown',
      declaredMimeType: investmentUploadMetadata!.declaredMimeType,
      quarantineStorageKey: investmentUploadMetadata!.storageKey,
      acceptedByUserId: params.acceptedByUserId,
      reconciliationOutcome: worst,
      hasOpenBlockingUnresolvedItems: false, // already proven false above, re-asserted structurally rather than re-derived
    },
    deps.investmentWriteDeps,
  );

  if (!write.ok && write.reason === 'already_written') {
    await deps.markWriteBatchStatus(batch.id, 'committed');
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
    return { ok: true, alreadyCompleted: true, iiSourceDocumentId: write.iiSourceDocumentId };
  }
  if (!write.ok) {
    await finishFailedWrite(write.reason);
    return { ok: false, reason: 'write_failed', message: write.reason };
  }

  await deps.markWriteBatchStatus(batch.id, 'committed');
  const movedToCompleted = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
  await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'run_completed', actorType: 'user', actorId: params.acceptedByUserId, metadata: { iiSourceDocumentId: write.iiSourceDocumentId } });
  if (!movedToCompleted) {
    // Same FAIL-02 reasoning as the Insurance branch above: the write
    // itself unquestionably succeeded (we have a real iiSourceDocumentId).
    return { ok: true, alreadyCompleted: true, iiSourceDocumentId: write.iiSourceDocumentId };
  }
  return { ok: true, alreadyCompleted: false, iiSourceDocumentId: write.iiSourceDocumentId };
}
