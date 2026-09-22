/**
 * Investment Intelligence AI-fallback adapter — REAL OpenAI provider proof,
 * through the REAL code path (schema, prompt, gateway). Mirrors
 * `tests/live-dev/aiePayslipAdapterLiveProviderProof.live.test.ts`'s own
 * established pattern exactly, for this adapter's own schema.
 *
 * WHY THIS TEST EXISTS. A 2026-09-22 live-DEV proof (built while live-proving
 * the payslip adapter) found that `investmentDocumentFactsSchema` — the
 * schema `lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts`
 * actually validates against, the ONE II AI-fallback mechanism reachable
 * from live UI today — had NEVER been registered in
 * `lib/aie/provider/openaiJsonSchema.ts`'s `KNOWN_SCHEMAS`, so every real
 * call failed with `outcome: 'provider_error'` before returning any data.
 * See that file's 2026-09-22 comment for the full disclosure. This test
 * proves the fix (`investment-intelligence/openaiSchema.ts` +
 * its `KNOWN_SCHEMAS` registration): a real call now gets PAST
 * `provider_error` into a genuine `success`/`schema_rejected`/`refused`
 * outcome.
 *
 * OPT-IN ONLY. Skipped unless `AIE_II_LIVE_PROVIDER_PROOF=1`, because it
 * spends real money against the configured OpenAI project (a handful of
 * tokens; sub-cent). Requires `AIE_AI_PROVIDER=openai` and a real
 * `AIE_OPENAI_API_KEY` in the environment (`.env.local`) — the key is never
 * printed, only its presence asserted.
 *
 * SCOPE, DISCLOSED. Exactly like the payslip live proof, this constructs its
 * OWN `AieDocumentAiGateway` with `isKillSwitchEnabled: () => true` and NO
 * `costAdmission` option, rather than importing
 * `aiFallbackDocumentExtraction.ts`'s own module-level singleton gateway
 * (which wires the real `reserveConservativeAiCost`/`settleAiCost`, requiring
 * the migration-0152 cost-ledger tables — unverified for this specific DEV
 * project as part of this dispatch, and orthogonal to what this test exists
 * to prove). This proof demonstrates the thing that is actually new here —
 * this schema now correctly round-trips through the real provider — not the
 * shared cost-admission plumbing, already separately proven by
 * `aieM2RealProviderProof.live.test.ts` and shared unchanged by every AIE
 * adapter including this one. It also deliberately does NOT exercise
 * `getAiFallbackDocumentExtraction()`'s own pilot-cohort gate, existing-review
 * lookup, `ii_ai_extraction_reviews` write or auto-apply step — none of those
 * are in this dispatch's scope (closing exactly the schema-registration
 * gap), and none of them are touched by this fix.
 */

import { describe, it, expect } from 'vitest';
import { createAieAiProvider } from '@/lib/aie/provider/providerFactory';
import { OpenAiAieProvider } from '@/lib/aie/provider/openaiAieProvider';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import {
  investmentDocumentFactsSchema,
  registerInvestmentDocumentFactsSchema,
  AIE_II_DOCUMENT_FACTS_SCHEMA_NAME,
  AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/investment-intelligence/documentFactsSchema';
import { II_AI_DOCUMENT_EXTRACTION_SYSTEM_PROMPT } from '@/lib/services/investment-intelligence/aiFallbackDocumentExtraction';
import { maskText, containsUnmaskedPii } from '@/lib/aie/masking/piiMasking';
import { getAieAiModel, getAieAiMaxOutputTokensPerDocument } from '@/lib/aie/config';

const ENABLED = process.env.AIE_II_LIVE_PROVIDER_PROOF === '1';

const LIVE_TENANT = { tenantKey: 'ii-live-proof-synthetic-tenant' };

/** Synthetic. Every value here is invented for this proof; no real investor,
 * PAN, folio or address appears. These double as the PII sentinels asserted
 * absent from the pre-egress payload and the provider's response. */
const SENTINELS = ['RAHUL VIJAY DESHPANDE', 'ABCDE1234F', '123456789/45'];

const SYNTHETIC_CAS_STATEMENT = [
  'CAMS - CONSOLIDATED ACCOUNT STATEMENT',
  'Investor: RAHUL VIJAY DESHPANDE',
  'PAN: ABCDE1234F',
  'Folio No: 123456789/45',
  '',
  'ACME MUTUAL FUND',
  'ACME Bluechip Growth Fund - Direct Plan - Growth Option    ISIN: INE002A01018',
  'Opening Balance as on 01-Jan-2026: 100.000 units',
  '15-Jan-2026  SIP Purchase   Amount: 500.00   NAV: 10.0000   Units: 50.000   Balance: 150.000',
  'Closing Balance as on 31-Jan-2026: 150.000 units, NAV: 25.5000, Market Value: 3825.00',
].join('\n');

describe.skipIf(!ENABLED)('AIE investment-intelligence adapter — real OpenAI provider proof', () => {
  it('selects the REAL OpenAI provider, not the mock, when AIE_AI_PROVIDER=openai', () => {
    expect(process.env.AIE_AI_PROVIDER).toBe('openai');
    expect(process.env.AIE_OPENAI_API_KEY, 'key must be present but is never printed').toBeTruthy();
    const provider = createAieAiProvider();
    expect(provider).toBeInstanceOf(OpenAiAieProvider);
    expect(provider).not.toBeInstanceOf(MockAieProvider);
  });

  it('sends only masked minimum-necessary content and no raw PII sentinel', () => {
    const masking = maskText(SYNTHETIC_CAS_STATEMENT, LIVE_TENANT);
    expect(containsUnmaskedPii(masking.maskedText)).toBe(false);
    for (const sentinel of SENTINELS) {
      expect(masking.maskedText, `sentinel leaked pre-egress: ${sentinel}`).not.toContain(sentinel);
    }
  });

  it('makes a real call and gets past provider_error into a genuine outcome, returning schema-valid document facts on success', async () => {
    registerInvestmentDocumentFactsSchema();
    const masking = maskText(SYNTHETIC_CAS_STATEMENT, LIVE_TENANT);
    const gateway = new AieDocumentAiGateway(createAieAiProvider(), { isKillSwitchEnabled: () => true });

    const result = await gateway.requestFieldCompletion({
      systemPrompt: II_AI_DOCUMENT_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: masking.maskedText,
      schemaName: AIE_II_DOCUMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION,
      model: getAieAiModel(),
      maxOutputTokens: getAieAiMaxOutputTokensPerDocument(),
      requestedFields: [],
      idempotencyKey: `ii-doc-extract-live-proof-${Date.now()}`,
    });

    console.log('[AIE II live proof] outcome=%s model=%s errorCodes=%s', result.outcome, getAieAiModel(), JSON.stringify(result.errorCodes ?? null));

    // The P0 regression this dispatch fixes: before the fix, this call threw
    // "no strict JSON Schema mapping registered" inside getKnownOpenAiJsonSchema,
    // which AieDocumentAiGateway.executeOnce() mapped to 'provider_error' on
    // EVERY call, regardless of what the document actually said. Asserting
    // the outcome is never 'provider_error' is this test's core proof.
    expect(result.outcome).not.toBe('provider_error');
    expect(['success', 'schema_rejected', 'refused']).toContain(result.outcome);

    const serialised = JSON.stringify(result);
    for (const sentinel of SENTINELS) {
      expect(serialised, `sentinel returned by provider path: ${sentinel}`).not.toContain(sentinel);
    }

    if (result.outcome === 'success') {
      const parsed = investmentDocumentFactsSchema.safeParse(result.data);
      expect(parsed.success, `provider response failed our own schema: ${JSON.stringify(result.data)}`).toBe(true);
      if (parsed.success) {
        console.log(
          '[AIE II live proof] documentTypeCandidate=%s positions=%d',
          parsed.data.documentTypeCandidate,
          parsed.data.positions.length
        );
        expect(parsed.data.positions.length, 'a real CAS statement with a clearly printed scheme should yield at least one position').toBeGreaterThan(0);
      }
    }
  }, 60_000);
});
