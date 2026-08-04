import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

export const insuranceSchema = z.object({
  policy_name: z.string().min(1),
  cover_type: z.enum(['life', 'income_protection', 'health', 'home', 'vehicle', 'other']).default('other'),
  cover_amount: z.number().min(0),
  premium: z.number().min(0),
  premium_frequency: z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off']),
  currency_code: z.enum(['AUD', 'INR']),
  renewal_date: z.string().date().optional(),
  waiting_period_days: z.number().int().min(0).optional(),
  benefit_period: z.string().optional(),
  provider: z.string().optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export type InsuranceInput = z.infer<typeof insuranceSchema>;
