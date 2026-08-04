import { z } from 'zod';

export const checkInsSchema = z.object({
  goals_reviewed_at: z.string().date().nullable().optional(),
  insurance_reviewed_at: z.string().date().nullable().optional(),
  debt_reviewed_at: z.string().date().nullable().optional(),
  investment_plan_reviewed_at: z.string().date().nullable().optional(),
  beneficiaries_reviewed_at: z.string().date().nullable().optional(),
  bills_paid_on_time: z.boolean().nullable().optional(),
  budget_maintained: z.boolean().nullable().optional(),
  savings_automated: z.boolean().nullable().optional(),
});

export type CheckInsInput = z.infer<typeof checkInsSchema>;
