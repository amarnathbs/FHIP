import { z } from 'zod';

export const profileSchema = z.object({
  full_name: z.string().min(1),
  date_of_birth: z.string().date().optional(),
  country_of_residence: z.enum(['AU', 'IN']),
  secondary_country: z.enum(['AU', 'IN']).nullable().optional(),
  preferred_currency: z.enum(['AUD', 'INR']),
  employment_status: z.string().optional(),
});

export type ProfileInput = z.infer<typeof profileSchema>;
