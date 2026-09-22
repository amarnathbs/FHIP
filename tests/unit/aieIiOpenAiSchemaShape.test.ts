/**
 * Drift detector between `investmentDocumentFactsSchema` (Zod, the real
 * validation authority —
 * `lib/aie/adapters/investment-intelligence/documentFactsSchema.ts`) and
 * `INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA` (the hand-written OpenAI
 * strict-mode literal actually sent to the provider —
 * `lib/aie/adapters/investment-intelligence/openaiSchema.ts`). There is no
 * Zod-to-JSON-Schema converter in this codebase by design (see
 * `openaiJsonSchema.ts`'s header), so these two must be kept in sync by
 * hand — this test is the best-effort mechanical check that catches the two
 * drifting apart (a key added to one and not the other, or a nested object
 * missing a required property), NOT a proof of full semantic equivalence.
 * Mirrors `tests/unit/aiePayslipOpenAiSchemaShape.test.ts`'s own pattern,
 * extended to walk the deeper `positions[].transactions[]` nesting this
 * schema has and the plain flat payslip schema does not.
 *
 * This exact class of gap (a real, live-reachable AI schema never added to
 * `openaiJsonSchema.ts`'s `KNOWN_SCHEMAS`, causing every real provider call
 * to throw and the gateway to report `provider_error`) is what a 2026-09-22
 * live-DEV proof found for this exact schema — see `openaiJsonSchema.ts`'s
 * 2026-09-22 comment for the full disclosure and its fix.
 */
import { describe, it, expect } from 'vitest';
import { investmentDocumentFactsSchema, AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/investment-intelligence/documentFactsSchema';
import { INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/investment-intelligence/openaiSchema';
import { getKnownOpenAiJsonSchema } from '@/lib/aie/provider/openaiJsonSchema';

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
      amcOrInstitutionText: 'ACME Mutual Fund',
      schemeText: 'ACME Bluechip Growth Fund - Direct Growth',
      isin: 'INE002A01018',
      isinPresentOnDocument: true,
      openingUnitBalance: '100.000000',
      openingBalanceStatedOnDocument: true,
      closingUnits: '150.000000',
      statementNav: '25.5000',
      statementNavDateIso: '2026-01-31',
      statementMarketValue: '3825.00',
      missingReasonCode: null,
      sourceLocation: { page: 1, line: 12, rawText: 'ACME Bluechip Growth Fund 150.000 units' },
      transactions: [
        {
          transactionDateIso: '2026-01-15',
          narrative: 'SIP Purchase',
          transactionTypeCandidate: 'sip' as const,
          amount: '500.00',
          units: '50.000000',
          navOrPrice: '10.0000',
          runningUnitBalance: '150.000000',
          feeAmount: null,
          feeKind: 'none' as const,
          missingReasonCode: null,
          sourceLocation: { page: 1, line: 13, rawText: 'SIP purchase 50.000 units @ 10.00' },
        },
      ],
    },
  ],
};

/** Recursively asserts every object-typed (sub)schema, at any depth,
 * satisfies OpenAI strict-mode's two structural rules: `additionalProperties:
 * false`, and `required` listing exactly its own `properties` keys. Walks
 * into `properties` values and `items` (for arrays) so `positions[].
 * transactions[].sourceLocation` is checked just as strictly as the root. */
function assertStrictModeShape(schema: unknown, path: string): void {
  if (schema === null || typeof schema !== 'object') return;
  const node = schema as { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown; items?: unknown };
  const typeIsObject = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
  if (typeIsObject) {
    expect(node.additionalProperties, `${path}: additionalProperties must be false (strict mode)`).toBe(false);
    expect((node.required ?? []).slice().sort(), `${path}: required must match its own properties`).toEqual(Object.keys(node.properties ?? {}).sort());
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      assertStrictModeShape(value, `${path}.${key}`);
    }
  }
  if (node.type === 'array' && node.items !== undefined) {
    assertStrictModeShape(node.items, `${path}[]`);
  }
}

describe('investment-intelligence OpenAI json schema <-> Zod schema parity', () => {
  it('the representative payload is valid Zod (including the cross-field superRefine rules)', () => {
    const zodResult = investmentDocumentFactsSchema.safeParse(REPRESENTATIVE_PAYLOAD);
    expect(zodResult.success, zodResult.success ? '' : JSON.stringify((zodResult as { error: unknown }).error)).toBe(true);
  });

  it('the JSON schema\'s top-level property set matches the representative payload\'s own keys', () => {
    const jsonProps = Object.keys((INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: Record<string, unknown> }).properties);
    expect(jsonProps.sort()).toEqual(Object.keys(REPRESENTATIVE_PAYLOAD).sort());
  });

  it('every object in the schema tree — root, position, transaction, sourceLocation — sets additionalProperties:false and required == its own properties', () => {
    assertStrictModeShape(INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA, 'root');
  });

  it('the representative payload\'s position and transaction keys match the JSON schema\'s nested required sets exactly', () => {
    const root = INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA as { properties: { positions: { items: { properties: Record<string, unknown>; required: string[] } } } };
    const positionSchema = root.properties.positions.items;
    const [samplePosition] = REPRESENTATIVE_PAYLOAD.positions;
    expect(positionSchema.required.slice().sort()).toEqual(Object.keys(samplePosition).sort());

    const transactionSchema = (positionSchema.properties.transactions as { items: { properties: Record<string, unknown>; required: string[] } }).items;
    const [sampleTransaction] = samplePosition.transactions;
    expect(transactionSchema.required.slice().sort()).toEqual(Object.keys(sampleTransaction).sort());
  });

  it('getKnownOpenAiJsonSchema resolves this schema without throwing (the exact call the real gateway makes — this is the P0 regression this dispatch fixes)', () => {
    expect(() => getKnownOpenAiJsonSchema(AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION)).not.toThrow();
  });
});
