/**
 * AIE liability-statement AI-fallback adapter — hand-written OpenAI
 * strict-mode JSON Schema mirroring `schema.ts`'s
 * `liabilityStatementDocumentFactsSchema`.
 *
 * See `lib/aie/adapters/shared/openaiFactsSchema.ts`'s header for why this is
 * hand-written rather than derived from the Zod schema, and why forgetting to
 * REGISTER it in `lib/aie/provider/openaiJsonSchema.ts`'s `KNOWN_SCHEMAS` is
 * the specific failure mode this programme has already suffered once (design
 * document §6.1: Investment Intelligence's schema was never added, so every
 * real OpenAI call it made failed with `provider_error` before returning
 * anything usable — with no signal that the cause was a missing registration
 * rather than a provider fault). That registration is made in the same change
 * as this file; neither half is useful without the other.
 *
 * `liabilityStatementDocumentFactsSchema` and this literal must be kept in
 * sync BY HAND. Strict mode has rules Zod's `.strict()` does not: every
 * property must appear in `required`, and a nullable field is a
 * `["type","null"]` union rather than an omitted key.
 *
 * WHAT IS DELIBERATELY NOT ENCODED HERE. String PATTERNS (the decimal-string
 * money format, the ISO date format) are not expressed as JSON-Schema
 * `pattern`s, matching every other adapter in this directory tree: strict mode
 * does not enforce them in this codebase's hand-written schemas, so the format
 * requirements are stated in the shared system prompt instead
 * (`AIE_DOCUMENT_FACTS_FORMAT_INSTRUCTIONS`) and re-checked by this adapter's
 * own Zod re-validation, which turns a mis-formatted response into a typed
 * `schema_rejected` rather than a value the app cannot use.
 */

import {
  aieScalarFieldJsonSchema,
  aieLineItemArrayJsonSchema,
  aieDocumentFactsJsonSchema,
  aieNullableString,
  aieRequiredString,
  aieRequiredEnum,
} from '../shared/openaiFactsSchema';
import { LIABILITY_ACTIVITY_TYPES } from '@/lib/financial-data-hub/liability/types';
import { AIE_LIABILITY_FACTS_SCHEMA_VERSION, AIE_LIABILITY_MAX_ACTIVITIES } from './schema';

export const LIABILITY_FACTS_OPENAI_JSON_SCHEMA: Record<string, unknown> = aieDocumentFactsJsonSchema({
  schemaVersion: AIE_LIABILITY_FACTS_SCHEMA_VERSION,
  properties: {
    institutionName: aieScalarFieldJsonSchema(),
    maskedIdentifier: aieScalarFieldJsonSchema(),
    statementPeriodStart: aieScalarFieldJsonSchema(),
    statementPeriodEnd: aieScalarFieldJsonSchema(),
    statementDate: aieScalarFieldJsonSchema(),
    dueDate: aieScalarFieldJsonSchema(),
    openingBalance: aieScalarFieldJsonSchema(),
    closingBalance: aieScalarFieldJsonSchema(),
    creditLimit: aieScalarFieldJsonSchema(),
    minimumPayment: aieScalarFieldJsonSchema(),
    interestRate: aieScalarFieldJsonSchema(),
    allActivitiesListed: { type: 'boolean' },
    activities: aieLineItemArrayJsonSchema({
      maxItems: AIE_LIABILITY_MAX_ACTIVITIES,
      required: [
        'activityType',
        'activityDate',
        'amount',
        'descriptionRaw',
        'merchantRaw',
        'principalComponent',
        'interestComponent',
        'feeComponent',
      ],
      properties: {
        // The closed FDH-10 vocabulary, reused rather than retyped — see
        // `schema.ts`'s note on why a drifted copy would only be discovered
        // at write time, by a DB CHECK constraint, after the user had already
        // confirmed the draft.
        activityType: aieRequiredEnum(LIABILITY_ACTIVITY_TYPES),
        activityDate: aieRequiredString,
        amount: aieRequiredString,
        // Nullable rather than omitted: strict mode requires every property
        // to be listed in `required`, so "the statement printed no
        // description / no merchant / no component split on this line" has to
        // be expressed as an explicit null.
        descriptionRaw: aieNullableString,
        merchantRaw: aieNullableString,
        principalComponent: aieNullableString,
        interestComponent: aieNullableString,
        feeComponent: aieNullableString,
      },
    }),
  },
});
