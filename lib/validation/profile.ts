import { z } from 'zod';
import { isPlausibleDob } from '@/lib/engines/age';
import { AUTHORITATIVE_COUNTRY_CODES } from '@/lib/services/jurisdiction';

export const profileSchema = z.object({
  full_name: z.string().min(1),
  date_of_birth: z
    .string()
    .date()
    .optional()
    .refine((dob) => isPlausibleDob(dob ?? null), { message: 'Date of birth must imply an age between 16 and 100' }),
  // G3: widened from ['AU','IN'] to the six authoritative registration
  // countries, sourced from the canonical vocabulary so this schema can never
  // drift from it. Note that passing a GENERIC country here does NOT confirm
  // it: PUT /api/user/profile deliberately RESETS country_confirmed_at and
  // country_source to null whenever country_of_residence changes on an
  // already-confirmed profile, which sends the user back through
  // /confirm-country. The database independently refuses to mark a GENERIC
  // country confirmed without a matching disclosure acknowledgement
  // (trg_enforce_generic_disclosure, migration 0127), so this widening cannot
  // become a route around the disclosure.
  country_of_residence: z.enum(AUTHORITATIVE_COUNTRY_CODES),
  // Deliberately NOT widened. G1/G3 both treat `secondary_country` as
  // superseded by cross_border_relationships; widening it here would grow a
  // legacy field this programme is retiring.
  secondary_country: z.enum(['AU', 'IN']).nullable().optional(),
  // G3 section 8.1: exactly AUD and INR, unchanged. This is the user's
  // reporting/base currency and is deliberately INDEPENDENT of country —
  // there is no cross-field refinement tying it to country_of_residence, and
  // adding one would break the required AU+INR / IN+AUD / GB+either
  // combinations.
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
