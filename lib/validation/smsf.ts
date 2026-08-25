import { z } from 'zod';

export const smsfFundCreateSchema = z.object({
  account_name: z.string().min(1),
  fund_name: z.string().min(1),
  summary_balance: z.number().min(0),
  summary_balance_date: z.string().optional().nullable(),
  owner: z.enum(['self', 'spouse', 'joint']).default('self'),
  currency_code: z.enum(['AUD', 'INR']).default('AUD'),
  country_code: z.literal('AU').default('AU'),
});
export type SmsfFundCreateInput = z.infer<typeof smsfFundCreateSchema>;

// Summary Mode edits only (fund_name/notes/summary_balance/date). Mode
// itself is never patched here — the only path from summary->detailed is
// the dedicated switch-to-detailed endpoint (the hard $0-variance gate);
// the only path from detailed->summary is the dedicated
// switch-to-summary endpoint (migration 0089) below.
export const smsfFundUpdateSchema = z.object({
  fund_name: z.string().min(1).optional(),
  summary_balance: z.number().min(0).optional(),
  summary_balance_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type SmsfFundUpdateInput = z.infer<typeof smsfFundUpdateSchema>;

// Detailed -> Summary switch-back (spec s.32-33, migration 0089). A new
// Summary value AND a valuation date are both required — spec: "require/
// confirm new Summary value + valuation date" — never optional the way
// summary_balance_date is on initial creation.
export const smsfSwitchToSummarySchema = z.object({
  new_summary_balance: z.number().min(0),
  new_summary_balance_date: z.string().min(1),
});
export type SmsfSwitchToSummaryInput = z.infer<typeof smsfSwitchToSummarySchema>;

export const SMSF_HOLDING_CLASS_TYPES = {
  cash: ['cash', 'cash_account', 'term_deposit'],
  listed_investment: ['au_shares', 'international_shares', 'etf', 'managed_fund', 'index_fund', 'reit'],
  fixed_income: ['government_bond', 'corporate_bond', 'other_bond'],
  property: ['residential_property', 'commercial_property', 'other_smsf_property'],
  other: ['gold_precious_metals', 'private_unlisted', 'crypto', 'other_smsf_asset'],
} as const;

const ALL_HOLDING_TYPES = Object.values(SMSF_HOLDING_CLASS_TYPES).flat() as [string, ...string[]];

const smsfHoldingBaseSchema = z.object({
  holding_class: z.enum(['cash', 'listed_investment', 'fixed_income', 'property', 'other']),
  holding_type: z.enum(ALL_HOLDING_TYPES),
  holding_name: z.string().min(1),
  value: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional().nullable(),
  linked_income_source_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const smsfHoldingSchema = smsfHoldingBaseSchema
  .refine(
    (v) => (SMSF_HOLDING_CLASS_TYPES[v.holding_class] as readonly string[]).includes(v.holding_type),
    { message: 'holding_type does not belong to holding_class', path: ['holding_type'] }
  )
  .refine((v) => v.linked_income_source_id == null || v.holding_class === 'property', {
    message: 'linked_income_source_id is only valid on a property holding',
    path: ['linked_income_source_id'],
  });
export type SmsfHoldingInput = z.infer<typeof smsfHoldingSchema>;

// Partial updates derive from the base object (pre-refinement) -- a PATCH
// legitimately sends only e.g. { value: 123 } without holding_class/
// holding_type present at all, which .refine()'d schemas can't express
// .partial() over. The DB-level chk_smsf_holdings_class_type/
// chk_smsf_holdings_income_link_property_only CHECK constraints (migration
// 0084) remain the authoritative backstop for any combination this laxer
// schema lets through.
export const smsfHoldingUpdateSchema = smsfHoldingBaseSchema.partial();

export const smsfMemberSchema = z.object({
  retirement_member_id: z.string().uuid(),
  member_interest_amount: z.number().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type SmsfMemberInput = z.infer<typeof smsfMemberSchema>;
