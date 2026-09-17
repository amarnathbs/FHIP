/**
 * AIE-1 closure mission — OpenAI Structured Outputs (strict json_schema)
 * builder for the AIE field-completion envelope.
 *
 * WHY A HAND-WRITTEN BUILDER, NOT A GENERIC ZOD-TO-JSON-SCHEMA LIBRARY.
 * `lib/aie/schema/schemaRegistry.ts` deliberately uses Zod, not a JSON
 * Schema library (see that file's own header) — this repo has zero
 * dependency on any zod-to-json-schema converter, and every schema this
 * gateway will ever send to a real provider (confirmed by reading every
 * registered schema: `schemaRegistry.ts`'s generic schema, plus
 * `adapters/insurance/schema.ts` and `adapters/investment-intelligence/
 * schema.ts`) shares EXACTLY one shape: a bounded array of
 * `{fieldName: <enum>, value: string|null, nullReason: <enum>|null,
 * sourceReferenceId: string}`, differing only in the allowed `fieldName`
 * values and the max array length. Introducing a general-purpose converter
 * dependency to handle exactly one recurring shape would be the same kind
 * of "unreviewed, unnecessary dependency" `schemaRegistry.ts` itself argues
 * against — so this module hand-builds the strict JSON Schema for that one
 * shape, parameterised by the allowed field names and max length, and
 * fails loudly (throws) for any schema name this builder does not
 * recognise rather than silently guessing a shape (mission section 7.3:
 * "handle provider schema-subset limitations explicitly").
 *
 * STRICT-MODE RULES APPLIED (confirmed against OpenAI's Structured Outputs
 * documentation, 2026-09-13): every object sets `additionalProperties:
 * false`; every property is listed in `required` (nullable-but-optional
 * fields are expressed as a `["string","null"]` type union, never simply
 * omitted from `required` — `nullReason` and `value` are both nullable
 * this way, matching the Zod `.nullable()` semantics exactly).
 */

import {
  AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME,
  AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION,
} from '../schema/schemaRegistry';
import {
  AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
  AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
  ALLOWED_AI_COMPLETABLE_FIELDS as INSURANCE_FIELDS,
} from '../adapters/insurance/schema';
import {
  AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
  AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
  ALLOWED_AI_COMPLETABLE_FIELDS as II_FIELDS,
} from '../adapters/investment-intelligence/schema';

const NULL_REASON_ENUM = ['not_present_on_document', 'illegible', 'ambiguous'] as const;

/** Builds the strict-mode JSON Schema for the one recurring "bounded array
 * of typed field candidates" envelope shape, given the specific adapter's
 * closed field-name enum and max array length. */
export function buildFieldCompletionJsonSchema(params: { allowedFieldNames: readonly string[]; maxItems: number }): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['fields'],
    properties: {
      fields: {
        type: 'array',
        maxItems: params.maxItems,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fieldName', 'value', 'nullReason', 'sourceReferenceId'],
          properties: {
            fieldName: { type: 'string', enum: [...params.allowedFieldNames] },
            value: { type: ['string', 'null'] },
            nullReason: { type: ['string', 'null'], enum: [...NULL_REASON_ENUM, null] },
            sourceReferenceId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  };
}

interface KnownSchemaSpec {
  allowedFieldNames: readonly string[];
  maxItems: number;
}

/** `schemaName@schemaVersion` -> the field-shape parameters needed to build
 * its strict JSON Schema. Deliberately closed (a `Map`, not a fallback) —
 * an AI-facing schema this builder does not recognise must be added here
 * explicitly, never guessed generically, because a wrong `enum`/`maxItems`
 * would silently widen what the provider is allowed to invent. */
const KNOWN_SCHEMAS = new Map<string, KnownSchemaSpec>([
  [
    `${AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME}@${AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION}`,
    // The generic schema's own Zod definition permits any non-empty
    // `fieldName` string (no closed enum, see `schemaRegistry.ts`) because
    // AIE-1.1 ships no domain adapter of its own. OpenAI's strict mode does
    // not support an open-ended string `fieldName` the way Zod's
    // `z.string().min(1)` does — string length/pattern constraints ARE
    // supported in strict mode, so this uses a bounded, printable-text
    // pattern instead of a closed enum for this one generic case only.
    // Every DOMAIN adapter schema below has its own closed enum, and that
    // is what the live orchestrator call path actually uses once wired
    // (see `orchestrator.ts`'s `schemaOverride`).
    { allowedFieldNames: [], maxItems: 50 },
  ],
  [
    `${AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME}@${AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION}`,
    { allowedFieldNames: INSURANCE_FIELDS, maxItems: 5 },
  ],
  [
    `${AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME}@${AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION}`,
    { allowedFieldNames: II_FIELDS, maxItems: 20 },
  ],
]);

export function getKnownOpenAiJsonSchema(schemaName: string, schemaVersion: string): Record<string, unknown> {
  const key = `${schemaName}@${schemaVersion}`;
  const spec = KNOWN_SCHEMAS.get(key);
  if (!spec) {
    throw new Error(`openaiJsonSchema: no strict JSON Schema mapping registered for "${key}" — add one to KNOWN_SCHEMAS rather than guessing a shape`);
  }
  if (spec.allowedFieldNames.length === 0) {
    // The one open-ended case (the generic schema) — see the comment above.
    return {
      type: 'object',
      additionalProperties: false,
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          maxItems: spec.maxItems,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['fieldName', 'value', 'nullReason', 'sourceReferenceId'],
            properties: {
              fieldName: { type: 'string', minLength: 1, maxLength: 200 },
              value: { type: ['string', 'null'] },
              nullReason: { type: ['string', 'null'], enum: [...NULL_REASON_ENUM, null] },
              sourceReferenceId: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    };
  }
  return buildFieldCompletionJsonSchema(spec);
}
