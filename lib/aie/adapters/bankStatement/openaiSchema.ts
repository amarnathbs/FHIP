/**
 * AIE bank-statement AI-fallback adapter — hand-written OpenAI strict-mode
 * JSON Schema mirroring `schema.ts`'s `bankStatementDocumentFactsSchema`.
 *
 * See `lib/aie/adapters/shared/openaiFactsSchema.ts`'s header for why this is
 * hand-written rather than derived, and why forgetting to register it is the
 * specific failure mode this programme has already suffered once
 * (design document §6.1: Investment Intelligence's schema was never added to
 * `KNOWN_SCHEMAS`, so every real OpenAI call it made failed with
 * `provider_error` before returning anything usable).
 *
 * `bankStatementDocumentFactsSchema` and this literal must be kept in sync BY
 * HAND. `tests/unit/aieUnifiedFallbackSchemaShape.test.ts` asserts a
 * representative payload validates against BOTH — a best-effort drift
 * detector, not a proof of equivalence.
 */

import {
  aieScalarFieldJsonSchema,
  aieMoneyFieldJsonSchema,
  aieLineItemArrayJsonSchema,
  aieDocumentFactsJsonSchema,
  aieNullableString,
  aieRequiredString,
  aieRequiredEnum,
} from '../shared/openaiFactsSchema';
import { AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION, AIE_BANK_STATEMENT_MAX_TRANSACTIONS, BANK_STATEMENT_CREDIT_DEBIT } from './schema';

export const BANK_STATEMENT_FACTS_OPENAI_JSON_SCHEMA: Record<string, unknown> = aieDocumentFactsJsonSchema({
  schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
  properties: {
    institutionName: aieScalarFieldJsonSchema(),
    maskedAccountIdentifier: aieScalarFieldJsonSchema(),
    statementPeriodStart: aieScalarFieldJsonSchema(),
    statementPeriodEnd: aieScalarFieldJsonSchema(),
    declaredOpeningBalance: aieMoneyFieldJsonSchema(),
    declaredClosingBalance: aieMoneyFieldJsonSchema(),
    allTransactionsListed: { type: 'boolean' },
    transactions: aieLineItemArrayJsonSchema({
      maxItems: AIE_BANK_STATEMENT_MAX_TRANSACTIONS,
      required: ['transactionDate', 'descriptionRaw', 'amount', 'creditDebit', 'balanceAfter'],
      properties: {
        transactionDate: aieRequiredString,
        descriptionRaw: aieRequiredString,
        amount: aieRequiredString,
        creditDebit: aieRequiredEnum(BANK_STATEMENT_CREDIT_DEBIT),
        // Nullable rather than omitted: strict mode requires every property to
        // be listed in `required`, so "the statement printed no running
        // balance on this line" has to be expressed as an explicit null.
        balanceAfter: aieNullableString,
      },
    }),
  },
});
