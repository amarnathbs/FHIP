import { z } from 'zod';

export const goalFundingSourceSchema = z.object({
  source_type: z.enum(['asset', 'investment', 'retirement', 'cash', 'manual', 'expected']),
  linked_asset_id: z.string().uuid().optional(),
  linked_investment_id: z.string().uuid().optional(),
  linked_retirement_id: z.string().uuid().optional(),
  allocated_amount: z.number().min(0).default(0),
  allocation_percentage: z.number().min(0).max(100).optional(),
  currency_code: z.enum(['AUD', 'INR']).optional(),
  availability_date: z.string().date().optional(),
  restricted_flag: z.boolean().optional(),
});

export type GoalFundingSourceInput = z.infer<typeof goalFundingSourceSchema>;
