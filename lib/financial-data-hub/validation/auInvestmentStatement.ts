/**
 * FDH-11 — Australia Investment Statement Intelligence: validation for the
 * user-facing API surface (spec sections 15-16, 19-20, 23). Follows the
 * existing `lib/financial-data-hub/validation/*` convention exactly — Zod,
 * no `user_id`/`owner_id`/`household_id` ever accepted from the client
 * (every route derives ownership from the authenticated session).
 */

import { z } from 'zod';
import { fdhCurrencyCode } from './primitives';

/** Body of `POST /investment-statement/upload` — metadata alongside the
 * streamed bytes (the file itself is the request body, same pattern as
 * `liability-statement/upload`). */
export const auInvestmentStatementUploadMetadataSchema = z.object({
  csv_kind: z.enum(['transaction', 'portfolio']),
  currency_code: fdhCurrencyCode,
  original_filename_sanitised: z.string().max(255).nullish(),
  institution_name: z.string().trim().min(1).max(200).nullish(),
  /** Rejected server-side if it looks like a full HIN/broker account
   * number — the DB-side
   * `chk_fdh_investment_statements_masked_identifier` constraint is the
   * backstop even if this check is ever bypassed (spec sections 20, 23). */
  masked_account_identifier: z.string().max(40).refine((v) => !/[0-9]{7,}/.test(v), 'must be a masked identifier, not a full number').nullish(),
  statement_date: z.string().date().nullish(),
  statement_period_start: z.string().date().nullish(),
  statement_period_end: z.string().date().nullish(),
});
export type AuInvestmentStatementUploadMetadataInput = z.infer<typeof auInvestmentStatementUploadMetadataSchema>;
