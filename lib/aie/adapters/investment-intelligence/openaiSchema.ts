/**
 * AIE Investment Intelligence AI-fallback adapter — hand-written OpenAI
 * strict-mode JSON Schema mirroring `documentFactsSchema.ts`'s
 * `investmentDocumentFactsSchema` exactly.
 *
 * WHY THIS EXISTS, AND WHY IT WAS MISSING UNTIL NOW. See
 * `lib/aie/provider/openaiJsonSchema.ts`'s 2026-09-22 addition comment for
 * the full disclosure: this schema was never registered in that file's
 * `KNOWN_SCHEMAS`, so every real OpenAI call Investment Intelligence's live
 * AI-fallback mechanism made failed before returning usable data
 * (`provider_error`, from `getKnownOpenAiJsonSchema` throwing). This file
 * and that registration close exactly that gap — nothing else in the II
 * AI-fallback pipeline changes.
 *
 * `investmentDocumentFactsSchema` must be kept in sync with this file BY
 * HAND — there is no mechanical converter in this codebase by design (see
 * `openaiJsonSchema.ts`'s own header) — so
 * `tests/unit/aieIiOpenAiSchemaShape.test.ts` asserts a REPRESENTATIVE
 * payload validates against BOTH the Zod schema and this literal
 * (structurally, recursively, field-by-field, including every nested
 * `positions[]`/`transactions[]`/`sourceLocation` object), mirroring the
 * payslip adapter's own established drift-detection pattern
 * (`tests/unit/aiePayslipOpenAiSchemaShape.test.ts`) — a best-effort drift
 * detector, not a proof of full semantic equivalence.
 *
 * WHAT IS DELIBERATELY NOT ENCODED, MATCHING THE PAYSLIP SCHEMA'S OWN
 * PRECEDENT. Neither string-length caps (`.max(200)` etc.) nor regex
 * patterns (decimal-string, ISO-date, ISIN shape) are encoded as JSON Schema
 * keywords here — `payslipDocumentFactsSchema`'s own OpenAI literal
 * (`payslip/openaiSchema.ts`) does the same (its money/date/text field
 * builders all reduce to a bare `{type:['string','null']}`), relying
 * instead on the caller's own Zod re-validation
 * (`investmentDocumentFactsSchema.parse(...)` in
 * `aiFallbackDocumentExtraction.ts`) as the actual correctness gate. This
 * file only needs to get the provider PAST `provider_error` into a real
 * `success`/`schema_rejected`/`refused` outcome; the Zod schema — including
 * its cross-field `superRefine` rules (ISIN/opening-balance presence pairs),
 * which strict-mode JSON Schema has no way to express at all — remains the
 * sole authority on whether a response is actually accepted.
 */

import { II_MISSING_REASON_CODES, II_AI_TRANSACTION_TYPE_CANDIDATES } from './documentFactsSchema';

function missingReasonFieldJsonSchema() {
  return { type: ['string', 'null'], enum: [...II_MISSING_REASON_CODES, null] };
}

function sourceLocationJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['page', 'line', 'rawText'],
    properties: {
      page: { type: ['integer', 'null'] },
      line: { type: ['integer', 'null'] },
      rawText: { type: ['string', 'null'] },
    },
  };
}

function transactionFactJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['transactionDateIso', 'narrative', 'transactionTypeCandidate', 'amount', 'units', 'navOrPrice', 'runningUnitBalance', 'feeAmount', 'feeKind', 'missingReasonCode', 'sourceLocation'],
    properties: {
      transactionDateIso: { type: ['string', 'null'] },
      narrative: { type: ['string', 'null'] },
      transactionTypeCandidate: { type: 'string', enum: [...II_AI_TRANSACTION_TYPE_CANDIDATES] },
      amount: { type: ['string', 'null'] },
      units: { type: ['string', 'null'] },
      navOrPrice: { type: ['string', 'null'] },
      runningUnitBalance: { type: ['string', 'null'] },
      feeAmount: { type: ['string', 'null'] },
      feeKind: { type: 'string', enum: ['stamp_duty', 'stt', 'other', 'none'] },
      missingReasonCode: missingReasonFieldJsonSchema(),
      sourceLocation: sourceLocationJsonSchema(),
    },
  };
}

function positionFactJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'folioToken',
      'amcOrInstitutionText',
      'schemeText',
      'isin',
      'isinPresentOnDocument',
      'openingUnitBalance',
      'openingBalanceStatedOnDocument',
      'closingUnits',
      'statementNav',
      'statementNavDateIso',
      'statementMarketValue',
      'missingReasonCode',
      'sourceLocation',
      'transactions',
    ],
    properties: {
      folioToken: { type: ['string', 'null'] },
      amcOrInstitutionText: { type: ['string', 'null'] },
      schemeText: { type: ['string', 'null'] },
      isin: { type: ['string', 'null'] },
      isinPresentOnDocument: { type: 'boolean' },
      openingUnitBalance: { type: ['string', 'null'] },
      openingBalanceStatedOnDocument: { type: 'boolean' },
      closingUnits: { type: ['string', 'null'] },
      statementNav: { type: ['string', 'null'] },
      statementNavDateIso: { type: ['string', 'null'] },
      statementMarketValue: { type: ['string', 'null'] },
      missingReasonCode: missingReasonFieldJsonSchema(),
      sourceLocation: sourceLocationJsonSchema(),
      transactions: {
        type: 'array',
        maxItems: 500,
        items: transactionFactJsonSchema(),
      },
    },
  };
}

export const INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'documentTypeCandidate', 'sourceInstitutionText', 'statementPeriodStartIso', 'statementPeriodEndIso', 'statementAsOfDateIso', 'positions', 'missingReasonCode'],
  properties: {
    schemaVersion: { type: 'string', enum: ['1'] },
    documentTypeCandidate: { type: 'string', enum: ['cas_statement', 'folio_details_statement', 'account_statement', 'unknown'] },
    sourceInstitutionText: { type: ['string', 'null'] },
    statementPeriodStartIso: { type: ['string', 'null'] },
    statementPeriodEndIso: { type: ['string', 'null'] },
    statementAsOfDateIso: { type: ['string', 'null'] },
    positions: {
      type: 'array',
      maxItems: 200,
      items: positionFactJsonSchema(),
    },
    missingReasonCode: missingReasonFieldJsonSchema(),
  },
};
