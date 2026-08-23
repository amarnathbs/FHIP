import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';
import { currencyMatchesCountry, currencyCountryRefinement } from './currencyCountry';

const liabilityBaseSchema = z.object({
  liability_name: z.string().min(1),
  debt_type: z
    .enum(['mortgage', 'personal_loan', 'credit_card', 'auto_loan', 'student_loan', 'other'])
    .default('other'),
  balance: z.number().min(0),
  interest_rate: z.number().min(0).max(100).optional(),
  interest_rate_type: z.enum(['fixed', 'variable']).optional(),
  fixed_rate_expiry: z.string().date().optional(),
  credit_limit: z.number().min(0).optional(),
  monthly_repayment: z.number().min(0).default(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional(),
  // See lib/validation/asset.ts's identical field for why this is
  // .optional() with no .default() — a default would break every save to
  // this table until migration 0067 (currency_override column) is applied.
  currency_override: z.boolean().optional(),
  lender: z.string().optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export const liabilitySchema = liabilityBaseSchema.refine(currencyMatchesCountry, currencyCountryRefinement);
export const liabilityPatchSchema = liabilityBaseSchema
  .partial()
  .refine(currencyMatchesCountry, currencyCountryRefinement);

export type LiabilityInput = z.infer<typeof liabilitySchema>;
