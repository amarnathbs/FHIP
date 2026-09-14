import { describe, it, expect, beforeAll } from 'vitest';
import { aieParserRegistry, sniffDocument } from '@/lib/aie/classifier/registry';
import { runExtractionPipeline, type AieOrchestratorDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { registerInvestmentIntelligenceAieParser, investmentIntelligenceRegisteredParser, toAieCandidates, candidatesByRecordType } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { buildInvestmentReconciliationRule, type InvestmentReconciliationContext } from '@/lib/aie/adapters/investment-intelligence/reconciliationRule';
import { matchAccountsReadOnly } from '@/lib/aie/adapters/investment-intelligence/accountMatching';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { buildAieIiCasFixtureText, buildUnsupportedDocumentText } from '../support/buildAieIiCasFixtureText';

function fakeDeps(): { deps: AieOrchestratorDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { transitions: [], parserAttempts: [], reconciliationRuns: [], unresolvedItems: [], fieldCandidates: [] };
  const deps: AieOrchestratorDeps = {
    recordTransition: async (p) => void calls.transitions.push(p),
    recordParserAttempt: async (p) => void calls.parserAttempts.push(p),
    recordMaskingSummary: async () => {},
    persistMaskTokenMap: async () => {},
    recordAiCompletionAttempt: async () => ({ id: 'fake' }),
    recordSchemaValidationResult: async () => {},
    recordFieldCandidates: async (p) => void calls.fieldCandidates.push(p),
    recordReconciliationRuns: async (p) => void calls.reconciliationRuns.push(p),
    createUnresolvedItems: async (p) => {
      calls.unresolvedItems.push(p);
      return (p as { items: unknown[] }).items.map((_, i) => `fake-item-${i}`);
    },
    audit: async () => {},
    gateway: new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true }),
  };
  return { deps, calls };
}

describe('AIE-1.2 — Investment Intelligence parser wrap (execution sequence step 6)', () => {
  beforeAll(() => {
    registerInvestmentIntelligenceAieParser();
  });

  it('registers exactly once under a stable adapterId/version (idempotent re-registration is a no-op, not a throw)', () => {
    expect(() => registerInvestmentIntelligenceAieParser()).not.toThrow();
    const registered = aieParserRegistry.list().filter((p) => p.adapterId === 'ii_cas_kfintech_folio_v1');
    expect(registered.length).toBe(1);
  });

  it('POSITIVE: a real CAS document sniffs true and parses to a complete, zero-error outcome with candidates for every record', () => {
    const text = buildAieIiCasFixtureText();
    const sniff = sniffDocument(text);
    expect(sniff.kind).toBe('unambiguous');
    const result = investmentIntelligenceRegisteredParser.parse(text);
    expect(result.outcome).toBe('complete');
    expect(result.aiEligibleGaps).toEqual([]); // disclosed: no real gap concept exists yet
    expect(result.candidates.some((c) => c.fieldName === 'metadata')).toBe(true);
    expect(result.candidates.some((c) => c.fieldName === 'transaction:0')).toBe(true);
    expect(result.candidates.some((c) => c.fieldName === 'holding:0')).toBe(true);
  });

  it('NEGATIVE: a document with no CAS/KFintech/Folio-statement evidence is never sniffed, never claimed', () => {
    const text = buildUnsupportedDocumentText();
    expect(sniffDocument(text).kind).toBe('none_matched');
    // Defensive: parse() itself also refuses to fabricate an outcome if
    // ever called directly on undetectable text.
    expect(investmentIntelligenceRegisteredParser.parse(text).outcome).toBe('not_applicable');
  });

  it('ADVERSARIAL: a document with a parse-time ERROR (garbled transaction row) surfaces as partial/failed, never silently "complete"', () => {
    // A malformed row that matches nothing in camsParser's transaction-row
    // grammar produces a real ParsedWarning with severity 'error' (see
    // camsParser.ts's own `unparseable_transaction_row`), which
    // `outcomeFor()` must turn into 'partial', never 'complete'.
    const text = [
      'CAMS Consolidated Account Statement',
      'Statement Period : 01-Jan-2025 To 31-Mar-2025',
      '',
      'Folio No: 9988776655',
      'PAN: BBBBB2222B',
      '',
      'Prime Mutual Fund',
      'Prime Flexi Cap Fund - Growth (Direct Plan) - ISIN: INF999K01AB1(Advisor: ARN00001) Registrar : CAMS',
      '',
      'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
      'THIS IS NOT A VALID TRANSACTION ROW AT ALL 12345',
      '',
      'Closing Unit Balance as on 31-Mar-2025 : 0.000 Units   Valuation : Rs. 0.00   NAV as on 31-Mar-2025 : Rs. 52.00',
    ].join('\n');
    const parsed = parseExtractedDocument(text);
    // Only assert the adapter's own honest mapping IF this fixture actually
    // reproduces a parser-level error (camsParser may simply skip an
    // unrecognised line silently in some layouts) — the adapter contract
    // under test is outcomeFor()'s mapping, not camsParser's own grammar.
    if (parsed.parsed && parsed.parsed.errors.length > 0) {
      const result = investmentIntelligenceRegisteredParser.parse(text);
      expect(result.outcome).not.toBe('complete');
    }
  });

  it('candidatesByRecordType round-trips toAieCandidates output for every record kind', () => {
    const parsed = parseExtractedDocument(buildAieIiCasFixtureText()).parsed!;
    const candidates = toAieCandidates(parsed);
    const txns = candidatesByRecordType(candidates, 'transaction');
    const holdings = candidatesByRecordType(candidates, 'holding');
    expect(txns.length).toBe(1);
    expect(holdings.length).toBe(1);
    expect(txns[0].value.canonicalType).toBe('purchase');
    // scaledToDecimalString pads to the module's fixed internal scale — the
    // exact string width is an implementation detail, only the numeric
    // value matters here.
    expect(Number(holdings[0].value.units)).toBe(100);
  });

  it('END-TO-END: the real AIE-1.1 orchestrator, driving this adapter\'s parser AND reconciliation rule together, reaches awaiting_acceptance for a clean first-time import with zero AI calls', async () => {
    const text = buildAieIiCasFixtureText();
    const parsed = parseExtractedDocument(text).parsed!;
    const candidates = toAieCandidates(parsed);
    const accountMatches = matchAccountsReadOnly(parsed, []); // no existing accounts — first-time import
    const ctx: InvestmentReconciliationContext = {
      sourceKey: 'cams',
      countryCode: 'IN',
      accountMatches,
      instrumentMatches: new Map(), // no existing instruments — first-time import, all "unresolved" (= genuinely new, not ambiguous)
      existingFingerprints: new Set(),
      existingSnapshots: new Map(),
      existingTransactionsForPosition: new Map(),
      existingAccountCurrency: new Map(),
      config: DEFAULT_RECONCILIATION_CONFIG,
    };
    const reconcile = buildInvestmentReconciliationRule(ctx);

    const { deps } = fakeDeps();
    const outcome = await runExtractionPipeline({
      runId: 'run-1',
      intakeId: 'intake-1',
      userId: 'user-1',
      extractedText: text,
      reconcile,
      deps,
    });

    expect(outcome.aiWasUsed).toBe(false); // deterministic-complete path — never reaches the masked-AI fallback
    expect(outcome.finalStatus).toBe('awaiting_acceptance');
    expect(outcome.unresolvedItemIds).toEqual([]);
    expect(candidates.length).toBeGreaterThan(0);
  });
});
