import { z } from 'zod';

export const householdSchema = z.object({
  household_name: z.string().optional(),
  household_type: z.string().optional(),
  marital_status: z.string().optional(),
  dependants_count: z.number().int().min(0).default(0),
  annual_household_income_range: z.string().optional(),
  primary_country: z.enum(['AU', 'IN']),
  // Cohort-matching dimensions for the Financial Twin (Module 8) — not
  // captured by any earlier module. Optional so existing households without
  // a value simply fall back to a broader cohort tier (spec section 6.4).
  housing_tenure: z.enum(['renter', 'mortgage_owner', 'outright_owner', 'other']).optional(),
  residence_type: z.enum(['metro', 'regional', 'rural', 'unspecified']).optional(),
});

export type HouseholdInput = z.infer<typeof householdSchema>;
