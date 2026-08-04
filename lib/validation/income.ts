import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

export const incomeSchema = z.object({
  source_name: z.string().min(1),
  income_type: z.enum(['salary', 'business', 'rental', 'investment', 'other']).default('other'),
  amount: z.number().min(0),
  net_amount: z.number().min(0).optional(),
  frequency: z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off']),
  currency_code: z.enum(['AUD', 'INR']),
  owner: z.enum(OWNER_VALUES).default('self'),
  is_taxable: z.boolean().default(true),
  employer_name: z.string().optional(),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export type IncomeInput = z.infer<typeof incomeSchema>;
