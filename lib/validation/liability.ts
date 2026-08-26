import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

export const liabilitySchema = z.object({
  liability_name: z.string().min(1),
  debt_type: z
    .enum([
      'mortgage', 'personal_loan', 'credit_card', 'auto_loan', 'student_loan',
      // FDH-10 additions (spec section 12) — additive only; every pre-existing
      // value above is unchanged.
      'investment_property_loan', 'line_of_credit', 'overdraft', 'other_term_loan',
      'other',
    ])
    .default('other'),
  balance: z.number().min(0),
  interest_rate: z.number().min(0).max(100).optional(),
  interest_rate_type: z.enum(['fixed', 'variable']).optional(),
  fixed_rate_expiry: z.string().date().optional(),
  credit_limit: z.number().min(0).optional(),
  monthly_repayment: z.number().min(0).default(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional(),
  lender: z.string().optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
  // FDH-10 additions (migration 0096) — statement-import metadata. All
  // optional so manual liability add/edit is completely unaffected (spec
  // section 129).
  masked_identifier: z.string().max(32).optional(),
  minimum_payment: z.number().min(0).optional(),
  available_credit: z.number().min(0).optional(),
  due_date: z.string().date().optional(),
});

export type LiabilityInput = z.infer<typeof liabilitySchema>;
