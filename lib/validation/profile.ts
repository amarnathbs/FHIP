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
  // App Review tier-2 Fix 1 (Profile Page) — migration 0099. Free-text
  // contact number; never used as an authentication identity (that stays
  // exclusively auth.users.email/phone, untouched by this schema).
  phone: z.string().nullable().optional(),
  // User-set opt-out so the completion score can tell "genuinely doesn't
  // apply to this household" apart from "not entered yet" — see migration
  // 0029 and healthScore.ts's 'not_applicable' treatment.
  not_applicable_investments: z.boolean().optional(),
  not_applicable_retirement: z.boolean().optional(),
  not_applicable_insurance: z.boolean().optional(),
});

export type ProfileInput = z.infer<typeof profileSchema>;
