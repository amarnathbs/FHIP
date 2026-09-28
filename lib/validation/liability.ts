import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';
import { AUTHORITATIVE_COUNTRY_CODES } from '@/lib/services/jurisdiction';
import { currencyMatchesCountry, currencyCountryRefinement } from './currencyCountry';

const liabilityBaseSchema = z.object({
  liability_name: z.string().min(1),
  debt_type: z
    .enum([
      'mortgage', 'personal_loan', 'credit_card', 'auto_loan', 'student_loan',
      // FDH-10 additions (spec section 12) — additive only; every pre-existing
      // value above is unchanged.
      'investment_property_loan', 'line_of_credit', 'overdraft', 'other_term_loan',
      'other',
    ])
    .default('other'),
  balance: z.number().min(0),
  interest_rate: z.number().min(0).max(100).optional(),
  interest_rate_type: z.enum(['fixed', 'variable']).optional(),
  fixed_rate_expiry: z.string().date().optional(),
  credit_limit: z.number().min(0).optional(),
  // Mission section 7 (2026-09-28 closure pass): was `.default(0)`, which
  // silently turned "the user left this blank" into a genuine, indistinguishable
  // $0 monthly repayment — the exact R16 violation ("error/null != 0") this
  // codebase's own field-disposition discipline forbids elsewhere. A manual
  // liability saved with no repayment figure now stores `null` (matching
  // `interest_rate` and `minimum_payment` immediately above/below, which were
  // already correctly `.optional()`), so `lib/read-models/liabilities.ts`'s
  // `contractualMonthly` is honestly `null` ("not entered") rather than a
  // fabricated `money(0, ...)` that a UI or the D-08 zero-consumption safety
  // net (`householdDebtServiceUnderD08`) could mistake for a confirmed $0.
  monthly_repayment: z.number().min(0).optional(),
  currency_code: z.enum(['AUD', 'INR']),
  // G6 Contract 1 — widened from ['AU','IN'] to all 6 authoritative country
  // codes; Zod-only restriction, no DB CHECK narrower than the FK. No migration.
  country_code: z.enum(AUTHORITATIVE_COUNTRY_CODES).optional(),
  // See lib/validation/asset.ts's identical field for why this is
  // .optional() with no .default() — a default would break every save to
  // this table until the currency_override column migration is applied.
  currency_override: z.boolean().optional(),
  lender: z.string().optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
  // FDH-10 additions (migration 0096) — statement-import metadata. All
  // optional so manual liability add/edit is completely unaffected (spec
  // section 129).
  masked_identifier: z.string().max(32).optional(),
  minimum_payment: z.number().min(0).optional(),
  available_credit: z.number().min(0).optional(),
  due_date: z.string().date().optional(),
});

export const liabilitySchema = liabilityBaseSchema.refine(currencyMatchesCountry, currencyCountryRefinement);
export const liabilityPatchSchema = liabilityBaseSchema
  .partial()
  .refine(currencyMatchesCountry, currencyCountryRefinement);

export type LiabilityInput = z.infer<typeof liabilitySchema>;
