import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

// Reload-edit contract note (G5B Phase 2 closure) — see lib/validation/income.ts's
// matching comment for the full root-cause writeup, shared verbatim across all
// three G5B-write-enabled modules. renewal_date, waiting_period_days,
// benefit_period, provider, master_item_key and notes are all genuinely
// nullable DB columns (migrations 0004/0008 — no NOT NULL, no default);
// `.nullable()` accepts the exact null GET already returns for an untouched
// row without loosening validation of any real value.
export const insuranceSchema = z.object({
  policy_name: z.string().min(1),
  cover_type: z.enum(['life', 'income_protection', 'health', 'home', 'vehicle', 'other']).default('other'),
  cover_amount: z.number().min(0),
  premium: z.number().min(0),
  premium_frequency: z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off']),
  currency_code: z.enum(['AUD', 'INR']),
  renewal_date: z.string().date().nullable().optional(),
  waiting_period_days: z.number().int().min(0).nullable().optional(),
  benefit_period: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type InsuranceInput = z.infer<typeof insuranceSchema>;
