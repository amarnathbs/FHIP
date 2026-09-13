/**
 * AIE-1 closure mission — coverage for the provider factory (mock/real
 * switch) and the strict-mode JSON Schema builder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAieAiProvider } from '@/lib/aie/provider/providerFactory';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { OpenAiAieProvider } from '@/lib/aie/provider/openaiAieProvider';
import { getKnownOpenAiJsonSchema, buildFieldCompletionJsonSchema } from '@/lib/aie/provider/openaiJsonSchema';
import { AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION } from '@/lib/aie/schema/schemaRegistry';
import {
  AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
  AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
  ALLOWED_AI_COMPLETABLE_FIELDS as INSURANCE_FIELDS,
} from '@/lib/aie/adapters/insurance/schema';

describe('createAieAiProvider — the one mock-vs-real switch', () => {
  let originalProviderEnv: string | undefined;
  let originalKeyEnv: string | undefined;

  beforeEach(() => {
    originalProviderEnv = process.env.AIE_AI_PROVIDER;
    originalKeyEnv = process.env.AIE_OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalProviderEnv === undefined) delete process.env.AIE_AI_PROVIDER;
    else process.env.AIE_AI_PROVIDER = originalProviderEnv;
    if (originalKeyEnv === undefined) delete process.env.AIE_OPENAI_API_KEY;
    else process.env.AIE_OPENAI_API_KEY = originalKeyEnv;
  });

  it('defaults to the mock provider when AIE_AI_PROVIDER is unset (production-safe default)', () => {
    delete process.env.AIE_AI_PROVIDER;
    const provider = createAieAiProvider();
    expect(provider).toBeInstanceOf(MockAieProvider);
  });

  it('any value other than the literal "openai" also selects mock (fail-closed convention)', () => {
    process.env.AIE_AI_PROVIDER = 'OpenAI'; // wrong case -- must not match
    const provider = createAieAiProvider();
    expect(provider).toBeInstanceOf(MockAieProvider);
  });

  it('selects the real OpenAI provider when explicitly configured with a key present', () => {
    process.env.AIE_AI_PROVIDER = 'openai';
    process.env.AIE_OPENAI_API_KEY = 'test-key-not-real';
    const provider = createAieAiProvider();
    expect(provider).toBeInstanceOf(OpenAiAieProvider);
  });

  it('NEVER silently falls back to mock when openai is selected but no key is configured -- throws loudly instead', () => {
    process.env.AIE_AI_PROVIDER = 'openai';
    delete process.env.AIE_OPENAI_API_KEY;
    expect(() => createAieAiProvider()).toThrow(/AIE_OPENAI_API_KEY is not set/);
  });
});

interface StrictFieldCompletionJsonSchema {
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: {
    fields: {
      maxItems: number;
      items: {
        additionalProperties: boolean;
        required: string[];
        properties: {
          fieldName: { type: string; enum: (string | null)[] };
          value: { type: (string | null)[] };
          nullReason: { type: (string | null)[] };
        };
      };
    };
  };
}

describe('getKnownOpenAiJsonSchema', () => {
  it('builds a strict schema for the generic envelope: additionalProperties false, all properties required, nullable unions', () => {
    const schema = getKnownOpenAiJsonSchema(AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION) as unknown as StrictFieldCompletionJsonSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['fields']);
    const itemSchema = schema.properties.fields.items;
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.required).toEqual(['fieldName', 'value', 'nullReason', 'sourceReferenceId']);
    expect(itemSchema.properties.value.type).toEqual(['string', 'null']);
    expect(itemSchema.properties.nullReason.type).toEqual(['string', 'null']);
  });

  it('builds a CLOSED enum for a domain adapter schema (insurance) -- never an open string', () => {
    const schema = getKnownOpenAiJsonSchema(AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION) as unknown as StrictFieldCompletionJsonSchema;
    const fieldNameSchema = schema.properties.fields.items.properties.fieldName;
    expect(fieldNameSchema.enum).toEqual([...INSURANCE_FIELDS]);
    expect(fieldNameSchema.type).toBe('string');
    // The whole point of wiring the adapter's own schema (mission section
    // 7.3 / orchestrator.ts's schemaOverride): a response naming any field
    // outside this closed list must be structurally impossible to accept,
    // not merely policy-checked.
    expect(fieldNameSchema.enum).not.toContain('coverAmount');
    expect(fieldNameSchema.enum).not.toContain('policyOwner');
  });

  it('throws for an unregistered schema name/version rather than guessing a shape', () => {
    expect(() => getKnownOpenAiJsonSchema('totally_unknown_schema', '1')).toThrow(/no strict JSON Schema mapping/);
  });

  it('buildFieldCompletionJsonSchema respects the caller-supplied maxItems bound', () => {
    const schema = buildFieldCompletionJsonSchema({ allowedFieldNames: ['a', 'b'], maxItems: 3 }) as unknown as StrictFieldCompletionJsonSchema;
    expect(schema.properties.fields.maxItems).toBe(3);
    expect(schema.properties.fields.items.properties.fieldName.enum).toEqual(['a', 'b']);
  });
});
