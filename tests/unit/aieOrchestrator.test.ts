import { describe, it, expect, beforeAll } from 'vitest';
import { runExtractionPipeline, type AieOrchestratorDeps } from '@/lib/aie/orchestrator';
import { aieParserRegistry } from '@/lib/aie/classifier/registry';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import type { AieFieldCandidate, AieReconciliationRunResult } from '@/lib/aie/types';

function fakeDeps(overrides: Partial<AieOrchestratorDeps> = {}): { deps: AieOrchestratorDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    transitions: [],
    parserAttempts: [],
    maskingSummaries: [],
    tokenMaps: [],
    aiAttempts: [],
    schemaResults: [],
    fieldCandidates: [],
    reconciliationRuns: [],
    unresolvedItems: [],
    audits: [],
  };
  const deps: AieOrchestratorDeps = {
    recordTransition: async (p) => {
      calls.transitions.push(p);
    },
    recordParserAttempt: async (p) => {
      calls.parserAttempts.push(p);
    },
    recordMaskingSummary: async (p) => {
      calls.maskingSummaries.push(p);
    },
    persistMaskTokenMap: async (p) => {
      calls.tokenMaps.push(p);
    },
    recordAiCompletionAttempt: async (p) => {
      calls.aiAttempts.push(p);
      return { id: 'fake-attempt-id' };
    },
    recordSchemaValidationResult: async (p) => {
      calls.schemaResults.push(p);
    },
    recordFieldCandidates: async (p) => {
      calls.fieldCandidates.push(p);
    },
    recordReconciliationRuns: async (p) => {
      calls.reconciliationRuns.push(p);
    },
    createUnresolvedItems: async (p) => {
      calls.unresolvedItems.push(p);
      return p.items.map((_, i) => `fake-item-${i}`);
    },
    audit: async (e) => {
      calls.audits.push(e);
    },
    gateway: new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true }),
    ...overrides,
  };
  return { deps, calls };
}

describe('AIE-1.1 orchestrator — the pipeline route (architecture steps 4-11)', () => {
  beforeAll(() => {
    aieParserRegistry.register({
      adapterId: 'test_complete_parser',
      version: '1',
      moduleHint: 'other',
      sniff: (text) => text.includes('COMPLETE_MARKER'),
      parse: () => ({
        outcome: 'complete',
        documentClass: 'test_doc',
        candidates: [{ fieldName: 'total', valueRaw: '100.00', isNull: false, sourceMethod: 'deterministic' }],
        aiEligibleGaps: [],
      }),
    });
    aieParserRegistry.register({
      adapterId: 'test_partial_parser',
      version: '1',
      moduleHint: 'other',
      sniff: (text) => text.includes('PARTIAL_MARKER'),
      parse: () => ({
        outcome: 'partial',
        documentClass: 'test_doc',
        candidates: [{ fieldName: 'total', valueRaw: '100.00', isNull: false, sourceMethod: 'deterministic' }],
        aiEligibleGaps: ['account_number'],
      }),
    });
  });

  it('deterministic-complete path: reaches awaiting_acceptance with ZERO AI attempts (AIE11-DEV-01: "prove zero provider calls")', async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await runExtractionPipeline({
      runId: 'run-1',
      intakeId: 'intake-1',
      userId: 'user-1',
      extractedText: 'COMPLETE_MARKER some statement text',
      reconcile: () => [{ ruleId: 'r1', ruleVersion: '1', outcome: 'pass' }],
      deps,
    });
    expect(outcome.finalStatus).toBe('awaiting_acceptance');
    expect(outcome.aiWasUsed).toBe(false);
    expect(calls.aiAttempts.length).toBe(0);
    expect(calls.maskingSummaries.length).toBe(0);
  });

  it('deterministic-partial path with an AI-eligible gap: masks BEFORE calling the gateway and the payload the gateway sees carries no seeded PII', async () => {
    let seenPrompt = '';
    const provider = new MockAieProvider({
      respond: (req) => {
        seenPrompt = req.userPrompt;
        return JSON.stringify({ fields: [{ fieldName: 'account_number', value: '999', nullReason: null, sourceReferenceId: 'p1' }] });
      },
    });
    const { deps, calls } = fakeDeps({ gateway: new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true }) });
    const seededPan = 'ABCDE1234F';
    const outcome = await runExtractionPipeline({
      runId: 'run-2',
      intakeId: 'intake-2',
      userId: 'user-1',
      extractedText: `PARTIAL_MARKER account holder PAN: ${seededPan}`,
      reconcile: () => [{ ruleId: 'r1', ruleVersion: '1', outcome: 'pass' }],
      deps,
    });
    expect(outcome.aiWasUsed).toBe(true);
    expect(seenPrompt).not.toContain(seededPan); // PII canary: never reaches the "provider"
    expect(calls.tokenMaps.length).toBe(1); // reversible map persisted for the masked PAN
    expect(outcome.finalStatus).toBe('awaiting_acceptance');
    expect(outcome.candidates.some((c) => c.fieldName === 'account_number' && c.valueRaw === '999')).toBe(true);
  });

  it('kill-switch-blocked AI fallback still proceeds to reconciliation using only deterministic candidates', async () => {
    const { deps, calls } = fakeDeps({ gateway: new AieDocumentAiGateway(new MockAieProvider({ respond: () => '{}' }), { isKillSwitchEnabled: () => false }) });
    const outcome = await runExtractionPipeline({
      runId: 'run-3',
      intakeId: 'intake-3',
      userId: 'user-1',
      extractedText: 'PARTIAL_MARKER no PII here',
      reconcile: (req) => [{ ruleId: 'r1', ruleVersion: '1', outcome: req.candidates.length > 0 ? 'pass' : 'indeterminate' }],
      deps,
    });
    expect(calls.audits.some((a) => (a as { eventType: string }).eventType === 'ai_fallback_kill_switch_blocked')).toBe(true);
    expect(outcome.finalStatus).toBe('awaiting_acceptance'); // deterministic candidate alone is enough to pass the injected rule
  });

  it('P4: a FAIL reconciliation outcome always produces a blocking unresolved item and the run stops at "unresolved", never awaiting_acceptance', async () => {
    const { deps, calls } = fakeDeps();
    const reconcile = (): AieReconciliationRunResult[] => [{ ruleId: 'balance_check', ruleVersion: '1', outcome: 'fail', delta: 500 }];
    const outcome = await runExtractionPipeline({
      runId: 'run-4',
      intakeId: 'intake-4',
      userId: 'user-1',
      extractedText: 'COMPLETE_MARKER text',
      reconcile,
      deps,
    });
    expect(outcome.finalStatus).toBe('unresolved');
    expect(outcome.unresolvedItemIds.length).toBe(1);
    expect(calls.unresolvedItems.length).toBe(1);
  });

  it('P4: an INDETERMINATE reconciliation outcome is also blocking, not treated as an acceptable pass', async () => {
    const { deps } = fakeDeps();
    const outcome = await runExtractionPipeline({
      runId: 'run-5',
      intakeId: 'intake-5',
      userId: 'user-1',
      extractedText: 'COMPLETE_MARKER text',
      reconcile: () => [{ ruleId: 'r1', ruleVersion: '1', outcome: 'indeterminate' }],
      deps,
    });
    expect(outcome.finalStatus).toBe('unresolved');
  });

  it('a schema-rejected AI response still proceeds to reconciliation with only deterministic candidates, never fabricating AI data', async () => {
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ wrongShape: true }) });
    const { deps } = fakeDeps({ gateway: new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true }) });
    const outcome = await runExtractionPipeline({
      runId: 'run-6',
      intakeId: 'intake-6',
      userId: 'user-1',
      extractedText: 'PARTIAL_MARKER text',
      reconcile: () => [{ ruleId: 'r1', ruleVersion: '1', outcome: 'pass' }],
      deps,
    });
    expect(outcome.candidates.every((c: AieFieldCandidate) => c.sourceMethod !== 'ai')).toBe(true);
    expect(outcome.finalStatus).toBe('awaiting_acceptance');
  });
});
