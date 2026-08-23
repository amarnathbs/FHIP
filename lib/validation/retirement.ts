import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';
import { currencyMatchesCountry, currencyCountryRefinement } from './currencyCountry';

const retirementBaseSchema = z.object({
  account_name: z.string().min(1),
  account_type: z.enum(['super', 'EPF', 'PPF', 'NPS', 'other']).default('other'),
  current_balance: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional(),
  // See lib/validation/asset.ts's identical field for why this is
  // .optional() with no .default() — a default would break every save to
  // this table until migration 0067 (currency_override column) is applied.
  currency_override: z.boolean().optional(),
  employer_contribution: z.number().min(0).optional(),
  personal_contribution: z.number().min(0).optional(),
  contribution_frequency: z
    .enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'])
    .optional(),
  target_retirement_age: z.number().int().min(1).max(119).optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export const retirementSchema = retirementBaseSchema.refine(currencyMatchesCountry, currencyCountryRefinement);
export const retirementPatchSchema = retirementBaseSchema
  .partial()
  .refine(currencyMatchesCountry, currencyCountryRefinement);

export type RetirementInput = z.infer<typeof retirementSchema>;
