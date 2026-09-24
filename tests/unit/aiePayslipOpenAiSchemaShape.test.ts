/**
 * Drift detector between `payslipDocumentFactsSchema` (Zod, the real
 * validation authority — `lib/aie/adapters/payslip/schema.ts`) and
 * `PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA` (the hand-written OpenAI
 * strict-mode literal actually sent to the provider —
 * `lib/aie/adapters/payslip/openaiSchema.ts`). There is no Zod-to-JSON-Schema
 * converter in this codebase by design (see `openaiJsonSchema.ts`'s header),
 * so these two must be kept in sync by hand — this test is the best-effort
 * mechanical check that catches the two drifting apart (a key added to one
 * and not the other), NOT a proof of full semantic equivalence.
 *
 * This exact class of gap (a real, live-reachable AI schema never added to
 * `openaiJsonSchema.ts`'s `KNOWN_SCHEMAS`, causing every real provider call
 * to throw and the gateway to report `provider_error`) is what this
 * dispatch's own live-DEV proof (`tests/live-dev/
 * aiePayslipAdapterLiveProviderProof.live.test.ts`) found for Investment
 * Intelligence's live AI-fallback mechanism — see `openaiJsonSchema.ts`'s
 * 2026-09-22 comment for the full disclosure.
 */
import { describe, it, expect } from 'vitest';
import { payslipDocumentFactsSchema } from '@/lib/aie/adapters/payslip/schema';
import { PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/payslip/openaiSchema';
import { getKnownOpenAiJsonSchema } from '@/lib/aie/provider/openaiJsonSchema';
import { AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/payslip/schema';

function emptyField() {
  return { value: null, missingReasonCode: 'not_present_on_document' as const };
}

const REPRESENTATIVE_PAYLOAD = {
  schemaVersion: '1' as const,
  documentMissingReasonCode: null,
  employerName: emptyField(),
  payPeriodStart: emptyField(),
  payPeriodEnd: emptyField(),
  paymentDate: emptyField(),
  payFrequency: { value: null, missingReasonCode: 'not_present_on_document' as const },
  grossPay: { value: '100.00', missingReasonCode: null },
  basePay: emptyField(),
  overtimePay: emptyField(),
  bonusPay: emptyField(),
  commissionPay: emptyField(),
  allowancesTotal: emptyField(),
  reimbursementsTotal: emptyField(),
  otherEarnings: emptyField(),
  taxWithheld: emptyField(),
  employeeDeductionsTotal: emptyField(),
  salarySacrifice: emptyField(),
  professionalTax: emptyField(),
  employerRetirementContribution: emptyField(),
  employeeRetirementContribution: emptyField(),
  employerNpsContribution: emptyField(),
  employeeNpsContribution: emptyField(),
  netPay: emptyField(),
};

describe('payslip OpenAI json schema <-> Zod schema parity', () => {
  it('the representative payload is valid Zod AND has exactly the JSON schema\'s top-level property set', () => {
    const zodResult = payslipDocumentFactsSchema.safeParse(REPRESENTATIVE_PAYLOAD);
    expect(zodResult.success).toBe(true);

    const jsonProps = Object.keys((PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: Record<string, unknown> }).properties);
    expect(jsonProps.sort()).toEqual(Object.keys(REPRESENTATIVE_PAYLOAD).sort());
  });

  it('every top-level property is listed in the JSON schema\'s own "required" (OpenAI strict-mode rule)', () => {
    const schema = PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('every nested field object also lists both its own properties in "required"', () => {
    const schema = PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: Record<string, unknown> };
    for (const [key, value] of Object.entries(schema.properties)) {
      if (key === 'schemaVersion' || key === 'documentMissingReasonCode') continue;
      type Obj = { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
      // Money fields (2026-09-25) are an anyOf of two exact object shapes;
      // strict mode's rules apply to EACH branch.
      const branches = Array.isArray((value as { anyOf?: unknown[] }).anyOf) ? ((value as { anyOf: Obj[] }).anyOf) : [value as Obj];
      for (const nested of branches) {
        expect(nested.additionalProperties, `${key} must set additionalProperties:false (strict mode)`).toBe(false);
        expect([...nested.required].sort(), `${key} required must match its own properties`).toEqual(Object.keys(nested.properties).sort());
      }
    }
  });

  it('money fields structurally forbid BOTH (value, reason) and (null, null) -- the live schema_rejected cause', () => {
    const money = (PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: Record<string, { anyOf?: Array<{ properties: Record<string, { type: string }> }> }> }).properties.grossPay;
    expect(money.anyOf).toHaveLength(2);
    const shapes = money.anyOf!.map((b) => `${b.properties.value.type}/${b.properties.missingReasonCode.type}`).sort();
    expect(shapes).toEqual(['null/string', 'string/null']);
  });

  it('getKnownOpenAiJsonSchema resolves this schema without throwing (the exact call the real gateway makes)', () => {
    expect(() => getKnownOpenAiJsonSchema(AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION)).not.toThrow();
  });
});
