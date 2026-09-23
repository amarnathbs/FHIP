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
import { AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION } from '../adapters/investment-intelligence/documentFactsSchema';
import { INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA } from '../adapters/investment-intelligence/openaiSchema';
import { AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION } from '../adapters/payslip/schema';
import { PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA } from '../adapters/payslip/openaiSchema';
// AIE unified document fallback (2026-09-23) — the four remaining FDH-3
// document types. Registering each schema HERE is the step §6.1 of the design
// document records as "easy to forget and already forgotten once for a live
// mechanism": a schema absent from `KNOWN_SCHEMAS` throws, the gateway maps
// that throw to `outcome: 'provider_error'`, and every real provider call for
// that adapter fails before returning anything usable — with no signal that
// the cause is a missing registration rather than a provider fault.
// `tests/unit/aieUnifiedFallbackSchemaShape.test.ts` asserts every one of
// these four resolves through `getKnownOpenAiJsonSchema()`, so a future
// adapter added without this line fails a test rather than failing live.
import { AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME, AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION } from '../adapters/bankStatement/schema';
import { BANK_STATEMENT_FACTS_OPENAI_JSON_SCHEMA } from '../adapters/bankStatement/openaiSchema';

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

/**
 * 2026-09-22 addition (found while live-proving the payslip AI-fallback
 * adapter against the REAL provider — see
 * `tests/live-dev/aiePayslipAdapterLiveProviderProof.live.test.ts`).
 *
 * NOT EVERY AI-FACING SCHEMA IN THIS CODEBASE IS THE "bounded array of typed
 * field candidates" ENVELOPE THIS FILE'S OWN HEADER CLAIMS IS THE ONLY SHAPE.
 * That claim was true when written (2026-09-13, AIE-1 closure mission) but a
 * later, real, LIVE-RECHABLE addition — Investment Intelligence's own
 * whole-document facts contract
 * (`lib/aie/adapters/investment-intelligence/documentFactsSchema.ts`'s
 * `investmentDocumentFactsSchema`, actually called by
 * `lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts`,
 * the ONE II AI-fallback mechanism reachable from live UI today) is a richly
 * nested object (`positions[].transactions[]...`), not that envelope shape —
 * and, at the time this comment was first written, it had NEVER been added
 * to `KNOWN_SCHEMAS` below. Confirmed live: calling the real gateway with
 * `AIE_AI_PROVIDER=openai` and `schemaName: AIE_II_DOCUMENT_FACTS_SCHEMA_NAME`
 * threw exactly the "no strict JSON Schema mapping registered" error this
 * function raises, which `AieDocumentAiGateway.executeOnce()` maps to
 * `outcome: 'provider_error'` — meaning Investment Intelligence's live
 * AI-fallback path could not successfully complete a real OpenAI call, in
 * any environment where `AIE_AI_PROVIDER=openai` was actually set, a
 * P0-class production-readiness gap independent of and in addition to this
 * adapter's own two disclosed blockers (masking key unset; every II parser
 * declares `aiEligibleGaps: []` — see `moduleRegistry.ts`'s own honesty
 * note).
 *
 * FIXED 2026-09-22, same day: `investmentDocumentFactsSchema` hand-converted
 * to `INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA`
 * (`investment-intelligence/openaiSchema.ts` — see that file's own header
 * for what is and is not encoded) and registered below. The entry now
 * resolves; see `tests/unit/aieIiOpenAiSchemaShape.test.ts` (drift
 * detector) and `tests/live-dev/aieIiAdapterLiveProviderProof.live.test.ts`
 * (opt-in real-provider proof).
 *
 * `rawSchema` is added here as an ESCAPE HATCH for exactly this case: a
 * schema whose shape does not fit the single generic
 * `buildFieldCompletionJsonSchema()` parameterisation. The payslip adapter
 * was the first consumer; Investment Intelligence's whole-document schema
 * (below) is the second.
 */
interface RawKnownSchemaSpec {
  rawSchema: Record<string, unknown>;
}

/** `schemaName@schemaVersion` -> the field-shape parameters needed to build
 * its strict JSON Schema. Deliberately closed (a `Map`, not a fallback) —
 * an AI-facing schema this builder does not recognise must be added here
 * explicitly, never guessed generically, because a wrong `enum`/`maxItems`
 * would silently widen what the provider is allowed to invent. */
const KNOWN_SCHEMAS = new Map<string, KnownSchemaSpec | RawKnownSchemaSpec>([
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
  [`${AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME}@${AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION}`, { rawSchema: PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA }],
  // 2026-09-22 fix — see this file's own 2026-09-22 addition comment above
  // and `investment-intelligence/openaiSchema.ts`'s header: this entry was
  // missing, which made every real OpenAI call from II's live AI-fallback
  // mechanism fail with `provider_error` before ever returning usable data.
  [`${AIE_II_DOCUMENT_FACTS_SCHEMA_NAME}@${AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION}`, { rawSchema: INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA }],
  // AIE unified document fallback (2026-09-23) — see the import block above.
  [`${AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME}@${AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION}`, { rawSchema: BANK_STATEMENT_FACTS_OPENAI_JSON_SCHEMA }],
]);

function isRawSpec(spec: KnownSchemaSpec | RawKnownSchemaSpec): spec is RawKnownSchemaSpec {
  return 'rawSchema' in spec;
}

export function getKnownOpenAiJsonSchema(schemaName: string, schemaVersion: string): Record<string, unknown> {
  const key = `${schemaName}@${schemaVersion}`;
  const spec = KNOWN_SCHEMAS.get(key);
  if (!spec) {
    throw new Error(`openaiJsonSchema: no strict JSON Schema mapping registered for "${key}" — add one to KNOWN_SCHEMAS rather than guessing a shape`);
  }
  if (isRawSpec(spec)) {
    return spec.rawSchema;
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
