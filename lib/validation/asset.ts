import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';
import { currencyMatchesCountry, currencyCountryRefinement } from './currencyCountry';

const assetBaseSchema = z.object({
  asset_name: z.string().min(1),
  asset_class: z.enum(['cash', 'property', 'vehicle', 'business', 'other']).default('other'),
  current_value: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional(),
  // Explicit, user-set carve-out for a genuinely foreign-currency holding
  // (e.g. the 'foreign_currency' catalogue item) — see currencyCountry.ts.
  // Deliberately .optional() with NO .default() — see FinancialDataGrid.tsx's
  // runSave(): the client only ever includes this key in the request body
  // when it's true, specifically so a false/absent value never gets
  // synthesized into the object handed to Supabase. currency_override is a
  // real DB column only once its migration is applied; until then, a
  // .default(false) here would inject the key into every single save (even
  // ones that never touch currency/country) and break all writes to this
  // table with a "column not found" error — .optional() with no default
  // lets Zod's parsed output omit the key entirely when absent, which
  // JSON.stringify then drops from the actual request body.
  currency_override: z.boolean().optional(),
  valuation_date: z.string().date().optional(),
  purchase_price: z.number().min(0).optional(),
  purchase_date: z.string().date().optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export const assetSchema = assetBaseSchema.refine(currencyMatchesCountry, currencyCountryRefinement);
export const assetPatchSchema = assetBaseSchema.partial().refine(currencyMatchesCountry, currencyCountryRefinement);

export type AssetInput = z.infer<typeof assetSchema>;
