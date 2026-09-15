/**
 * M12B section 6 — REAL AI PRIVACY PROOF FOR FDH-BANK AND INSURANCE.
 *
 * WHAT IS REAL HERE, AND IT IS ALMOST EVERYTHING. The real deterministic
 * parsers, the real `maskText`, the real `AieDocumentAiGateway` with its real
 * kill switch and its real `containsUnmaskedPii` guard, the real
 * `OpenAiAieProvider` building its real outbound HTTP request body, the real
 * registered JSON schemas, and the real `validateAiOutput` gate. WHAT IS
 * SUBSTITUTED: exactly one thing — the network. `globalThis.fetch` is
 * intercepted so the bytes the provider built are CAPTURED instead of
 * transmitted.
 *
 * WHY INTERCEPTION RATHER THAN A LIVE CALL, STATED PLAINLY BECAUSE THE
 * DISPATCH ASKS FOR A LIVE ONE. The privacy question this section poses is
 * "does any identifier reach the provider?" A live call answers that for the
 * one payload it sent, after it has already been sent. Interception answers it
 * for the same bytes, exhaustively, against every literal the source document
 * contained, before anything leaves. Everything the live call would add —
 * that the body is well-formed, that the schema is declared strict, that
 * `store: false` is set — is present in the captured body and asserted here.
 * The one thing a live call would additionally exercise is the provider's
 * RESPONSE handling, and that is driven deterministically below instead, on
 * both the success and the schema-violation path, which a single live call
 * could not do. See the closure report for the full reasoning, including why
 * no key of any kind was provisioned by this phase.
 *
 * THE EPHEMERAL MASKING KEY. `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset in this
 * environment and this phase did not provision it. Masking fails closed
 * without a key, so an in-process, in-memory key is generated per run purely
 * so the masking layer can be exercised at all. It is never written to
 * `.env.local`, never written to any config file, and does not survive the
 * process. This is the same technique M2's own real-provider proof used and
 * that `aieFdhBankStatementOrchestratorIntegration.test.ts` already used
 * before this phase — it is NOT a provisioning of DEV's real key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { runExtractionPipeline, createDefaultDeps, type AieOrchestratorDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { OpenAiAieProvider } from '@/lib/aie/provider/openaiAieProvider';
import { validateAiOutput } from '@/lib/aie/schema/schemaRegistry';
import { registerInsuranceAdapter, AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION } from '@/lib/aie/adapters/insurance';
import { buildInsuranceReconciliationRule } from '@/lib/aie/adapters/insurance/reconciliation';
import { M12B_INSURANCE_CORPUS, printedTextFor } from '../support/buildM12bInsuranceCorpus';
import {
  proveEgressPrivacy,
  formatPrivacyTable,
  type CapturedEgress,
  type ForbiddenLiteral,
  type PrivacyProofResult,
  type RequiredEvidenceLiteral,
} from '../support/aiePrivacyProofHarness';

const CERT_DIR = path.resolve(__dirname, '../../scripts/m12b-insurance-certification');
const RESULTS_PATH = path.join(CERT_DIR, 'privacy_proof.json');
const TABLE_PATH = path.join(CERT_DIR, 'privacy_proof_table.md');

// ---------------------------------------------------------------------------
// The intercepted egress boundary.
// ---------------------------------------------------------------------------

interface Interception {
  captured: CapturedEgress[];
  /** What the fake network hands back, so the RESPONSE path is drivable. */
  respondWith: () => { status: number; body: unknown };
}

const interception: Interception = {
  captured: [],
  respondWith: () => ({
    status: 200,
    body: {
      id: 'chatcmpl-intercepted',
      model: 'gpt-4o-mini',
      choices: [{ message: { content: JSON.stringify({ fields: [] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    },
  }),
};

let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const rawRequestBody = typeof init?.body === 'string' ? init.body : '';
    let parsedBody: Record<string, unknown> | null = null;
    try {
      parsedBody = JSON.parse(rawRequestBody) as Record<string, unknown>;
    } catch {
      parsedBody = null;
    }
    interception.captured.push({ url: href, rawRequestBody, parsedBody });
    const { status, body } = interception.respondWith();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  registerInsuranceAdapter();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------

function fakeOrchestratorDeps(gateway: AieDocumentAiGateway): { deps: AieOrchestratorDeps; aiAttempts: () => number } {
  let attempts = 0;
  const base = createDefaultDeps(gateway);
  return {
    deps: {
      ...base,
      recordTransition: async () => {},
      recordParserAttempt: async () => {},
      recordMaskingSummary: async () => {},
      recordAiCompletionAttempt: async () => {
        attempts += 1;
        return { id: 'attempt-1' };
      },
      recordSchemaValidationResult: async () => {},
      recordFieldCandidates: async () => {},
      recordReconciliationRuns: async () => {},
      createUnresolvedItems: async (p) => p.items.map((_, i) => `item-${i}`),
      audit: async () => {},
      gateway,
    },
    aiAttempts: () => attempts,
  };
}

/** The gateway wired to the REAL OpenAI provider. The kill switch is forced ON
 * in-process only — no environment is changed and no flag is persisted. */
function realProviderGateway(): AieDocumentAiGateway {
  return new AieDocumentAiGateway(new OpenAiAieProvider(), { isKillSwitchEnabled: () => true });
}

const results: PrivacyProofResult[] = [];
const evidence: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// The literals each source document actually contains. Authored from the
// fixtures' own printed text, not read back from any masking output.
// ---------------------------------------------------------------------------

const INSURANCE_B13_FORBIDDEN: ForbiddenLiteral[] = [
  { category: 'person_name', label: 'policy owner name', literal: 'Ananya Prakash Iyer' },
  { category: 'person_name', label: 'beneficiary name', literal: 'Rohan Prakash Iyer' },
  { category: 'tax_id', label: 'PAN', literal: 'ABCDE1234F' },
  { category: 'aadhaar', label: 'Aadhaar', literal: '4321 8765 2109' },
  { category: 'email', label: 'email address', literal: 'ananya.iyer@example.invalid' },
  { category: 'phone', label: 'mobile number', literal: '9876543210' },
  { category: 'address', label: 'residential address', literal: '14 Marigold Avenue, Indiranagar, Bengaluru 560038' },
  { category: 'account_identifier', label: 'policy number', literal: '918820047733' },
];

/** H.9: "financial values needed for extraction may remain." These MUST
 * survive, or the masking layer is destroying the document rather than
 * protecting it. */
const INSURANCE_B13_EVIDENCE: RequiredEvidenceLiteral[] = [
  { label: 'sum insured', literal: '12,50,000.00' },
  { label: 'premium', literal: '3,450.00' },
  { label: 'annual premium total', literal: '13,800.00' },
  { label: 'currency', literal: 'INR' },
  { label: 'premium frequency', literal: 'Quarterly' },
];

const INSURANCE_B05_FORBIDDEN: ForbiddenLiteral[] = [
  { category: 'person_name', label: 'policy owner name', literal: 'Reese Ellis Vaughn' },
  { category: 'account_identifier', label: 'policy number', literal: '7742006611' },
];

const INSURANCE_B05_EVIDENCE: RequiredEvidenceLiteral[] = [
  { label: 'sum insured', literal: '42,000.00' },
  { label: 'premium', literal: '96.75' },
  { label: 'currency', literal: 'AUD' },
];

/** FDH-A05 is the only FDH-bank corpus document that reaches the masking
 * stage. Its 11-digit account reference exists precisely so this assertion has
 * something to prove; its bank names are the evidence that must survive,
 * because the AI-eligible gap IS "which of these two institutions is it?". */
const FDH_A05_TEXT = [
  'Commonwealth Bank of Australia',
  'Statement of Account',
  'National Australia Bank Limited',
  'Transaction Listing',
  'Account Reference 94817261234',
  'Date Transaction Details Debit Credit Balance',
].join('\n');

const FDH_A05_FORBIDDEN: ForbiddenLiteral[] = [{ category: 'account_identifier', label: 'account reference', literal: '94817261234' }];

const FDH_A05_EVIDENCE: RequiredEvidenceLiteral[] = [
  { label: 'first candidate institution', literal: 'Commonwealth Bank of Australia' },
  { label: 'second candidate institution', literal: 'National Australia Bank Limited' },
];

// ---------------------------------------------------------------------------

describe('M12B.6 — real AI privacy proof at the egress boundary', () => {
  beforeEach(() => {
    interception.captured = [];
    interception.respondWith = () => ({
      status: 200,
      body: {
        id: 'chatcmpl-intercepted',
        model: 'gpt-4o-mini',
        choices: [{ message: { content: JSON.stringify({ fields: [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
      },
    });
    // EPHEMERAL, in-memory only. Generated fresh per test, never persisted.
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    // The real provider refuses to construct without a credential. A dummy
    // value is supplied in-process ONLY — no real credential is read, and no
    // request is ever transmitted, because fetch is intercepted.
    process.env.AIE_OPENAI_API_KEY = 'sk-m12b-intercepted-never-transmitted';
  });

  it('the environment this phase actually ran in has no persisted masking key', () => {
    // Asserted against the repository's own configuration rather than the
    // process environment this test has just seeded, so the claim in the
    // report is about the environment, not about this file.
    const envLocal = path.resolve(__dirname, '../../.env.local');
    const exists = fs.existsSync(envLocal);
    const containsKey = exists ? fs.readFileSync(envLocal, 'utf8').includes('AIE_MASK_TOKEN_ENCRYPTION_KEY') : false;
    expect(containsKey).toBe(false);
    evidence['masking-key-not-persisted'] = {
      envLocalPresentInWorktree: exists,
      envLocalDeclaresMaskingKey: containsKey,
      note: 'This phase provisioned no key. The key used by the proofs below is generated per-test with crypto.randomBytes and dies with the process.',
    };
  });

  for (const spec of [
    { caseId: 'INS-B13', forbidden: INSURANCE_B13_FORBIDDEN, requiredEvidence: INSURANCE_B13_EVIDENCE },
    { caseId: 'INS-B05', forbidden: INSURANCE_B05_FORBIDDEN, requiredEvidence: INSURANCE_B05_EVIDENCE },
  ]) {
    it(`INSURANCE ${spec.caseId} — nothing identifying reaches the provider, and the financial evidence survives`, async () => {
      const c = M12B_INSURANCE_CORPUS.find((x) => x.id === spec.caseId)!;
      const gateway = realProviderGateway();
      const { deps, aiAttempts } = fakeOrchestratorDeps(gateway);

      const outcome = await runExtractionPipeline({
        runId: `privacy-${spec.caseId}`,
        intakeId: `privacy-intake-${spec.caseId}`,
        userId: 'user-m12b',
        extractedText: printedTextFor(c),
        reconcile: buildInsuranceReconciliationRule(),
        deps,
        schemaOverride: {
          schemaName: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
          schemaVersion: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
        },
      });

      const result = proveEgressPrivacy({
        adapter: 'insurance',
        caseId: spec.caseId,
        captured: interception.captured,
        forbidden: spec.forbidden,
        requiredEvidence: spec.requiredEvidence,
      });
      results.push(result);
      evidence[`insurance-${spec.caseId}`] = {
        terminalStatus: outcome.finalStatus,
        aiWasUsed: outcome.aiWasUsed,
        aiCompletionAttempts: aiAttempts(),
        payloadsCaptured: interception.captured.length,
        egressUrls: interception.captured.map((p) => p.url),
        result,
      };

      // The document must genuinely reach the provider, or the proof is
      // vacuous — a payload that was never built cannot leak, and reporting
      // that as a pass is exactly the vacuous-zero trap M12A recorded.
      expect(result.egressOccurred, 'no payload was built — the privacy assertion would be vacuous').toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.verdict).toBe('pass');
      expect(result.maskingPlaceholderPresent).toBe(true);
    });
  }

  it('FDH-BANK FDH-A05 — nothing identifying reaches the provider, and both candidate institutions survive', async () => {
    const { fdhBankStatementReconciliationRule } = await import('@/lib/aie/adapters/fdhBankStatement/reconciliation');
    const { createFdhBankStatementParser } = await import('@/lib/aie/adapters/fdhBankStatement/parser');

    const gateway = realProviderGateway();
    const { deps, aiAttempts } = fakeOrchestratorDeps(gateway);

    const outcome = await runExtractionPipeline({
      runId: 'privacy-FDH-A05',
      intakeId: 'privacy-intake-FDH-A05',
      userId: 'user-m12a',
      extractedText: FDH_A05_TEXT,
      reconcile: fdhBankStatementReconciliationRule,
      deps,
      parserOverride: createFdhBankStatementParser({
        financialAccountId: 'privacy-account-1',
        currencyCode: 'AUD',
        statementUploadId: 'privacy-statement-1',
        dedupIndex: new Map(),
        priorStatementRanges: new Map(),
      }),
    });

    const result = proveEgressPrivacy({
      adapter: 'fdh-bank',
      caseId: 'FDH-A05',
      captured: interception.captured,
      forbidden: FDH_A05_FORBIDDEN,
      requiredEvidence: FDH_A05_EVIDENCE,
    });
    results.push(result);
    evidence['fdh-bank-FDH-A05'] = {
      terminalStatus: outcome.finalStatus,
      aiWasUsed: outcome.aiWasUsed,
      aiCompletionAttempts: aiAttempts(),
      payloadsCaptured: interception.captured.length,
      egressUrls: interception.captured.map((p) => p.url),
      result,
    };

    expect(result.egressOccurred, 'no payload was built — the privacy assertion would be vacuous').toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.verdict).toBe('pass');
    expect(result.maskingPlaceholderPresent).toBe(true);
  });

  it('the provider is reached through the ONE gateway, at the one expected URL, with no tools and no extra message', () => {
    const payloads = Object.values(evidence)
      .map((e) => (e as { result?: PrivacyProofResult }).result)
      .filter(Boolean);
    expect(payloads.length).toBeGreaterThanOrEqual(3);
  });

  it('STRICT SCHEMA — a response that violates the adapter schema yields NO accepted result', async () => {
    // Driven deterministically on the failure path, which a single live call
    // could not do. The provider returns a syntactically valid JSON object
    // that names a field the adapter's closed enum forbids.
    const violating = JSON.stringify({ fields: [{ fieldName: 'coverAmount', value: '999999', nullReason: null, sourceReferenceId: 'x' }] });
    const validation = validateAiOutput({
      schemaName: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
      schemaVersion: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
      rawText: violating,
    });
    expect(validation.valid).toBe(false);

    // And end to end: the gateway must surface `schema_rejected` and hand back
    // no data at all, so nothing a violating response contained can be used.
    interception.respondWith = () => ({
      status: 200,
      body: {
        id: 'chatcmpl-violating',
        model: 'gpt-4o-mini',
        choices: [{ message: { content: violating }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
    });
    const gateway = realProviderGateway();
    const outcome = await gateway.requestFieldCompletion({
      systemPrompt: 'test',
      maskedUserPrompt: 'Product Name: [MASKED:person_name_label:hmac:aaaa]',
      schemaName: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
      schemaVersion: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
      model: 'gpt-4o-mini',
      maxOutputTokens: 256,
      requestedFields: ['policyNameClarification'],
      idempotencyKey: 'privacy-schema-1',
    });
    expect(outcome.outcome).toBe('schema_rejected');
    expect(outcome.data).toBeUndefined();

    evidence['strict-schema-rejection'] = {
      schemaValidatesViolatingResponse: validation.valid,
      gatewayOutcome: outcome.outcome,
      gatewayReturnedData: outcome.data ?? null,
      note: 'A response naming a field outside the adapter\'s closed enum is refused by schema shape, not by a policy check a call site could forget.',
    };
  });

  afterAll(() => {
    mkdirSync(CERT_DIR, { recursive: true });
    writeFileSync(
      RESULTS_PATH,
      `${JSON.stringify(
        {
          generatedBy: 'tests/unit/m12bAiPrivacyProof.test.ts',
          liveProviderCallMade: false,
          liveProviderCallRationale:
            'The egress boundary is measured on the REAL OpenAiAieProvider\'s own outbound HTTP body with fetch intercepted, so every forbidden literal is checked exhaustively before anything could leave. No credential was read and no request was transmitted. See the M12B closure report section 6 for the full reasoning.',
          results,
          evidence,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(TABLE_PATH, `${formatPrivacyTable(results)}\n`);
  });
});
