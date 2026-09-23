/**
 * AIE document-fallback adapters — SHARED hand-written OpenAI strict-mode
 * JSON Schema builders.
 *
 * WHY HAND-WRITTEN AT ALL. This codebase has no Zod-to-JSON-Schema converter,
 * by design (`lib/aie/provider/openaiJsonSchema.ts`'s own header). OpenAI's
 * strict Structured Outputs mode also has stricter rules than Zod's
 * `.strict()`: EVERY property must be listed in `required`, and a
 * nullable-but-present field is a `["type","null"]` union rather than simply
 * absent. So each adapter's Zod schema and its JSON-Schema mirror must be
 * kept in sync BY HAND.
 *
 * WHY THE BUILDERS ARE SHARED. Hand-syncing is exactly the step
 * `AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md` §4 item 2 warns "is
 * easy to forget and has already been forgotten once for a live mechanism"
 * (§6.1 — Investment Intelligence's schema was never registered, so every
 * real OpenAI call it made failed with `provider_error`). Four more
 * hand-written mirrors is four more chances to make that mistake. Sharing the
 * FIELD-level builders means the per-adapter file only has to get its field
 * LIST right, not re-derive the envelope shape — and the field list is the
 * part a representative-payload test can actually check
 * (`tests/unit/aieUnifiedFallbackSchemaShape.test.ts` validates one payload
 * against both the Zod schema and this literal, per adapter; a best-effort
 * drift detector, not a proof of equivalence).
 *
 * NOTE ON `enum` WITH `null`. Strict mode requires the null to be a member of
 * the `enum` array when the type union admits it, which is why every
 * `missingReasonCode` here is `enum: [...codes, null]` rather than just the
 * codes. Getting this wrong produces a provider-side 400, not a silent
 * mis-shape.
 */

import { AIE_MISSING_REASON_CODES } from './factsFields';

const MISSING_REASON_ENUM: (string | null)[] = [...AIE_MISSING_REASON_CODES, null];

/** The envelope shared by every scalar field: `{ value, missingReasonCode }`.
 * Money, quantity, date and free text all use the plain string form — strict
 * mode does not enforce string `pattern`s in this codebase's hand-written
 * schemas, which is why the shared system prompt states the required formats
 * explicitly instead (see `prompt.ts`, and §6.4 of the design document for
 * the live evidence that this is necessary). */
export function aieScalarFieldJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'missingReasonCode'],
    properties: {
      value: { type: ['string', 'null'] },
      missingReasonCode: { type: ['string', 'null'], enum: MISSING_REASON_ENUM },
    },
  };
}

/** The same envelope, but with the `value` constrained to a closed set. */
export function aieEnumFieldJsonSchema(values: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'missingReasonCode'],
    properties: {
      value: { type: ['string', 'null'], enum: [...values, null] },
      missingReasonCode: { type: ['string', 'null'], enum: MISSING_REASON_ENUM },
    },
  };
}

/** A line-item array (transactions, activities, holdings). `maxItems` is a
 * real cost and blast-radius control, not decoration: it bounds both the
 * output token spend of a single document and the number of rows a single
 * unreviewed extraction could ever propose. */
export function aieLineItemArrayJsonSchema(params: {
  properties: Record<string, unknown>;
  required: readonly string[];
  maxItems: number;
}): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: params.maxItems,
    items: {
      type: 'object',
      additionalProperties: false,
      required: [...params.required],
      properties: params.properties,
    },
  };
}

/** Inside a line item, a field the model may omit is still `required` by
 * strict mode — it is expressed as a nullable type instead. */
export const aieNullableString: Record<string, unknown> = { type: ['string', 'null'] };
export const aieRequiredString: Record<string, unknown> = { type: 'string' };
export function aieNullableEnum(values: readonly string[]): Record<string, unknown> {
  return { type: ['string', 'null'], enum: [...values, null] };
}
export function aieRequiredEnum(values: readonly string[]): Record<string, unknown> {
  return { type: 'string', enum: [...values] };
}

/** Assembles the top-level document-facts object. Every adapter's schema has
 * the same two mandatory members — a literal `schemaVersion` and a
 * document-level `documentMissingReasonCode` escape hatch so an empty
 * extraction carries a structured reason rather than having one inferred from
 * every field being null. */
export function aieDocumentFactsJsonSchema(params: {
  schemaVersion: string;
  properties: Record<string, unknown>;
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    schemaVersion: { type: 'string', enum: [params.schemaVersion] },
    documentMissingReasonCode: { type: ['string', 'null'], enum: MISSING_REASON_ENUM },
    ...params.properties,
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}
