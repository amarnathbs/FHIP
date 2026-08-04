import { z } from 'zod';

export const householdMemberSchema = z.object({
  household_id: z.string().uuid().optional(),
  full_name: z.string().min(1),
  relationship: z.enum(['self', 'spouse', 'partner', 'child', 'parent', 'other_dependant', 'other']),
  date_of_birth: z.string().date().optional(),
});

export type HouseholdMemberInput = z.infer<typeof householdMemberSchema>;
