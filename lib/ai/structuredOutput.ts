// Module 11.0 — structured output contract (spec section 45).
//
// Every provider response, mock or real, is validated against this schema
// before anything downstream (an audit row, a future UI) is allowed to see
// it. A response that fails validation is REJECTED — the gateway never
// passes through a provider's raw JSON on the theory that "it's probably
// fine" (spec section 47: fail closed).

import { z } from 'zod';

export const SAFETY_CLASSIFICATIONS = [
  'GENERAL_EDUCATION',
  'FHIP_EXPLANATION',
  'SCENARIO_REQUEST',
  'PRODUCT_ADVICE',
  'TAX_ADVICE',
  'LEGAL_ADVICE',
  'MONEY_MOVEMENT',
  'DATA_WRITE',
  'UNSUPPORTED_PREDICTION',
  'PRIVACY_SENSITIVE',
  'PROMPT_INJECTION_SUSPECTED',
] as const;
export type SafetyClassification = (typeof SAFETY_CLASSIFICATIONS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

export const sourceRefSchema = z.object({
  source_type: z.string().min(1),
  source_id: z.string().min(1),
  model_version: z.string().nullable(),
  data_as_of: z.string().nullable(),
});

export const aiResponseEnvelopeSchema = z
  .object({
    answer_type: z.string().min(1),
    headline: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    key_points: z.array(z.string()).max(20),
    actions: z.array(z.string()).max(10),
    source_refs: z.array(sourceRefSchema).max(50),
    confidence: z.enum(CONFIDENCE_LEVELS),
    data_as_of: z.string().nullable(),
    limitations: z.array(z.string()).max(20),
    safety_classification: z.enum(SAFETY_CLASSIFICATIONS),
    prompt_version: z.string().min(1),
    model_version: z.string().min(1),
  })
  .strict();

export type AIResponseEnvelope = z.infer<typeof aiResponseEnvelopeSchema>;

export type ValidationOutcome =
  | { ok: true; envelope: AIResponseEnvelope }
  | { ok: false; reason: string };

/**
 * Parses and validates a raw provider text response. Rejects (does not
 * throw) on: non-JSON text, missing/extra fields (schema is `.strict()`,
 * spec section 45 "do not trust arbitrary provider JSON"), an
 * out-of-vocabulary safety_classification or confidence value, or a
 * source_refs entry missing required fields.
 */
export function validateProviderResponse(rawText: string): ValidationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'Provider response was not valid JSON.' };
  }
  const result = aiResponseEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `Schema validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  return { ok: true, envelope: result.data };
}

/**
 * Cross-checks that every source_ref cited in a validated envelope is one
 * FHIP itself actually offered in the context (spec section 51-E: "Provider
 * output references an unknown source" must fail safely). Returns the list
 * of unknown source_ids, empty if all are known.
 */
export function findUnknownSourceRefs(envelope: AIResponseEnvelope, knownSourceIds: ReadonlySet<string>): string[] {
  return envelope.source_refs.map((r) => r.source_id).filter((id) => !knownSourceIds.has(id));
}
