/**
 * AIE payslip AI-fallback adapter — hand-written OpenAI strict-mode JSON
 * Schema mirroring `schema.ts`'s `payslipDocumentFactsSchema` exactly.
 *
 * WHY THIS EXISTS AS A SEPARATE, HAND-WRITTEN FILE. See
 * `lib/aie/provider/openaiJsonSchema.ts`'s own header and its 2026-09-22
 * addition comment: this codebase has no Zod-to-JSON-Schema converter by
 * design, and OpenAI's strict Structured Outputs mode has stricter rules
 * than Zod's own `.strict()` (every property must be listed in `required`,
 * nullable-but-optional fields are `["type","null"]` unions rather than
 * simply absent). `payslipDocumentFactsSchema` must be kept in sync with
 * this file BY HAND — there is no mechanical check that could not itself be
 * fooled by a matching-shaped-but-wrong pair, so
 * `tests/unit/aiePayslipOpenAiSchemaShape.test.ts` instead asserts a
 * REPRESENTATIVE payload validates against BOTH `payslipDocumentFactsSchema`
 * (the Zod side) and this literal (structurally, field-by-field) — a
 * best-effort drift detector, not a proof of equivalence.
 */

const MISSING_REASON_ENUM = ['not_present_on_document', 'illegible', 'ambiguous', 'conflicting_values_on_document'];

function moneyFieldJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'missingReasonCode'],
    properties: {
      value: { type: ['string', 'null'] },
      missingReasonCode: { type: ['string', 'null'], enum: [...MISSING_REASON_ENUM, null] },
    },
  };
}

function dateFieldJsonSchema() {
  return moneyFieldJsonSchema();
}

function textFieldJsonSchema() {
  return moneyFieldJsonSchema();
}

function payFrequencyFieldJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'missingReasonCode'],
    properties: {
      value: {
        type: ['string', 'null'],
        enum: ['weekly', 'fortnightly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'irregular', 'unknown', null],
      },
      missingReasonCode: { type: ['string', 'null'], enum: [...MISSING_REASON_ENUM, null] },
    },
  };
}

const MONEY_FIELD_KEYS = [
  'grossPay',
  'basePay',
  'overtimePay',
  'bonusPay',
  'commissionPay',
  'allowancesTotal',
  'reimbursementsTotal',
  'otherEarnings',
  'taxWithheld',
  'employeeDeductionsTotal',
  'salarySacrifice',
  'professionalTax',
  'employerRetirementContribution',
  'employeeRetirementContribution',
  'employerNpsContribution',
  'employeeNpsContribution',
  'netPay',
] as const;

export const PAYSLIP_DOCUMENT_FACTS_OPENAI_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'documentMissingReasonCode',
    'employerName',
    'payPeriodStart',
    'payPeriodEnd',
    'paymentDate',
    'payFrequency',
    ...MONEY_FIELD_KEYS,
  ],
  properties: {
    schemaVersion: { type: 'string', enum: ['1'] },
    documentMissingReasonCode: { type: ['string', 'null'], enum: [...MISSING_REASON_ENUM, null] },
    employerName: textFieldJsonSchema(),
    payPeriodStart: dateFieldJsonSchema(),
    payPeriodEnd: dateFieldJsonSchema(),
    paymentDate: dateFieldJsonSchema(),
    payFrequency: payFrequencyFieldJsonSchema(),
    ...Object.fromEntries(MONEY_FIELD_KEYS.map((k) => [k, moneyFieldJsonSchema()])),
  },
};
