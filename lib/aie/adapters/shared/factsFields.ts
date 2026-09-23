/**
 * AIE document-fallback adapters — SHARED Zod field builders.
 *
 * WHY THIS FILE EXISTS. `lib/aie/adapters/payslip/schema.ts` established the
 * whole-document "facts" contract this programme uses: every scalar the model
 * could guess is `.nullable()` and paired with a `missingReasonCode` drawn
 * from a CLOSED enum, so "I don't know" always has a typed shape and a
 * plausible guess never does; money is an exact decimal STRING, never a JSON
 * number; there is no confidence field anywhere (P4/REC-04) and no canonical
 * id of any kind. Four more document types now need exactly that contract, so
 * the field-level builders live here once rather than being retyped four
 * times — retyping them is precisely how two of the four would eventually
 * drift into accepting a JSON number for money.
 *
 * PAYSLIP IS DELIBERATELY NOT REFACTORED ONTO THIS FILE. The payslip adapter
 * is merged, live-proven against the real provider, and is the reference this
 * programme is measured against; rewriting its schema to import these
 * builders would put the one proven implementation at risk to save a few
 * lines. Its builders are byte-equivalent in behaviour to these. Recorded as
 * a deliberate, reversible duplication rather than an oversight — a follow-up
 * can converge them once these four are themselves proven.
 *
 * THE `superRefine` SCOPE IS COPIED FROM PAYSLIP ON PURPOSE, INCLUDING ITS
 * LIMIT. Only MONEY fields carry the "value and missingReasonCode are
 * mutually exclusive" cross-check. OpenAI's strict Structured Outputs mode
 * enforces structure (types, enums, required keys) but not cross-field
 * invariants, so every refinement added here is a refinement the model can
 * fail — turning a usable extraction into a `schema_rejected` outcome. The
 * payslip adapter proved the money-only scope works against the real
 * `gpt-4o-mini`; widening it to text/date/enum fields is an untested change
 * to the one thing that is known to work, so it is not made here.
 */

import { z } from 'zod';

/** CLOSED. Every value says something about the DOCUMENT, never about the
 * model's own certainty — the same discipline as `PAYSLIP_MISSING_REASON_CODES`
 * and `II_MISSING_REASON_CODES`. A model that is merely unsure has no way to
 * say so, which is the point. */
export const AIE_MISSING_REASON_CODES = ['not_present_on_document', 'illegible', 'ambiguous', 'conflicting_values_on_document'] as const;

export type AieMissingReasonCode = (typeof AIE_MISSING_REASON_CODES)[number];

export const aieMissingReasonSchema = z.enum(AIE_MISSING_REASON_CODES).nullable();

/**
 * A decimal carried as a STRING. Accepting a JSON number here would
 * reintroduce IEEE-754 float loss at the one boundary designed to prevent it
 * — and for the three statement types whose own native extraction shape
 * already stores money as exact decimal strings
 * (`RetirementStatementExtraction`, `AuInvestmentStatementExtraction`), a
 * float would additionally be a type error at the mapping boundary rather
 * than a silent rounding.
 */
export function aieMoneyField() {
  return z
    .object({
      value: z
        .string()
        .regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'must be an exact decimal string, not a float')
        .nullable(),
      missingReasonCode: aieMissingReasonSchema,
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
}

/** A quantity (units/shares). Wider than money — share registries genuinely
 * print fractional unit holdings to 4-6 places — but still an exact decimal
 * string for the same reason. */
export function aieQuantityField() {
  return z
    .object({
      value: z
        .string()
        .regex(/^-?\d{1,15}(\.\d{1,6})?$/, 'must be an exact decimal string, not a float')
        .nullable(),
      missingReasonCode: aieMissingReasonSchema,
    })
    .strict();
}

export function aieDateField() {
  return z
    .object({
      value: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      missingReasonCode: aieMissingReasonSchema,
    })
    .strict();
}

export function aieTextField(maxLength = 200) {
  return z
    .object({
      value: z.string().max(maxLength).nullable(),
      missingReasonCode: aieMissingReasonSchema,
    })
    .strict();
}

export function aieEnumField<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .object({
      value: z.enum(values).nullable(),
      missingReasonCode: aieMissingReasonSchema,
    })
    .strict();
}

/** A bare decimal string, for use INSIDE a line-item array where the
 * per-field `missingReasonCode` envelope would multiply the token cost of
 * every row for no benefit — a transaction row that the model could not read
 * is omitted from the array entirely, which is a clearer signal than 12
 * reason codes. */
export const aieLineItemMoney = z.string().regex(/^-?\d{1,15}(\.\d{1,2})?$/, 'must be an exact decimal string, not a float');
export const aieLineItemQuantity = z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/, 'must be an exact decimal string, not a float');
export const aieLineItemDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
