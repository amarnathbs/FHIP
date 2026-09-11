import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';
import { AUTHORITATIVE_COUNTRY_CODES } from '@/lib/services/jurisdiction';
import { currencyMatchesCountry, currencyCountryRefinement } from './currencyCountry';

const investmentBaseSchema = z.object({
  investment_name: z.string().min(1),
  investment_type: z
    .enum(['shares', 'managed_fund', 'etf', 'crypto', 'business_equity', 'other'])
    .default('other'),
  current_value: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  // G6 Contract 1 — widened from ['AU','IN'] to all 6 authoritative country
  // codes; Zod-only restriction, no DB CHECK narrower than the FK. No migration.
  country_code: z.enum(AUTHORITATIVE_COUNTRY_CODES).optional(),
  // See lib/validation/asset.ts's identical field for why this is
  // .optional() with no .default() — a default would break every save to
  // this table until the currency_override column migration is applied.
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
