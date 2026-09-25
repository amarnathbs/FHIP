/**
 * AIE retirement-statement AI-fallback adapter — versioned whole-document
 * facts contract (AU superannuation / account-based pension, India EPF/NPS).
 *
 * Same anti-invention discipline as the payslip and bank-statement adapters:
 * every scalar is `.nullable()` and paired with a `missingReasonCode` from a
 * CLOSED enum, so "I don't know" always has a typed shape and a plausible
 * guess never does. No confidence field anywhere (P4/REC-04).
 *
 * MONEY IS A DECIMAL STRING HERE FOR A STRONGER REASON THAN ELSEWHERE. The
 * native extraction shape this maps onto, `RetirementStatementExtraction`,
 * already stores every money field as a `string`, and its own header calls a
 * `number` on a money field "a defect". So a JSON number here would not merely
 * risk IEEE-754 loss — it would be a type error at the mapping boundary. The
 * shared `aieMoneyField()` builder enforces the decimal-string form.
 *
 * WHAT IS DELIBERATELY ABSENT. No `jurisdiction`, no `currencyCode`, no
 * account identity — those are caller context, established from the
 * document's own already-declared metadata before the AI was ever asked, and
 * are never AI-derived anywhere in this codebase. No member number, TFN, UAN
 * or PRAN: the masking layer has already tokenised any such value before this
 * schema's caller sends the text, and FDH-12's own validation refuses to
 * store anything but a partial identifier in any case.
 *
 * NO SMSF CLASSIFICATION FIELD, AND THAT IS A SAFETY DECISION, NOT AN
 * OVERSIGHT. Whether a statement belongs to a self-managed super fund
 * determines whether it is routed away from ordinary super into the SMSF
 * module entirely. That judgement is made by `smsfDetection.ts` from the
 * document text on both the native and the AI path, and letting a model
 * express an opinion on it would put a product-routing decision inside an
 * unverifiable field.
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';
import {
  aieDateField,
  aieMoneyField,
  aieTextField,
  aieMissingReasonSchema,
  aieLineItemMoney,
  aieLineItemQuantity,
  aieLineItemDate,
  AIE_AI_IDENTIFIER_READ_MAX,
} from '../shared/factsFields';
import { RETIREMENT_ACTIVITY_TYPES } from '@/lib/financial-data-hub/retirement/types';

export const AIE_RETIREMENT_FACTS_SCHEMA_NAME = 'aie_retirement_statement_document_facts';
export const AIE_RETIREMENT_FACTS_SCHEMA_VERSION = '1';

/** Sized against the line-item output budget, exactly as the bank-statement
 * adapter's own cap is. A member statement's activity list is normally far
 * shorter than a bank statement's, so this is generous in practice. */
export const AIE_RETIREMENT_MAX_ACTIVITIES = 60;
export const AIE_RETIREMENT_MAX_POSITIONS = 30;

/** One activity line as PRINTED. `amount` is a POSITIVE MAGNITUDE and the
 * direction is NEVER carried here — it is looked up from
 * `RETIREMENT_ACTIVITY_DIRECTION`, the single definition of whether an
 * activity adds to or subtracts from the balance. Letting the model supply a
 * sign would create a second, contradictory source of truth for the
 * reconciliation identity. */
export const retirementActivitySchema = z
  .object({
    activityType: z.enum(RETIREMENT_ACTIVITY_TYPES),
    amount: aieLineItemMoney,
    activityDate: aieLineItemDate.nullable(),
    descriptionRaw: z.string().max(300).nullable(),
    employerNameRaw: z.string().max(200).nullable(),
    /** Whether this line is a SUMMARY TOTAL rather than an individual
     * movement, and whether it is a YEAR-TO-DATE figure. Both are required
     * booleans on the native type, and both matter: summing a document's
     * individual contributions AND its "total contributions" line would
     * double-count the year. The model is asked because only the document
     * itself says which a line is. */
    isSummaryTotal: z.boolean(),
    isYearToDate: z.boolean(),
  })
  .strict();

export type RetirementActivityFacts = z.infer<typeof retirementActivitySchema>;

/** One investment option holding within the fund. */
export const retirementPositionSchema = z
  .object({
    optionNameRaw: z.string().min(1).max(200),
    assetClassRaw: z.string().max(120).nullable(),
    units: aieLineItemQuantity.nullable(),
    unitPrice: aieLineItemQuantity.nullable(),
    marketValue: aieLineItemMoney.nullable(),
    valuationDate: aieLineItemDate.nullable(),
  })
  .strict();

export type RetirementPositionFacts = z.infer<typeof retirementPositionSchema>;

export const retirementDocumentFactsSchema = z
  .object({
    schemaVersion: z.literal(AIE_RETIREMENT_FACTS_SCHEMA_VERSION),
    documentMissingReasonCode: aieMissingReasonSchema,
    fundName: aieTextField(200),
    // 2026-09-25 (other-PDF AI proof): READ limit widened to AIE_AI_IDENTIFIER_READ_MAX.
    // Found live: gpt-4o-mini copied masking tokens (~56 chars each) into this
    // field and the WHOLE billed extraction was schema_rejected for a value the
    // draft discards anyway (a token or anything over 40 chars is dropped
    // before review). The stored-value limits are enforced downstream, unchanged.
    maskedAccountIdentifier: aieTextField(AIE_AI_IDENTIFIER_READ_MAX),
    statementDate: aieDateField(),
    statementStartDate: aieDateField(),
    statementEndDate: aieDateField(),
    openingBalance: aieMoneyField(),
    closingBalance: aieMoneyField(),
    employerContributions: aieMoneyField(),
    personalContributions: aieMoneyField(),
    salarySacrifice: aieMoneyField(),
    governmentContributions: aieMoneyField(),
    rolloversIn: aieMoneyField(),
    rolloversOut: aieMoneyField(),
    withdrawals: aieMoneyField(),
    pensionPayments: aieMoneyField(),
    investmentEarnings: aieMoneyField(),
    fees: aieMoneyField(),
    insurancePremiums: aieMoneyField(),
    tax: aieMoneyField(),
    activities: z.array(retirementActivitySchema).max(AIE_RETIREMENT_MAX_ACTIVITIES),
    positions: z.array(retirementPositionSchema).max(AIE_RETIREMENT_MAX_POSITIONS),
  })
  .strict();

export type RetirementDocumentFacts = z.infer<typeof retirementDocumentFactsSchema>;

let registered = false;

/** Idempotent — safe to call from multiple module-load sites and tests, the
 * same convention as every other adapter's `register*Schema()`. */
export function registerRetirementDocumentFactsSchema(): void {
  if (registered) return;
  aieSchemaRegistry.register({
    name: AIE_RETIREMENT_FACTS_SCHEMA_NAME,
    version: AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
    schema: retirementDocumentFactsSchema,
    ownerAdapterId: 'aie_retirement_statement_ai_fallback_v1',
  });
  registered = true;
}
