/**
 * AIE-1.3 — FDH bank-statement adapter: end-to-end orchestrator integration
 * (AIE13-AI-03/04, AIE13-RECON-08, non-negotiable prohibitions on raw PII
 * reaching a provider and on accepting a failed/indeterminate
 * reconciliation). Drives AIE-1.1 core's real, UNCHANGED
 * `runExtractionPipeline` (via the new, additive `parserOverride` field —
 * see `lib/aie/orchestrator.ts`'s own doc comment) with this adapter's real
 * parser + reconciliation rule, using the same `fakeDeps()` pattern
 * `tests/unit/aieOrchestrator.test.ts` already established.
 */
import { describe, it, expect } from 'vitest';
import { buildBankPdfFixture } from '../support/buildBankPdfFixture';
import { classifyPdf } from '@/lib/financial-data-hub/bank-pdf/classification';
import { runExtractionPipeline, createDefaultDeps, type AieOrchestratorDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { createFdhBankStatementParser } from '@/lib/aie/adapters/fdhBankStatement/parser';
import { fdhBankStatementReconciliationRule } from '@/lib/aie/adapters/fdhBankStatement/reconciliation';

async function extractedTextFor(bytes: Buffer): Promise<string> {
  const classified = await classifyPdf(bytes);
  return (classified.pages ?? []).join('\n');
}

function freshCtx() {
  return {
    financialAccountId: 'test-account-1',
    currencyCode: 'AUD',
    statementUploadId: 'test-statement-1',
    dedupIndex: new Map(),
    priorStatementRanges: new Map(),
  };
}

function fakeDeps(gateway: AieDocumentAiGateway): { deps: AieOrchestratorDeps; calls: Record<string, unknown[]> } {
  const base = createDefaultDeps(gateway);
  const calls: Record<string, unknown[]> = { unresolvedItems: [], aiAttempts: [], reconciliationRuns: [] };
  return {
    deps: {
      ...base,
      recordTransition: async () => {},
      recordParserAttempt: async () => {},
      recordMaskingSummary: async () => {},
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

describe('AIE-1.3 FDH bank-statement adapter — end-to-end through AIE-1.1 core orchestrator', () => {
  it('scenario 1: deterministic-complete CBA statement reaches awaiting_acceptance with ZERO AI calls', async () => {
    const pdf = buildBankPdfFixture({
      brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
      columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
      transactions: [{ date: '1 Aug 2026', description: 'CARD PURCHASE WOOLWORTHS 1234', amount: '45.20 DR', balance: '954.80' }],
    });
    const text = await extractedTextFor(pdf);
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true });
    const { deps, calls } = fakeDeps(gateway);
    const parser = createFdhBankStatementParser(freshCtx());

    const outcome = await runExtractionPipeline({
      runId: 'run-1',
      intakeId: 'intake-1',
      userId: 'user-1',
      extractedText: text,
      parserOverride: parser,
      reconcile: fdhBankStatementReconciliationRule,
      deps,
    });

    expect(outcome.finalStatus).toBe('awaiting_acceptance');
    expect(outcome.aiWasUsed).toBe(false);
    expect(calls.aiAttempts.length).toBe(0);
    expect(calls.unresolvedItems.length).toBe(0);
  });

  it('failed balance reconciliation blocks the run at "unresolved" and never reaches awaiting_acceptance', async () => {
    // Seeded schema-valid wrong balance (AIE13-RECON-12): the printed
    // running balance does not match opening + signed activity.
    const pdf = buildBankPdfFixture({
      brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
      columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
      transactions: [
        { date: '1 Aug 2026', description: 'CARD PURCHASE A', amount: '10.00 DR', balance: '990.00' },
        { date: '2 Aug 2026', description: 'CARD PURCHASE B', amount: '10.00 DR', balance: '9999.00' }, // break
      ],
    });
    const text = await extractedTextFor(pdf);
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true });
    const { deps, calls } = fakeDeps(gateway);
    const parser = createFdhBankStatementParser(freshCtx());

    const outcome = await runExtractionPipeline({
      runId: 'run-2',
      intakeId: 'intake-2',
      userId: 'user-1',
      extractedText: text,
      parserOverride: parser,
      reconcile: fdhBankStatementReconciliationRule,
      deps,
    });

    expect(outcome.finalStatus).toBe('unresolved');
    expect(calls.unresolvedItems.length).toBe(1);
  });

  it('ambiguous layout: masked institution-hint prompt sent to the (mock) provider never carries the raw statement text, and the AI response can never itself cause acceptance', async () => {
    const rawSecretMarker = '94817261234'; // an 11+ digit run — matches AIE-1.1's own `long_digit_run` PII pattern
    const text = [
      'Commonwealth Bank of Australia',
      'Statement of Account',
      'National Australia Bank Limited',
      'Transaction Listing',
      `Account Reference ${rawSecretMarker}`,
      'Date Transaction Details Debit Credit Balance',
    ].join('\n');

    let capturedPrompt = '';
    const gateway = new AieDocumentAiGateway(
      new MockAieProvider({
        respond: (req) => {
          capturedPrompt = req.userPrompt;
          return JSON.stringify({ fields: [] });
        },
      }),
      { isKillSwitchEnabled: () => true },
    );
    const { deps, calls } = fakeDeps(gateway);
    const parser = createFdhBankStatementParser(freshCtx());

    const outcome = await runExtractionPipeline({
      runId: 'run-3',
      intakeId: 'intake-3',
      userId: 'user-1',
      extractedText: text,
      parserOverride: parser,
      reconcile: fdhBankStatementReconciliationRule,
      deps,
    });

    // The AI stage genuinely ran (this is the one case this adapter ever
    // declares AI-eligible).
    expect(outcome.aiWasUsed).toBe(true);
    expect(calls.aiAttempts.length).toBe(1);
    // P1: the exact sensitive marker must never appear in what was actually
    // sent to the (mock) provider.
    expect(capturedPrompt).not.toContain(rawSecretMarker);
    // AIE13-AI-10 / P4: even though the mock "AI" returned an empty field
    // list (never invents a value), an ambiguous layout is STILL blocked —
    // it can never reach awaiting_acceptance regardless of what any AI
    // response contains.
    expect(outcome.finalStatus).toBe('unresolved');
    expect(calls.unresolvedItems.length).toBe(1);
  });

  it('AI fallback kill switch OFF (the real production-safe default): ambiguous layout still blocks, with zero genuine provider attempts recorded', async () => {
    const text = [
      'Commonwealth Bank of Australia',
      'Statement of Account',
      'National Australia Bank Limited',
      'Transaction Listing',
      'Date Transaction Details Debit Credit Balance',
    ].join('\n');
    const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => false });
    const { deps, calls } = fakeDeps(gateway);
    const parser = createFdhBankStatementParser(freshCtx());

    const outcome = await runExtractionPipeline({
      runId: 'run-4',
      intakeId: 'intake-4',
      userId: 'user-1',
      extractedText: text,
      parserOverride: parser,
      reconcile: fdhBankStatementReconciliationRule,
      deps,
    });

    // `aiWasUsed` is set once the AI stage is entered at all (even when the
    // kill switch blocks the actual call) — see `lib/aie/orchestrator.ts`.
    // The genuine signal that nothing left the process is
    // `calls.aiAttempts`, which stays empty (kill_switch_blocked never
    // records a completion attempt — see orchestrator.ts's own comment).
    expect(calls.aiAttempts.length).toBe(0);
    expect(outcome.finalStatus).toBe('unresolved');
  });
});
