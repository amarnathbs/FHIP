// Module 11 remediation R2 — OpenAI Structured Outputs JSON Schemas for the
// two response contracts AIModelGateway validates (brief section 12: "Use
// strict structured output").
//
// OpenAI strict mode (`response_format.json_schema.strict = true`) rules
// that shape everything below:
//   * every object must list ALL its properties in `required`;
//   * every object must set `additionalProperties: false`;
//   * "optional" is expressed as a nullable type, never by omission;
//   * a record with a variable key set is not expressible — so the pack's
//     `blocks` map is emitted as an object with EVERY block code as a
//     nullable property, and lib/ai/insightPack/types.ts strips the nulls
//     before zod validation.
//
// These schemas are the WIRE contract only. The authoritative contract is
// still the zod schema (packEnvelopeSchema / aiResponseEnvelopeSchema),
// which runs on every response regardless of provider — a provider that
// returned something the JSON schema allowed but zod rejects is still
// rejected. Length caps (max 200/400/1200 chars etc.) live in zod, not here.

import { PACK_BLOCK_CODES, PACK_SCHEMA_VERSION, PACK_CONFIDENCE_LEVELS } from '@/lib/ai/insightPack/types';
import { SAFETY_CLASSIFICATIONS, CONFIDENCE_LEVELS } from '@/lib/ai/structuredOutput';

export type OpenAiResponseSchemaName = 'ai_response_envelope' | 'insight_pack_envelope';

type JsonSchema = Record<string, unknown>;

const str: JsonSchema = { type: 'string' };
const nullableStr: JsonSchema = { type: ['string', 'null'] };
const strArray: JsonSchema = { type: 'array', items: { type: 'string' } };

function strictObject(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

const metricClaim = strictObject({
  metric_code: str,
  source_value: { type: ['number', 'null'] },
  display_value: str,
  currency: nullableStr,
});

const sourceRefClaim = strictObject({ source_type: str, source_id: str });

const packBlock = strictObject({
  block_code: { type: 'string', enum: [...PACK_BLOCK_CODES] },
  status: { type: 'string', enum: ['POPULATED', 'UNAVAILABLE', 'PARTIAL'] },
  headline: str,
  short_answer: str,
  explanation: str,
  why_it_matters: str,
  metric_claims: { type: 'array', items: metricClaim },
  source_refs: { type: 'array', items: sourceRefClaim },
  limitations: strArray,
  confidence: { type: 'string', enum: [...PACK_CONFIDENCE_LEVELS] },
  data_as_of: nullableStr,
  related_module: nullableStr,
  action_route: nullableStr,
});

const priorityItem = strictObject({
  rank: { type: 'integer' },
  action_code: str,
  explanation: str,
});

const blocksObject = strictObject(
  Object.fromEntries(PACK_BLOCK_CODES.map((code) => [code, { anyOf: [packBlock, { type: 'null' }] }]))
);

export const INSIGHT_PACK_ENVELOPE_JSON_SCHEMA: JsonSchema = strictObject({
  pack_version: { type: 'string', enum: [PACK_SCHEMA_VERSION] },
  snapshot_id: str,
  data_as_of: nullableStr,
  reporting_currency: { type: 'string', enum: ['AUD', 'INR'] },
  overall_confidence: { type: 'string', enum: [...PACK_CONFIDENCE_LEVELS] },
  blocks: blocksObject,
  top_strengths: strArray,
  top_risks: strArray,
  priority_review_areas: { type: 'array', items: priorityItem },
  limitations: strArray,
});

const envelopeSourceRef = strictObject({
  source_type: str,
  source_id: str,
  model_version: nullableStr,
  data_as_of: nullableStr,
});

export const AI_RESPONSE_ENVELOPE_JSON_SCHEMA: JsonSchema = strictObject({
  answer_type: str,
  headline: str,
  summary: str,
  key_points: strArray,
  actions: strArray,
  source_refs: { type: 'array', items: envelopeSourceRef },
  confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
  data_as_of: nullableStr,
  limitations: strArray,
  safety_classification: { type: 'string', enum: [...SAFETY_CLASSIFICATIONS] },
  prompt_version: str,
  model_version: str,
});

/** Closed registry: an unknown schema name throws rather than defaulting to a permissive `json_object` mode. */
export function getOpenAiJsonSchema(name: OpenAiResponseSchemaName): { name: string; schema: JsonSchema } {
  switch (name) {
    case 'insight_pack_envelope':
      return { name: `insight_pack_envelope_${PACK_SCHEMA_VERSION.replace(/[^a-zA-Z0-9_]/g, '_')}`, schema: INSIGHT_PACK_ENVELOPE_JSON_SCHEMA };
    case 'ai_response_envelope':
      return { name: 'ai_response_envelope_v1', schema: AI_RESPONSE_ENVELOPE_JSON_SCHEMA };
    default: {
      const never: never = name;
      throw new Error(`Unknown OpenAI response schema: ${String(never)}`);
    }
  }
}
