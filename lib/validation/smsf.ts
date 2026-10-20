import { z } from 'zod';
import { MASKED_IDENTIFIER_MESSAGE, maskedIdentifierProblem } from '@/lib/validation/maskedIdentifier';

const smsfFundCreateBase = z.object({
  account_name: z.string().min(1),
  fund_name: z.string().min(1),
  // How the fund is recorded (PO decision 17-10-2026): itemised (detailed) = assets and liabilities are entered afterwards and the net is
  // DERIVED; summary = a typed net value only. Never both. Omitted: a typed value means summary, none means itemised (the recommended default).
  mode: z.enum(['detailed', 'summary']).optional(),
  summary_balance: z.number().min(0).optional(),
  summary_balance_date: z.string().optional().nullable(),
  owner: z.enum(['self', 'spouse', 'joint']).default('self'),
  currency_code: z.enum(['AUD', 'INR']).default('AUD'),
  country_code: z.literal('AU').default('AU'),
});
export const smsfFundCreateSchema = smsfFundCreateBase
  .superRefine((v, ctx) => {
    const mode = v.mode ?? (v.summary_balance !== undefined ? 'summary' : 'detailed');
    if (mode === 'summary' && v.summary_balance === undefined) {
      ctx.addIssue({ code: 'custom', path: ['summary_balance'], message: 'a net value is required when the fund is recorded as a net value only' });
    }
    if (mode === 'detailed' && v.summary_balance !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['summary_balance'], message: 'an itemised fund derives its net from its assets and liabilities, so it cannot also carry a typed net value' });
    }
  })
  .transform((v) => ({ ...v, mode: v.mode ?? (v.summary_balance !== undefined ? ('summary' as const) : ('detailed' as const)) }));
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

// ---------------------------------------------------------------------------------------------------------------------
// Entity-level liabilities (migration 0289) and the itemised-or-net-only switch (migration 0290)
// ---------------------------------------------------------------------------------------------------------------------
export const SMSF_LIABILITY_TYPES = ['property_loan', 'other_loan', 'tax_payable', 'other'] as const;
export type SmsfLiabilityType = (typeof SMSF_LIABILITY_TYPES)[number];

const smsfLiabilityBaseSchema = z.object({
  liability_name: z.string().trim().min(1),
  liability_type: z.enum(SMSF_LIABILITY_TYPES),
  lender: z.string().trim().optional().nullable(),
  balance: z.number().min(0),
  interest_rate: z.number().min(0).max(100).optional().nullable(),
  monthly_repayment: z.number().min(0).optional().nullable(),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional().nullable(),
  // The canonical liability fields (migration 0295), same values and same masking rule as the personal liabilities register.
  interest_rate_type: z.enum(['fixed', 'variable']).optional().nullable(),
  fixed_rate_expiry: z.string().date().optional().nullable(),
  // One rule, one message, shared with the personal liabilities register (WP-E, F24).
  masked_identifier: z
    .string()
    .trim()
    .refine((v) => maskedIdentifierProblem(v) === null, { message: MASKED_IDENTIFIER_MESSAGE })
    .optional()
    .nullable(),
  due_date: z.string().date().optional().nullable(),
  /** The SMSF property asset this loan funds (a descriptive link, never an amount). */
  smsf_holding_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});
export const smsfLiabilitySchema = smsfLiabilityBaseSchema.extend({ liability_type: z.enum(SMSF_LIABILITY_TYPES).default('other') });
export type SmsfLiabilityInput = z.infer<typeof smsfLiabilitySchema>;
export const smsfLiabilityUpdateSchema = smsfLiabilityBaseSchema.partial();

// The recording-mode switch. `confirm` false = PREVIEW ONLY (nothing changes, the response says what would). The itemised branch carries the
// whole set of assets and liabilities so the switch is atomic: there is never a moment with neither or both counted.
export const smsfSwitchModeSchema = z.discriminatedUnion('to_mode', [
  z.object({
    to_mode: z.literal('detailed'),
    assets: z.array(smsfHoldingSchema).default([]),
    liabilities: z.array(smsfLiabilitySchema).default([]),
    confirm: z.boolean().default(false),
  }),
  z.object({
    to_mode: z.literal('summary'),
    net: z.number().min(0),
    net_date: z.string().min(1).optional().nullable(),
    confirm: z.boolean().default(false),
  }),
]).superRefine((v, ctx) => {
  if (v.to_mode === 'detailed' && v.assets.length + v.liabilities.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['assets'], message: 'enter at least one asset or liability to record the fund as itemised' });
  }
});
export type SmsfSwitchModeInput = z.infer<typeof smsfSwitchModeSchema>;

export const smsfConfirmSchema = z.object({ confirm: z.boolean().default(false) });
export const smsfMoveLoanSchema = z.object({ liability_id: z.string().uuid(), confirm: z.boolean().default(false) });
export const smsfAdoptRowsSchema = z.object({ retirement_row_ids: z.array(z.string().uuid()).min(1), confirm: z.boolean().default(false) });
