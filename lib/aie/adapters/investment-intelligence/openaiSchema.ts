/**
 * AIE-1 final-closure gap #2 (2026-09-22) — hand-written OpenAI strict-mode
 * JSON Schema mirroring `documentFactsSchema.ts`'s `investmentDocumentFactsSchema`
 * exactly.
 *
 * WHY THIS FILE EXISTS. `lib/aie/provider/openaiJsonSchema.ts`'s own header
 * explains this codebase has no Zod-to-JSON-Schema converter by design, and
 * its `KNOWN_SCHEMAS` map only ever covered the ONE recurring
 * "bounded array of typed field candidates" envelope shape — until a
 * separate, concurrent dispatch (2026-09-22, the payslip AI-fallback
 * adapter) found, via its own live-DEV proof against the real provider, that
 * `investmentDocumentFactsSchema` (a richly nested whole-document object:
 * `positions[].transactions[]...`) had NEVER been added to that map at all.
 * Calling the real gateway with `schemaName: AIE_II_DOCUMENT_FACTS_SCHEMA_NAME`
 * throws "no strict JSON Schema mapping registered" before any HTTP request
 * is even made — meaning Investment Intelligence's live AI-fallback
 * mechanism (`lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts`,
 * and this adapter's own `dispatch.ts`/`orchestrator.ts` path) could never
 * complete a real OpenAI call. That earlier dispatch deliberately left this
 * unfixed (flagged as a dedicated follow-up, out of its own payslip-scoped
 * time budget) — this file is that follow-up, done as part of AIE-1's own
 * Investment Intelligence HTTP dispatch closure work.
 *
 * THIS FILE MUST BE KEPT IN SYNC BY HAND with `documentFactsSchema.ts`'s
 * `investmentDocumentFactsSchema` — there is no mechanical converter that
 * could not itself be fooled by a matching-shaped-but-wrong pair.
 * `tests/unit/aieIiOpenAiSchemaShape.test.ts` is the best-effort mechanical
 * drift detector (a representative payload validates against BOTH sides,
 * plus structural required/additionalProperties checks), not a proof of full
 * semantic equivalence.
 *
 * DELIBERATE SIMPLIFICATIONS VS THE ZOD SIDE (same discipline the payslip
 * mirror already established): regex-constrained strings on the Zod side
 * (ISO dates, exact-decimal strings, ISIN format) are represented here as
 * plain `["string","null"]` types, WITHOUT a `pattern` constraint. OpenAI's
 * strict Structured Outputs mode's exact supported JSON Schema keyword
 * subset for `pattern` is not something this codebase has proven safe
 * end-to-end, and a malformed `pattern` the provider silently ignored (or
 * rejected the whole schema over) would be a worse failure mode than relying
 * on the Zod side's own regex re-validation after the fact — a
 * format-violating value is still caught, just one layer later, and
 * surfaces as an honest `schema_rejected` outcome rather than a wrong or
 * unexplained provider-side schema error. The Zod schema remains the sole
 * validation authority; this file only has to be loose enough to accept
 * every value the Zod side would, and closed (via enums/additionalProperties)
 * everywhere the Zod side is closed.
 *
 * `superRefine` cross-field checks in `investmentDocumentFactsSchema`
 * (`isin`/`isinPresentOnDocument` coherence, `openingUnitBalance`/
 * `openingBalanceStatedOnDocument` coherence) have no JSON Schema
 * equivalent — strict mode has no conditional-on-sibling-value construct
 * usable here. A model that violates either coherence rule still gets
 * caught by the Zod side's `superRefine` and reported as `schema_rejected`,
 * exactly like every other adapter's out-of-band business rule.
 */

const MISSING_REASON_ENUM = ['not_present_on_document', 'illegible', 'ambiguous', 'conflicting_values_on_document'];

const II_AI_TRANSACTION_TYPE_CANDIDATES = [
  'purchase',
  'sip',
  'redemption',
  'dividend',
  'reinvestment',
  'transfer',
  'fee',
  'tax',
  'adjustment',
  'reversal',
  'unclassified',
  'unknown',
];

const FEE_KIND_ENUM = ['stamp_duty', 'stt', 'other', 'none'];

const DOCUMENT_TYPE_CANDIDATE_ENUM = ['cas_statement', 'folio_details_statement', 'account_statement', 'unknown'];

function nullableString() {
  return { type: ['string', 'null'] };
}

function nullableInt() {
  return { type: ['integer', 'null'] };
}

function nullableEnum(values: readonly string[]) {
  return { type: ['string', 'null'], enum: [...values, null] };
}

function sourceLocationJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['page', 'line', 'rawText'],
    properties: {
      page: nullableInt(),
      line: nullableInt(),
      rawText: nullableString(),
    },
  };
}

function transactionFactJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'transactionDateIso',
      'narrative',
      'transactionTypeCandidate',
      'amount',
      'units',
      'navOrPrice',
      'runningUnitBalance',
      'feeAmount',
      'feeKind',
      'missingReasonCode',
      'sourceLocation',
    ],
    properties: {
      transactionDateIso: nullableString(),
      narrative: nullableString(),
      // Required and NOT nullable on the Zod side (z.enum with no
      // .nullable()) — every transaction must state a type candidate,
      // falling back to 'unknown' rather than null when the narrative does
      // not identify one.
      transactionTypeCandidate: { type: 'string', enum: [...II_AI_TRANSACTION_TYPE_CANDIDATES] },
      amount: nullableString(),
      units: nullableString(),
      navOrPrice: nullableString(),
      runningUnitBalance: nullableString(),
      feeAmount: nullableString(),
      // Required and NOT nullable on the Zod side.
      feeKind: { type: 'string', enum: [...FEE_KIND_ENUM] },
      missingReasonCode: nullableEnum(MISSING_REASON_ENUM),
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
      folioToken: nullableString(),
      amcOrInstitutionText: nullableString(),
      schemeText: nullableString(),
      isin: nullableString(),
      // Required and NOT nullable on the Zod side (a plain z.boolean()).
      isinPresentOnDocument: { type: 'boolean' },
      openingUnitBalance: nullableString(),
      // Required and NOT nullable on the Zod side.
      openingBalanceStatedOnDocument: { type: 'boolean' },
      closingUnits: nullableString(),
      statementNav: nullableString(),
      statementNavDateIso: nullableString(),
      statementMarketValue: nullableString(),
      missingReasonCode: nullableEnum(MISSING_REASON_ENUM),
      sourceLocation: sourceLocationJsonSchema(),
      transactions: { type: 'array', maxItems: 500, items: transactionFactJsonSchema() },
    },
  };
}

export const INVESTMENT_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'documentTypeCandidate',
    'sourceInstitutionText',
    'statementPeriodStartIso',
    'statementPeriodEndIso',
    'statementAsOfDateIso',
    'positions',
    'missingReasonCode',
  ],
  properties: {
    schemaVersion: { type: 'string', enum: ['1'] },
    // Required and NOT nullable on the Zod side.
    documentTypeCandidate: { type: 'string', enum: [...DOCUMENT_TYPE_CANDIDATE_ENUM] },
    sourceInstitutionText: nullableString(),
    statementPeriodStartIso: nullableString(),
    statementPeriodEndIso: nullableString(),
    statementAsOfDateIso: nullableString(),
    positions: { type: 'array', maxItems: 200, items: positionFactJsonSchema() },
    missingReasonCode: nullableEnum(MISSING_REASON_ENUM),
  },
};
