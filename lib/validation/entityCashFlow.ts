import { z } from 'zod';

// Entity-level income and expenses (migration 0296): one economic flow, one record, scoped to ONE entity (an SMSF fund or a registered Company,
// Family Trust or HUF). The types are the database CHECK lists, restated here so a bad value is answered in plain words before it reaches the
// database. There is deliberately NO loan repayment expense type: principal is a cash flow, derived from the entity liabilities (PO, F23).
export const ENTITY_INCOME_TYPES = ['rent', 'interest', 'dividends', 'distributions', 'trading_revenue', 'other'] as const;
export type EntityIncomeType = (typeof ENTITY_INCOME_TYPES)[number];

export const ENTITY_EXPENSE_TYPES = ['property_costs', 'insurance', 'accounting_audit', 'admin_fees', 'investment_fees', 'taxes_levies', 'bank_fees', 'other'] as const;
export type EntityExpenseType = (typeof ENTITY_EXPENSE_TYPES)[number];

export const ENTITY_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'] as const;

export const ENTITY_INCOME_TYPE_LABELS: Record<EntityIncomeType, string> = {
  rent: 'Rent',
  interest: 'Interest',
  dividends: 'Dividends',
  distributions: 'Distributions',
  trading_revenue: 'Trading revenue',
  other: 'Other income',
};

export const ENTITY_EXPENSE_TYPE_LABELS: Record<EntityExpenseType, string> = {
  property_costs: 'Property costs',
  insurance: 'Insurance',
  accounting_audit: 'Accounting and audit',
  admin_fees: 'Administration fees',
  investment_fees: 'Investment fees',
  taxes_levies: 'Taxes and levies',
  bank_fees: 'Bank fees',
  other: 'Other expense',
};

const flowBase = {
  amount: z.number().min(0),
  frequency: z.enum(ENTITY_FREQUENCIES),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional().nullable(),
  notes: z.string().optional().nullable(),
};

const entityIncomeBaseSchema = z.object({
  income_type: z.enum(ENTITY_INCOME_TYPES),
  income_name: z.string().trim().min(1, 'Describe this income'),
  /** The SMSF property asset a rent record comes from (rent only). */
  smsf_holding_id: z.string().uuid().optional().nullable(),
  /** The Company, Trust or HUF asset a rent record comes from (rent only). */
  business_entity_asset_id: z.string().uuid().optional().nullable(),
  ...flowBase,
});

/** Rent needs an amount AND a frequency (PO F22). Only rent may be tied to an asset. */
export const entityIncomeSchema = entityIncomeBaseSchema.superRefine((v, ctx) => {
  if (v.income_type === 'rent' && !(v.amount > 0)) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Enter the rent amount and how often it is paid' });
  }
  if (v.income_type !== 'rent' && (v.smsf_holding_id || v.business_entity_asset_id)) {
    ctx.addIssue({ code: 'custom', path: ['income_type'], message: 'Only rent can be tied to a property' });
  }
});
export type EntityIncomeInput = z.infer<typeof entityIncomeSchema>;
export const entityIncomeUpdateSchema = entityIncomeBaseSchema.partial();

export const entityExpenseSchema = z.object({
  expense_type: z.enum(ENTITY_EXPENSE_TYPES),
  expense_name: z.string().trim().min(1, 'Describe this expense'),
  ...flowBase,
});
export type EntityExpenseInput = z.infer<typeof entityExpenseSchema>;
export const entityExpenseUpdateSchema = entityExpenseSchema.partial();

export const smsfMoveCashFlowSchema = z.object({
  register: z.enum(['income', 'expenses']),
  row_id: z.string().uuid(),
  confirm: z.boolean().default(false),
});
