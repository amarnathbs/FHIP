/**
 * AIE retirement-statement AI-fallback adapter — hand-written OpenAI
 * strict-mode JSON Schema mirroring `schema.ts`'s
 * `retirementDocumentFactsSchema`.
 *
 * See `lib/aie/adapters/shared/openaiFactsSchema.ts`'s header for why this is
 * hand-written rather than derived, and why omitting the `KNOWN_SCHEMAS`
 * registration is the specific failure this programme has already suffered
 * once (design document §6.1).
 *
 * This literal and the Zod schema must be kept in sync BY HAND.
 * `tests/unit/aieUnifiedFallbackSchemaShape.test.ts` validates a
 * representative payload against BOTH — a best-effort drift detector, not a
 * proof of equivalence.
 */

import {
  aieScalarFieldJsonSchema,
  aieLineItemArrayJsonSchema,
  aieDocumentFactsJsonSchema,
  aieNullableString,
  aieRequiredString,
  aieRequiredEnum,
} from '../shared/openaiFactsSchema';
import { RETIREMENT_ACTIVITY_TYPES } from '@/lib/financial-data-hub/retirement/types';
import { AIE_RETIREMENT_FACTS_SCHEMA_VERSION, AIE_RETIREMENT_MAX_ACTIVITIES, AIE_RETIREMENT_MAX_POSITIONS } from './schema';

const SCALAR_MONEY_KEYS = [
  'openingBalance',
  'closingBalance',
  'employerContributions',
  'personalContributions',
  'salarySacrifice',
  'governmentContributions',
  'rolloversIn',
  'rolloversOut',
  'withdrawals',
  'pensionPayments',
  'investmentEarnings',
  'fees',
  'insurancePremiums',
  'tax',
] as const;

export const RETIREMENT_FACTS_OPENAI_JSON_SCHEMA: Record<string, unknown> = aieDocumentFactsJsonSchema({
  schemaVersion: AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
  properties: {
    fundName: aieScalarFieldJsonSchema(),
    maskedAccountIdentifier: aieScalarFieldJsonSchema(),
    statementDate: aieScalarFieldJsonSchema(),
    statementStartDate: aieScalarFieldJsonSchema(),
    statementEndDate: aieScalarFieldJsonSchema(),
    ...Object.fromEntries(SCALAR_MONEY_KEYS.map((k) => [k, aieScalarFieldJsonSchema()])),
    activities: aieLineItemArrayJsonSchema({
      maxItems: AIE_RETIREMENT_MAX_ACTIVITIES,
      required: ['activityType', 'amount', 'activityDate', 'descriptionRaw', 'employerNameRaw', 'isSummaryTotal', 'isYearToDate'],
      properties: {
        activityType: aieRequiredEnum(RETIREMENT_ACTIVITY_TYPES),
        amount: aieRequiredString,
        // Strict mode requires every property in `required`, so "the
        // statement did not print this" is an explicit null, not an omission.
        activityDate: aieNullableString,
        descriptionRaw: aieNullableString,
        employerNameRaw: aieNullableString,
        isSummaryTotal: { type: 'boolean' },
        isYearToDate: { type: 'boolean' },
      },
    }),
    positions: aieLineItemArrayJsonSchema({
      maxItems: AIE_RETIREMENT_MAX_POSITIONS,
      required: ['optionNameRaw', 'assetClassRaw', 'units', 'unitPrice', 'marketValue', 'valuationDate'],
      properties: {
        optionNameRaw: aieRequiredString,
        assetClassRaw: aieNullableString,
        units: aieNullableString,
        unitPrice: aieNullableString,
        marketValue: aieNullableString,
        valuationDate: aieNullableString,
      },
    }),
  },
});
