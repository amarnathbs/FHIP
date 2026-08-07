import { z } from 'zod';
import { isPlausibleDob, MIN_PLAUSIBLE_DEPENDANT_AGE, MAX_PLAUSIBLE_DEPENDANT_AGE } from '@/lib/engines/age';

export const householdMemberSchema = z.object({
  household_id: z.string().uuid().optional(),
  full_name: z.string().min(1),
  relationship: z.enum(['self', 'spouse', 'partner', 'child', 'parent', 'other_dependant', 'other']),
  // Wider bounds than the primary profile — household members/dependants can
  // legitimately be infants; only rejects genuine data-entry errors.
  date_of_birth: z
    .string()
    .date()
    .optional()
    .refine((dob) => isPlausibleDob(dob ?? null, undefined, MIN_PLAUSIBLE_DEPENDANT_AGE, MAX_PLAUSIBLE_DEPENDANT_AGE), {
      message: 'Date of birth must imply a plausible age (0-100)',
    }),
});

export type HouseholdMemberInput = z.infer<typeof householdMemberSchema>;
