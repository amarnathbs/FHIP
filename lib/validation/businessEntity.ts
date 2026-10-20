import { z } from 'zod';
import { AUTHORITATIVE_COUNTRY_CODES } from '@/lib/services/jurisdiction';

// LR-11 — Company. LR-13 — Family Trust (fast-follow, migration 0136 widens
// the DB CHECK). Deliberately NOT restricted to AU like SMSF's validation
// (lib/validation/smsf.ts's `country_code: z.literal('AU')`) — see migration
// 0134's own header for why that assumption does not transfer to either
// entity type.
//
// M4B — HUF (migration 0154). This entity type IS jurisdiction-restricted,
// unlike the other two: a Hindu Undivided Family is a creature of Indian
// personal law, and the Product Owner scoped it "for only Indian users".
// THE RESTRICTION IS DELIBERATELY NOT EXPRESSED HERE. `country_code` on a
// business entity is informational and nullable (migration 0134), so pinning
// it the way `lib/validation/smsf.ts` pins `z.literal('AU')` would gate on a
// CLIENT-SUPPLIED field rather than on the caller's authoritative home
// jurisdiction — precisely the defect class G3's negative controls forbid.
// The real gate reads `user_profiles.country_of_residence` server-side in
// `app/api/business-entities/route.ts`, backstopped by the
// `trg_business_entities_huf_india_gate` trigger (migration 0154) so a
// direct PostgREST insert is refused too. This schema's only job is to say
// `'huf'` is a well-formed entity type at all.
const businessEntityCountryCode = z.enum(AUTHORITATIVE_COUNTRY_CODES).optional().nullable();

/** The entity types `business_entities.entity_type` accepts, mirroring
 *  migration 0154's CHECK. Exported so the India gate and the UI resolve the
 *  same literal rather than each restating it. */
export const BUSINESS_ENTITY_TYPES = ['company', 'family_trust', 'huf'] as const;
export type BusinessEntityType = (typeof BUSINESS_ENTITY_TYPES)[number];

/** The entity types restricted to a single home jurisdiction, and which one.
 *  Company and Family Trust are absent BY DESIGN — they are jurisdiction-
 *  agnostic (migration 0134's header, WP-09's lesson). Kept as data rather
 *  than an `if (type === 'huf')` so a future restricted type cannot be added
 *  to the union without this map being the one place to update. */
export const BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY: Partial<Record<BusinessEntityType, 'AU' | 'IN'>> = {
  huf: 'IN',
};

// LR-13: no trustee/beneficiary/distribution-rule field exists here or
// anywhere in this schema, deliberately — see migration 0136's own header
// for the Product Owner lock this respects. A Family Trust is modelled with
// exactly the same ownership_percentage-based consolidation as a Company.
// M4B: an HUF is modelled identically again — same ownership_percentage,
// same Summary/Detailed valuation, no karta/coparcener/partition field (see
// migration 0154's own header for the same Product Owner lock).
export const businessEntityCreateSchema = z.object({
  name: z.string().min(1),
  entity_type: z.enum(BUSINESS_ENTITY_TYPES).default('company'),
  country_code: businessEntityCountryCode,
  currency_code: z.enum(['AUD', 'INR']).default('AUD'),
  ownership_percentage: z.number().gt(0).max(100).default(100),
  // PO decision 17-10-2026 (D4): a NEW entity is recorded itemised by default (assets and liabilities, the net is derived). Net value only stays
  // available. Either-or, never both: the database refuses an itemised entity that also carries a typed net (migration 0297).
  valuation_mode: z.enum(['summary', 'detailed']).default('detailed'),
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
// PO decision 17-10-2026 / migration 0297: the way an entity is recorded (itemised or net value only) is NOT patchable. It changes only through the
// preview-first switch (POST /api/business-entities/[id]/switch-mode), which keeps the history and never leaves both representations counted.
export const businessEntityUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  country_code: businessEntityCountryCode,
  currency_code: z.enum(['AUD', 'INR']).optional(),
  ownership_percentage: z.number().gt(0).max(100).optional(),
  summary_net_asset_value: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
});
export type BusinessEntityUpdateInput = z.infer<typeof businessEntityUpdateSchema>;

// Entity-level lines (migration 0297): what an entity owns and owes, with the detail the PO asked for. A line is retired, never deleted.
export const BUSINESS_ENTITY_ASSET_TYPES = ['cash', 'property', 'shares_investments', 'business_assets', 'vehicle_equipment', 'other'] as const;
export const BUSINESS_ENTITY_LIABILITY_TYPES = ['property_loan', 'other_loan', 'tax_payable', 'trade_creditors', 'other'] as const;

const lineCommon = {
  label: z.string().trim().min(1),
  value: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  as_at_date: z.string().date().optional().nullable(),
  country_code: z.enum(['AU', 'IN']).optional().nullable(),
  notes: z.string().optional().nullable(),
};
const businessEntityAssetBaseSchema = z.object({ asset_type: z.enum(BUSINESS_ENTITY_ASSET_TYPES).optional().nullable(), ...lineCommon });
const businessEntityLiabilityBaseSchema = z.object({
  liability_type: z.enum(BUSINESS_ENTITY_LIABILITY_TYPES).optional().nullable(),
  lender: z.string().trim().optional().nullable(),
  interest_rate: z.number().min(0).max(100).optional().nullable(),
  monthly_repayment: z.number().min(0).optional().nullable(),
  ...lineCommon,
});
export const businessEntityAssetSchema = businessEntityAssetBaseSchema;
export const businessEntityLiabilitySchema = businessEntityLiabilityBaseSchema;
export type BusinessEntityAssetInput = z.infer<typeof businessEntityAssetSchema>;
export type BusinessEntityLiabilityInput = z.infer<typeof businessEntityLiabilitySchema>;
/** Kept for callers that only need the two fields every line has. */
export type BusinessEntityLineItemInput = BusinessEntityAssetInput | BusinessEntityLiabilityInput;

export const businessEntityAssetUpdateSchema = businessEntityAssetBaseSchema.partial();
export const businessEntityLiabilityUpdateSchema = businessEntityLiabilityBaseSchema.partial();
