/**
 * Financial Data Hub — validation for institutions and financial accounts.
 */

import { z } from 'zod';
import {
  FDH_ACCOUNT_STATUSES,
  FDH_ACCOUNT_TYPES,
  FDH_INSTITUTION_TYPES,
} from '../constants/enums';
import {
  fdhCountryCode,
  fdhCurrencyCode,
  fdhDate,
  fdhMachineKey,
  fdhMaskedIdentifier,
  fdhOwnershipInput,
  fdhUuid,
  refineDateOrder,
} from './primitives';

/** Admin/service-role write path only. `fdh_financial_institutions` has no
 * INSERT policy for the authenticated role. */
export const fdhFinancialInstitutionSchema = z.object({
  country_code: fdhCountryCode,
  institution_code: fdhMachineKey,
  institution_name: z.string().min(1).max(200),
  institution_type: z.enum(FDH_INSTITUTION_TYPES),
  active: z.boolean().default(true),
});

/**
 * A user's source account.
 *
 * NOTE WHAT IS ABSENT: there is no `full_account_number`, no `bsb`, no `ifsc`
 * and no `iban` field, in this schema or in the table. FDH-1 introduces no new
 * plaintext PII. A genuine temporary need for a full identifier during parsing
 * is FDH-3's secure processing lifecycle, not a persisted column.
 *
 * `account_fingerprint` is intentionally NOT accepted from a caller. It will
 * be derived server-side from a keyed, non-reversible hash once key management
 * exists; accepting one from outside would let a caller forge a collision with
 * another account.
 */
export const fdhFinancialAccountSchema = fdhOwnershipInput
  .extend({
    institution_id: fdhUuid.nullish(),
    account_type: z.enum(FDH_ACCOUNT_TYPES),
    country_code: fdhCountryCode,
    currency_code: fdhCurrencyCode,
    display_name: z.string().min(1).max(200),
    masked_identifier: fdhMaskedIdentifier.nullish(),
    status: z.enum(FDH_ACCOUNT_STATUSES).default('active'),
    opened_at: fdhDate.nullish(),
    closed_at: fdhDate.nullish(),
    last_statement_date: fdhDate.nullish(),
  })
  .superRefine(refineDateOrder('opened_at', 'closed_at'))
  .superRefine((v, ctx) => {
    if (v.status === 'closed' && !v.closed_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['closed_at'],
        message: 'a closed account must record when it closed',
      });
    }
  });

export type FdhFinancialInstitutionInput = z.infer<typeof fdhFinancialInstitutionSchema>;
export type FdhFinancialAccountInput = z.infer<typeof fdhFinancialAccountSchema>;
