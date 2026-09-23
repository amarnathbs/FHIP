/**
 * AIE AU investment-statement (FDH-11) AI-fallback adapter — hand-written
 * OpenAI strict-mode JSON Schema mirroring `schema.ts`'s
 * `auInvestmentDocumentFactsSchema`.
 *
 * See `lib/aie/adapters/shared/openaiFactsSchema.ts`'s header for why this is
 * hand-written rather than derived from the Zod schema, and why FAILING TO
 * REGISTER IT is the specific failure mode this programme has already suffered
 * once (design document §6.1: Investment Intelligence's own facts schema was
 * never added to `openaiJsonSchema.ts`'s `KNOWN_SCHEMAS`, so every real OpenAI
 * call its live fallback mechanism made failed with `provider_error` before
 * returning anything usable, with no signal that a missing map entry — rather
 * than a provider fault — was the cause). The matching registration for THIS
 * schema is in `lib/aie/provider/openaiJsonSchema.ts`; changing this file
 * without that one registered achieves nothing.
 *
 * `auInvestmentDocumentFactsSchema` and this literal must be kept in sync BY
 * HAND. Strict mode requires every property to appear in `required`, so a
 * field the model may omit is expressed as an explicit nullable type rather
 * than by being left out.
 */

import {
  aieScalarFieldJsonSchema,
  aieLineItemArrayJsonSchema,
  aieDocumentFactsJsonSchema,
  aieNullableString,
  aieRequiredString,
  aieRequiredEnum,
} from '../shared/openaiFactsSchema';
import { AU_STATEMENT_TRANSACTION_TYPES } from '@/lib/financial-data-hub/investment/types';
import {
  AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
  AIE_AU_INVESTMENT_MAX_HOLDINGS,
  AIE_AU_INVESTMENT_MAX_TRANSACTIONS,
} from './schema';

export const AU_INVESTMENT_FACTS_OPENAI_JSON_SCHEMA: Record<string, unknown> = aieDocumentFactsJsonSchema({
  schemaVersion: AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
  properties: {
    institutionName: aieScalarFieldJsonSchema(),
    statementDate: aieScalarFieldJsonSchema(),
    statementPeriodStart: aieScalarFieldJsonSchema(),
    statementPeriodEnd: aieScalarFieldJsonSchema(),
    allRowsListed: { type: 'boolean' },
    holdings: aieLineItemArrayJsonSchema({
      maxItems: AIE_AU_INVESTMENT_MAX_HOLDINGS,
      required: ['securityNameRaw', 'tickerRaw', 'isin', 'quantity', 'unitPrice', 'marketValue', 'valuationDate'],
      properties: {
        securityNameRaw: aieRequiredString,
        tickerRaw: aieNullableString,
        isin: aieNullableString,
        quantity: aieRequiredString,
        unitPrice: aieNullableString,
        marketValue: aieNullableString,
        valuationDate: aieNullableString,
      },
    }),
    transactions: aieLineItemArrayJsonSchema({
      maxItems: AIE_AU_INVESTMENT_MAX_TRANSACTIONS,
      required: ['transactionType', 'tradeDate', 'settlementDate', 'securityNameRaw', 'tickerRaw', 'quantity', 'unitPrice', 'amount', 'brokerage'],
      properties: {
        // The CLOSED FDH-11 statement vocabulary, shared with the native
        // parser rather than re-declared here — including its own `UNKNOWN`
        // member, which is what the model is told to use for a line whose
        // meaning the statement does not print.
        transactionType: aieRequiredEnum(AU_STATEMENT_TRANSACTION_TYPES),
        tradeDate: aieNullableString,
        settlementDate: aieNullableString,
        securityNameRaw: aieNullableString,
        tickerRaw: aieNullableString,
        quantity: aieNullableString,
        unitPrice: aieNullableString,
        amount: aieRequiredString,
        brokerage: aieNullableString,
      },
    }),
  },
});
