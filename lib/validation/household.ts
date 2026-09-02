import { z } from 'zod';
import { AUTHORITATIVE_COUNTRY_CODES } from '@/lib/services/jurisdiction';

export const householdSchema = z.object({
  household_name: z.string().optional(),
  household_type: z.string().optional(),
  marital_status: z.string().optional(),
  dependants_count: z.number().int().min(0).default(0),
  annual_household_income_range: z.string().optional(),
  // G3: widened to the six authoritative countries so onboarding can complete
  // for a generic-country user. households.primary_country is a one-way copy
  // of the confirmed residence written at onboarding time and is never read
  // for any logic branch (see lib/services/jurisdiction.ts's module header) —
  // it is NOT the G1 authoritative primary country, which lives on
  // user_profiles.primary_country and is owned exclusively by the
  // confirm_primary_country_change() RPC.
  primary_country: z.enum(AUTHORITATIVE_COUNTRY_CODES),
  // Cohort-matching dimensions for the Financial Twin (Module 8) — not
  // captured by any earlier module. Optional so existing households without
  // a value simply fall back to a broader cohort tier (spec section 6.4).
  housing_tenure: z.enum(['renter', 'mortgage_owner', 'outright_owner', 'other']).optional(),
  residence_type: z.enum(['metro', 'regional', 'rural', 'unspecified']).optional(),
});

export type HouseholdInput = z.infer<typeof householdSchema>;
