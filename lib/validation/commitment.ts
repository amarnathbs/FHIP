import { z } from 'zod';

export const commitmentSchema = z.object({
  commitment_name: z.string().min(1),
  category: z.enum(['tax', 'education', 'property', 'legal', 'medical', 'other']).default('other'),
  amount: z.number().min(0),
  due_date: z.string().date(),
  is_mandatory: z.boolean().default(true),
  currency_code: z.enum(['AUD', 'INR']).default('AUD'),
  notes: z.string().optional(),
});

export type CommitmentInput = z.infer<typeof commitmentSchema>;
