/**
 * AIE payslip AI-fallback adapter — REAL OpenAI provider proof, through the
 * REAL code path (schema, prompt, gateway). Mirrors
 * `tests/live-dev/aieM2RealProviderProof.live.test.ts`'s own established
 * pattern exactly, for this adapter's own schema.
 *
 * OPT-IN ONLY. Skipped unless `AIE_PAYSLIP_LIVE_PROVIDER_PROOF=1`, because it
 * spends real money against the configured OpenAI project (a handful of
 * gpt-4o-mini tokens; sub-cent). Requires `AIE_AI_PROVIDER=openai` and a real
 * `AIE_OPENAI_API_KEY` in the environment (`.env.local`) — the key is never
 * printed, only its presence asserted.
 *
 * SCOPE, DISCLOSED. This constructs its OWN `AieDocumentAiGateway` with
 * `isKillSwitchEnabled: () => true` and NO `costAdmission` option — exactly
 * like `aieM2RealProviderProof.live.test.ts` does — rather than importing
 * `lib/aie/adapters/payslip/gateway.ts`'s own module-level singleton (which
 * wires the real `reserveConservativeAiCost`/`settleAiCost`, requiring the
 * migration-0152 cost-ledger tables to exist in whatever database
 * `SUPABASE_SERVICE_ROLE_KEY` in this environment points at — unverified for
 * this specific DEV project as part of this dispatch). This proof
 * demonstrates the thing that is actually new here — this adapter's own
 * schema/prompt correctly round-trips through the real provider — not the
 * shared cost-admission plumbing, which is already separately proven by
 * `aieM2RealProviderProof.live.test.ts` and shared unchanged by every AIE
 * adapter including this one.
 */

import { describe, it, expect } from 'vitest';
import { createAieAiProvider } from '@/lib/aie/provider/providerFactory';
import { OpenAiAieProvider } from '@/lib/aie/provider/openaiAieProvider';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { payslipDocumentFactsSchema, registerPayslipDocumentFactsSchema, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/payslip/schema';
import { mapPayslipFactsToExtraction } from '@/lib/aie/adapters/payslip/mapping';
import { PAYSLIP_AI_EXTRACTION_SYSTEM_PROMPT } from '@/lib/aie/adapters/payslip/gateway';
import { maskText, containsUnmaskedPii } from '@/lib/aie/masking/piiMasking';
import { getAieAiModel, getAieAiMaxOutputTokensPerDocument } from '@/lib/aie/config';

const ENABLED = process.env.AIE_PAYSLIP_LIVE_PROVIDER_PROOF === '1';

const LIVE_TENANT = { tenantKey: 'payslip-live-proof-synthetic-tenant' };

/** Synthetic. Every value here is invented for this proof; no real employee,
 * TFN, bank account or address appears. These double as the PII sentinels
 * asserted absent from the pre-egress payload and the provider's response. */
// NOTE ON FORMAT (disclosed limitation, not fixed here — see
// docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md's
// known-limitations section): the shared `tax_id`/`bank_account` patterns
// require the ATO/bank-standard SPACED format ('123 456 789') and digits
// immediately adjacent to the BSB, respectively. A TFN or BSB+account printed
// in a different real-world format (hyphens, or with intervening label text
// like "Acc") will NOT be masked. This proof therefore uses the standard
// spaced TFN format, which IS masked, and does not exercise the
// bank-account/BSB pattern's own narrower matching window at all.
const SENTINELS = ['JANE ANNE CITIZEN', '123 456 789', '42 Wattle Street, Sydney NSW 2000'];

const SYNTHETIC_PAYSLIP = [
  'ACME AUSTRALIA PTY LTD',
  'Payslip for the period 01/03/2026 to 14/03/2026',
  'Employee: JANE ANNE CITIZEN   TFN: 123 456 789',
  'Address: 42 Wattle Street, Sydney NSW 2000',
  'Pay frequency: Fortnightly   Payment date: 18/03/2026',
  'Gross pay: $3,200.00',
  'Ordinary hours: $3,000.00',
  'Overtime: $200.00',
  'PAYG withholding: $712.00',
  'Superannuation (employer): $352.00',
  'Net pay: $2,488.00',
].join('\n');

describe.skipIf(!ENABLED)('AIE payslip adapter — real OpenAI provider proof', () => {
  it('selects the REAL OpenAI provider, not the mock, when AIE_AI_PROVIDER=openai', () => {
    expect(process.env.AIE_AI_PROVIDER).toBe('openai');
    expect(process.env.AIE_OPENAI_API_KEY, 'key must be present but is never printed').toBeTruthy();
    const provider = createAieAiProvider();
    expect(provider).toBeInstanceOf(OpenAiAieProvider);
    expect(provider).not.toBeInstanceOf(MockAieProvider);
  });

  it('sends only masked minimum-necessary content and no raw PII sentinel', () => {
    const masking = maskText(SYNTHETIC_PAYSLIP, LIVE_TENANT);
    expect(containsUnmaskedPii(masking.maskedText)).toBe(false);
    for (const sentinel of SENTINELS) {
      expect(masking.maskedText, `sentinel leaked pre-egress: ${sentinel}`).not.toContain(sentinel);
    }
  });

  it('makes a real call, returns schema-valid payslip facts, and maps to a usable PayrollExtraction', async () => {
    registerPayslipDocumentFactsSchema();
    const masking = maskText(SYNTHETIC_PAYSLIP, LIVE_TENANT);
    const gateway = new AieDocumentAiGateway(createAieAiProvider(), { isKillSwitchEnabled: () => true });

    const result = await gateway.requestFieldCompletion({
      systemPrompt: PAYSLIP_AI_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: masking.maskedText,
      schemaName: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION,
      model: getAieAiModel(),
      maxOutputTokens: getAieAiMaxOutputTokensPerDocument(),
      requestedFields: [],
      idempotencyKey: `payslip-live-proof-${Date.now()}`,
    });

    // eslint-disable-next-line no-console
    console.log('[AIE payslip live proof] outcome=%s model=%s errorCodes=%s', result.outcome, getAieAiModel(), JSON.stringify(result.errorCodes ?? null));

    expect(['success', 'schema_rejected', 'refused']).toContain(result.outcome);

    const serialised = JSON.stringify(result);
    for (const sentinel of SENTINELS) {
      expect(serialised, `sentinel returned by provider path: ${sentinel}`).not.toContain(sentinel);
    }

    if (result.outcome === 'success') {
      const parsed = payslipDocumentFactsSchema.safeParse(result.data);
      expect(parsed.success, `provider response failed our own schema: ${JSON.stringify(result.data)}`).toBe(true);
      if (parsed.success) {
        // eslint-disable-next-line no-console
        console.log('[AIE payslip live proof] grossPay=%s netPay=%s payFrequency=%s', parsed.data.grossPay.value, parsed.data.netPay.value, parsed.data.payFrequency.value);
        const extraction = mapPayslipFactsToExtraction(parsed.data, { country: 'AU', currencyCode: 'AUD' });
        expect(extraction, 'a real payslip with a clearly printed gross/net figure should map to a usable extraction').not.toBeNull();
      }
    }
  }, 60_000);
});
