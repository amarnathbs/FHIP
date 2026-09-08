import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

// Reload-edit contract note (G5B Phase 2 closure): net_amount, employer_name,
// master_item_key and notes are all genuinely nullable DB columns (see
// migrations 0004/0008 — no NOT NULL, no default). GET returns an untouched
// row's value for each as JSON null, and the shared grid's save path
// (components/grid/FinancialDataGrid.tsx's runSave) round-trips whatever it
// last read for every configured field on every save, not only the field the
// user actually touched. Before this fix these four fields were `.optional()`
// only (undefined-only — permits an absent key, not an explicit null), so
// editing any field on a record that had reached a full page reload (and
// therefore carried real `null`s instead of merely-absent keys) failed this
// schema with a 422, even though the value being resent was never actually
// changing. `.nullable()` makes the schema accept the exact null the API
// itself already returns; it does not loosen validation of any real, non-null
// value (min(0)/string rules still apply), and an update patch carrying an
// explicit null here is a genuine no-op against an already-null column, never
// a data-clearing operation on a real stored value.
export const incomeSchema = z.object({
  source_name: z.string().min(1),
  income_type: z.enum(['salary', 'business', 'rental', 'investment', 'other']).default('other'),
  amount: z.number().min(0),
  net_amount: z.number().min(0).nullable().optional(),
  frequency: z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off']),
  currency_code: z.enum(['AUD', 'INR']),
  owner: z.enum(OWNER_VALUES).default('self'),
  is_taxable: z.boolean().default(true),
  employer_name: z.string().nullable().optional(),
  master_item_key: z.string().nullable().optional(),
  // LR-3: explicit opt-out once this row's real income is tracked via an
  // approved bank/payslip import instead — see migration 0131.
  superseded_by_bank_import: z.boolean().default(false),
  notes: z.string().nullable().optional(),
});

export type IncomeInput = z.infer<typeof incomeSchema>;
