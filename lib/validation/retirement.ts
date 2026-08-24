import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

export const retirementSchema = z.object({
  account_name: z.string().min(1),
  account_type: z.enum(['super', 'EPF', 'PPF', 'NPS', 'other']).default('other'),
  current_balance: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional(),
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

export type RetirementInput = z.infer<typeof retirementSchema>;
