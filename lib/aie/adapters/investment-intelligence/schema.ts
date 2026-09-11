/**
 * AIE-1.2 — the Investment Intelligence adapter's own versioned schema,
 * registered against AIE-1.1's EXISTING Zod-based schema registry
 * (`lib/aie/schema/schemaRegistry.ts`'s `aieSchemaRegistry`) — mandatory
 * execution sequence step 5: "using AIE-1.1's JSON-Schema-equivalent (Zod)
 * registry — do not introduce a second schema mechanism."
 *
 * NON-NEGOTIABLE PROHIBITION ENFORCED BY SCHEMA SHAPE, NOT JUST POLICY TEXT:
 * "No AI-created instrument identifier, owner, account, currency, FX, or
 * cost base." `ALLOWED_AI_COMPLETABLE_FIELDS` below is a closed enum that
 * intentionally does not, and must never, include any identity/instrument/
 * currency/cost-base/FX field name. Because the schema is `.strict()` and
 * `fieldName` is a `z.enum` over exactly this list, a masked-AI response
 * naming any other field is a schema-validation REJECTION (JSC-03 unknown-
 * key rejection composed with this narrower enum), not a policy check that
 * could be forgotten at a call site.
 *
 * As `parserAdapter.ts` discloses, no real II parser today reports a gap
 * this schema could legitimately fill — this schema exists so the
 * architecture is in place (per the spec's own phased AI-fallback design),
 * but it is UNEXERCISED by any real document in this pass. Any future
 * genuine gap (e.g. an illegible narrative fragment on an otherwise fully
 * extracted line) is expected to add a field to this SAME enum, under a
 * bumped version, not a new schema mechanism.
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';

export const AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME = 'aie_ii_adapter_field_completion';
export const AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION = '1';

/** Deliberately narrow. Every entry here must be a narrative/clarification
 * field only — never identity, instrument, currency, FX or cost-base. */
export const ALLOWED_AI_COMPLETABLE_FIELDS = ['sourceDescriptionClarification'] as const;
export type AllowedAiCompletableField = (typeof ALLOWED_AI_COMPLETABLE_FIELDS)[number];

export const investmentAdapterFieldCompletionSchema = z
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
      .max(20),
  })
  .strict();

let registeredSchema = false;

export function registerInvestmentAdapterSchema(): void {
  if (registeredSchema) return;
  aieSchemaRegistry.register({
    name: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
    version: AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
    schema: investmentAdapterFieldCompletionSchema,
    ownerAdapterId: 'ii_cas_kfintech_folio_v1',
  });
  registeredSchema = true;
}
