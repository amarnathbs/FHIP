/**
 * AIE-1 final-closure gap #2 (2026-09-22) — drift detector between
 * `investmentDocumentFactsSchema` (Zod, the real validation authority —
 * `lib/aie/adapters/investment-intelligence/documentFactsSchema.ts`) and
 * `INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA` (the hand-written OpenAI
 * strict-mode literal actually sent to the provider —
 * `lib/aie/adapters/investment-intelligence/openaiSchema.ts`). There is no
 * Zod-to-JSON-Schema converter in this codebase by design (see
 * `openaiJsonSchema.ts`'s own header), so these two must be kept in sync by
 * hand — this test is the best-effort mechanical check that catches the two
 * drifting apart (a key added to one and not the other), NOT a proof of
 * full semantic equivalence.
 *
 * THIS IS THE FIX for the exact gap a concurrent 2026-09-22 dispatch found
 * and deliberately left unfixed: `investmentDocumentFactsSchema` was never
 * registered in `openaiJsonSchema.ts`'s `KNOWN_SCHEMAS`, so Investment
 * Intelligence's real AI-fallback path could never complete a real OpenAI
 * call (`getKnownOpenAiJsonSchema` threw before any HTTP request was made).
 * This test uses ONLY the mocked/capturing test provider path (no real
 * OpenAI call, no `AIE_OPENAI_API_KEY` needed) — it proves the schema
 * resolves and is internally well-formed, not that a live model call
 * succeeds against it (that would require a real, budgeted OpenAI spend,
 * explicitly out of scope for this DEV-only closure work).
 */
import { describe, it, expect } from 'vitest';
import { investmentDocumentFactsSchema, AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/investment-intelligence/documentFactsSchema';
import { INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/investment-intelligence/openaiSchema';
import { getKnownOpenAiJsonSchema } from '@/lib/aie/provider/openaiJsonSchema';

function sourceLocation() {
  return { page: 1, line: 1, rawText: 'sample line' };
}

const REPRESENTATIVE_PAYLOAD = {
  schemaVersion: '1' as const,
  documentTypeCandidate: 'cas_statement' as const,
  sourceInstitutionText: 'CAMS',
  statementPeriodStartIso: '2026-01-01',
  statementPeriodEndIso: '2026-01-31',
  statementAsOfDateIso: '2026-01-31',
  missingReasonCode: null,
  positions: [
    {
      folioToken: '[MASKED:folio_number:hmac:abc123]',
      amcOrInstitutionText: 'Sample AMC',
      schemeText: 'Sample Growth Fund',
      isin: null,
      isinPresentOnDocument: false,
      openingUnitBalance: null,
      openingBalanceStatedOnDocument: false,
      closingUnits: '100.500000',
      statementNav: '25.1234',
      statementNavDateIso: '2026-01-31',
      statementMarketValue: '2525.90',
      missingReasonCode: null,
      sourceLocation: sourceLocation(),
      transactions: [
        {
          transactionDateIso: '2026-01-15',
          narrative: 'Purchase - Growth Option',
          transactionTypeCandidate: 'purchase' as const,
          amount: '1000.00',
          units: '39.750000',
          navOrPrice: '25.1572',
          runningUnitBalance: '100.500000',
          feeAmount: null,
          feeKind: 'none' as const,
          missingReasonCode: null,
          sourceLocation: sourceLocation(),
        },
      ],
    },
  ],
};

describe('Investment Intelligence OpenAI json schema <-> Zod schema parity', () => {
  it('the representative payload is valid Zod', () => {
    const result = investmentDocumentFactsSchema.safeParse(REPRESENTATIVE_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it('the JSON schema top-level property set matches the representative payload exactly', () => {
    const jsonProps = Object.keys((INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: Record<string, unknown> }).properties);
    expect(jsonProps.sort()).toEqual(Object.keys(REPRESENTATIVE_PAYLOAD).sort());
  });

  it('every top-level property is listed in the JSON schema\'s own "required" (OpenAI strict-mode rule)', () => {
    const schema = INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('the position and transaction nested objects are closed and internally consistent (additionalProperties:false, required === own properties)', () => {
    const schema = INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as {
      properties: { positions: { items: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean; properties: { transactions: { items: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } } } } } };
    };
    const positionSchema = schema.properties.positions.items;
    expect(positionSchema.additionalProperties).toBe(false);
    expect(positionSchema.required.sort()).toEqual(Object.keys(positionSchema.properties).sort());

    const transactionSchema = positionSchema.properties.transactions.items;
    expect(transactionSchema.additionalProperties).toBe(false);
    expect(transactionSchema.required.sort()).toEqual(Object.keys(transactionSchema.properties).sort());
  });

  it('getKnownOpenAiJsonSchema resolves this schema without throwing (the exact call the real gateway makes before any HTTP request)', () => {
    expect(() => getKnownOpenAiJsonSchema(AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION)).not.toThrow();
    expect(getKnownOpenAiJsonSchema(AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION)).toBe(INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA);
  });

  it('an unknown schema name/version still throws exactly as before (the escape hatch does not weaken the closed-map guarantee)', () => {
    expect(() => getKnownOpenAiJsonSchema('not_a_real_schema', '999')).toThrow(/no strict JSON Schema mapping registered/);
  });
});
