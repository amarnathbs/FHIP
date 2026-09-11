import { describe, it, expect, beforeAll } from 'vitest';
import { registerInvestmentAdapterSchema, AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION, ALLOWED_AI_COMPLETABLE_FIELDS } from '@/lib/aie/adapters/investment-intelligence/schema';
import { validateAiOutput } from '@/lib/aie/schema/schemaRegistry';

describe('AIE-1.2 — the adapter\'s own AI-fallback schema (execution sequence step 5, P1.2 identity prohibition enforced by schema shape)', () => {
  beforeAll(() => {
    registerInvestmentAdapterSchema();
  });

  it('registers idempotently against AIE-1.1\'s shared Zod registry — no second schema mechanism', () => {
    expect(() => registerInvestmentAdapterSchema()).not.toThrow();
  });

  it('POSITIVE: a schema-valid response naming only an allowed narrative field passes', () => {
    const payload = JSON.stringify({
      fields: [{ fieldName: 'sourceDescriptionClarification', value: 'Illegible fund-house abbreviation on line 42', nullReason: null, sourceReferenceId: 'ref-1' }],
    });
    const result = validateAiOutput({ schemaName: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, schemaVersion: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION, rawText: payload });
    expect(result.valid).toBe(true);
  });

  it('PROHIBITION (P1.2): a response naming an IDENTITY-shaped field (e.g. an instrument identifier) is REJECTED by schema shape, not by a policy check that could be forgotten', () => {
    for (const forbiddenField of ['instrumentIsin', 'ownerMemberId', 'accountFolioNumber', 'currencyCode', 'costBase', 'fxRate']) {
      const payload = JSON.stringify({ fields: [{ fieldName: forbiddenField, value: 'anything', nullReason: null, sourceReferenceId: 'ref-1' }] });
      const result = validateAiOutput({ schemaName: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, schemaVersion: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION, rawText: payload });
      expect(result.valid).toBe(false);
    }
  });

  it('the allowed-field enum itself contains no identity/instrument/currency/cost-base/FX-shaped name (a structural self-check, not just this test\'s own examples)', () => {
    const forbiddenSubstrings = ['isin', 'owner', 'account', 'currency', 'costbase', 'cost_base', 'fx', 'folio', 'amc', 'pan'];
    for (const field of ALLOWED_AI_COMPLETABLE_FIELDS) {
      const lower = field.toLowerCase();
      for (const bad of forbiddenSubstrings) {
        expect(lower.includes(bad)).toBe(false);
      }
    }
  });

  it('unknown top-level keys are rejected (JSC-03 reuse — no adapter-specific relaxation of AIE-1.1\'s own strict-schema rule)', () => {
    const payload = JSON.stringify({ fields: [], extraTopLevelKey: 'should not be here' });
    const result = validateAiOutput({ schemaName: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, schemaVersion: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION, rawText: payload });
    expect(result.valid).toBe(false);
  });
});
