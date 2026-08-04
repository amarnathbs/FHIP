import { z } from 'zod';

export const goalContributionSchema = z.object({
  contribution_date: z.string().date(),
  amount: z.number(),
  currency_code: z.enum(['AUD', 'INR']),
  contribution_type: z
    .enum(['regular', 'one_off', 'bonus', 'tax_refund', 'family', 'asset_sale', 'transfer', 'withdrawal', 'adjustment'])
    .default('regular'),
  contribution_status: z.enum(['planned', 'confirmed', 'reversed']).default('confirmed'),
  funding_source_id: z.string().uuid().optional(),
  notes: z.string().optional(),
});

export type GoalContributionInput = z.infer<typeof goalContributionSchema>;
