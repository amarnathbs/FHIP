/**
 * AIE-1.4 — Insurance adapter's own versioned schema, registered against
 * AIE-1.1's EXISTING Zod-based schema registry
 * (`lib/aie/schema/schemaRegistry.ts`'s `aieSchemaRegistry`) — mandatory
 * execution sequence step 5: "using AIE-1.1's JSON-Schema-equivalent (Zod)
 * registry — do not introduce a second schema mechanism." Same pattern as
 * AIE-1.2's `lib/aie/adapters/investment-intelligence/schema.ts`.
 *
 * NON-NEGOTIABLE PROHIBITION ENFORCED BY SCHEMA SHAPE. AIE14 section 4: "No
 * AI advice, ownership invention, tax classification, live valuation or
 * balancing value." `ALLOWED_AI_COMPLETABLE_FIELDS` is a closed enum
 * containing exactly ONE narrative field — never an identity, money,
 * currency, date or owner/insured/beneficiary field. Because the schema is
 * `.strict()` and `fieldName` is a `z.enum` over exactly this list, any
 * masked-AI response naming another field is a schema-validation REJECTION
 * (JSC-03 unknown-key rejection composed with this narrower enum), not a
 * policy check a call site could forget.
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';

export const AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME = 'aie_insurance_adapter_field_completion';
export const AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION = '1';

/** Deliberately narrow. `policyNameClarification` is a product/plan LABEL
 * clarification only (e.g. disambiguating "Life Cover" vs a printed product
 * brand name already visible elsewhere on the document) — never a value,
 * currency, date, or any owner/insured/beneficiary identity field. */
export const ALLOWED_AI_COMPLETABLE_FIELDS = ['policyNameClarification'] as const;
export type AllowedAiCompletableField = (typeof ALLOWED_AI_COMPLETABLE_FIELDS)[number];

export const insuranceAdapterFieldCompletionSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            fieldName: z.enum(ALLOWED_AI_COMPLETABLE_FIELDS),
            value: z.string().nullable(),
            nullReason: z.enum(['not_present_on_document', 'illegible', 'ambiguous']).nullable(),
            sourceReferenceId: z.string().min(1),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

let registeredSchema = false;

export function registerInsuranceAdapterSchema(): void {
  if (registeredSchema) return;
  aieSchemaRegistry.register({
    name: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
    version: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
    schema: insuranceAdapterFieldCompletionSchema,
    ownerAdapterId: 'insurance_generic_schedule_v1',
  });
  registeredSchema = true;
}
