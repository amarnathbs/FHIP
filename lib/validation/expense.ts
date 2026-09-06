import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

// Reload-edit contract note (G5B Phase 2 closure) — see lib/validation/income.ts's
// matching comment for the full root-cause writeup, shared verbatim across all
// three G5B-write-enabled modules. master_item_key and notes are genuinely
// nullable DB columns (migration 0004 — no NOT NULL, no default); `.nullable()`
// accepts the exact null GET already returns for an untouched row without
// loosening validation of any real value.
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
  master_item_key: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type ExpenseInput = z.infer<typeof expenseSchema>;
