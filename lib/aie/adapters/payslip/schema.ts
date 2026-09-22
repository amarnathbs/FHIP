/**
 * AIE payslip AI-fallback adapter — versioned whole-document facts contract.
 *
 * Same shape and the same anti-invention discipline as
 * `lib/aie/adapters/investment-intelligence/documentFactsSchema.ts` (see that
 * file's own header for the full rationale, not repeated here): every
 * scalar the model could guess is `.nullable()` and paired with a
 * `missingReasonCode` drawn from a CLOSED enum, so "I don't know" always has
 * a typed shape and a plausible guess never does. Money values are exact
 * decimal STRINGS, never JSON numbers (`decimalStringField`, already
 * established by `lib/aie/schema/schemaRegistry.ts`). There is no confidence
 * field anywhere (P4/REC-04) and no canonical id of any kind — the model
 * cannot name a row, only describe what the document printed.
 *
 * WHAT IS DELIBERATELY ABSENT. No `country`/`currencyCode` field — those are
 * jurisdiction facts this adapter's caller always supplies from the
 * document's own already-declared `country_code`, matching every other
 * adapter's "identity is never AI-derived" rule (see
 * `lib/aie/adapters/payslip/types.ts`'s header). No employee/employer
 * identifying numbers (TFN, PAN, employee id, bank account) — the same
 * privacy scope FDH-9's own native parser already enforces
 * (`lib/financial-data-hub/payslip/types.ts`'s `PayrollComponent.labelRaw`
 * comment), and in any case `maskText()` has already tokenised any such
 * value in the text this schema's caller sends before it ever reaches this
 * schema.
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';
import { PAY_FREQUENCIES } from '@/lib/financial-data-hub/payslip/types';

export const AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME = 'aie_payslip_document_facts';
export const AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION = '1';

/** CLOSED. Same shape as `II_MISSING_REASON_CODES` — every value says
 * something about the DOCUMENT, never the model's own certainty. */
export const PAYSLIP_MISSING_REASON_CODES = ['not_present_on_document', 'illegible', 'ambiguous', 'conflicting_values_on_document'] as const;
const missingReasonSchema = z.enum(PAYSLIP_MISSING_REASON_CODES).nullable();

/** A decimal carried as a STRING, matching `decimalStringField`
 * (`schemaRegistry.ts`) exactly — accepting a JSON number here would
 * reintroduce IEEE-754 float loss at the one boundary designed to prevent
 * it. */
const moneyFieldSchema = z
  .object({
    value: z
      .string()
      .regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'must be an exact decimal string, not a float')
      .nullable(),
    missingReasonCode: missingReasonSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.value !== null && v.missingReasonCode !== null) {
      ctx.addIssue({ code: 'custom', path: ['missingReasonCode'], message: 'missingReasonCode must be null when a value is supplied' });
    }
    if (v.value === null && v.missingReasonCode === null) {
      ctx.addIssue({ code: 'custom', path: ['missingReasonCode'], message: 'missingReasonCode is required when value is null' });
    }
  });

const dateFieldSchema = z
  .object({
    value: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    missingReasonCode: missingReasonSchema,
  })
  .strict();

const textFieldSchema = z
  .object({
    value: z.string().max(200).nullable(),
    missingReasonCode: missingReasonSchema,
  })
  .strict();

const payFrequencyFieldSchema = z
  .object({
    value: z.enum(PAY_FREQUENCIES).nullable(),
    missingReasonCode: missingReasonSchema,
  })
  .strict();

export const payslipDocumentFactsSchema = z
  .object({
    schemaVersion: z.literal(AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION),
    /** Document-level "I could essentially not read this" escape hatch —
     * mirrors the II whole-document schema's own top-level field so an
     * empty extraction has a structured reason rather than being inferred
     * from every field being null. */
    documentMissingReasonCode: missingReasonSchema,
    employerName: textFieldSchema,
    payPeriodStart: dateFieldSchema,
    payPeriodEnd: dateFieldSchema,
    paymentDate: dateFieldSchema,
    payFrequency: payFrequencyFieldSchema,
    grossPay: moneyFieldSchema,
    basePay: moneyFieldSchema,
    overtimePay: moneyFieldSchema,
    bonusPay: moneyFieldSchema,
    commissionPay: moneyFieldSchema,
    allowancesTotal: moneyFieldSchema,
    reimbursementsTotal: moneyFieldSchema,
    otherEarnings: moneyFieldSchema,
    taxWithheld: moneyFieldSchema,
    employeeDeductionsTotal: moneyFieldSchema,
    salarySacrifice: moneyFieldSchema,
    professionalTax: moneyFieldSchema,
    employerRetirementContribution: moneyFieldSchema,
    employeeRetirementContribution: moneyFieldSchema,
    employerNpsContribution: moneyFieldSchema,
    employeeNpsContribution: moneyFieldSchema,
    netPay: moneyFieldSchema,
  })
  .strict();

export type PayslipDocumentFacts = z.infer<typeof payslipDocumentFactsSchema>;

let registered = false;

/** Idempotent — safe to call from multiple module-load sites / tests, same
 * convention as every other adapter's `register*Schema()`. */
export function registerPayslipDocumentFactsSchema(): void {
  if (registered) return;
  aieSchemaRegistry.register({
    name: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME,
    version: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION,
    schema: payslipDocumentFactsSchema,
    ownerAdapterId: 'aie_payslip_ai_fallback_v1',
  });
  registered = true;
}
