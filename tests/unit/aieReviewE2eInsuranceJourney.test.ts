/**
 * AIE-1.5 — the one realistic end-to-end journey the spec's mandatory
 * execution sequence and this repo's own engineering discipline require:
 * a document goes through AIE-1.1's REAL, unmodified `runExtractionPipeline`
 * with the REAL, merged-in AIE-1.4 Insurance parser + reconciliation rule
 * -> produces a real blocking `aie_unresolved_item` shape -> a typed
 * correction is validated exactly as `lib/aie/review/decide.ts` would
 * validate it -> `revalidateRun` re-runs the SAME real reconciliation rule
 * against the corrected candidate set -> the item resolves and the run
 * reaches `awaiting_acceptance` -> `acceptRun` calls the REAL
 * `acceptAndWriteInsuranceCandidates` (AIE-1.4's own write gate, feature-
 * flagged on for this test only) -> a real `insurance_policies`-shaped row
 * is produced and the run completes.
 *
 * All persistence is injected/faked (no database, no Supabase) — matching
 * every other AIE test in this repository. This proves the WIRING is
 * correct end-to-end; it does not replace live-DEV verification (not
 * performed this pass — see AIE_1_5_IMPLEMENTATION.md).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { runExtractionPipeline, createDefaultDeps, type AieOrchestratorDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { registerInsuranceAdapter } from '@/lib/aie/adapters/insurance';
import { buildInsuranceReconciliationRule } from '@/lib/aie/adapters/insurance/reconciliation';
import type { AcceptAndWriteInsuranceDeps } from '@/lib/aie/adapters/insurance';
import { acceptAndWriteInsuranceCandidates } from '@/lib/aie/adapters/insurance';
import { buildAieInsuranceFixtureText } from '../support/buildAieInsuranceFixtureText';

import { resolveModuleDescriptorByAdapterId, resolveReasonCodeMeta } from '@/lib/aie/review/moduleRegistry';
import { validateCorrection, findCorrectableFieldSpec } from '@/lib/aie/review/validation';
import { revalidateRun, type RevalidateRunDeps } from '@/lib/aie/review/revalidate';
import { acceptRun, type AcceptRunDeps } from '@/lib/aie/review/accept';
import { computeUserFacingState } from '@/lib/aie/review/userState';
import type { AieFieldCandidate, AieUnresolvedItemInput } from '@/lib/aie/types';
import type { AieRunRow, LatestCorrectionRow } from '@/lib/aie/db/repository';

function orchestratorFakeDeps(): { deps: AieOrchestratorDeps; calls: Record<string, unknown[]> } {
  const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true });
  const base = createDefaultDeps(gateway);
  const calls: Record<string, unknown[]> = { unresolvedItems: [] };
  return {
    deps: {
      ...base,
      recordTransition: async () => {},
      recordParserAttempt: async () => {},
      recordMaskingSummary: async () => {},
      persistMaskTokenMap: async () => {},
      recordAiCompletionAttempt: async () => ({ id: 'fake' }),
      recordSchemaValidationResult: async () => {},
      recordFieldCandidates: async () => {},
      recordReconciliationRuns: async () => {},
      createUnresolvedItems: async (p) => {
        calls.unresolvedItems.push(p);
        return p.items.map((_, i) => `item-${i}`);
      },
      audit: async () => {},
      gateway,
    },
    calls,
  };
}

describe('AIE-1.5 end-to-end journey — Insurance: unresolved -> correct -> revalidate -> accept -> completed', () => {
  const originalWriteFlag = process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED;

  beforeAll(() => {
    registerInsuranceAdapter();
  });

  afterEach(() => {
    if (originalWriteFlag === undefined) delete process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED;
    else process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED = originalWriteFlag;
  });

  it('runs the full journey against the REAL insurance parser, reconciliation rule and write gate', async () => {
    // --- Step 1: real extraction through the real orchestrator. The
    // fixture prints an unsupported currency (USD) — a real, material
    // reconciliation failure, not a contrived one.
    const { deps: orchestratorDeps } = orchestratorFakeDeps();
    const outcome = await runExtractionPipeline({
      runId: 'run-e2e-1',
      intakeId: 'intake-e2e-1',
      userId: 'user-e2e-1',
      extractedText: buildAieInsuranceFixtureText({ currency: 'USD' }),
      reconcile: buildInsuranceReconciliationRule(),
      deps: orchestratorDeps,
    });

    expect(outcome.finalStatus).toBe('unresolved');
    expect(outcome.unresolvedItemIds).toHaveLength(1);
    const originalCandidates: AieFieldCandidate[] = outcome.candidates;
    expect(originalCandidates.find((c) => c.fieldName === 'currencyCode')?.valueRaw).toBe('USD');

    // --- Step 2: the review layer's own reason-code registry correctly
    // identifies this as a correctable currency problem — real code, not a
    // hand-authored fixture reason code.
    const descriptor = resolveModuleDescriptorByAdapterId('insurance_generic_schedule_v1');
    expect(descriptor?.integrationTested).toBe(true);
    const reasonCode = 'reconciliation_fail:insurance_currency_supported';
    const meta = resolveReasonCodeMeta(descriptor, reasonCode);
    expect(meta.allowedActions).toContain('correct');
    const spec = findCorrectableFieldSpec(meta.correctableFields, 'currencyCode');
    expect(spec).not.toBeNull();

    // --- Step 3: typed, server-validated correction (exactly what
    // decide.ts does before ever calling recordReviewDecision).
    const validated = validateCorrection(spec!, 'aud');
    expect(validated).toEqual({ ok: true, normalized: 'AUD' });

    const correction: LatestCorrectionRow = { fieldName: 'currencyCode', valueNormalized: validated.ok ? validated.normalized : '', valueRaw: 'aud', decisionId: 'decision-1', actorId: 'user-e2e-1' };

    // --- Step 4: revalidateRun re-runs the REAL reconciliation rule
    // against the corrected candidate set.
    const runRow: AieRunRow = { id: 'run-e2e-1', intakeId: 'intake-e2e-1', userId: 'user-e2e-1', status: 'unresolved', aiUsed: false, startedAt: new Date().toISOString() };
    const revalidateCalls: Record<string, unknown[]> = { transitions: [], reconciliationRuns: [] };
    const revalidateDeps: RevalidateRunDeps = {
      getRunForUser: async () => runRow,
      listFieldCandidatesForRun: async () => originalCandidates,
      listLatestCorrectionsForRun: async () => [correction],
      getAdapterIdForRun: async () => 'insurance_generic_schedule_v1',
      listOpenUnresolvedItemsForRun: async () => [{ id: 'item-0', reasonCode, severity: 'blocking', status: 'open', displayCandidate: null, evidenceRef: { ruleId: 'insurance_currency_supported', ruleVersion: '1' }, itemVersion: 1 }],
      recordReconciliationRuns: async (p) => {
        revalidateCalls.reconciliationRuns.push(p);
      },
      createUnresolvedItems: async (p: { items: AieUnresolvedItemInput[] }) => p.items.map((_, i: number) => `new-${i}`),
      resolveItemBySystem: async () => ({ ok: true }),
      transitionRunStatusCas: async (p) => {
        revalidateCalls.transitions.push(p);
        runRow.status = p.toStatus;
        return true;
      },
      recordRunTransitionAudit: async () => {},
      audit: async () => {},
    };

    const revalidation = await revalidateRun({ runId: 'run-e2e-1', userId: 'user-e2e-1' }, revalidateDeps);
    expect(revalidation).toMatchObject({ ok: true, runStatus: 'awaiting_acceptance', openBlockingItemCount: 0, resolvedItemIds: ['item-0'] });
    expect(computeUserFacingState({ runStatus: 'awaiting_acceptance', reconciliationOutcome: 'pass', openBlockingItemCount: 0, hasEverReachedWritePending: false })).toBe('ready_to_accept');

    // --- Step 5: acceptRun calls the REAL AIE-1.4 write gate. The
    // adapter's own canonical-write flag must be explicitly on for this —
    // proving AIE-1.5 does not bypass AIE-1.4's own gate.
    process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED = 'true';
    let savedRow: Record<string, unknown> | null = null;
    const insuranceWriteDeps: AcceptAndWriteInsuranceDeps = {
      findExistingLink: async () => null,
      saveInsurancePolicy: async (_userId, row) => {
        savedRow = row;
        return { id: 'policy-e2e-1' };
      },
      recordLink: async () => ({ ok: true }),
    };

    runRow.status = 'awaiting_acceptance';
    const acceptCalls: Record<string, unknown[]> = { transitions: [] };
    const acceptDeps: AcceptRunDeps = {
      isCanonicalAcceptanceEnabled: () => true,
      getRunForUser: async () => runRow,
      countItemsBlockingAcceptanceForRun: async () => 0,
      latestReconciliationOutcomesForRun: async () => [
        { ruleId: 'insurance_currency_supported', outcome: 'pass' },
        { ruleId: 'insurance_required_fields_present', outcome: 'pass' },
        { ruleId: 'insurance_document_class_supported', outcome: 'pass' },
      ],
      listFieldCandidatesForRun: async () => originalCandidates,
      listLatestCorrectionsForRun: async () => [correction],
      transitionRunStatusCas: async (p) => {
        acceptCalls.transitions.push(p);
        runRow.status = p.toStatus;
        return true;
      },
      findOrCreateWriteBatch: async () => ({ id: 'batch-e2e-1', status: 'pending' }),
      markWriteBatchStatus: async () => {},
      audit: async () => {},
      acceptAndWriteInsurance: acceptAndWriteInsuranceCandidates,
      insuranceWriteDeps,
    };

    const acceptance = await acceptRun(
      { runId: 'run-e2e-1', userId: 'user-e2e-1', acceptedByUserId: 'user-e2e-1', ownerHouseholdRole: 'self', idempotencyKey: 'run-e2e-1:accept:1' },
      acceptDeps,
    );

    expect(acceptance).toEqual({ ok: true, alreadyCompleted: false, insurancePolicyId: 'policy-e2e-1' });
    expect(runRow.status).toBe('completed');
    // The corrected currency (not the originally-extracted, unsupported
    // USD) is what actually reached the canonical row — proof the
    // correction genuinely flowed through revalidation into the write.
    expect(savedRow).toMatchObject({ currency_code: 'AUD', policy_name: 'Acme SecureLife Term Cover', owner: 'self' });
  });
});
