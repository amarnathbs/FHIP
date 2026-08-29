/**
 * FDH-10 — Credit Cards & Loans Intelligence: validation for the user-facing
 * API surface (spec sections 18-20). Follows the existing
 * `lib/financial-data-hub/validation/*` convention exactly — Zod, no
 * `user_id`/`owner_id`/`household_id` ever accepted from the client (spec
 * section 20: every route derives ownership from the authenticated session).
 */

import { z } from 'zod';
import { fdhCountryCode, fdhCurrencyCode } from './primitives';
import { fdhSanitisedFilename } from './filename';

/** Body of `POST /liability-statement/upload` — metadata alongside the
 * streamed bytes (the file itself is the request body, same pattern as
 * `bank-csv/upload`). */
export const liabilityStatementUploadMetadataSchema = z.object({
  statement_type: z.enum(['credit_card', 'loan']),
  country_code: fdhCountryCode,
  currency_code: fdhCurrencyCode,
  original_filename_sanitised: fdhSanitisedFilename.nullish(),
  institution_name: z.string().trim().min(1).max(200).nullish(),
  /** Rejected server-side if it looks like a full account/card number — the
   * DB-side `chk_fdh_liability_statements_masked_identifier` constraint is
   * the backstop even if this check is ever bypassed. */
  masked_identifier: z.string().max(40).refine((v) => !/[0-9]{7,}/.test(v), 'must be a masked identifier, not a full number').nullish(),
  statement_period_start: z.string().date().nullish(),
  statement_period_end: z.string().date().nullish(),
  statement_date: z.string().date().nullish(),
  due_date: z.string().date().nullish(),
  opening_balance: z.coerce.number().finite().nullish(),
  closing_balance: z.coerce.number().finite().nullish(),
  credit_limit: z.coerce.number().nonnegative().nullish(),
  minimum_payment: z.coerce.number().nonnegative().nullish(),
  interest_rate: z.coerce.number().nonnegative().nullish(),
});
export type LiabilityStatementUploadMetadataInput = z.infer<typeof liabilityStatementUploadMetadataSchema>;
