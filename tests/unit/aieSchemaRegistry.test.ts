import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  aieSchemaRegistry,
  validateAiOutput,
  decimalStringField,
  isoDateStringField,
  currencyCodeField,
  AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME,
  AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION,
} from '@/lib/aie/schema/schemaRegistry';

describe('AIE-1.1 JSON Schema gateway (JSC-01..12, Zod-based — see module header deviation note)', () => {
  it('validates a well-formed generic field-completion response', () => {
    const raw = JSON.stringify({ fields: [{ fieldName: 'account_number', value: null, nullReason: 'not_present_on_document', sourceReferenceId: 'p1' }] });
    const result = validateAiOutput({ schemaName: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, schemaVersion: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION, rawText: raw });
    expect(result.valid).toBe(true);
  });

  it('rejects malformed JSON with a stable code, never throwing', () => {
    const result = validateAiOutput({ schemaName: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, schemaVersion: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION, rawText: '{not json' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errorCodes).toEqual(['json_parse_failed']);
  });

  it('rejects an unregistered schema name/version rather than silently passing', () => {
    const result = validateAiOutput({ schemaName: 'does_not_exist', schemaVersion: '1', rawText: '{}' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errorCodes).toEqual(['schema_not_registered']);
  });

  it('JSC-03: rejects unknown/extra properties by default (.strict())', () => {
    const raw = JSON.stringify({
      fields: [{ fieldName: 'x', value: '1', nullReason: null, sourceReferenceId: 'p1', unexpectedExtraKey: 'should not be allowed' }],
    });
    const result = validateAiOutput({ schemaName: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, schemaVersion: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION, rawText: raw });
    expect(result.valid).toBe(false);
  });

  it('rejects a non-null candidate missing its required source reference (PRM-06)', () => {
    const raw = JSON.stringify({ fields: [{ fieldName: 'x', value: '10.00', nullReason: null, sourceReferenceId: '' }] });
    const result = validateAiOutput({ schemaName: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, schemaVersion: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION, rawText: raw });
    expect(result.valid).toBe(false);
  });

  it('registry treats a published schema version as immutable — re-registering the same name+version with different content throws', () => {
    aieSchemaRegistry.register({ name: 'test_immutable_schema', version: '1', schema: z.object({ a: z.string() }).strict() });
    expect(() => aieSchemaRegistry.register({ name: 'test_immutable_schema', version: '1', schema: z.object({ b: z.string() }).strict() })).toThrow();
  });

  it('registering the exact same schema object twice under the same name+version is a harmless no-op', () => {
    const schema = z.object({ c: z.string() }).strict();
    aieSchemaRegistry.register({ name: 'test_idempotent_schema', version: '1', schema });
    expect(() => aieSchemaRegistry.register({ name: 'test_idempotent_schema', version: '1', schema })).not.toThrow();
  });
});

describe('AIE-1.1 shared normalisation primitives (NORM-01/JSC-08)', () => {
  it('decimalStringField accepts plain decimal strings and rejects scientific notation / numbers-as-numbers', () => {
    expect(decimalStringField.safeParse('1234.56').success).toBe(true);
    expect(decimalStringField.safeParse('-42').success).toBe(true);
    expect(decimalStringField.safeParse('1.2e10').success).toBe(false);
    expect(decimalStringField.safeParse('1,234.56').success).toBe(false);
  });

  it('isoDateStringField accepts only YYYY-MM-DD', () => {
    expect(isoDateStringField.safeParse('2026-09-11').success).toBe(true);
    expect(isoDateStringField.safeParse('11/09/2026').success).toBe(false);
  });

  it('currencyCodeField accepts only 3-letter uppercase codes', () => {
    expect(currencyCodeField.safeParse('AUD').success).toBe(true);
    expect(currencyCodeField.safeParse('aud').success).toBe(false);
    expect(currencyCodeField.safeParse('AUDD').success).toBe(false);
  });
});
