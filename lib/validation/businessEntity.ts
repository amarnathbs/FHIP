import { z } from 'zod';
import { AUTHORITATIVE_COUNTRY_CODES } from '@/lib/services/jurisdiction';

// LR-11 — Company. LR-13 — Family Trust (fast-follow, migration 0136 widens
// the DB CHECK). Deliberately NOT restricted to AU like SMSF's validation
// (lib/validation/smsf.ts's `country_code: z.literal('AU')`) — see migration
// 0134's own header for why that assumption does not transfer to either
// entity type.
const businessEntityCountryCode = z.enum(AUTHORITATIVE_COUNTRY_CODES).optional().nullable();

// LR-13: no trustee/beneficiary/distribution-rule field exists here or
// anywhere in this schema, deliberately — see migration 0136's own header
// for the Product Owner lock this respects. A Family Trust is modelled with
// exactly the same ownership_percentage-based consolidation as a Company.
export const businessEntityCreateSchema = z.object({
  name: z.string().min(1),
  entity_type: z.enum(['company', 'family_trust']).default('company'),
  country_code: businessEntityCountryCode,
  currency_code: z.enum(['AUD', 'INR']).default('AUD'),
  ownership_percentage: z.number().gt(0).max(100).default(100),
  valuation_mode: z.enum(['summary', 'detailed']).default('summary'),
  // Required only in Summary mode — enforced by .refine() below, not a bare
  // .optional() the API route would have to remember to re-check.
  summary_net_asset_value: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type BusinessEntityCreateInput = z.infer<typeof businessEntityCreateSchema>;

export const businessEntityCreateInputSchema = businessEntityCreateSchema.refine(
  (v) => v.valuation_mode !== 'summary' || typeof v.summary_net_asset_value === 'number',
  { message: 'summary_net_asset_value is required while valuation_mode is summary', path: ['summary_net_asset_value'] }
);

// Mode itself is never patched here, mirroring SMSF's own "no bare mode
// flip" discipline — this phase deliberately keeps the switch simple
// (unlike SMSF's $0-variance-gated switch-to-detailed RPC) since a business
// entity's net value has no separate "must reconcile to the cent" invariant
// the way SMSF's retirement_accounts.current_balance does. A user can PATCH
// valuation_mode directly through this same schema; there is no dedicated
// switch endpoint for LR-11's simpler model.
export const businessEntityUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  country_code: businessEntityCountryCode,
  currency_code: z.enum(['AUD', 'INR']).optional(),
  ownership_percentage: z.number().gt(0).max(100).optional(),
  valuation_mode: z.enum(['summary', 'detailed']).optional(),
  summary_net_asset_value: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
});
export type BusinessEntityUpdateInput = z.infer<typeof businessEntityUpdateSchema>;

const businessEntityLineItemBaseSchema = z.object({
  label: z.string().min(1),
  value: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  notes: z.string().optional().nullable(),
});
export const businessEntityAssetSchema = businessEntityLineItemBaseSchema;
export const businessEntityLiabilitySchema = businessEntityLineItemBaseSchema;
export type BusinessEntityLineItemInput = z.infer<typeof businessEntityLineItemBaseSchema>;

export const businessEntityLineItemUpdateSchema = businessEntityLineItemBaseSchema.partial();
