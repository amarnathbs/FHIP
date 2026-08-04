import { z } from 'zod';

export const goalMilestoneSchema = z.object({
  milestone_name: z.string().min(1),
  target_amount: z.number().min(0),
  target_date: z.string().date().optional(),
  display_order: z.number().int().min(0).optional(),
  notes: z.string().optional(),
});

export type GoalMilestoneInput = z.infer<typeof goalMilestoneSchema>;
