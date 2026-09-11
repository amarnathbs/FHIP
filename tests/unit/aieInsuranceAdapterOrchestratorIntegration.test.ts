/**
 * AIE-1.4 — Insurance adapter: end-to-end orchestrator integration.
 * Drives AIE-1.1 core's real, UNCHANGED `runExtractionPipeline` (no
 * orchestrator modification was needed for this adapter — see parser.ts's
 * header: it registers as a normal global `RegisteredParser`, unlike
 * AIE-1.3's per-request `parserOverride`) with this adapter's real parser +
 * reconciliation rule, using the same `fakeDeps()` pattern
 * `tests/unit/aieOrchestrator.test.ts` / AIE-1.3's own integration test
 * already establish.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runExtractionPipeline, createDefaultDeps, type AieOrchestratorDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { registerInsuranceAdapter } from '@/lib/aie/adapters/insurance';
import { buildInsuranceReconciliationRule } from '@/lib/aie/adapters/insurance/reconciliation';
import { buildAieInsuranceFixtureText, buildAieInsurancePdsFixtureText } from '../support/buildAieInsuranceFixtureText';

function fakeDeps(gateway: AieDocumentAiGateway): { deps: AieOrchestratorDeps; calls: Record<string, unknown[]> } {
  const base = createDefaultDeps(gateway);
  const calls: Record<string, unknown[]> = { unresolvedItems: [], aiAttempts: [], reconciliationRuns: [], maskingSummaries: [] };
  return {
    deps: {
      ...base,
      recordTransition: async () => {},
      recordParserAttempt: async () => {},
      recordMaskingSummary: async (p) => {
        calls.maskingSummaries.push(p);
      },
      persistMaskTokenMap: async () => {},
      recordAiCompletionAttempt: async (p) => {
        calls.aiAttempts.push(p);
        return { id: 'fake-id' };
      },
      recordSchemaValidationResult: async () => {},
      recordFieldCandidates: async () => {},
      recordReconciliationRuns: async (p) => {
        calls.reconciliationRuns.push(p);
      },
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

describe('AIE-1.4 Insurance adapter — end-to-end through AIE-1.1 core orchestrator', () => {
  beforeAll(() => {
    registerInsuranceAdapter();
  });

  it('scenario: clean deterministic policy schedule reaches awaiting_acceptance with ZERO AI calls', async () => {
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true });
    const { deps, calls } = fakeDeps(gateway);

    const outcome = await runExtractionPipeline({
      runId: 'run-1',
      intakeId: 'intake-1',
      userId: 'user-1',
      extractedText: buildAieInsuranceFixtureText(),
      reconcile: buildInsuranceReconciliationRule(),
      deps,
    });

    expect(outcome.finalStatus).toBe('awaiting_acceptance');
    expect(outcome.aiWasUsed).toBe(false);
    expect(calls.aiAttempts.length).toBe(0);
    expect(calls.unresolvedItems.length).toBe(0);
  });

  it('scenario: a Product Disclosure Statement is claimed (insurance-domain signal) but blocked as an unsupported sub-class — a real blocking unresolved item is created, no silent pass-through', async () => {
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true });
    const { deps, calls } = fakeDeps(gateway);

    const outcome = await runExtractionPipeline({
      runId: 'run-2',
      intakeId: 'intake-2',
      userId: 'user-1',
      extractedText: buildAieInsurancePdsFixtureText(),
      reconcile: buildInsuranceReconciliationRule(),
      deps,
    });

    expect(outcome.finalStatus).toBe('unresolved');
    expect(outcome.unresolvedItemIds.length).toBeGreaterThan(0);
    expect(calls.unresolvedItems.length).toBe(1);
    const items = calls.unresolvedItems[0] as { items: { reasonCode: string }[] };
    expect(items.items.some((i) => i.reasonCode.includes('insurance_document_class_supported'))).toBe(true);
  });

  it('AI kill switch (global) leaves the deterministic route fully available — a missing policyName still reaches reconciliation deterministically when AI is globally OFF', async () => {
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [{ fieldName: 'policyNameClarification', value: 'Should never be used', nullReason: null, sourceReferenceId: 'x' }] }) }), {
      isKillSwitchEnabled: () => false, // global AIE_AI_FALLBACK_ENABLED OFF
    });
    const { deps, calls } = fakeDeps(gateway);

    const outcome = await runExtractionPipeline({
      runId: 'run-3',
      intakeId: 'intake-3',
      userId: 'user-1',
      extractedText: buildAieInsuranceFixtureText({ omitFields: ['productName'] }),
      reconcile: buildInsuranceReconciliationRule(),
      deps,
    });

    expect(outcome.aiWasUsed).toBe(true); // the gateway was invoked...
    expect(calls.aiAttempts.length).toBe(0); // ...but blocked before any "attempt" is recorded (kill_switch_blocked)
    // policyName never arrived (deterministic partial + AI blocked) — the
    // required-fields reconciliation rule must fail, not silently ignore it.
    expect(outcome.finalStatus).toBe('unresolved');
  });

  it('a genuinely unrelated document is never claimed at all and produces zero insurance candidates', async () => {
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true });
    const { deps } = fakeDeps(gateway);

    const outcome = await runExtractionPipeline({
      runId: 'run-4',
      intakeId: 'intake-4',
      userId: 'user-1',
      extractedText: 'MONTHLY BANK STATEMENT\nAccount Number: 123456789\nOpening Balance: 1,000.00',
      reconcile: buildInsuranceReconciliationRule(),
      deps,
    });

    expect(outcome.candidates.filter((c) => c.fieldName === 'policyName').length).toBe(0);
  });
});
