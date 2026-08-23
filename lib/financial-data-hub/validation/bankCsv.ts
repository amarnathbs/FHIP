/**
 * R7 — Bank CSV Engine: validation for the user-facing API surface (spec
 * section 54). Follows the existing FDH `lib/financial-data-hub/validation/*`
 * convention — Zod, no `user_id` accepted from the client.
 */

import { z } from 'zod';
import {
  FDH_CSV_AMOUNT_CONVENTIONS,
  FDH_DUPLICATE_RESOLUTIONS,
  FDH_TRANSACTION_CORRECTION_FIELDS,
} from '../constants/enums';
import { SUPPORTED_DATE_FORMATS } from '../bank-csv/dateFormats';
import { fdhCountryCode, fdhCurrencyCode, fdhUuid } from './primitives';
import { fdhSanitisedFilename } from './filename';

/** Body of `POST /bank-csv/upload` — metadata alongside the streamed bytes
 * (the file itself is the request body, exactly like FDH-3's
 * `.../upload-sessions/{id}/complete`; this endpoint composes session-create
 * and complete-upload into one call for the bank-CSV-specific flow, spec
 * 57's "bounded upload flow"). */
export const bankCsvUploadMetadataSchema = z.object({
  original_filename_sanitised: fdhSanitisedFilename.nullish(),
  institution_id: fdhUuid.nullish(),
  country_code: fdhCountryCode,
  currency_code: fdhCurrencyCode,
  /** Optional masked identifier the user already knows (e.g. "****1234"),
   * used for account-identity resolution when the CSV itself carries none
   * (spec 30-31). Rejected server-side if it looks like a full account
   * number — see `bank-csv/accountIdentity.ts` normaliseMaskedIdentifier. */
  declared_masked_identifier: z.string().max(40).nullish(),
  statement_period_start: z.string().date().nullish(),
  statement_period_end: z.string().date().nullish(),
});
export type BankCsvUploadMetadataInput = z.infer<typeof bankCsvUploadMetadataSchema>;

/** Body of `POST /bank-csv/:id/map` — a user-confirmed generic column
 * mapping (spec 22-23). */
export const bankCsvMappingConfirmSchema = z.object({
  amount_convention: z.enum(FDH_CSV_AMOUNT_CONVENTIONS),
  date_format: z.enum(SUPPORTED_DATE_FORMATS),
  delimiter: z.string().length(1).default(','),
  column_mapping: z.object({
    transaction_date: z.string().min(1),
    posting_date: z.string().min(1).nullish(),
    value_date: z.string().min(1).nullish(),
    description: z.string().min(1),
    amount: z.string().min(1).nullish(),
    debit: z.string().min(1).nullish(),
    credit: z.string().min(1).nullish(),
    dr_cr_indicator: z.string().min(1).nullish(),
    balance: z.string().min(1).nullish(),
    reference: z.string().min(1).nullish(),
    currency: z.string().min(1).nullish(),
  }),
  save_as_reusable_template: z.boolean().default(true),
})
  .superRefine((v, ctx) => {
    if (v.amount_convention === 'single_signed' && !v.column_mapping.amount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['column_mapping', 'amount'], message: 'amount column is required for single_signed' });
    }
    if (v.amount_convention === 'debit_credit_columns' && !(v.column_mapping.debit || v.column_mapping.credit)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['column_mapping', 'debit'], message: 'at least one of debit/credit column is required' });
    }
    if (v.amount_convention === 'dr_cr_indicator' && !(v.column_mapping.amount && v.column_mapping.dr_cr_indicator)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['column_mapping', 'dr_cr_indicator'], message: 'amount and dr_cr_indicator columns are both required' });
    }
  });
export type BankCsvMappingConfirmInput = z.infer<typeof bankCsvMappingConfirmSchema>;

/** Body of `POST /bank-transactions/:id/duplicate-resolution` (spec 54). A
 * user may only settle a duplicate-candidate PAIR they own — never declare
 * an unrelated transaction certified/reconciled (spec 82). */
export const bankTransactionDuplicateResolutionSchema = z.object({
  duplicate_candidate_id: fdhUuid,
  resolution: z.enum(FDH_DUPLICATE_RESOLUTIONS),
});
export type BankTransactionDuplicateResolutionInput = z.infer<typeof bankTransactionDuplicateResolutionSchema>;

/** Body of `POST /bank-transactions/:id/correction` (spec 47). Narrowly
 * scoped to the closed set of correctable fields — never `description_raw`,
 * never provenance/certification fields. */
export const bankTransactionCorrectionSchema = z.object({
  field_name: z.enum(FDH_TRANSACTION_CORRECTION_FIELDS),
  corrected_value: z.unknown(),
  reason: z.string().max(500).nullish(),
});
export type BankTransactionCorrectionInput = z.infer<typeof bankTransactionCorrectionSchema>;
