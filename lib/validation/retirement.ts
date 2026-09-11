import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';
import { AUTHORITATIVE_COUNTRY_CODES } from '@/lib/services/jurisdiction';
import { currencyMatchesCountry, currencyCountryRefinement } from './currencyCountry';

const retirementBaseSchema = z.object({
  account_name: z.string().min(1),
  account_type: z.enum(['super', 'EPF', 'PPF', 'NPS', 'other']).default('other'),
  current_balance: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  // G6 Contract 1 — widened from ['AU','IN'] to all 6 authoritative country
  // codes; Zod-only restriction, no DB CHECK narrower than the FK. No migration.
  // (SMSF creation has its own, separate, unrelated DB-trigger gate on the
  // user's own country_of_residence = 'AU' -- migration 0084 -- untouched here.)
  country_code: z.enum(AUTHORITATIVE_COUNTRY_CODES).optional(),
  // See lib/validation/asset.ts's identical field for why this is
  // .optional() with no .default() — a default would break every save to
  // this table until the currency_override column migration is applied.
  currency_override: z.boolean().optional(),
  employer_contribution: z.number().min(0).optional(),
  personal_contribution: z.number().min(0).optional(),
  contribution_frequency: z
    .enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'])
    .optional(),
  // Legacy per-account field (migration 0004). The Retirement Planning UI
  // no longer sends this — target retirement age is captured once per
  // member (Self/Spouse) via retirement_members / /api/retirement/members
  // instead (spec s.16-17, s.28). Kept optional here only for backward
  // compatibility with the existing column; never populated by new writes.
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
