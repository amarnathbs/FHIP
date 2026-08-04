import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

export const expenseSchema = z.object({
  expense_name: z.string().min(1),
  expense_category: z
    .enum(['housing', 'transport', 'food', 'utilities', 'insurance', 'debt_repayment', 'other'])
    .default('other'),
  amount: z.number().min(0),
  frequency: z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off']),
  currency_code: z.enum(['AUD', 'INR']),
  owner: z.enum(OWNER_VALUES).default('self'),
  is_essential: z.boolean().default(false),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export type ExpenseInput = z.infer<typeof expenseSchema>;
