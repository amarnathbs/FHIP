/**
 * Hand-written OpenAI strict-mode JSON Schema mirroring ./schema.ts (registered in lib/aie/provider/openaiJsonSchema.ts -- forgetting that
 * registration makes every real call fail as provider_error, the failure this programme has already suffered once).
 * Kept in sync BY HAND; tests/unit/bankCategoriseAi.test.ts checks one payload against both.
 */
import { AIE_BANK_CATEGORISE_CONFIDENCE, AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL } from './schema';

export const BANK_CATEGORISE_OPENAI_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'categoryKey', 'confidence'],
        properties: {
          key: { type: 'string' },
          categoryKey: { type: 'string' },
          confidence: { type: 'string', enum: [...AIE_BANK_CATEGORISE_CONFIDENCE] },
        },
      },
    },
  },
};
