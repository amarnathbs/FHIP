import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';
import { currencyMatchesCountry, currencyCountryRefinement } from './currencyCountry';

const investmentBaseSchema = z.object({
  investment_name: z.string().min(1),
  investment_type: z
    .enum(['shares', 'managed_fund', 'etf', 'crypto', 'business_equity', 'other'])
    .default('other'),
  current_value: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional(),
  // See lib/validation/asset.ts's identical field for why this is
  // .optional() with no .default() — a default would break every save to
  // this table until migration 0067 (currency_override column) is applied.
  currency_override: z.boolean().optional(),
  institution: z.string().optional(),
  cost_base: z.number().min(0).optional(),
  annual_contribution: z.number().min(0).optional(),
  risk_profile: z.enum(['conservative', 'balanced', 'growth', 'high_growth', 'unknown']).optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export const investmentSchema = investmentBaseSchema.refine(currencyMatchesCountry, currencyCountryRefinement);
export const investmentPatchSchema = investmentBaseSchema
  .partial()
  .refine(currencyMatchesCountry, currencyCountryRefinement);

export type InvestmentInput = z.infer<typeof investmentSchema>;
