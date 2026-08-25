import { z } from 'zod';
import { isPlausibleDob } from '@/lib/engines/age';

export const profileSchema = z.object({
  full_name: z.string().min(1),
  date_of_birth: z
    .string()
    .date()
    .optional()
    .refine((dob) => isPlausibleDob(dob ?? null), { message: 'Date of birth must imply an age between 16 and 100' }),
  country_of_residence: z.enum(['AU', 'IN']),
  secondary_country: z.enum(['AU', 'IN']).nullable().optional(),
  preferred_currency: z.enum(['AUD', 'INR']),
  employment_status: z.string().optional(),
  // App Review spec §16 — Profile page "Contact number" (migration 0079).
  // Deliberately loose validation (no enum/regex): this app supports
  // international numbers across AU/IN households and any stricter pattern
  // risks rejecting a real, valid number.
  phone: z.string().max(30).optional().nullable(),
  // User-set opt-out so the completion score can tell "genuinely doesn't
  // apply to this household" apart from "not entered yet" — see migration
  // 0029 and healthScore.ts's 'not_applicable' treatment.
  not_applicable_investments: z.boolean().optional(),
  not_applicable_retirement: z.boolean().optional(),
  not_applicable_insurance: z.boolean().optional(),
});

export type ProfileInput = z.infer<typeof profileSchema>;
